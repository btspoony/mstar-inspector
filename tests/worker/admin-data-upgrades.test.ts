/**
 * The operator data-upgrade runner and its console routes (spec
 * operator-data-upgrade § Upgrade registry and state machine, D8).
 *
 * No item ships in this plan's task 2, so these cases register a FIXTURE item
 * against a real table (`server_flags`: a `fixture.upgrade.*` row with
 * `enabled = 0` is un-migrated work, `enabled = 1` is moved work) and drive it
 * through the real admin mount. What is pinned:
 *
 *   - one step moves one batch and a second step over finished work moves
 *     NOTHING (replay idempotency, the crash-safety property);
 *   - a downtime item refuses `step` with 409 once it is running outside its
 *     window, but its FIRST step opens the window and records ownership;
 *   - a non-zero verify check lands `failed` + `last_error`, never `completed`;
 *   - `reset` returns the item to `pending` with no cursor or counter and
 *     leaves the migrated rows and the maintenance window alone.
 */
import { afterEach, describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { getMaintenanceMode, setMaintenanceMode } from "../../src/dashboard/runtime-config-store";
import type { Env } from "../../src/worker/env";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import {
  DATA_UPGRADES,
  type DataUpgradeItem,
  type UpgradeCursor,
} from "../../src/admin/data-upgrades";
import type { DashboardD1 } from "../../src/dashboard/users";

const SESSION_SECRET = ["test", "data", "upgrade", "secret", "32-bytes"].join("-");
const OPERATOR = "Support-Bot";
const ITEM_ID = "fixture-upgrade";
const MOVED_KEY = "fixture.upgrade.moved";

/**
 * The fixture item: `server_flags` rows keyed `fixture.upgrade.*` with
 * `enabled = 0` are un-migrated. One batch flips up to two of them, so a
 * three-row worklist needs two steps — the paging the cursor exists for.
 */
function fixtureItem(overrides: Partial<DataUpgradeItem> = {}): DataUpgradeItem {
  return {
    id: ITEM_ID,
    title: "fixture upgrade",
    requiresDowntime: false,
    order: 1,
    async preflight(db: DashboardD1) {
      const row = await db
        .prepare("SELECT COUNT(*) AS n FROM server_flags WHERE key LIKE 'fixture.upgrade.%' AND enabled = 0")
        .first<{ n: number }>();
      return { pending: row?.n ?? 0 };
    },
    async runBatch(db: DashboardD1, cursor: UpgradeCursor | null) {
      const offset = typeof cursor?.offset === "number" ? cursor.offset : 0;
      const pending = await db
        .prepare("SELECT key FROM server_flags WHERE key LIKE 'fixture.upgrade.%' AND enabled = 0 ORDER BY key")
        .all<{ key: string }>();
      const keys = pending.results.slice(0, 2).map((row) => row.key);
      // ONE transaction: the flip and its audit row land together or not at all.
      await db.batch(
        keys.map((key) =>
          db.prepare("UPDATE server_flags SET enabled = 1 WHERE key = ?1").bind(key),
        ),
      );
      const left = pending.results.length - keys.length;
      return {
        cursor: left > 0 ? { offset: offset + keys.length } : null,
        processed: keys.length,
        done: left === 0,
        log: { moved: keys.length },
      };
    },
    async verify(db: DashboardD1) {
      const row = await db
        .prepare("SELECT COUNT(*) AS n FROM server_flags WHERE key LIKE 'fixture.upgrade.%' AND enabled = 0")
        .first<{ n: number }>();
      return { unmigrated: row?.n ?? 0 };
    },
    ...overrides,
  };
}

function seedFlag(db: TestD1, key: string, enabled: 0 | 1): void {
  db.raw
    .prepare("INSERT INTO server_flags (key, enabled, updated_at, updated_by) VALUES (?, ?, ?, 'fixture')")
    .run(key, enabled, "2026-11-17T00:00:00.000Z");
}

/** The operator account plus `count` un-migrated fixture rows. */
function fixture(count = 3): TestD1 {
  const db = createMigratedTestD1();
  db.raw
    .prepare("INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES (?, ?, 'member', ?, NULL)")
    .run(crypto.randomUUID(), OPERATOR, "2026-11-17T00:00:00.000Z");
  for (let index = 0; index < count; index += 1) seedFlag(db, `${MOVED_KEY}.${index}`, 0);
  return db;
}

function envFor(db: TestD1): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} },
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} },
    DEPLOYMENT_MODE: "saas",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    PLATFORM_OPERATORS: OPERATOR.toLowerCase(),
    DB: db,
  } as unknown as Env;
}

async function api(
  db: TestD1,
  method: "GET" | "POST",
  path: string,
  login: string | null = OPERATOR,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (login !== null) {
    headers.Cookie = `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}`;
  }
  return worker.fetch(
    new Request(`https://worker.local/_internal_admin${path}`, { method, headers }),
    envFor(db),
  );
}

/** Register `item` for this case; `afterEach` restores the shipped registry. */
const SHIPPED_UPGRADES = [...DATA_UPGRADES];

function register(item: DataUpgradeItem): void {
  DATA_UPGRADES.push(item);
}

afterEach(() => {
  DATA_UPGRADES.splice(0, DATA_UPGRADES.length, ...SHIPPED_UPGRADES);
});

async function state(db: TestD1): Promise<{ status: string; processed: number; cursor_json: string | null }> {
  const row = await db
    .prepare("SELECT status, processed, cursor_json FROM operator_data_upgrades WHERE id = ?1")
    .bind(ITEM_ID)
    .first<{ status: string; processed: number; cursor_json: string | null }>();
  return row ?? { status: "pending", processed: 0, cursor_json: null };
}

function movedCount(db: TestD1): number {
  const row = db.raw
    .prepare("SELECT COUNT(*) AS n FROM server_flags WHERE key LIKE 'fixture.upgrade.%' AND enabled = 1")
    .get() as { n: number };
  return row.n;
}

describe("the data-upgrade runner", () => {
  test("a second step over finished work processes nothing", async () => {
    const db = fixture(3);
    register(fixtureItem());

    const first = await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/step`);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { batch: { cursor: unknown; processed: number; done: boolean } };
    expect(firstBody.batch).toMatchObject({ cursor: { offset: 2 }, processed: 2, done: false });
    expect(await state(db)).toEqual({ status: "running", processed: 2, cursor_json: '{"offset":2}' });

    const second = await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/step`);
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { batch: { cursor: unknown; processed: number; done: boolean } };
    expect(secondBody.batch).toMatchObject({ cursor: null, processed: 1, done: true });
    expect(movedCount(db)).toBe(3);

    // The replay: an empty batch moves nothing and keeps the item `running`
    // until an explicit verify (an empty batch is not a completion).
    const replay = await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/step`);
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as { batch: { cursor: unknown; processed: number; done: boolean } };
    expect(replayBody.batch).toMatchObject({ cursor: null, processed: 0, done: true });
    expect(await state(db)).toEqual({ status: "running", processed: 3, cursor_json: "null" });
    expect(movedCount(db)).toBe(3);
    // Every batch's entry survives, including the empty replay.
    const logged = db.raw
      .prepare("SELECT log_json FROM operator_data_upgrades WHERE id = ?")
      .get(ITEM_ID) as { log_json: string };
    expect(JSON.parse(logged.log_json)).toEqual([{ moved: 2 }, { moved: 1 }, { moved: 0 }]);
  });

  test("a downtime item opens the window on its first step and refuses the next one outside it", async () => {
    const db = fixture(3);
    register(fixtureItem({ requiresDowntime: true }));

    const first = await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/step`);
    expect(first.status).toBe(200);
    expect((await getMaintenanceMode(db)).enabled).toBe(true);
    expect(
      db.raw.prepare("SELECT maintenance_owned FROM operator_data_upgrades WHERE id = ?").get(ITEM_ID),
    ).toEqual({ maintenance_owned: 1 });

    // The operator opened the platform again mid-upgrade: the item must not
    // keep stepping outside a window it can no longer claim as its own.
    await setMaintenanceMode(db, { enabled: false, actor: OPERATOR }, "2026-11-17T01:00:00.000Z");
    const refused = await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/step`);
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as { error: string };
    expect(body.error).toContain("maintenance mode must be on");
    expect(await state(db)).toEqual({ status: "running", processed: 2, cursor_json: '{"offset":2}' });
    expect(movedCount(db)).toBe(2);
  });

  test("a non-zero verify check lands failed with last_error, never completed", async () => {
    const db = fixture(1);
    register(fixtureItem({ verify: async () => ({ unmigrated: 4, orphaned: 0 }) }));

    await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/step`);
    const res = await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/verify`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: { status: string; lastError: string; finishedAt: string | null } };
    expect(body.state.status).toBe("failed");
    expect(body.state.lastError).toBe("verify failed: unmigrated=4");
    expect(body.state.finishedAt).toBeNull();
    expect(await state(db)).toEqual({ status: "failed", processed: 1, cursor_json: "null" });

    // `failed` is not a step-able state: the operator resets first.
    expect((await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/step`)).status).toBe(409);
  });

  test("reset closes a window the runner opened, and only that one", async () => {
    const db = fixture(3);
    register(fixtureItem({ requiresDowntime: true }));
    await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/step`);
    expect((await getMaintenanceMode(db)).enabled).toBe(true);

    const res = await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/reset`);
    expect(res.status).toBe(200);
    // The claim is dropped, so no later `completed` could close the window: it
    // must be closed now rather than stranded open.
    expect((await getMaintenanceMode(db)).enabled).toBe(false);
    expect(
      db.raw.prepare("SELECT maintenance_owned FROM operator_data_upgrades WHERE id = ?").get(ITEM_ID),
    ).toEqual({ maintenance_owned: 0 });

    // An operator-opened window survives a reset: the runner never owned it.
    const operatorDb = fixture(3);
    await setMaintenanceMode(
      operatorDb,
      { enabled: true, reason: "planned incident", actor: OPERATOR },
      "2026-11-17T02:00:00.000Z",
    );
    await api(operatorDb, "POST", `/api/data-upgrades/${ITEM_ID}/step`);
    expect((await api(operatorDb, "POST", `/api/data-upgrades/${ITEM_ID}/reset`)).status).toBe(200);
    const mode = await getMaintenanceMode(operatorDb);
    expect(mode.enabled).toBe(true);
    expect(mode.reason).toBe("planned incident");
  });

  test("a concurrent step is refused with upgrade_running, and plans nothing", async () => {
    const db = fixture(3);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const inner = fixtureItem();
    // Hold the first batch in flight so the second request provably overlaps it.
    register({
      ...inner,
      async runBatch(dbApi, cursor) {
        entered.resolve();
        await release.promise;
        return inner.runBatch(dbApi, cursor);
      },
    });

    const first = api(db, "POST", `/api/data-upgrades/${ITEM_ID}/step`);
    await entered.promise;
    const second = await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/step`);
    expect(second.status).toBe(409);
    const refusal = (await second.json()) as { error: string };
    expect(refusal.error).toBe("upgrade_running");
    // The refused caller ran no batch: only the claim holder's page moved.
    expect(movedCount(db)).toBe(0);

    release.resolve();
    expect((await first).status).toBe(200);
    expect(movedCount(db)).toBe(2);
    expect(await state(db)).toEqual({ status: "running", processed: 2, cursor_json: '{"offset":2}' });

    // The claim was released, so the walk continues immediately.
    expect((await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/step`)).status).toBe(200);
    expect(movedCount(db)).toBe(3);
  });

  test("a batch that throws releases the claim, so the operator can retry", async () => {
    const db = fixture(2);
    const inner = fixtureItem();
    let failing = true;
    register({
      ...inner,
      async runBatch(dbApi, cursor) {
        if (failing) throw new Error("batch exploded");
        return inner.runBatch(dbApi, cursor);
      },
    });

    expect((await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/step`)).status).toBe(500);
    // The claim is gone with the failed batch: the retry is not a 5-minute
    // `upgrade_running` wait for a lease nobody holds.
    failing = false;
    expect((await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/step`)).status).toBe(200);
    expect(movedCount(db)).toBe(2);
  });

  test("a verify during a running step is refused with upgrade_running", async () => {
    const db = fixture(3);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const inner = fixtureItem();
    register({
      ...inner,
      async runBatch(dbApi, cursor) {
        entered.resolve();
        await release.promise;
        return inner.runBatch(dbApi, cursor);
      },
    });

    const step = api(db, "POST", `/api/data-upgrades/${ITEM_ID}/step`);
    await entered.promise;
    const refused = await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/verify`);
    expect(refused.status).toBe(409);
    const refusal = (await refused.json()) as { error: string };
    expect(refusal.error).toBe("upgrade_running");
    // The verify ran no check: the step still owns the row.
    expect(await state(db)).toMatchObject({ status: "running" });

    release.resolve();
    expect((await step).status).toBe(200);
    expect(await state(db)).toMatchObject({ status: "running", processed: 2 });
  });

  test("a reset during a verify is refused with upgrade_running", async () => {
    const db = fixture(1);
    const entered = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const inner = fixtureItem();
    register({
      ...inner,
      async verify(dbApi) {
        entered.resolve();
        await release.promise;
        return inner.verify(dbApi);
      },
    });

    expect((await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/step`)).status).toBe(200);
    const verifying = api(db, "POST", `/api/data-upgrades/${ITEM_ID}/verify`);
    await entered.promise;

    const refused = await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/reset`);
    expect(refused.status).toBe(409);
    const body = (await refused.json()) as { error: string; state: { status: string } };
    expect(body.error).toBe("upgrade_running");
    expect(body.state.status).toBe("verifying");
    // Nothing was cleared: the cursor and the moved rows survive the refusal.
    expect(await state(db)).toEqual({ status: "verifying", processed: 1, cursor_json: "null" });
    expect(movedCount(db)).toBe(1);

    release.resolve();
    expect((await verifying).status).toBe(200);
    expect(await state(db)).toMatchObject({ status: "completed" });
  });

  test("step, verify and reset each write one audit row", async () => {
    const db = fixture(1);
    register(fixtureItem());

    await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/step`);
    const verified = await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/verify`);
    expect(verified.status).toBe(200);
    await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/reset`);

    const rows = db.raw
      .prepare(
        "SELECT actor_login, action, target_type, target_id, detail_json FROM platform_audit_events ORDER BY rowid",
      )
      .all() as Array<{
      actor_login: string;
      action: string;
      target_type: string;
      target_id: string;
      detail_json: string;
    }>;
    expect(rows.map((row) => row.action)).toEqual(["upgrade.step", "upgrade.verify", "upgrade.reset"]);
    expect(rows.map((row) => row.actor_login)).toEqual([OPERATOR, OPERATOR, OPERATOR]);
    expect(rows.every((row) => row.target_type === "data_upgrade" && row.target_id === ITEM_ID)).toBe(true);
    expect(rows.map((row) => JSON.parse(row.detail_json))).toEqual([
      { phase: "step", outcome: "running" },
      { phase: "verify", outcome: "completed" },
      { phase: "reset", outcome: "pending" },
    ]);
  });

  test("a clean verify completes and closes only the window the runner opened", async () => {
    const db = fixture(1);
    register(fixtureItem({ requiresDowntime: true }));

    await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/step`);
    const res = await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/verify`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: { status: string; ended?: string; finishedAt: string | null } };
    expect(body.state.status).toBe("completed");
    expect(body.state.finishedAt).not.toBeNull();
    // The runner owned the window, so it closes it and drops its claim.
    expect((await getMaintenanceMode(db)).enabled).toBe(false);

    // An operator-enabled window stays on: it was never the runner's to close.
    const operatorDb = fixture(1);
    await setMaintenanceMode(
      operatorDb,
      { enabled: true, reason: "planned incident", actor: OPERATOR },
      "2026-11-17T02:00:00.000Z",
    );
    await api(operatorDb, "POST", `/api/data-upgrades/${ITEM_ID}/step`);
    expect((await api(operatorDb, "POST", `/api/data-upgrades/${ITEM_ID}/verify`)).status).toBe(200);
    const mode = await getMaintenanceMode(operatorDb);
    expect(mode.enabled).toBe(true);
    expect(mode.reason).toBe("planned incident");
  });

  test("reset clears the cursor and counter but keeps the migrated rows", async () => {
    const db = fixture(3);
    register(fixtureItem());
    await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/step`);
    expect(movedCount(db)).toBe(2);

    const res = await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/reset`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: { status: string; processed: number; cursor: unknown } };
    expect(body.state).toMatchObject({ status: "pending", processed: 0, cursor: null, startedAt: null });
    expect(movedCount(db)).toBe(2);

    // The re-run is a no-op pass over the moved rows: the worklist excludes them.
    const rerun = await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/step`);
    const rerunBody = (await rerun.json()) as { batch: { processed: number } };
    expect(rerunBody.batch.processed).toBe(1);
    expect(movedCount(db)).toBe(3);
  });
});

describe("the data-upgrade routes", () => {
  test("the list states the item, its pending state and its preflight counts", async () => {
    const db = fixture(2);
    register(fixtureItem());
    const res = await api(db, "GET", "/api/data-upgrades");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      upgrades: Array<{ id: string; state: { status: string }; preflight: Record<string, number> }>;
    };
    // The shipped registry renders beside the fixture item: `repo-backfill`.
    expect(body.upgrades.map((item) => item.id).sort()).toEqual(["fixture-upgrade", "repo-backfill"]);
    const listed = body.upgrades.find((item) => item.id === ITEM_ID)!;
    expect(listed.state.status).toBe("pending");
    expect(listed.preflight).toEqual({ pending: 2 });
  });

  test("an unknown id is a 404 and a non-operator sees the namespace 404", async () => {
    const db = fixture(1);
    register(fixtureItem());
    expect((await api(db, "POST", "/api/data-upgrades/nope/step")).status).toBe(404);
    expect((await api(db, "GET", "/api/data-upgrades", null)).status).toBe(404);
  });

  test("verify refuses a pending item instead of completing it", async () => {
    const db = fixture(1);
    register(fixtureItem());
    const res = await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/verify`);
    expect(res.status).toBe(409);
    expect((await state(db)).status).toBe("pending");
  });
});
