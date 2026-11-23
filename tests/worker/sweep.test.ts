
import { describe, expect, jest, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { getSweepSettings, setSweepSettings } from "../../src/dashboard/runtime-config-store";
import {
  createFailureStore,
  QUEUE_MAX_ATTEMPTS,
  type ReviewFailureInput,
} from "../../src/store/failure-store";
import type { D1Like, D1StatementLike } from "../../src/store/types";
import {
  ALERT_MAINTENANCE_AUDIT_ACTION,
  ALERT_PAGING_AUDIT_ACTION,
  runSweep,
  type SweepAlertFields,
  type SweepCommentClaimFields,
  type SweepDeps,
  type SweepInviteLapseFields,
  type SweepLog,
  type SweepMaintenanceReplayFields,
  type SweepRetentionFields,
  type SweepLedgerRetentionFields,
  type SweepWarnFields,
} from "../../src/worker/sweep";
import {
  COMMENT_CLAIM_ATTEMPTS_DEFAULT,
  COMMENT_CLAIM_OUTBOX_DEFAULT,
  COMMENT_CLAIM_RETRY_DEFAULT,
  type CommentClaimSettingsLogFields,
} from "../../src/pipeline/comment-claim-settings-reader";
import { createMigratedTestD1, seedBot, seedTarget, type TestD1 } from "../store/helpers";

const SWEEP_FAILURE_THRESHOLD = QUEUE_MAX_ATTEMPTS + 1;
const SWEEP_INVITE_LAPSE_CAP = 500;
const SWEEP_WINDOW_HOURS = 24;
const SWEEP_OVERRIDE = {
  failureThreshold: 2,
  windowHours: 6,
  webhookTimeoutMs: 250,
  retentionDays: 60,
  retentionCap: 1,
  inviteLapseCap: 2,
};

function failureDb(): TestD1 {
  const db = createMigratedTestD1();
  seedBot(db, "bot-sweep", 9301);
  seedTarget(db, "bot-sweep", { id: BASE.target_id });
  return db;
}

const BASE = {
  target_id: "target-sweep",
  installation_id: 123,
  owner: "acme",
  repo: "widgets",
  pr_number: 42,
  head_sha: "0123456789abcdef0123456789abcdef01234567",
};

const failureRow = (stage: ReviewFailureInput["stage"], error: string): ReviewFailureInput => ({
  ...BASE,
  stage,
  code: "review.internal.unclassified",
  message: "the review did not complete",
  error,
});

type WarnCall = {
  fields:
    | SweepAlertFields
    | SweepWarnFields
    | SweepRetentionFields
    | SweepLedgerRetentionFields
    | SweepInviteLapseFields
    | SweepCommentClaimFields
    | SweepMaintenanceReplayFields
    | CommentClaimSettingsLogFields;
  msg?: string;
};

function captureLog(): { log: SweepLog; calls: WarnCall[] } {
  const calls: WarnCall[] = [];
  return { log: { warn: (fields, msg) => void calls.push({ fields, msg }) }, calls };
}

async function seedInWindow(db: D1Like, count: number): Promise<void> {
  const store = createFailureStore(db);
  for (let i = 0; i < count; i++) {
    await store.record(failureRow("runner", `boom-${i}`));
  }
}

function seedOutsideWindow(db: D1Like & { raw: Database }): void {
  db.raw
    .query(
      `INSERT INTO review_failures (id, installation_id, owner, repo, pr_number, head_sha, stage, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pipeline', 'old boom', datetime('now', '-25 hours'))`,
    )
    .run(crypto.randomUUID(), BASE.installation_id, BASE.owner, BASE.repo, BASE.pr_number, BASE.head_sha);
}

function recordingDb(captured: string[], bindings: Map<string, unknown[]>): D1Like {
  return {
    prepare(query: string): D1StatementLike {
      captured.push(query);
      const stmt: D1StatementLike = {
        bind(...values: unknown[]): D1StatementLike {
          bindings.set(query, values);
          return stmt;
        },
        async first<T = Record<string, unknown>>(): Promise<T | null> {
          return null;
        },
        async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
          return { results: [] as T[] };
        },
        async run<T = Record<string, unknown>>(): Promise<{
          results: T[];
          meta: { changes: number; last_row_id: number };
        }> {
          return { results: [] as T[], meta: { changes: 0, last_row_id: 0 } };
        },
      };
      return stmt;
    },
    async batch(): Promise<[]> {
      return [];
    },
  };
}

describe("runSweep", () => {
  test("absent rows preserve the existing cron defaults", async () => {
    expect(await getSweepSettings(failureDb())).toEqual({
      issue: null,
      values: {
        failureThreshold: QUEUE_MAX_ATTEMPTS + 1,
        windowHours: 24,
        webhookTimeoutMs: 3_000,
        retentionDays: 30,
        retentionCap: 500,
        inviteLapseCap: 500,
      },
    });
  });

  test("only one settings read supplies the default window to both alert lanes", async () => {
    const captured: string[] = [];
    const bindings = new Map<string, unknown[]>();
    const unexpectedQueueCall = () => { throw new Error("Unexpected queue call"); };
    const result = await runSweep(recordingDb(captured, bindings), {
      queue: { send: unexpectedQueueCall, sendBatch: unexpectedQueueCall, metrics: unexpectedQueueCall },
    });
    expect(captured.filter((query) =>
      query.includes("FROM review_runtime_settings") &&
      bindings.get(query)?.some((value) => typeof value === "string" && value.startsWith("platform.sweep.")),
    )).toHaveLength(1);
    const deliveryDelete = captured.find((query) => query.includes("DELETE FROM webhook_deliveries"));
    expect(bindings.get(deliveryDelete!)).toEqual(["-30 days", 500]);
    const countAt = captured.findIndex((query) => query.includes("GROUP BY stage"));
    expect(bindings.get(captured[countAt]!)).toEqual(["-24 hours"]);
    expect(captured[countAt + 1]).toContain("stage = 'maintenance_deferred'");
    expect(bindings.get(captured[countAt + 1]!)).toEqual(["-24 hours"]);
    expect(captured).toHaveLength(countAt + 2);
    expect(result).toEqual({
      failures24h: 0,
      thresholdBreached: false,
      invitesExpired: 0,
      webhook: "not_attempted",
    });
  });
  test("flips lapsed pending invites in every workspace in one run, and flips none on the second", async () => {
    const db = failureDb();
    db.raw
      .query(`INSERT INTO workspaces (id, slug, name, created_by, created_at, deleted_at)
              VALUES ('ws-2', 'ws-2', 'Second', NULL, '2026-10-21T00:00:00.000Z', NULL)`)
      .run();
    const insert = (id: string, workspaceId: string, expiresAt: string): void => {
      db.raw
        .prepare(
          `INSERT INTO workspace_invites
             (id, workspace_id, github_login, role, status, invited_by,
              created_at, expires_at, accepted_at)
           VALUES (?, ?, ?, 'member', 'pending', NULL, ?, ?, NULL)`,
        )
        .run(id, workspaceId, id, new Date().toISOString(), expiresAt);
    };
    const lapsed = new Date(Date.now() - 60_000).toISOString();
    insert("lapsed-default", "default", lapsed);
    insert("lapsed-ws-2", "ws-2", lapsed);

    const { log, calls } = captureLog();
    const first = await runSweep(db, { log });
    expect(db.raw.query("SELECT id, status FROM workspace_invites ORDER BY id").all()).toEqual([
      { id: "lapsed-default", status: "expired" },
      { id: "lapsed-ws-2", status: "expired" },
    ]);
    expect(first.invitesExpired).toBe(2);

    const second = await runSweep(db, { log });
    expect(second.invitesExpired).toBe(0);
    expect(db.raw.query("SELECT id, status FROM workspace_invites ORDER BY id").all()).toEqual([
      { id: "lapsed-default", status: "expired" },
      { id: "lapsed-ws-2", status: "expired" },
    ]);
    expect(calls).toHaveLength(0);
    expect(first).toEqual({
      failures24h: 0,
      thresholdBreached: false,
      invitesExpired: 2,
      webhook: "not_attempted",
    });
  });

  test.each([null, SWEEP_OVERRIDE])("an invite backlog drains across successive runs (settings %j)", async (settings) => {
    const db = failureDb();
    if (settings) await setSweepSettings(db, settings, "operator");
    const cap = settings?.inviteLapseCap ?? SWEEP_INVITE_LAPSE_CAP;
    db.raw
      .query(`INSERT INTO workspaces (id, slug, name, created_by, created_at, deleted_at)
              VALUES ('ws-2', 'ws-2', 'Second', NULL, '2026-10-21T00:00:00.000Z', NULL)`)
      .run();
    const lapsed = new Date(Date.now() - 60_000).toISOString();
    const live = new Date(Date.now() + 60_000).toISOString();
    const insert = db.raw.prepare(
      `INSERT INTO workspace_invites
         (id, workspace_id, github_login, role, status, invited_by,
          created_at, expires_at, accepted_at)
       VALUES (?, ?, ?, 'member', ?, NULL, ?, ?, NULL)`,
    );
    const backlog = cap + 2;
    for (let i = 0; i < backlog; i++) {
      insert.run(`lapsed-${i}`, i % 2 === 0 ? "default" : "ws-2", `lapsed-${i}`, "pending", lapsed, lapsed);
    }
    insert.run("live", "default", "live", "pending", live, live);
    insert.run("accepted", "ws-2", "accepted", "accepted", lapsed, lapsed);

    const { log, calls } = captureLog();
    const first = await runSweep(db, { log });
    expect(first.invitesExpired).toBe(cap);
    const pendingAfterFirst = db.raw
      .query("SELECT COUNT(*) AS n FROM workspace_invites WHERE status = 'pending' AND expires_at <= ?")
      .get(lapsed) as { n: number };
    expect(pendingAfterFirst.n).toBe(backlog - cap);

    const second = await runSweep(db, { log });
    expect(second.invitesExpired).toBe(backlog - cap);
    const third = await runSweep(db, { log });
    expect(third.invitesExpired).toBe(0);

    const rows = db.raw.query("SELECT status, COUNT(*) AS n FROM workspace_invites GROUP BY status").all() as Array<{
      status: string;
      n: number;
    }>;
    expect(Object.fromEntries(rows.map((row) => [row.status, row.n]))).toEqual({
      expired: backlog,
      pending: 1,
      accepted: 1,
    });
    expect(db.raw.query("SELECT id FROM workspace_invites WHERE id = 'live' AND status = 'pending'").all()).toHaveLength(1);
    expect(calls).toHaveLength(0);
  });

  test("a continuously-fed backlog still serves the OLDEST lapsed row first (no starvation)", async () => {
    const db = failureDb();
    const insert = db.raw.prepare(
      `INSERT INTO workspace_invites
         (id, workspace_id, github_login, role, status, invited_by,
          created_at, expires_at, accepted_at)
       VALUES (?, 'default', ?, 'member', 'pending', NULL, ?, ?, NULL)`,
    );
    const ago = (minutes: number): string => new Date(Date.now() - minutes * 60_000).toISOString();
    const oldestExpiry = ago(10 * 24 * 60);
    insert.run("oldest", "zzz-oldest", oldestExpiry, oldestExpiry);
    const feed = (generation: number, minutesAgo: number): void => {
      const expiry = ago(minutesAgo);
      for (let i = 0; i < SWEEP_INVITE_LAPSE_CAP; i++) {
        insert.run(`g${generation}-${String(i).padStart(4, "0")}`, `aaa-${generation}-${String(i).padStart(4, "0")}`, expiry, expiry);
      }
    };

    feed(1, 5);
    const expired = (): Array<{ id: string }> =>
      db.raw.query("SELECT id FROM workspace_invites WHERE status = 'expired' ORDER BY expires_at, id").all() as Array<{
        id: string;
      }>;
    const lapsedPending = (): number =>
      (db.raw.query("SELECT COUNT(*) AS n FROM workspace_invites WHERE status = 'pending'").get() as { n: number }).n;

    const first = await runSweep(db, { log: captureLog().log });
    expect(first.invitesExpired).toBe(SWEEP_INVITE_LAPSE_CAP);
    expect(expired().slice(0, 2)).toEqual([{ id: "oldest" }, { id: "g1-0000" }]);
    expect(expired()).toHaveLength(SWEEP_INVITE_LAPSE_CAP);
    expect(lapsedPending()).toBe(1);

    feed(2, 3);
    const second = await runSweep(db, { log: captureLog().log });
    expect(second.invitesExpired).toBe(SWEEP_INVITE_LAPSE_CAP);
    expect(expired()).toContainEqual({ id: "g1-0499" });

    feed(3, 1);
    await runSweep(db, { log: captureLog().log });
    expect(lapsedPending()).toBeLessThanOrEqual(SWEEP_INVITE_LAPSE_CAP);
    expect(lapsedPending()).toBeGreaterThan(0);

    let drained = 0;
    for (let run = 0; run < 4; run++) drained += (await runSweep(db, { log: captureLog().log })).invitesExpired ?? 0;
    expect(drained).toBeGreaterThan(0);
    expect(lapsedPending()).toBe(0);
    expect(db.raw.query("SELECT status FROM workspace_invites WHERE id = 'oldest'").get()).toEqual({
      status: "expired",
    });
  });

  test("leaves a live pending invite untouched (real D1)", async () => {
    const db = failureDb();
    db.raw
      .prepare(
        `INSERT INTO workspace_invites
           (id, workspace_id, github_login, role, status, invited_by,
            created_at, expires_at, accepted_at)
         VALUES ('live', 'default', 'live', 'member', 'pending', NULL, ?, ?, NULL)`,
      )
      .run(new Date().toISOString(), new Date(Date.now() + 60_000).toISOString());

    const result = await runSweep(db, { log: captureLog().log });
    expect(db.raw.query("SELECT id, status FROM workspace_invites").all()).toEqual([
      { id: "live", status: "pending" },
    ]);
    expect(result.invitesExpired).toBe(0);
  });

  test("the invite lapse failure degrades to a warn and the failure-sweep still runs", async () => {
    const db = failureDb();
    await seedInWindow(db, SWEEP_FAILURE_THRESHOLD + 1);
    const { log, calls } = captureLog();
    const wrapped: D1Like = {
      prepare(query: string): D1StatementLike {
        if (query.includes("UPDATE workspace_invites")) throw new Error("invites locked");
        return db.prepare(query);
      },
      batch: (statements) => db.batch(statements),
    };
    const result = await runSweep(wrapped, { log });
    expect(calls[0]!.fields).toMatchObject({
      event: "invite_lapse_swept_failed",
      detail: "invites locked",
    });
    expect(calls[1]!.fields).toMatchObject({ event: "ops_sweep_alert", failures_24h: SWEEP_FAILURE_THRESHOLD + 1 });
    expect(result).toEqual({
      failures24h: SWEEP_FAILURE_THRESHOLD + 1,
      thresholdBreached: true,
      invitesExpired: null,
      webhook: "absent",
    });
  });
  test("retention_swept log carries the deleted count", async () => {
    const db: D1Like = {
      prepare(): D1StatementLike {
        const stmt: D1StatementLike = {
          bind(): D1StatementLike {
            return stmt;
          },
          async first<T = Record<string, unknown>>(): Promise<T | null> {
            return null;
          },
          async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
            return { results: [] as T[] };
          },
          async run<T = Record<string, unknown>>(): Promise<{
            results: T[];
            meta: { changes: number; last_row_id: number };
          }> {
            return { results: [] as T[], meta: { changes: 3, last_row_id: 0 } };
          },
        };
        return stmt;
      },
      async batch(): Promise<[]> {
        return [];
      },
    };
    const { log, calls } = captureLog();
    const result = await runSweep(db, { log });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.fields).toEqual({ event: "retention_swept", deleted: 3 });
    expect(calls[1]!.fields).toEqual({ event: "pull_request_retention_swept", deleted: 3 });
    expect(result).toEqual({
      failures24h: 0,
      thresholdBreached: false,
      invitesExpired: 3,
      webhook: "not_attempted",
    });
  });

  test("seeks the retention cutoff and latest alert by action (EXPLAIN QUERY PLAN)", async () => {
    const db = failureDb();
    const { values: settings } = await getSweepSettings(db);
    await seedInWindow(db, SWEEP_FAILURE_THRESHOLD + 1);
    const captured: string[] = [];
    const { log } = captureLog();
    await runSweep({
      ...db,
      prepare(sql) {
        captured.push(sql);
        return db.prepare(sql);
      },
    }, { log });

    const retentionSql = captured.find((sql) => sql.includes("DELETE FROM webhook_deliveries"));
    const alertSql = captured.find((sql) => sql.includes("FROM platform_audit_events"));
    expect(retentionSql).toBeDefined();
    expect(alertSql).toBeDefined();

    const retentionPlan = db.raw
      .query<{ detail: string }, [string, number]>(`EXPLAIN QUERY PLAN ${retentionSql}`)
      .all(`-${settings.retentionDays} days`, settings.retentionCap);
    const alertPlan = db.raw
      .query<{ detail: string }, [string]>(`EXPLAIN QUERY PLAN ${alertSql}`)
      .all(ALERT_PAGING_AUDIT_ACTION);
    expect(retentionPlan.map(({ detail }) => detail).join("\n")).toMatch(
      /SEARCH webhook_deliveries .*idx_webhook_deliveries_created \(created_at</,
    );
    expect(alertPlan.map(({ detail }) => detail).join("\n")).toMatch(
      /SEARCH platform_audit_events .*platform_audit_events_action_created \(action=\?/,
    );
  });

  test.each([
    { settings: null, middleAgeKept: false, oldCount: 0 },
    { settings: SWEEP_OVERRIDE, middleAgeKept: true, oldCount: 1 },
  ])("delivery cleanup applies retention days and row cap ($settings)", async ({ settings, middleAgeKept, oldCount }) => {
    const db = failureDb();
    if (settings) await setSweepSettings(db, settings, "operator");
    db.raw
      .query(
        `INSERT INTO review_bots (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc, created_by, created_at, updated_at)
         VALUES ('app-1', 'retention-app', 9001, 'retention-app', 'enc', 'enc', 'tester', datetime('now'), datetime('now'))`,
      )
      .run();
    const insertDelivery = (id: string, ageDays: number): void => {
      db.raw
        .query(
          `INSERT INTO webhook_deliveries (id, bot_id, event_name, outcome, created_at)
           VALUES (?, 'app-1', 'pull_request', 'ok', datetime('now', ?))`,
        )
        .run(id, `-${ageDays} days`);
    };
    insertDelivery("old-1", 61);
    insertDelivery("old-2", 62);
    insertDelivery("middle", 31);
    insertDelivery("fresh", 1);
    const { log } = captureLog();
    const result = await runSweep(db, { log });
    const remaining = db.raw.query("SELECT id FROM webhook_deliveries ORDER BY id").all() as Array<{ id: string }>;
    const ids = remaining.map((row) => row.id);
    expect(ids).toContain("fresh");
    expect(ids.includes("middle")).toBe(middleAgeKept);
    expect(ids.filter((id) => id.startsWith("old-"))).toHaveLength(oldCount);
    expect(result).toEqual({
      failures24h: 0,
      thresholdBreached: false,
      invitesExpired: 0,
      webhook: "not_attempted",
    });
  });

  test("PR-ledger retention drops only TERMINAL rows older than the window", async () => {
    const db = failureDb();
    db.raw
      .query(
        `INSERT INTO review_bots (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc, created_by, created_at, updated_at)
         VALUES ('app-1', 'ledger-app', 9001, 'ledger-app', 'enc', 'enc', 'tester', datetime('now'), datetime('now'))`,
      )
      .run();
    const insertPr = (id: string, number: number, state: string, ageDays: number): void => {
      db.raw
        .query(
          `INSERT INTO pull_requests (id, bot_id, owner, repo, pr_number, state, last_seen_at)
           VALUES (?, 'app-1', 'acme', 'widgets', ?, ?, datetime('now', ?))`,
        )
        .run(id, number, state, `-${ageDays} days`);
    };
    insertPr("pr-merged-old", 1, "merged", 120);
    insertPr("pr-closed-old", 2, "closed", 91);
    insertPr("pr-open-old", 3, "open", 120);
    insertPr("pr-merged-fresh", 4, "merged", 1);

    const { log, calls } = captureLog();
    await runSweep(db, { log });
    const remaining = db.raw
      .query("SELECT id FROM pull_requests ORDER BY id")
      .all() as Array<{ id: string }>;
    expect(remaining.map((row) => row.id)).toEqual(["pr-merged-fresh", "pr-open-old"]);
    expect(calls[0]!.fields).toEqual({ event: "pull_request_retention_swept", deleted: 2 });
  });

  test("retention failure degrades to a warn and the failure-sweep still runs (breach alert fires)", async () => {
    const db = failureDb();
    await seedInWindow(db, SWEEP_FAILURE_THRESHOLD + 1);
    const { log, calls } = captureLog();
    const wrapped: D1Like = {
      prepare(query: string): D1StatementLike {
        if (query.includes("DELETE FROM webhook_deliveries")) {
          throw new Error("retention table locked");
        }
        return db.prepare(query);
      },
      batch: (statements) => db.batch(statements),
    };
    const result = await runSweep(wrapped, { log });
    expect(calls[0]!.fields).toMatchObject({ event: "retention_swept_failed", detail: "retention table locked" });
    expect(calls[1]!.fields).toMatchObject({ event: "ops_sweep_alert", failures_24h: SWEEP_FAILURE_THRESHOLD + 1 });
    expect(result).toEqual({
      failures24h: SWEEP_FAILURE_THRESHOLD + 1,
      thresholdBreached: true,
      invitesExpired: 0,
      webhook: "absent",
    });
  });

  test("corrupt settings cannot delete deliveries using a fallback retention policy", async () => {
    const db = failureDb();
    await setSweepSettings(db, SWEEP_OVERRIDE, "operator");
    db.raw.run("UPDATE review_runtime_settings SET value = 'bad' WHERE key = 'platform.sweep.retention_days'");
    db.raw.run(`INSERT INTO webhook_deliveries (id, bot_id, event_name, outcome, created_at)
                VALUES ('delivery', 'bot-sweep', 'pull_request', 'ok', datetime('now', '-31 days'))`);
    await seedInWindow(db, 3);
    const { log, calls } = captureLog();
    expect(await runSweep(db, { log })).toMatchObject({ failures24h: 3, thresholdBreached: true });
    expect(calls[0]?.fields).toEqual({
      event: "ops_sweep_settings_unreadable",
      detail: "platform.sweep.retention_days",
    });
    expect(calls[0]?.msg).toContain("Invalid settings rows; webhook retention skipped");
    expect(db.raw.query("SELECT id FROM webhook_deliveries").get()).toEqual({ id: "delivery" });
  });

  test("a failed settings read reports the redacted D1 error and skips webhook retention", async () => {
    const db = failureDb();
    db.raw.run(`INSERT INTO webhook_deliveries (id, bot_id, event_name, outcome, created_at)
                VALUES ('delivery', 'bot-sweep', 'pull_request', 'ok', datetime('now', '-31 days'))`);
    const alertUrl = "https://ops.example/local-alert";
    const wrapped: D1Like = {
      prepare(query: string): D1StatementLike {
        if (query.includes("FROM review_runtime_settings")) throw new Error(`database unavailable: ${alertUrl}`);
        return db.prepare(query);
      },
      batch: (statements) => db.batch(statements),
    };
    const { log, calls } = captureLog();
    await runSweep(wrapped, { log, alertUrl });
    expect(calls[0]?.fields).toEqual({
      event: "ops_sweep_settings_unreadable",
      detail: "database unavailable: [REDACTED]",
    });
    expect(calls[0]?.msg).toContain("D1 settings read failed; webhook retention skipped");
    expect(db.raw.query("SELECT id FROM webhook_deliveries").get()).toEqual({ id: "delivery" });
  });

  test("counts only in-window rows, across the infra-failure stages (parse + runner/sandbox/pipeline)", async () => {
    const db = failureDb();
    const store = createFailureStore(db);
    for (const stage of ["parse", "runner", "sandbox", "pipeline"] as const) {
      await store.record(failureRow(stage, `boom-${stage}`));
    }
    seedOutsideWindow(db);

    const result = await runSweep(db, { log: captureLog().log });
    expect(result.failures24h).toBe(4);
    expect(result.thresholdBreached).toBe(false);
  });

  for (const stage of ["recheck", "usage", "rate-limit"] as const) {
    test(`${stage} rows never page ops; a runner row still counts`, async () => {
      const db = failureDb();
      const store = createFailureStore(db);
      for (let i = 0; i < 6; i++) {
        await store.record(failureRow(stage, `degraded-${i}`));
      }
      const { log, calls } = captureLog();
      const quiet = await runSweep(db, { log });
      expect(quiet.failures24h).toBe(0);
      expect(quiet.thresholdBreached).toBe(false);
      expect(calls).toHaveLength(0);
      expect(db.raw.query("SELECT COUNT(*) AS n FROM review_failures").get()).toEqual({ n: 6 });

      await store.record(failureRow("runner", "boom"));
      const counted = await runSweep(db, { log: captureLog().log });
      expect(counted.failures24h).toBe(1);
      expect(counted.thresholdBreached).toBe(false);
    });
  }

  test("a quota refusal does not page ops while a sandbox failure does, and the breakdown names it", async () => {
    const db = failureDb();
    const store = createFailureStore(db);
    await store.record(failureRow("quota", "quota exceeded"));
    await store.record(failureRow("sandbox", "container acquisition failed"));

    const { log, calls } = captureLog();
    const quiet = await runSweep(db, { log });
    expect(quiet).toEqual({
      failures24h: 1,
      thresholdBreached: false,
      invitesExpired: 0,
      webhook: "not_attempted",
    });
    expect(calls).toHaveLength(0);
    expect(db.raw.query("SELECT COUNT(*) AS n FROM review_failures").get()).toEqual({ n: 2 });

    for (let i = 0; i < SWEEP_FAILURE_THRESHOLD; i++) {
      await store.record(failureRow("sandbox", `boom-${i}`));
    }
    const { log: breachLog, calls: breachCalls } = captureLog();
    await runSweep(db, { log: breachLog });
    const alert = breachCalls[0]!.fields as SweepAlertFields;
    expect(alert.failures_24h).toBe(SWEEP_FAILURE_THRESHOLD + 1);
    expect(alert.stages).toEqual([{ stage: "sandbox", count: SWEEP_FAILURE_THRESHOLD + 1 }]);
  });

  test("quota rows re-enter the pager when the window refuses more than one workspace", async () => {
    const db = failureDb();
    db.raw
      .prepare(
        `INSERT INTO workspaces (id, slug, name, created_by, created_at, deleted_at)
         VALUES ('ws-two', 'ws-two', 'Second', NULL, datetime('now'), NULL)`,
      )
      .run();
    seedTarget(db, "bot-sweep", { id: "target-sweep-two", workspaceId: "ws-two" });
    const store = createFailureStore(db);
    for (let i = 0; i < 4; i++) {
      await store.record(failureRow("quota", `quota-a-${i}`));
      await store.record({
        ...BASE,
        target_id: "target-sweep-two",
        stage: "quota",
        code: "review.internal.unclassified",
        message: "the review did not complete",
        error: `quota-b-${i}`,
      });
    }

    const { log, calls } = captureLog();
    const result = await runSweep(db, { log });
    expect(result.failures24h).toBe(8);
    expect(result.thresholdBreached).toBe(true);
    const alert = calls[0]!.fields as SweepAlertFields;
    expect(alert.failures_24h).toBe(8);
    expect(alert.stages).toEqual([{ stage: "quota", count: 8 }]);
    expect(alert.due).toEqual(["infrastructure"]);
  });

  test("the payload's stages preserve the query's ordered, non-empty stage groups", async () => {
    const db = failureDb();
    const store = createFailureStore(db);
    for (let i = 0; i < 5; i++) {
      await store.record(failureRow("sandbox", `sandbox-${i}`));
    }
    for (let i = 0; i < 3; i++) {
      await store.record(failureRow("parse", `parse-${i}`));
    }
    await store.record(failureRow("quota", "quota exceeded"));

    const { log, calls } = captureLog();
    await runSweep(db, { log });
    const alert = calls[0]!.fields as SweepAlertFields;
    expect(alert.failures_24h).toBe(8);
    expect(alert.stages).toEqual([
      { stage: "parse", count: 3 },
      { stage: "sandbox", count: 5 },
    ]);
  });

  test("a maintenance_deferred row is a separate existence signal, never part of the infrastructure total", async () => {
    const db = failureDb();
    const store = createFailureStore(db);
    await store.record(failureRow("maintenance_deferred", "maintenance_window"));
    await store.record(failureRow("sandbox", "container acquisition failed"));

    const { log, calls } = captureLog();
    const result = await runSweep(db, { log });
    expect(result.failures24h).toBe(1);
    const alert = calls[0]!.fields as SweepAlertFields;
    expect(alert.failures_24h).toBe(1);
    expect(alert.stages).toEqual([{ stage: "sandbox", count: 1 }]);
    expect(alert.maintenance_deferred).toEqual({ count: 1 });
    expect(alert.due).toEqual(["maintenance"]);
    expect(db.raw.query("SELECT COUNT(*) AS n FROM review_failures").get()).toEqual({ n: 2 });
  });

  test("a maintenance_deferred row rides the breach payload under its own key, leaving the total alone", async () => {
    const db = failureDb();
    const store = createFailureStore(db);
    await store.record(failureRow("maintenance_deferred", "maintenance_window"));
    await seedInWindow(db, SWEEP_FAILURE_THRESHOLD + 1);

    const { log, calls } = captureLog();
    const result = await runSweep(db, { log });
    expect(result.failures24h).toBe(SWEEP_FAILURE_THRESHOLD + 1);
    expect(result.thresholdBreached).toBe(true);
    const alert = calls[0]!.fields as SweepAlertFields;
    expect(alert.maintenance_deferred).toEqual({ count: 1 });
    expect(alert.due).toEqual(["infrastructure", "maintenance"]);
    expect(alert.failures_24h).toBe(SWEEP_FAILURE_THRESHOLD + 1);
    expect(alert.stages).toEqual([{ stage: "runner", count: SWEEP_FAILURE_THRESHOLD + 1 }]);
  });

  test("threshold boundary: ONE fully-failed message's rows do not alert", async () => {
    const db = failureDb();
    await seedInWindow(db, QUEUE_MAX_ATTEMPTS);
    const { log, calls } = captureLog();

    const result = await runSweep(db, { log });
    expect(result).toEqual({
      failures24h: QUEUE_MAX_ATTEMPTS,
      thresholdBreached: false,
      invitesExpired: 0,
      webhook: "not_attempted",
    });
    expect(calls).toHaveLength(0);
  });

  test("breach (one row past the threshold) emits the ops_sweep_alert event; absent webhook = log-only", async () => {
    const db = failureDb();
    await seedInWindow(db, SWEEP_FAILURE_THRESHOLD + 1);
    const { log, calls } = captureLog();
    const fetchImpl = mock(() => Promise.resolve(new Response("ok")));

    const result = await runSweep(db, { log, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result).toEqual({
      failures24h: SWEEP_FAILURE_THRESHOLD + 1,
      thresholdBreached: true,
      invitesExpired: 0,
      webhook: "absent",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.fields).toEqual({
      event: "ops_sweep_alert",
      failures_24h: SWEEP_FAILURE_THRESHOLD + 1,
      dlq_check: "skipped",
      thresholds: { failures_24h: SWEEP_FAILURE_THRESHOLD, window_hours: 24 },
      stages: [{ stage: "runner", count: SWEEP_FAILURE_THRESHOLD + 1 }],
      due: ["infrastructure"],
    });
  });

  test("breach with webhook POSTs the alert payload as JSON with a timeout signal", async () => {
    const db = failureDb();
    await seedInWindow(db, SWEEP_FAILURE_THRESHOLD + 1);
    const { log } = captureLog();
    const seen: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = (async (url: unknown, init?: RequestInit) => {
      seen.push({ url: String(url), init });
      return new Response("ok");
    }) as unknown as typeof fetch;

    const result = await runSweep(db, { alertUrl: "https://ops.example/hook", fetchImpl, log });
    expect(result.webhook).toBe("posted");
    expect(seen).toHaveLength(1);
    expect(seen[0]!.url).toBe("https://ops.example/hook");
    expect(seen[0]!.init?.method).toBe("POST");
    expect((seen[0]!.init?.headers as Record<string, string>)["content-type"]).toBe("application/json");
    expect(seen[0]!.init?.signal).toBeInstanceOf(AbortSignal);
    expect(JSON.parse(String(seen[0]!.init?.body))).toEqual({
      event: "ops_sweep_alert",
      failures_24h: SWEEP_FAILURE_THRESHOLD + 1,
      dlq_check: "skipped",
      thresholds: { failures_24h: SWEEP_FAILURE_THRESHOLD, window_hours: 24 },
      stages: [{ stage: "runner", count: SWEEP_FAILURE_THRESHOLD + 1 }],
      due: ["infrastructure"],
    });
  });

  test("webhook failure degrades to a warn log and never throws", async () => {
    const db = failureDb();
    await seedInWindow(db, SWEEP_FAILURE_THRESHOLD + 1);
    const { log, calls } = captureLog();
    const fetchImpl = (async () => {
      throw new Error("sink unreachable");
    }) as unknown as typeof fetch;

    const result = await runSweep(db, { alertUrl: "https://ops.example/hook", fetchImpl, log });
    expect(result.webhook).toBe("failed");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.fields).toMatchObject({ event: "ops_sweep_alert" });
    expect(calls[1]!.fields).toMatchObject({ event: "ops_sweep_alert_webhook_failed", detail: "sink unreachable" });
  });

  test("webhook non-2xx response is NOT posted — warn + failed disposition (qc W-2/F-001)", async () => {
    const db = failureDb();
    await seedInWindow(db, SWEEP_FAILURE_THRESHOLD + 1);
    const { log, calls } = captureLog();
    const fetchImpl = (async () => new Response("sink degraded", { status: 503 })) as unknown as typeof fetch;

    const result = await runSweep(db, { alertUrl: "https://ops.example/hook", fetchImpl, log });
    expect(result.webhook).toBe("failed");
    expect(calls).toHaveLength(2);
    expect(calls[0]!.fields).toMatchObject({ event: "ops_sweep_alert" });
    expect(calls[1]!.fields).toMatchObject({ event: "ops_sweep_alert_webhook_failed" });
    expect((calls[1]!.fields as SweepWarnFields).detail).toContain("503");
  });

  test("the configured alertUrl is exact-string-redacted from the failure detail (SEC-02)", async () => {
    const db = failureDb();
    await seedInWindow(db, SWEEP_FAILURE_THRESHOLD + 1);
    const { log, calls } = captureLog();
    const url = "https://ops.example/hook?token=abc123";
    const fetchImpl = (async () => {
      throw new Error(`request to ${url} failed: connection refused`);
    }) as unknown as typeof fetch;

    const result = await runSweep(db, { alertUrl: url, fetchImpl, log });
    expect(result.webhook).toBe("failed");
    const detail = (calls[1]!.fields as SweepWarnFields).detail;
    expect(detail).not.toContain(url);
    expect(detail).toContain("[REDACTED]");
  });

  test("D1 errors propagate to the caller (the scheduled handler owns the catch-all)", async () => {
    const broken: D1Like = {
      prepare(): D1StatementLike {
        throw new Error("d1 down");
      },
      async batch(): Promise<[]> {
        return [];
      },
    };
    await expect(runSweep(broken, { log: captureLog().log })).rejects.toThrow("d1 down");
  });
});

describe("runSweep — paging audit window", () => {
  function alertRows(db: TestD1): Array<{ actor_login: string; detail_json: string; created_at: string }> {
    return db.raw
      .query("SELECT actor_login, detail_json, created_at FROM platform_audit_events WHERE action = ? ORDER BY created_at")
      .all(ALERT_PAGING_AUDIT_ACTION) as Array<{ actor_login: string; detail_json: string; created_at: string }>;
  }

  function seedAlert(db: TestD1, at: string): void {
    db.raw
      .prepare(
        `INSERT INTO platform_audit_events
           (id, actor_login, action, target_type, target_id, detail_json, created_at)
         VALUES (?, 'sweep', ?, 'sweep', 'failure_paging', '{}', ?)`,
      )
      .run(crypto.randomUUID(), ALERT_PAGING_AUDIT_ACTION, at);
  }

  function okSink(): { fetchImpl: typeof fetch; calls: () => number } {
    let n = 0;
    const fetchImpl = (async () => {
      n += 1;
      return new Response("ok");
    }) as unknown as typeof fetch;
    return { fetchImpl, calls: () => n };
  }

  test("a breach posts once, and a second breaching sweep inside the window posts nothing", async () => {
    const db = failureDb();
    const { fetchImpl, calls } = okSink();
    const log = captureLog().log;
    await seedInWindow(db, SWEEP_FAILURE_THRESHOLD + 1);

    const start = Date.parse("2026-01-01T00:00:00.000Z");
    jest.useFakeTimers();
    jest.setSystemTime(start);
    try {
      const first = await runSweep(db, { alertUrl: "https://ops.example/hook", fetchImpl, log });
      expect(first.webhook).toBe("posted");
      expect(calls()).toBe(1);
      expect(alertRows(db)).toHaveLength(1);
      expect(alertRows(db)[0]!.actor_login).toBe("sweep");
      expect(JSON.parse(alertRows(db)[0]!.detail_json)).toEqual({
        failures_24h: SWEEP_FAILURE_THRESHOLD + 1,
        stages: [{ stage: "runner", count: SWEEP_FAILURE_THRESHOLD + 1 }],
      });

      jest.setSystemTime(start + 1_000);
      const second = await runSweep(db, { alertUrl: "https://ops.example/hook", fetchImpl, log });
      expect(second).toMatchObject({ thresholdBreached: true, webhook: "not_attempted" });
      expect(calls()).toBe(1);
      expect(alertRows(db)).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("once the recorded alert slides out of the window, a new breach posts again", async () => {
    const db = failureDb();
    const { fetchImpl, calls } = okSink();
    const log = captureLog().log;
    await seedInWindow(db, SWEEP_FAILURE_THRESHOLD + 1);

    db.raw.run("DELETE FROM platform_audit_events");
    seedAlert(db, new Date(Date.now() - (SWEEP_WINDOW_HOURS + 1) * 3_600_000).toISOString());

    const breach = await runSweep(db, { alertUrl: "https://ops.example/hook", fetchImpl, log });
    expect(breach.webhook).toBe("posted");
    expect(calls()).toBe(1);
    expect(alertRows(db)).toHaveLength(2);
  });

  test("a failed audit append still reports the alert as posted, and logs", async () => {
    const db = failureDb();
    await seedInWindow(db, SWEEP_FAILURE_THRESHOLD + 1);
    const { fetchImpl, calls } = okSink();
    const { log, calls: warns } = captureLog();
    const blockedAppend: D1Like = {
      prepare(query: string): D1StatementLike {
        if (query.includes("INSERT INTO platform_audit_events")) throw new Error("audit locked");
        return db.prepare(query);
      },
      batch: (statements) => db.batch(statements),
    };

    const result = await runSweep(blockedAppend, { alertUrl: "https://ops.example/hook", fetchImpl, log });
    expect(result.webhook).toBe("posted");
    expect(calls()).toBe(1);
    expect(warns.at(-1)!.fields).toMatchObject({ event: "ops_sweep_alert_audit_failed", detail: "audit locked" });

    const again = await runSweep(db, { alertUrl: "https://ops.example/hook", fetchImpl, log });
    expect(again.webhook).toBe("posted");
    expect(calls()).toBe(2);
  });

  test("an absent sink records nothing, so the alert stays retryable", async () => {
    const db = failureDb();
    await seedInWindow(db, SWEEP_FAILURE_THRESHOLD + 1);
    const { fetchImpl, calls } = okSink();
    const log = captureLog().log;

    const logOnly = await runSweep(db, { log });
    expect(logOnly.webhook).toBe("absent");
    expect(alertRows(db)).toHaveLength(0);

    const posted = await runSweep(db, { alertUrl: "https://ops.example/hook", fetchImpl, log });
    expect(posted.webhook).toBe("posted");
    expect(calls()).toBe(1);
  });

  test("a POST failure records nothing, so the next sweep retries", async () => {
    const db = failureDb();
    await seedInWindow(db, SWEEP_FAILURE_THRESHOLD + 1);
    const { fetchImpl, calls } = okSink();
    const log = captureLog().log;
    const rejecting = (async () => new Response("sink degraded", { status: 503 })) as unknown as typeof fetch;

    const failed = await runSweep(db, { alertUrl: "https://ops.example/hook", fetchImpl: rejecting, log });
    expect(failed.webhook).toBe("failed");
    expect(alertRows(db)).toHaveLength(0);

    const retried = await runSweep(db, { alertUrl: "https://ops.example/hook", fetchImpl, log });
    expect(retried.webhook).toBe("posted");
    expect(calls()).toBe(1);
    expect(alertRows(db)).toHaveLength(1);
  });

  test("an ordinary in-window stamp suppresses the post", async () => {
    const db = failureDb();
    const { fetchImpl, calls } = okSink();
    const log = captureLog().log;
    await seedInWindow(db, SWEEP_FAILURE_THRESHOLD + 1);
    seedAlert(db, new Date(Date.now() - 3_600_000).toISOString());

    const result = await runSweep(db, { alertUrl: "https://ops.example/hook", fetchImpl, log });
    expect(result).toMatchObject({ thresholdBreached: true, webhook: "not_attempted" });
    expect(calls()).toBe(0);
  });

  test("a future-dated stamp is no recent alert, so the breach still posts", async () => {
    const db = failureDb();
    const { fetchImpl, calls } = okSink();
    const log = captureLog().log;
    await seedInWindow(db, SWEEP_FAILURE_THRESHOLD + 1);
    seedAlert(db, new Date(Date.now() + 24 * 3_600_000).toISOString());

    const result = await runSweep(db, { alertUrl: "https://ops.example/hook", fetchImpl, log });
    expect(result).toMatchObject({ thresholdBreached: true, webhook: "posted" });
    expect(calls()).toBe(1);
    expect(alertRows(db)).toHaveLength(2);
  });

  test("a barely future-dated stamp is still no recent alert, so the breach posts", async () => {
    const db = failureDb();
    const { fetchImpl, calls } = okSink();
    const log = captureLog().log;
    await seedInWindow(db, SWEEP_FAILURE_THRESHOLD + 1);
    seedAlert(db, new Date(Date.now() + 30_000).toISOString());

    const result = await runSweep(db, { alertUrl: "https://ops.example/hook", fetchImpl, log });
    expect(result).toMatchObject({ thresholdBreached: true, webhook: "posted" });
    expect(calls()).toBe(1);
    expect(alertRows(db)).toHaveLength(2);
  });

  test("a stamp equal to the reading clock is not a past alert, so the breach posts", async () => {
    const db = failureDb();
    const { fetchImpl, calls } = okSink();
    const log = captureLog().log;
    await seedInWindow(db, SWEEP_FAILURE_THRESHOLD + 1);
    const now = new Date("2026-01-01T00:00:00.000Z");
    seedAlert(db, now.toISOString());
    jest.useFakeTimers();
    jest.setSystemTime(now);
    try {
      const result = await runSweep(db, { alertUrl: "https://ops.example/hook", fetchImpl, log });
      expect(result).toMatchObject({ thresholdBreached: true, webhook: "posted" });
      expect(calls()).toBe(1);
      expect(alertRows(db)).toHaveLength(2);
    } finally {
      jest.useRealTimers();
    }
  });

  test("an unreadable window read logs and still pages the breach", async () => {
    const db = failureDb();
    await seedInWindow(db, SWEEP_FAILURE_THRESHOLD + 1);
    const { fetchImpl, calls } = okSink();
    const { log, calls: warns } = captureLog();
    const unreadable: D1Like = {
      prepare(query: string): D1StatementLike {
        if (query.includes("MAX(created_at)")) throw new Error("audit locked");
        return db.prepare(query);
      },
      batch: (statements) => db.batch(statements),
    };

    const result = await runSweep(unreadable, { alertUrl: "https://ops.example/hook", fetchImpl, log });
    expect(result.webhook).toBe("posted");
    expect(calls()).toBe(1);
    expect(warns[0]!.fields).toMatchObject({
      event: "ops_sweep_alert_window_unreadable",
      detail: "audit locked",
    });
  });

  test("an unparseable recorded stamp counts as no recent alert", async () => {
    const db = failureDb();
    await seedInWindow(db, SWEEP_FAILURE_THRESHOLD + 1);
    seedAlert(db, "not-a-timestamp");
    const { fetchImpl, calls } = okSink();
    const { log, calls: warns } = captureLog();

    const result = await runSweep(db, { alertUrl: "https://ops.example/hook", fetchImpl, log });
    expect(result.webhook).toBe("posted");
    expect(calls()).toBe(1);
    expect(warns[0]!.fields).toMatchObject({ event: "ops_sweep_alert_window_unreadable" });
  });

  test("a healthy window writes nothing and a later breach still pages", async () => {
    const db = failureDb();
    const { fetchImpl, calls } = okSink();
    const log = captureLog().log;

    const healthy = await runSweep(db, { alertUrl: "https://ops.example/hook", fetchImpl, log });
    expect(healthy).toMatchObject({ thresholdBreached: false, webhook: "not_attempted" });
    expect(alertRows(db)).toHaveLength(0);

    await seedInWindow(db, SWEEP_FAILURE_THRESHOLD + 1);
    const breach = await runSweep(db, { alertUrl: "https://ops.example/hook", fetchImpl, log });
    expect(breach.webhook).toBe("posted");
    expect(calls()).toBe(1);
  });
});

describe("runSweep — maintenance audit window", () => {
  function auditRows(db: TestD1, action: string): Array<{ detail_json: string }> {
    return db.raw
      .query("SELECT detail_json FROM platform_audit_events WHERE action = ? ORDER BY created_at")
      .all(action) as Array<{ detail_json: string }>;
  }

  function seedAudit(db: TestD1, action: string, targetId: string, at: string): void {
    db.raw
      .prepare(
        `INSERT INTO platform_audit_events
           (id, actor_login, action, target_type, target_id, detail_json, created_at)
         VALUES (?, 'sweep', ?, 'sweep', ?, '{}', ?)`,
      )
      .run(crypto.randomUUID(), action, targetId, at);
  }

  async function seedDeferral(db: TestD1): Promise<void> {
    await createFailureStore(db).record(failureRow("maintenance_deferred", "maintenance_window"));
  }

  function sink(): { fetchImpl: typeof fetch; bodies: () => string[] } {
    const bodies: string[] = [];
    const fetchImpl = (async (_url: unknown, init?: RequestInit) => {
      bodies.push(String(init?.body));
      return new Response("ok");
    }) as unknown as typeof fetch;
    return { fetchImpl, bodies: () => bodies };
  }

  test("a deferral alone posts with a healthy infrastructure total", async () => {
    const db = failureDb();
    await seedDeferral(db);
    const { fetchImpl, bodies } = sink();

    const result = await runSweep(db, { alertUrl: "https://ops.example/hook", fetchImpl });
    expect(result).toMatchObject({ failures24h: 0, thresholdBreached: false, webhook: "posted" });
    expect(bodies()).toHaveLength(1);
    expect(JSON.parse(bodies()[0]!)).toEqual({
      event: "ops_sweep_alert",
      failures_24h: 0,
      dlq_check: "skipped",
      thresholds: { failures_24h: SWEEP_FAILURE_THRESHOLD, window_hours: SWEEP_WINDOW_HOURS },
      stages: [],
      maintenance_deferred: { count: 1 },
      due: ["maintenance"],
    });
    expect(auditRows(db, ALERT_MAINTENANCE_AUDIT_ACTION)).toHaveLength(1);
    expect(auditRows(db, ALERT_PAGING_AUDIT_ACTION)).toHaveLength(0);
  });

  test("overrides apply to failure counts, both de-bounce lanes, the threshold and the webhook timeout", async () => {
    const db = failureDb();
    await seedInWindow(db, 3);
    await seedDeferral(db);
    for (const stage of ["runner", "maintenance_deferred"] as const) {
      await createFailureStore(db).record(failureRow(stage, "old"));
    }
    db.raw.run("UPDATE review_failures SET created_at = datetime('now', '-8 hours') WHERE error = 'old'");
    const oldStamp = new Date(Date.now() - 8 * 3_600_000).toISOString();
    seedAudit(db, ALERT_PAGING_AUDIT_ACTION, "failure_paging", oldStamp);
    seedAudit(db, ALERT_MAINTENANCE_AUDIT_ACTION, "maintenance_deferred", oldStamp);
    const { fetchImpl, bodies } = sink();
    const deps = { fetchImpl, log: captureLog().log, alertUrl: "https://ops.example/hook" };
    expect(await runSweep(db, deps)).toMatchObject({ failures24h: 4, thresholdBreached: false, webhook: "not_attempted" });
    await setSweepSettings(db, SWEEP_OVERRIDE, "operator");
    const timeout = jest.spyOn(AbortSignal, "timeout");
    try {
      expect(await runSweep(db, deps)).toMatchObject({ failures24h: 3, thresholdBreached: true, webhook: "posted" });
      expect(timeout).toHaveBeenCalledWith(SWEEP_OVERRIDE.webhookTimeoutMs);
    } finally {
      timeout.mockRestore();
    }
    expect(bodies()).toHaveLength(1);
    expect(JSON.parse(bodies()[0]!)).toMatchObject({
      failures_24h: 3,
      thresholds: { failures_24h: 2, window_hours: 6 },
      maintenance_deferred: { count: 1 },
      due: ["infrastructure", "maintenance"],
    });
  });

  test("a deferral inside the maintenance window does not post again", async () => {
    const db = failureDb();
    await seedDeferral(db);
    const { fetchImpl, bodies } = sink();
    const log = captureLog().log;

    const start = Date.parse("2026-01-01T00:00:00.000Z");
    jest.useFakeTimers();
    jest.setSystemTime(start);
    try {
      const first = await runSweep(db, { alertUrl: "https://ops.example/hook", fetchImpl, log });
      expect(first.webhook).toBe("posted");
      expect(bodies()).toHaveLength(1);

      jest.setSystemTime(start + 60_000);
      const second = await runSweep(db, { alertUrl: "https://ops.example/hook", fetchImpl, log });
      expect(second).toMatchObject({ thresholdBreached: false, webhook: "not_attempted" });
      expect(bodies()).toHaveLength(1);
      expect(auditRows(db, ALERT_MAINTENANCE_AUDIT_ACTION)).toHaveLength(1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("a paging alert does not suppress the maintenance alert in the same sweep", async () => {
    const db = failureDb();
    await seedDeferral(db);
    await seedInWindow(db, SWEEP_FAILURE_THRESHOLD + 1);
    const { fetchImpl, bodies } = sink();

    const result = await runSweep(db, { alertUrl: "https://ops.example/hook", fetchImpl });
    expect(result.webhook).toBe("posted");
    expect(bodies()).toHaveLength(1);
    expect(JSON.parse(bodies()[0]!)).toEqual({
      event: "ops_sweep_alert",
      failures_24h: SWEEP_FAILURE_THRESHOLD + 1,
      dlq_check: "skipped",
      thresholds: { failures_24h: SWEEP_FAILURE_THRESHOLD, window_hours: SWEEP_WINDOW_HOURS },
      stages: [{ stage: "runner", count: SWEEP_FAILURE_THRESHOLD + 1 }],
      maintenance_deferred: { count: 1 },
      due: ["infrastructure", "maintenance"],
    });
    expect(auditRows(db, ALERT_PAGING_AUDIT_ACTION)).toHaveLength(1);
    expect(auditRows(db, ALERT_MAINTENANCE_AUDIT_ACTION)).toHaveLength(1);
  });

  test("an already-latched paging lane leaves the maintenance lane to post alone", async () => {
    const db = failureDb();
    await seedDeferral(db);
    await seedInWindow(db, SWEEP_FAILURE_THRESHOLD + 1);
    seedAudit(db, ALERT_PAGING_AUDIT_ACTION, "failure_paging", new Date(Date.now() - 3_600_000).toISOString());
    const { fetchImpl, bodies } = sink();

    const result = await runSweep(db, { alertUrl: "https://ops.example/hook", fetchImpl });
    expect(result).toMatchObject({ thresholdBreached: true, webhook: "posted" });
    expect(bodies()).toHaveLength(1);
    expect(JSON.parse(bodies()[0]!)).toEqual({
      event: "ops_sweep_alert",
      failures_24h: SWEEP_FAILURE_THRESHOLD + 1,
      dlq_check: "skipped",
      thresholds: { failures_24h: SWEEP_FAILURE_THRESHOLD, window_hours: SWEEP_WINDOW_HOURS },
      stages: [{ stage: "runner", count: SWEEP_FAILURE_THRESHOLD + 1 }],
      maintenance_deferred: { count: 1 },
      due: ["maintenance"],
    });
    expect(auditRows(db, ALERT_MAINTENANCE_AUDIT_ACTION)).toHaveLength(1);
    expect(auditRows(db, ALERT_PAGING_AUDIT_ACTION)).toHaveLength(1);
  });

  test("a failed maintenance POST records nothing, so the next sweep retries", async () => {
    const db = failureDb();
    await seedDeferral(db);
    const log = captureLog().log;
    const rejecting = (async () => new Response("sink degraded", { status: 503 })) as unknown as typeof fetch;

    const failed = await runSweep(db, { alertUrl: "https://ops.example/hook", fetchImpl: rejecting, log });
    expect(failed.webhook).toBe("failed");
    expect(auditRows(db, ALERT_MAINTENANCE_AUDIT_ACTION)).toHaveLength(0);

    const { fetchImpl, bodies } = sink();
    const retried = await runSweep(db, { alertUrl: "https://ops.example/hook", fetchImpl, log });
    expect(retried.webhook).toBe("posted");
    expect(bodies()).toHaveLength(1);
    expect(auditRows(db, ALERT_MAINTENANCE_AUDIT_ACTION)).toHaveLength(1);
  });

  test("the deferral count travels under the frozen nested key, never the camelCase one", async () => {
    const db = failureDb();
    await seedDeferral(db);
    await seedDeferral(db);
    const { fetchImpl, bodies } = sink();

    await runSweep(db, { alertUrl: "https://ops.example/hook", fetchImpl });
    const body = JSON.parse(bodies()[0]!) as Record<string, unknown>;
    expect(body.maintenance_deferred).toEqual({ count: 2 });
    expect(body).not.toHaveProperty("maintenanceDeferred");
  });

  test("due names both lanes when one sweep owes both alerts", async () => {
    const db = failureDb();
    await seedDeferral(db);
    await seedInWindow(db, SWEEP_FAILURE_THRESHOLD + 1);
    const { fetchImpl, bodies } = sink();

    await runSweep(db, { alertUrl: "https://ops.example/hook", fetchImpl });
    const body = JSON.parse(bodies()[0]!) as { due: string[]; maintenance_deferred?: { count: number } };
    expect(body.due).toEqual(["infrastructure", "maintenance"]);
    expect(body.maintenance_deferred).toEqual({ count: 1 });
  });

  test("a de-bounced maintenance lane is not listed in due and carries no count key", async () => {
    const db = failureDb();
    await seedDeferral(db);
    await seedInWindow(db, SWEEP_FAILURE_THRESHOLD + 1);
    seedAudit(db, ALERT_MAINTENANCE_AUDIT_ACTION, "maintenance_deferred", new Date(Date.now() - 60_000).toISOString());
    const { fetchImpl, bodies } = sink();

    const result = await runSweep(db, { alertUrl: "https://ops.example/hook", fetchImpl });
    expect(result).toMatchObject({ thresholdBreached: true, webhook: "posted" });
    expect(bodies()).toHaveLength(1);
    const body = JSON.parse(bodies()[0]!) as Record<string, unknown> & { due: string[] };
    expect(body.due).toEqual(["infrastructure"]);
    expect(body).not.toHaveProperty("maintenance_deferred");
    expect(auditRows(db, ALERT_PAGING_AUDIT_ACTION)).toHaveLength(1);
    expect(auditRows(db, ALERT_MAINTENANCE_AUDIT_ACTION)).toHaveLength(1);
  });
});

describe("runSweep — comment-claim outbox", () => {
  function seedClaim(
    db: TestD1,
    overrides: { state?: "queued" | "consumed" | "expired"; attempts?: number; ageMs?: number; commentId?: number } = {},
  ): void {
    const { state = "queued", attempts = 0, ageMs = COMMENT_CLAIM_RETRY_DEFAULT + 1_000, commentId = 9001 } = overrides;
    const queuedMs = Date.now() - ageMs;
    db.raw
      .prepare(
        `INSERT INTO comment_trigger_claims
           (installation_id, owner, repo, pr_number, comment_id, state, payload_json, attempts, created_ms, queued_ms)
         VALUES (123, 'acme', 'widgets', 42, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        commentId,
        state,
        JSON.stringify({
          ...BASE,
          head_sha: null,
          action: "created",
          triggered_by: "issue_comment",
          comment_id: commentId,
          appRef: { appId: "app-1" },
        }),
        attempts,
        queuedMs,
        queuedMs,
      );
  }

  function claimRow(db: TestD1) {
    return db.raw
      .query("SELECT state, attempts, queued_ms, consumed_ms, payload_json FROM comment_trigger_claims")
      .get() as { state: string; attempts: number; queued_ms: number; consumed_ms: number | null; payload_json: string | null };
  }

  function fakeQueue(fail = false): { queue: SweepDeps["queue"]; sent: unknown[] } {
    const sent: unknown[] = [];
    return {
      sent,
      queue: {
        send: async (message: unknown) => {
          if (fail) throw new Error("queue down");
          sent.push(message);
        },
      } as never,
    };
  }

  function seedSettings(
    db: TestD1,
    values: Partial<{ retryMs: number; maxAttempts: number; outboxCap: number }>,
  ): void {
    const rows: Array<[string, number]> = [];
    if (values.retryMs !== undefined) rows.push(["review.comment_claim.retry_ms", values.retryMs]);
    if (values.maxAttempts !== undefined) {
      rows.push(["review.comment_claim.max_attempts", values.maxAttempts]);
    }
    if (values.outboxCap !== undefined) rows.push(["review.comment_claim.outbox_cap", values.outboxCap]);
    const insert = db.raw.prepare(
      `INSERT INTO review_runtime_settings (key, value, updated_at, updated_by)
       VALUES (?, ?, '2026-11-05T00:00:00.000Z', 'fixture')`,
    );
    for (const [key, value] of rows) insert.run(key, String(value));
  }

  test("re-sends a stale claim with its stored payload and bumps the attempt", async () => {
    const db = failureDb();
    seedClaim(db);
    const { queue, sent } = fakeQueue();
    const { log, calls } = captureLog();

    await runSweep(db, { log, queue });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({
      installation_id: 123,
      pr_number: 42,
      comment_id: 9001,
      triggered_by: "issue_comment",
      appRef: { appId: "app-1" },
    });
    const row = claimRow(db);
    expect(row).toMatchObject({ state: "queued", attempts: 1, consumed_ms: null });
    expect(row.queued_ms).toBeGreaterThan(Date.now() - 60_000);
    expect(calls.at(-1)?.fields).toEqual({ event: "comment_claim_outbox", resent: 1, expired: 0, failed: 0 });
  });

  test("a claim inside the retry window is left for the send in flight", async () => {
    const db = failureDb();
    seedClaim(db, { ageMs: 1_000 });
    const { queue, sent } = fakeQueue();
    const { log, calls } = captureLog();

    await runSweep(db, { log, queue });

    expect(sent).toHaveLength(0);
    expect(calls).toHaveLength(0);
    expect(claimRow(db)).toMatchObject({ state: "queued", attempts: 0 });
  });

  for (const ageMs of [1_000, -900_000]) {
    test(`a full-attempt claim still awaiting delivery stays queued (age ${ageMs}ms)`, async () => {
      const db = failureDb();
      seedSettings(db, { maxAttempts: 1 });
      seedClaim(db, { attempts: 1, ageMs });
      const { queue, sent } = fakeQueue();
      const { log, calls } = captureLog();

      await runSweep(db, { log, queue });

      expect(sent).toHaveLength(0);
      expect(calls).toHaveLength(0);
      const row = claimRow(db);
      expect(row).toMatchObject({ state: "queued", attempts: 1 });
      expect(JSON.parse(row.payload_json!)).toMatchObject({ comment_id: 9001 });
    });
  }

  test("a claim at the stored attempt cap expires instead of being re-sent", async () => {
    const db = failureDb();
    seedSettings(db, { maxAttempts: 1 });
    seedClaim(db, { attempts: 1 });
    const { queue, sent } = fakeQueue();
    const { log, calls } = captureLog();

    await runSweep(db, { log, queue });

    expect(sent).toHaveLength(0);
    expect(claimRow(db)).toMatchObject({ state: "expired", payload_json: null });
    expect(calls.at(-1)?.fields).toEqual({ event: "comment_claim_outbox", resent: 0, expired: 1, failed: 0 });
  });

  test("a consumed row is never re-sent, however old", async () => {
    const db = failureDb();
    seedClaim(db, { state: "consumed", ageMs: 10 * COMMENT_CLAIM_RETRY_DEFAULT });
    const { queue, sent } = fakeQueue();

    await runSweep(db, { log: captureLog().log, queue });

    expect(sent).toHaveLength(0);
    expect(claimRow(db)).toMatchObject({ state: "consumed" });
  });

  test("a failing send still counts the attempt, so the claim cannot be retried forever", async () => {
    const db = failureDb();
    seedClaim(db);
    const { queue } = fakeQueue(true);
    const { log, calls } = captureLog();

    await runSweep(db, { log, queue });

    expect(claimRow(db)).toMatchObject({ state: "queued", attempts: 1 });
    expect(calls.at(-1)?.fields).toEqual({ event: "comment_claim_outbox", resent: 0, expired: 0, failed: 1 });
  });

  test("the stored retry window drives the scan, not a source constant", async () => {
    const db = failureDb();
    seedClaim(db, { ageMs: 60_000 });
    const { queue, sent } = fakeQueue();
    const { log, calls } = captureLog();

    await runSweep(db, { log, queue });
    expect(sent).toHaveLength(0);
    expect(calls).toHaveLength(0);

    seedSettings(db, { retryMs: 30_000 });
    await runSweep(db, { log, queue });

    expect(sent).toHaveLength(1);
    expect(calls.some((call) => call.fields.event === "comment_claim_outbox")).toBe(true);
  });

  test("the stored outbox cap bounds one sweep", async () => {
    const db = failureDb();
    seedSettings(db, { outboxCap: 1 });
    seedClaim(db, { commentId: 9001 });
    seedClaim(db, { commentId: 9002 });
    const { queue, sent } = fakeQueue();

    await runSweep(db, { log: captureLog().log, queue });
    expect(sent).toHaveLength(1);

    await runSweep(db, { log: captureLog().log, queue });
    expect(sent).toHaveLength(2);
  });

  test("a degraded settings read falls back to the documented defaults with ONE warn", async () => {
    const db = failureDb();
    db.raw
      .prepare(
        `INSERT INTO review_runtime_settings (key, value, updated_at, updated_by)
         VALUES ('review.comment_claim.retry_ms', 'abc', '2026-11-05T00:00:00.000Z', 'fixture')`,
      )
      .run();
    seedClaim(db, { ageMs: 60_000 });
    const { queue, sent } = fakeQueue();
    const { log, calls } = captureLog();

    await runSweep(db, { log, queue });

    expect(sent).toHaveLength(0);
    const degraded = calls.filter(
      (call) => call.fields.event === "review_comment_claim_settings_degraded",
    );
    expect(degraded).toHaveLength(1);
    expect(degraded[0]?.fields).toMatchObject({
      retry_ms: COMMENT_CLAIM_RETRY_DEFAULT,
      max_attempts: COMMENT_CLAIM_ATTEMPTS_DEFAULT,
      outbox_cap: COMMENT_CLAIM_OUTBOX_DEFAULT,
    });
  });
});

describe("runSweep — maintenance replay outbox", () => {
  async function seedPendingReplay(
    db: TestD1,
    overrides: { targetId?: string; requestedAt?: string } = {},
  ): Promise<string> {
    const id = crypto.randomUUID();
    const { targetId = BASE.target_id, requestedAt = "2026-11-01T00:00:00.000Z" } = overrides;
    db.raw
      .prepare(
        `INSERT INTO review_failures
           (id, target_id, installation_id, owner, repo, pr_number, head_sha, stage, error,
            maintenance_replay_requested_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'maintenance_deferred', 'maintenance_window', ?)`,
      )
      .run(id, targetId, BASE.installation_id, BASE.owner, BASE.repo, BASE.pr_number, BASE.head_sha, requestedAt);
    return id;
  }

  function replayRow(db: TestD1, id: string) {
    return db.raw
      .query(
        `SELECT maintenance_replay_requested_at, maintenance_replay_sent_at, maintenance_replay_last_attempt_at
           FROM review_failures WHERE id = ?`,
      )
      .get(id) as {
      maintenance_replay_requested_at: string | null;
      maintenance_replay_sent_at: string | null;
      maintenance_replay_last_attempt_at: string | null;
    };
  }

  function setMaintenance(db: TestD1, enabled: boolean): void {
    db.raw
      .prepare(
        `INSERT INTO review_runtime_settings (key, value, updated_at, updated_by)
         VALUES ('platform.maintenance.enabled', ?, '2026-11-05T00:00:00.000Z', 'fixture')`,
      )
      .run(enabled ? "1" : "0");
  }

  function fakeQueue(): { queue: SweepDeps["queue"]; sent: unknown[] } {
    const sent: unknown[] = [];
    return {
      sent,
      queue: {
        send: async (message: unknown) => {
          sent.push(message);
        },
      } as never,
    };
  }

  test("a pending replay is sent once with the frozen payload while maintenance is off", async () => {
    const db = failureDb();
    const id = await seedPendingReplay(db);
    setMaintenance(db, false);
    const { queue, sent } = fakeQueue();
    const { log, calls } = captureLog();

    await runSweep(db, { log, queue });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toEqual({
      installation_id: BASE.installation_id,
      owner: BASE.owner,
      repo: BASE.repo,
      pr_number: BASE.pr_number,
      head_sha: null,
      action: "maintenance_replay",
      triggered_by: "pull_request",
      botRef: { appId: "bot-sweep" },
      targetId: BASE.target_id,
    });
    expect(replayRow(db, id).maintenance_replay_sent_at).not.toBeNull();
    expect(calls.some((call) => call.fields.event === "maintenance_replay_outbox")).toBe(true);

    await runSweep(db, { log, queue });
    expect(sent).toHaveLength(1);
  });

  test("cap 1 with a pending replay reserves the slot for the replay, and the comment lane is served next sweep", async () => {
    const db = failureDb();
    await seedPendingReplay(db);
    db.raw
      .prepare(
        `INSERT INTO comment_trigger_claims
           (installation_id, owner, repo, pr_number, comment_id, state, payload_json, attempts, created_ms, queued_ms)
         VALUES (123, 'acme', 'widgets', 42, 9001, 'queued', ?, 0, 0, 0)`,
      )
      .run(JSON.stringify({ ...BASE, head_sha: null, action: "created", triggered_by: "issue_comment" }));
    db.raw
      .prepare(
        `INSERT INTO review_runtime_settings (key, value, updated_at, updated_by)
         VALUES ('review.comment_claim.outbox_cap', '1', '2026-11-05T00:00:00.000Z', 'fixture')`,
      )
      .run();
    const { queue, sent } = fakeQueue();

    await runSweep(db, { log: captureLog().log, queue });
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ action: "maintenance_replay" });

    await runSweep(db, { log: captureLog().log, queue });
    expect(sent).toHaveLength(2);
    expect(sent[1]).toMatchObject({ triggered_by: "issue_comment" });
  });

  test("cap 2 gives a pending replay one slot and the comment lane the other", async () => {
    const db = failureDb();
    await seedPendingReplay(db);
    db.raw
      .prepare(
        `INSERT INTO comment_trigger_claims
           (installation_id, owner, repo, pr_number, comment_id, state, payload_json, attempts, created_ms, queued_ms)
         VALUES (123, 'acme', 'widgets', 42, 9001, 'queued', ?, 0, 0, 0)`,
      )
      .run(JSON.stringify({ ...BASE, head_sha: null, action: "created", triggered_by: "issue_comment" }));
    db.raw
      .prepare(
        `INSERT INTO review_runtime_settings (key, value, updated_at, updated_by)
         VALUES ('review.comment_claim.outbox_cap', '2', '2026-11-05T00:00:00.000Z', 'fixture')`,
      )
      .run();
    const { queue, sent } = fakeQueue();

    await runSweep(db, { log: captureLog().log, queue });

    expect(sent).toHaveLength(2);
    expect(sent.some((message) => JSON.stringify(message).includes('"issue_comment"'))).toBe(true);
    expect(sent.some((message) => JSON.stringify(message).includes('"maintenance_replay"'))).toBe(true);
  });

  test("nothing is sent while maintenance is active", async () => {
    const db = failureDb();
    const id = await seedPendingReplay(db);
    setMaintenance(db, true);
    const { queue, sent } = fakeQueue();
    const { log } = captureLog();

    await runSweep(db, { log, queue });

    expect(sent).toHaveLength(0);
    expect(replayRow(db, id)).toMatchObject({
      maintenance_replay_requested_at: "2026-11-01T00:00:00.000Z",
      maintenance_replay_sent_at: null,
    });
  });

  test("a dead oldest target does not starve the next pending request in the same sweep", async () => {
    const db = failureDb();
    const deadTarget = seedTarget(db, "bot-sweep", { id: "target-dead" });
    db.raw
      .prepare("UPDATE review_targets SET deleted_at = ? WHERE id = ?")
      .run("2026-11-02T00:00:00.000Z", deadTarget);
    const dead = await seedPendingReplay(db, { targetId: deadTarget, requestedAt: "2026-11-01T00:00:00.000Z" });
    const live = await seedPendingReplay(db, { requestedAt: "2026-11-05T00:00:00.000Z" });
    db.raw
      .prepare(
        `INSERT INTO review_runtime_settings (key, value, updated_at, updated_by)
         VALUES ('review.comment_claim.outbox_cap', '2', '2026-11-05T00:00:00.000Z', 'fixture')`,
      )
      .run();
    const { queue, sent } = fakeQueue();
    const { log, calls } = captureLog();

    await runSweep(db, { log, queue });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ action: "maintenance_replay", targetId: BASE.target_id });
    expect(replayRow(db, live).maintenance_replay_sent_at).not.toBeNull();
    expect(replayRow(db, dead)).toMatchObject({
      maintenance_replay_requested_at: "2026-11-01T00:00:00.000Z",
      maintenance_replay_sent_at: null,
    });
    expect(replayRow(db, dead).maintenance_replay_last_attempt_at).not.toBeNull();
    const outboxLog = calls.find((call) => call.fields.event === "maintenance_replay_outbox");
    expect(outboxLog?.fields).toEqual({ event: "maintenance_replay_outbox", sent: 1, failed: 0, target_unavailable: 1 });
  });

  test("a dead backlog is bounded per pass: cap 1 touches one row and the next sweep moves on", async () => {
    const db = failureDb();
    const deadTarget = seedTarget(db, "bot-sweep", { id: "target-dead" });
    db.raw
      .prepare("UPDATE review_targets SET deleted_at = ? WHERE id = ?")
      .run("2026-11-02T00:00:00.000Z", deadTarget);
    const dead = [
      await seedPendingReplay(db, { targetId: deadTarget, requestedAt: "2026-11-01T00:00:00.000Z" }),
      await seedPendingReplay(db, { targetId: deadTarget, requestedAt: "2026-11-02T00:00:00.000Z" }),
      await seedPendingReplay(db, { targetId: deadTarget, requestedAt: "2026-11-03T00:00:00.000Z" }),
    ];
    db.raw
      .prepare(
        `INSERT INTO review_runtime_settings (key, value, updated_at, updated_by)
         VALUES ('review.comment_claim.outbox_cap', '1', '2026-11-05T00:00:00.000Z', 'fixture')`,
      )
      .run();
    const { queue, sent } = fakeQueue();
    const { log, calls } = captureLog();

    await runSweep(db, { log, queue });

    expect(sent).toHaveLength(0);
    expect(calls.find((call) => call.fields.event === "maintenance_replay_outbox")?.fields).toEqual({
      event: "maintenance_replay_outbox",
      sent: 0,
      failed: 0,
      target_unavailable: 1,
    });
    const touched = () => dead.filter((id) => replayRow(db, id).maintenance_replay_last_attempt_at !== null);
    expect(touched()).toHaveLength(1);

    await runSweep(db, { log, queue });

    expect(touched()).toHaveLength(2);
    expect(sent).toHaveLength(0);
  });

  test("a replay whose send keeps failing rotates behind the next pending request on the next sweep", async () => {
    const db = failureDb();
    const stuckTarget = seedTarget(db, "bot-sweep", { id: "target-stuck" });
    const stuck = await seedPendingReplay(db, { targetId: stuckTarget, requestedAt: "2026-11-01T00:00:00.000Z" });
    const later = await seedPendingReplay(db, { requestedAt: "2026-11-05T00:00:00.000Z" });
    db.raw
      .prepare(
        `INSERT INTO review_runtime_settings (key, value, updated_at, updated_by)
         VALUES ('review.comment_claim.outbox_cap', '1', '2026-11-05T00:00:00.000Z', 'fixture')`,
      )
      .run();
    const sent: unknown[] = [];
    const queue = {
      send: async (message: { targetId?: string }) => {
        if (message.targetId === stuckTarget) throw new Error("queue is down");
        sent.push(message);
      },
    } as unknown as SweepDeps["queue"];
    const { log } = captureLog();

    await runSweep(db, { log, queue });

    expect(sent).toHaveLength(0);
    expect(replayRow(db, stuck).maintenance_replay_sent_at).toBeNull();
    expect(replayRow(db, stuck).maintenance_replay_last_attempt_at).not.toBeNull();

    await runSweep(db, { log, queue });

    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ action: "maintenance_replay", targetId: BASE.target_id });
    expect(replayRow(db, later).maintenance_replay_sent_at).not.toBeNull();
    expect(replayRow(db, stuck).maintenance_replay_sent_at).toBeNull();
  });

  test("a comment attempt whose DB write fails still spends the comment lane's share", async () => {
    const db = failureDb();
    await seedPendingReplay(db);
    db.raw
      .prepare(
        `INSERT INTO comment_trigger_claims
           (installation_id, owner, repo, pr_number, comment_id, state, payload_json, attempts, created_ms, queued_ms)
         VALUES (123, 'acme', 'widgets', 42, 9001, 'queued', ?, 0, 0, 0)`,
      )
      .run(JSON.stringify({ ...BASE, head_sha: null, action: "created", triggered_by: "issue_comment" }));
    db.raw
      .prepare(
        `INSERT INTO review_runtime_settings (key, value, updated_at, updated_by)
         VALUES ('review.comment_claim.outbox_cap', '2', '2026-11-05T00:00:00.000Z', 'fixture')`,
      )
      .run();
    const lockedUpdate: D1StatementLike = {
      bind: () => lockedUpdate,
      first: async () => null,
      all: async () => ({ results: [] }),
      async run() {
        throw new Error("claim row locked");
      },
    };
    const brokenWrites: D1Like = {
      prepare(query: string): D1StatementLike {
        return query.includes("UPDATE comment_trigger_claims SET attempts")
          ? lockedUpdate
          : db.prepare(query);
      },
      batch: (statements) => db.batch(statements),
    };
    const { queue, sent } = fakeQueue();
    const { log } = captureLog();

    await runSweep(brokenWrites, { log, queue });

    expect(sent).toHaveLength(2);
    expect(sent.some((message) => JSON.stringify(message).includes('"issue_comment"'))).toBe(true);
    expect(sent.some((message) => JSON.stringify(message).includes('"maintenance_replay"'))).toBe(true);
  });

  test("a queue send that resolves but a sent stamp that fails leaves the row pending for the next sweep", async () => {
    const db = failureDb();
    const id = await seedPendingReplay(db);
    db.raw
      .prepare(
        `INSERT INTO review_runtime_settings (key, value, updated_at, updated_by)
         VALUES ('review.comment_claim.outbox_cap', '1', '2026-11-05T00:00:00.000Z', 'fixture')`,
      )
      .run();
    const lockedStamp: D1StatementLike = {
      bind: () => lockedStamp,
      first: async () => null,
      all: async () => ({ results: [] }),
      async run() {
        throw new Error("review_failures locked");
      },
    };
    let failStamp = true;
    const flaky: D1Like = {
      prepare(query: string): D1StatementLike {
        return failStamp && query.includes("SET maintenance_replay_sent_at")
          ? lockedStamp
          : db.prepare(query);
      },
      batch: (statements) => db.batch(statements),
    };
    const { queue, sent } = fakeQueue();
    const { log, calls } = captureLog();

    await runSweep(flaky, { log, queue });

    expect(sent).toHaveLength(1);
    expect(replayRow(db, id).maintenance_replay_sent_at).toBeNull();
    expect(replayRow(db, id).maintenance_replay_last_attempt_at).not.toBeNull();
    expect(calls.some((call) => call.fields.event === "maintenance_replay_outbox_send_failed")).toBe(true);

    failStamp = false;
    await runSweep(flaky, { log, queue });

    expect(replayRow(db, id).maintenance_replay_sent_at).not.toBeNull();
    await runSweep(flaky, { log, queue });
    expect(sent).toHaveLength(2);
  });
});
