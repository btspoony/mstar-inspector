/**
 * The maintenance-deferred replay route driven through the real
 * admin mount. What is pinned:
 *
 *   - the winner writes the audit row + the request stamp in ONE batch, sends
 *     exactly the secret-free current-head payload, then stamps `sent`;
 *   - a repeated request answers 200 from the row's own stamps with no second
 *     send and no second audit row;
 *   - a send that fails leaves durable pending state and answers 202
 *     `requested`;
 *   - every refusal happens before the request batch, so it writes no state
 *     and no audit row, and uses its declared status.
 */
import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { setMaintenanceMode } from "../../src/dashboard/runtime-config-store";
import type { ReviewJobPayload } from "../../src/contracts/review-job";
import type { Env } from "../../src/worker/env";
import { createMigratedTestD1, seedBot, seedTarget, type TestD1 } from "../store/helpers";

const SESSION_SECRET = ["test", "maintenance", "replay", "secret", "32-bytes!"].join("-");
const OPERATOR = "Support-Bot";
const MEMBER = "regular-member";
const BOT_ID = "bot-replay";
const FAILURE_ID = "failure-deferred";
const TARGET_ID = "target-replay";

/** One live bot + target + the deferred failure row the route replays. */
function fixture(opts: { stage?: string; deletedTarget?: boolean } = {}): TestD1 {
  const db = createMigratedTestD1();
  const insertUser = db.raw.prepare(
    "INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES (?, ?, 'member', ?, NULL)",
  );
  insertUser.run(crypto.randomUUID(), OPERATOR, "2026-11-18T00:00:00.000Z");
  insertUser.run(crypto.randomUUID(), MEMBER, "2026-11-18T00:00:00.000Z");
  seedBot(db, BOT_ID, 9401);
  seedTarget(db, BOT_ID, { id: TARGET_ID });
  if (opts.deletedTarget === true) {
    db.raw.prepare("UPDATE review_targets SET deleted_at = ? WHERE id = ?").run("2026-11-18T01:00:00.000Z", TARGET_ID);
  }
  db.raw
    .prepare(
      `INSERT INTO review_failures
         (id, target_id, installation_id, owner, repo, pr_number, head_sha, stage, error)
       VALUES (?, ?, 777, 'acme', 'widgets', 42, 'old-head', ?, 'maintenance_window: closed')`,
    )
    .run(FAILURE_ID, TARGET_ID, opts.stage ?? "maintenance_deferred");
  return db;
}

type Sent = { payloads: ReviewJobPayload[] };

function envFor(db: TestD1, sent: Sent, opts: { failSend?: boolean; noQueue?: boolean } = {}): Env {
  const queue =
    opts.noQueue === true
      ? undefined
      : {
          send: async (payload: ReviewJobPayload) => {
            if (opts.failSend === true) throw new Error("queue is down");
            sent.payloads.push(payload);
          },
        };
  const env = {
    REVIEW_QUEUE: queue,
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} },
    DEPLOYMENT_MODE: "saas",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    PLATFORM_OPERATORS: OPERATOR.toLowerCase(),
    DB: db,
  };
  return env as unknown as Env;
}

async function replay(
  db: TestD1,
  sent: Sent,
  opts: { login?: string | null; failSend?: boolean; noQueue?: boolean; failureId?: string } = {},
): Promise<Response> {
  const headers: Record<string, string> = {};
  const login = opts.login === undefined ? OPERATOR : opts.login;
  if (login !== null) headers.Cookie = `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}`;
  return worker.fetch(
    new Request(
      `https://worker.local/_internal_admin/api/maintenance-deferred/${opts.failureId ?? FAILURE_ID}/replay`,
      { method: "POST", headers },
    ),
    envFor(db, sent, opts),
  );
}

function failureState(db: TestD1): { requested: string | null; sent: string | null; stage: string } {
  return db.raw
    .prepare(
      "SELECT maintenance_replay_requested_at AS requested, maintenance_replay_sent_at AS sent, stage FROM review_failures WHERE id = ?",
    )
    .get(FAILURE_ID) as { requested: string | null; sent: string | null; stage: string };
}

function auditCount(db: TestD1): number {
  const row = db.raw
    .prepare("SELECT COUNT(*) AS n FROM platform_audit_events WHERE action = 'maintenance.deferred.replay'")
    .get() as { n: number };
  return row.n;
}

describe("the maintenance replay route", () => {
  test("the winner sends the current-head payload, stamps requested then sent, and audits once", async () => {
    const db = fixture();
    const sent: Sent = { payloads: [] };

    const res = await replay(db, sent);
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ failureId: FAILURE_ID, state: "sent" });
    expect(sent.payloads).toEqual([
      {
        installation_id: 777,
        owner: "acme",
        repo: "widgets",
        pr_number: 42,
        head_sha: null,
        action: "maintenance_replay",
        triggered_by: "pull_request",
        botRef: { appId: BOT_ID },
        targetId: TARGET_ID,
      },
    ]);
    const state = failureState(db);
    expect(state.stage).toBe("maintenance_deferred");
    expect(state.requested).not.toBeNull();
    expect(state.sent).not.toBeNull();
    expect(auditCount(db)).toBe(1);
    expect(
      db.raw.prepare("SELECT target_type, target_id, actor_login, detail_json FROM platform_audit_events").get(),
    ).toEqual({
      target_type: "review_failure",
      target_id: FAILURE_ID,
      actor_login: OPERATOR,
      detail_json: JSON.stringify({ target_id: TARGET_ID }),
    });
    // The failure row is never deleted — it is the record of the recovery.
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM review_failures").get()).toEqual({ n: 1 });
  });

  test("a repeated request answers 200 with the row's state and sends nothing again", async () => {
    const db = fixture();
    const sent: Sent = { payloads: [] };

    expect((await replay(db, sent)).status).toBe(202);
    const repeat = await replay(db, sent);
    expect(repeat.status).toBe(200);
    expect(await repeat.json()).toEqual({ failureId: FAILURE_ID, state: "sent" });
    expect(sent.payloads).toHaveLength(1);
    expect(auditCount(db)).toBe(1);
  });

  test("a repeated request answers 200 from the row while maintenance is active or unreadable", async () => {
    const sent: Sent = { payloads: [] };

    // Sent, then the window closes: the recorded state stays observable.
    const active = fixture();
    expect((await replay(active, sent)).status).toBe(202);
    await setMaintenanceMode(active, { enabled: true, reason: "upgrade", actor: OPERATOR }, "2026-11-18T02:00:00.000Z");
    const whileActive = await replay(active, sent);
    expect(whileActive.status).toBe(200);
    expect(await whileActive.json()).toEqual({ failureId: FAILURE_ID, state: "sent" });

    // Requested-but-unsent, then the setting is unreadable: same answer.
    const unreadable = fixture();
    expect((await replay(unreadable, sent, { failSend: true })).status).toBe(202);
    unreadable.raw.exec("DROP TABLE review_runtime_settings");
    const whileUnreadable = await replay(unreadable, sent);
    expect(whileUnreadable.status).toBe(200);
    expect(await whileUnreadable.json()).toEqual({ failureId: FAILURE_ID, state: "requested" });

    expect(sent.payloads).toHaveLength(1);
    expect(auditCount(active)).toBe(1);
    expect(auditCount(unreadable)).toBe(1);
  });

  test("a send failure keeps durable pending state and answers 202 requested", async () => {
    const db = fixture();
    const sent: Sent = { payloads: [] };

    const res = await replay(db, sent, { failSend: true });
    expect(res.status).toBe(202);
    expect(await res.json()).toEqual({ failureId: FAILURE_ID, state: "requested" });
    const state = failureState(db);
    expect(state.requested).not.toBeNull();
    expect(state.sent).toBeNull();
    expect(auditCount(db)).toBe(1);

    // The retry (the sweep, here a second operator press after the send heals)
    // is answered from the pending state: no new audit, no new request.
    const retry = await replay(db, sent);
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({ failureId: FAILURE_ID, state: "requested" });
    expect(auditCount(db)).toBe(1);
  });

  test("refusals write no state and no audit row", async () => {
    const sent: Sent = { payloads: [] };
    const expectRefusal = async (
      db: TestD1,
      status: number,
      error: string,
      opts: Parameters<typeof replay>[2] = {},
    ): Promise<void> => {
      const res = await replay(db, sent, opts);
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error });
      expect(auditCount(db)).toBe(0);
      expect(failureState(db)).toMatchObject({ requested: null, sent: null });
    };

    await expectRefusal(fixture(), 404, "unknown_failure", { failureId: "no-such-failure" });
    await expectRefusal(fixture({ stage: "runner" }), 409, "not_maintenance_deferred");
    await expectRefusal(fixture({ deletedTarget: true }), 409, "target_unavailable");
    await expectRefusal(fixture(), 503, "queue_unavailable", { noQueue: true });

    const closed = fixture();
    await setMaintenanceMode(closed, { enabled: true, reason: "upgrade", actor: OPERATOR }, "2026-11-18T02:00:00.000Z");
    await expectRefusal(closed, 409, "maintenance_active");

    // A non-operator sees the indistinguishable 404 the namespace answers
    // every outsider — never a distinguishable refusal.
    const outsider = fixture();
    const res = await replay(outsider, sent, { login: MEMBER });
    expect(res.status).toBe(404);
    expect(auditCount(outsider)).toBe(0);
  });

  test("an unreadable maintenance window refuses 503 rather than replaying", async () => {
    const db = fixture();
    // No settings table at all: the window cannot be read, so the route must
    // not treat the outage as an open window.
    db.raw.exec("DROP TABLE review_runtime_settings");
    const sent: Sent = { payloads: [] };
    const res = await replay(db, sent);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: "maintenance_unreadable" });
    expect(sent.payloads).toHaveLength(0);
    expect(auditCount(db)).toBe(0);
  });
});
