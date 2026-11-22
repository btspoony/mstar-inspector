import { afterEach, describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { getMaintenanceMode, setMaintenanceMode } from "../../src/dashboard/runtime-config-store";
import type { Env } from "../../src/worker/env";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import {
  DATA_UPGRADES,
  releaseUpgradeClaim,
  resetDataUpgrade,
  settleUpgradeMaintenance,
  settleVerifyState,
  type DataUpgradeItem,
  type UpgradeCursor,
} from "../../src/admin/data-upgrades";
import type { DashboardD1 } from "../../src/dashboard/users";

const SESSION_SECRET = ["test", "data", "upgrade", "secret", "32-bytes"].join("-");
const OPERATOR = "Support-Bot";
const ITEM_ID = "fixture-upgrade";
const MOVED_KEY = "fixture.upgrade.moved";

function fixtureItem(overrides: Partial<DataUpgradeItem> = {}): DataUpgradeItem {
  return {
    id: ITEM_ID,
    title: "fixture upgrade",
    impact: "Flips fixture flag rows. Never deletes a flag.",
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

function claimToken(db: TestD1): string | null {
  const row = db.raw
    .prepare("SELECT claim_token FROM operator_data_upgrades WHERE id = ?")
    .get(ITEM_ID) as { claim_token: string | null } | null;
  return row?.claim_token ?? null;
}

function seedClaimedRow(
  db: TestD1,
  opts: { status: string; maintenanceOwned: 0 | 1; startedAt: string; token: string },
): void {
  db.raw
    .prepare(
      "INSERT INTO operator_data_upgrades (id, status, maintenance_owned, started_at, claim_token) VALUES (?, ?, ?, ?, ?)",
    )
    .run(ITEM_ID, opts.status, opts.maintenanceOwned, opts.startedAt, opts.token);
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

    const replay = await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/step`);
    expect(replay.status).toBe(200);
    const replayBody = (await replay.json()) as { batch: { cursor: unknown; processed: number; done: boolean } };
    expect(replayBody.batch).toMatchObject({ cursor: null, processed: 0, done: true });
    expect(await state(db)).toEqual({ status: "running", processed: 3, cursor_json: "null" });
    expect(movedCount(db)).toBe(3);
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

    expect((await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/step`)).status).toBe(409);
  });

  test("reset closes a window the runner opened, and only that one", async () => {
    const db = fixture(3);
    register(fixtureItem({ requiresDowntime: true }));
    await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/step`);
    expect((await getMaintenanceMode(db)).enabled).toBe(true);

    const res = await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/reset`);
    expect(res.status).toBe(200);
    expect((await getMaintenanceMode(db)).enabled).toBe(false);
    expect(
      db.raw.prepare("SELECT maintenance_owned FROM operator_data_upgrades WHERE id = ?").get(ITEM_ID),
    ).toEqual({ maintenance_owned: 0 });

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
    register({
      ...inner,
      async runBatch(dbApi, cursor, actor) {
        entered.resolve();
        await release.promise;
        return inner.runBatch(dbApi, cursor, actor);
      },
    });

    const first = api(db, "POST", `/api/data-upgrades/${ITEM_ID}/step`);
    await entered.promise;
    const second = await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/step`);
    expect(second.status).toBe(409);
    const refusal = (await second.json()) as { error: string };
    expect(refusal.error).toBe("upgrade_running");
    expect(movedCount(db)).toBe(0);

    release.resolve();
    expect((await first).status).toBe(200);
    expect(movedCount(db)).toBe(2);
    expect(await state(db)).toEqual({ status: "running", processed: 2, cursor_json: '{"offset":2}' });

    expect((await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/step`)).status).toBe(200);
    expect(movedCount(db)).toBe(3);
  });

  test("a claim taken over during the batch is refused the progress write", async () => {
    const db = fixture(3);
    const successorStamp = "2026-11-17T04:00:00.000Z";
    const inner = fixtureItem();
    register({
      ...inner,
      async runBatch(dbApi, cursor, actor) {
        const batch = await inner.runBatch(dbApi, cursor, actor);
        db.raw
          .prepare("UPDATE operator_data_upgrades SET started_at = ?, claim_token = ? WHERE id = ?")
          .run(successorStamp, "claim-successor", ITEM_ID);
        return batch;
      },
    });

    const step = await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/step`);
    expect(step.status).toBe(409);
    const refusal = (await step.json()) as { error: string };
    expect(refusal.error).toBe("upgrade_running");
    expect(db.raw.prepare("SELECT * FROM operator_data_upgrades WHERE id = ?").get(ITEM_ID)).toMatchObject({
      status: "running",
      started_at: successorStamp,
      claim_token: "claim-successor",
      processed: 0,
      cursor_json: null,
      log_json: null,
    });
    expect(
      db.raw.prepare("SELECT COUNT(*) AS n FROM platform_audit_events WHERE action = 'upgrade.step'").get(),
    ).toEqual({ n: 0 });
  });

  test("a batch that throws releases the claim, so the operator can retry", async () => {
    const db = fixture(2);
    const inner = fixtureItem();
    let failing = true;
    register({
      ...inner,
      async runBatch(dbApi, cursor, actor) {
        if (failing) throw new Error("batch exploded");
        return inner.runBatch(dbApi, cursor, actor);
      },
    });

    expect((await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/step`)).status).toBe(500);
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
      async runBatch(dbApi, cursor, actor) {
        entered.resolve();
        await release.promise;
        return inner.runBatch(dbApi, cursor, actor);
      },
    });

    const step = api(db, "POST", `/api/data-upgrades/${ITEM_ID}/step`);
    await entered.promise;
    const refused = await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/verify`);
    expect(refused.status).toBe(409);
    const refusal = (await refused.json()) as { error: string };
    expect(refusal.error).toBe("upgrade_running");
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
        return inner.verify(dbApi, { runStartedAt: null });
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
    expect(await state(db)).toEqual({ status: "verifying", processed: 1, cursor_json: "null" });
    expect(movedCount(db)).toBe(1);

    release.resolve();
    expect((await verifying).status).toBe(200);
    expect(await state(db)).toMatchObject({ status: "completed" });
  });

  test("a reset between verify's state write and its cleanup cannot take the claim", async () => {
    const db = fixture(1);
    const stamp = "2026-11-17T03:00:00.000Z";
    const token = "claim-verify";
    seedClaimedRow(db, { status: "verifying", maintenanceOwned: 1, startedAt: stamp, token });
    await setMaintenanceMode(db, { enabled: true, reason: "data upgrade: fixture", actor: OPERATOR }, stamp);

    expect(await settleVerifyState(db, ITEM_ID, "completed", null, stamp, token)).toBe("ok");
    expect(db.raw.prepare("SELECT status, started_at FROM operator_data_upgrades WHERE id = ?").get(ITEM_ID)).toEqual({
      status: "completed",
      started_at: stamp,
    });

    const reset = await resetDataUpgrade(db, fixtureItem(), OPERATOR, "2026-11-17T03:00:30.000Z");
    expect(reset.kind).toBe("refused");
    expect(
      db.raw.prepare("SELECT status, maintenance_owned, started_at FROM operator_data_upgrades WHERE id = ?").get(ITEM_ID),
    ).toEqual({ status: "completed", maintenance_owned: 1, started_at: stamp });
    expect((await getMaintenanceMode(db)).enabled).toBe(true);

    expect(await settleUpgradeMaintenance(db, ITEM_ID, "completed", OPERATOR, stamp, token)).toBe("ok");
    expect(await releaseUpgradeClaim(db, ITEM_ID, "completed", stamp, token)).toBe("ok");
    expect((await getMaintenanceMode(db)).enabled).toBe(false);
    expect(
      db.raw.prepare("SELECT maintenance_owned, started_at, claim_token FROM operator_data_upgrades WHERE id = ?").get(ITEM_ID),
    ).toEqual({ maintenance_owned: 0, started_at: null, claim_token: null });
  });

  test("a guarded cleanup that matches no row is refused and keeps maintenance ownership", async () => {
    const db = fixture(1);
    const stamp = "2026-11-17T03:00:00.000Z";
    seedClaimedRow(db, { status: "completed", maintenanceOwned: 1, startedAt: stamp, token: "claim-owner" });
    await setMaintenanceMode(db, { enabled: true, reason: "data upgrade: fixture", actor: OPERATOR }, stamp);

    expect(
      await settleUpgradeMaintenance(db, ITEM_ID, "completed", OPERATOR, stamp, "claim-other"),
    ).toBe("refused");
    expect(
      db.raw.prepare("SELECT status, maintenance_owned FROM operator_data_upgrades WHERE id = ?").get(ITEM_ID),
    ).toEqual({ status: "completed", maintenance_owned: 1 });
    expect((await getMaintenanceMode(db)).enabled).toBe(true);
  });

  test("a claim replaced under the SAME stamp cannot close the window it lost", async () => {
    const db = fixture(1);
    const stamp = "2026-11-17T03:00:00.000Z";
    seedClaimedRow(db, { status: "completed", maintenanceOwned: 1, startedAt: stamp, token: "claim-lost" });
    await setMaintenanceMode(db, { enabled: true, reason: "data upgrade: fixture", actor: OPERATOR }, stamp);

    db.raw
      .prepare("UPDATE operator_data_upgrades SET claim_token = ? WHERE id = ?")
      .run("claim-winner", ITEM_ID);

    expect(await settleUpgradeMaintenance(db, ITEM_ID, "completed", OPERATOR, stamp, "claim-lost")).toBe("refused");
    expect(await getMaintenanceMode(db)).toEqual({
      enabled: true,
      reason: "data upgrade: fixture",
      since: stamp,
      unreadable: false,
    });
    expect(
      db.raw.prepare("SELECT maintenance_owned, claim_token FROM operator_data_upgrades WHERE id = ?").get(ITEM_ID),
    ).toEqual({ maintenance_owned: 1, claim_token: "claim-winner" });
    expect(
      db.raw
        .prepare("SELECT COUNT(*) AS n FROM platform_audit_events WHERE action = 'platform.maintenance.set'")
        .get(),
    ).toEqual({ n: 1 });
    expect(await releaseUpgradeClaim(db, ITEM_ID, "completed", stamp, "claim-lost")).toBe("refused");
    expect(
      db.raw.prepare("SELECT started_at, claim_token FROM operator_data_upgrades WHERE id = ?").get(ITEM_ID),
    ).toEqual({ started_at: stamp, claim_token: "claim-winner" });
  });

  test("a lease taken over before the batch closes no window and writes no audit", async () => {
    const db = fixture(1);
    const stamp = "2026-11-17T03:00:00.000Z";
    const nextStamp = "2026-11-17T03:01:00.000Z";
    seedClaimedRow(db, { status: "completed", maintenanceOwned: 1, startedAt: stamp, token: "claim-old" });
    await setMaintenanceMode(db, { enabled: true, reason: "data upgrade: fixture", actor: OPERATOR }, stamp);

    const racing: DashboardD1 = {
      prepare: (sql) => db.prepare(sql),
      async batch(statements) {
        db.raw
          .prepare("UPDATE operator_data_upgrades SET started_at = ?, claim_token = ? WHERE id = ?")
          .run(nextStamp, "claim-new", ITEM_ID);
        return db.batch(statements);
      },
    };
    expect(await settleUpgradeMaintenance(racing, ITEM_ID, "completed", OPERATOR, stamp, "claim-old")).toBe("refused");

    const mode = await getMaintenanceMode(db);
    expect(mode).toEqual({
      enabled: true,
      reason: "data upgrade: fixture",
      since: stamp,
      unreadable: false,
    });
    expect(
      db.raw.prepare("SELECT maintenance_owned, started_at FROM operator_data_upgrades WHERE id = ?").get(ITEM_ID),
    ).toEqual({ maintenance_owned: 1, started_at: nextStamp });
    expect(
      db.raw
        .prepare("SELECT COUNT(*) AS n FROM platform_audit_events WHERE action = 'platform.maintenance.set'")
        .get(),
    ).toEqual({ n: 1 });
  });

  test("a row that no longer owns the window is settled without touching it", async () => {
    const db = fixture(1);
    const stamp = "2026-11-17T03:00:00.000Z";
    seedClaimedRow(db, { status: "completed", maintenanceOwned: 0, startedAt: stamp, token: "claim-operator" });
    await setMaintenanceMode(db, { enabled: true, reason: "planned incident", actor: OPERATOR }, stamp);

    expect(await settleUpgradeMaintenance(db, ITEM_ID, "completed", OPERATOR, stamp, "claim-operator")).toBe("ok");
    expect(await getMaintenanceMode(db)).toEqual({
      enabled: true,
      reason: "planned incident",
      since: stamp,
      unreadable: false,
    });
  });

  test("the owner closes the window and audits it once", async () => {
    const db = fixture(1);
    const stamp = "2026-11-17T03:00:00.000Z";
    seedClaimedRow(db, { status: "completed", maintenanceOwned: 1, startedAt: stamp, token: "claim-owner" });
    await setMaintenanceMode(db, { enabled: true, reason: "data upgrade: fixture", actor: OPERATOR }, stamp);

    expect(await settleUpgradeMaintenance(db, ITEM_ID, "completed", OPERATOR, stamp, "claim-owner")).toBe("ok");
    expect(await getMaintenanceMode(db)).toEqual({
      enabled: false,
      reason: null,
      since: null,
      unreadable: false,
    });
    expect(
      db.raw.prepare("SELECT maintenance_owned FROM operator_data_upgrades WHERE id = ?").get(ITEM_ID),
    ).toEqual({ maintenance_owned: 0 });
    const audits = db.raw
      .prepare(
        "SELECT actor_login, detail_json FROM platform_audit_events WHERE action = 'platform.maintenance.set' ORDER BY rowid",
      )
      .all() as Array<{ actor_login: string; detail_json: string }>;
    expect(audits.map((row) => row.actor_login)).toEqual([OPERATOR, OPERATOR]);
    expect(JSON.parse(audits[1]?.detail_json ?? "null")).toEqual({
      before: { enabled: true, reason: "data upgrade: fixture", since: stamp },
      after: { enabled: false, reason: null, since: null },
    });
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
    expect((await getMaintenanceMode(db)).enabled).toBe(false);

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

  test("reset clears the cursor, counter and claim token but keeps the migrated rows", async () => {
    const db = fixture(3);
    register(fixtureItem());
    await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/step`);
    expect(movedCount(db)).toBe(2);

    const res = await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/reset`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: { status: string; processed: number; cursor: unknown } };
    expect(body.state).toMatchObject({ status: "pending", processed: 0, cursor: null, startedAt: null });
    expect(movedCount(db)).toBe(2);
    expect(claimToken(db)).toBeNull();

    const rerun = await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/step`);
    const rerunBody = (await rerun.json()) as { batch: { processed: number } };
    expect(rerunBody.batch.processed).toBe(1);
    expect(movedCount(db)).toBe(3);
  });

  test("a step's claim carries a fresh token and releases it", async () => {
    const db = fixture(3);
    const inner = fixtureItem();
    register({
      ...inner,
      async runBatch(dbApi, cursor, actor) {
        expect(claimToken(db)).not.toBeNull();
        return inner.runBatch(dbApi, cursor, actor);
      },
    });

    await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/step`);
    expect(claimToken(db)).toBeNull();
  });
});

describe("the data-upgrade routes", () => {
  test("the list states the item, its pending state and its preflight counts", async () => {
    const db = fixture(2);
    register(fixtureItem());
    const res = await api(db, "GET", "/api/data-upgrades");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      upgrades: Array<{
        id: string;
        impact: string;
        state: { status: string };
        preflight: Record<string, number>;
      }>;
    };
    expect(body.upgrades.map((item) => item.id).sort()).toEqual([
      "fixture-upgrade",
      "ledger-target-alignment",
      "orphan-ledger-attribution",
      "repo-backfill",
      "repo-id-claim",
    ]);
    const listed = body.upgrades.find((item) => item.id === ITEM_ID)!;
    expect(listed.state.status).toBe("pending");
    expect(listed.preflight).toEqual({ pending: 2 });
    expect(listed.impact).toBe("Flips fixture flag rows. Never deletes a flag.");
    const backfill = body.upgrades.find((item) => item.id === "repo-backfill")!.impact;
    expect(backfill).not.toContain("Never deletes a ledger row.");
    expect(backfill).toContain("Never deletes reviews, findings or failures.");
    expect(body.upgrades.find((item) => item.id === "orphan-ledger-attribution")!.impact).toContain(
      "Never rewrites a row that already has one.",
    );
    expect(body.upgrades.find((item) => item.id === "ledger-target-alignment")!.impact).toContain(
      "Never deletes a ledger row",
    );
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

describe("the runner's run-start stamp", () => {
  function runStart(db: TestD1): string | null {
    const row = db.raw
      .prepare("SELECT run_started_at FROM operator_data_upgrades WHERE id = ?")
      .get(ITEM_ID) as { run_started_at: string | null } | null;
    return row?.run_started_at ?? null;
  }

  test("the first step stamps the run once and later steps keep it", async () => {
    const db = fixture(3);
    register(fixtureItem());

    expect((await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/step`)).status).toBe(200);
    const stamped = runStart(db);
    expect(stamped).not.toBeNull();

    expect((await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/step`)).status).toBe(200);
    expect(runStart(db)).toBe(stamped);
  });

  test("verify reads the run start and passes it to the item", async () => {
    const db = fixture(1);
    let seen: string | null | undefined;
    const inner = fixtureItem();
    register({
      ...inner,
      async verify(dbApi, context) {
        seen = context.runStartedAt;
        return inner.verify(dbApi, { runStartedAt: null });
      },
    });

    expect((await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/step`)).status).toBe(200);
    expect((await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/verify`)).status).toBe(200);
    expect(seen).toBe(runStart(db));
    expect(seen).not.toBeNull();
  });

  test("an advisory check never fails the item and stays in the reported checks", async () => {
    const db = fixture(1);
    register(
      fixtureItem({
        advisoryChecks: ["historical_rows"],
        verify: async () => ({ unmigrated: 0, historical_rows: 7 }),
      }),
    );

    await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/step`);
    const res = await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/verify`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { state: { status: string; lastError: string | null }; checks: Record<string, number> };
    expect(body.state.status).toBe("completed");
    expect(body.state.lastError).toBeNull();
    expect(body.checks.historical_rows).toBe(7);
  });

  test("reset keeps the run start: the item's boundary outlives the attempt", async () => {
    const db = fixture(3);
    register(fixtureItem());
    await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/step`);
    const stamped = runStart(db);
    expect(stamped).not.toBeNull();

    expect((await api(db, "POST", `/api/data-upgrades/${ITEM_ID}/reset`)).status).toBe(200);
    expect(runStart(db)).toBe(stamped);
    expect(await state(db)).toEqual({ status: "pending", processed: 0, cursor_json: null });
  });
});
