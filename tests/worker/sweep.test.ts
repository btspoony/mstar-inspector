/**
 * Ops sweep tests (architect verdict AL-6) — the cron
 * failure sweep (src/worker/sweep.ts) over the REAL migration DDL
 * (bun:sqlite D1 double, tests/store/helpers.ts) plus a recording fake for
 * the window-SQL pin and an injected fetch for the webhook paths.
 *
 * Pinned contracts: the threshold DERIVED from the queue's delivery budget
 * (one fully-failed message never alerts), the 24h window, the 3s webhook
 * timeout, the trailing-24h window SQL, the `ops_sweep_alert`
 * payload shape (`dlq_check: "skipped"` — DLQ depth is NOT read), webhook
 * absent = log-only, webhook failure = warn log only (never throws).
 */

import { describe, expect, jest, mock, test } from "bun:test";
import type { Database } from "bun:sqlite";
import { createFailureStore, QUEUE_MAX_ATTEMPTS } from "../../src/store/failure-store";
import type { D1Like, D1StatementLike } from "../../src/store/types";
import {
  ALERT_PAGING_AUDIT_ACTION,
  runSweep,
  SWEEP_FAILURE_THRESHOLD,
  SWEEP_INVITE_LAPSE_CAP,
  SWEEP_LOG_DETAIL_MAX,
  SWEEP_RETENTION_CAP,
  SWEEP_RETENTION_DAYS,
  SWEEP_WEBHOOK_TIMEOUT_MS,
  SWEEP_WINDOW_HOURS,
  type SweepAlertFields,
  type SweepCommentClaimFields,
  type SweepDeps,
  type SweepInviteLapseFields,
  type SweepLog,
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

/**
 * A migrated DB carrying the target every recorded row names (its FK parent).
 * The sweep itself reads no target, but the write contract requires one.
 */
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

type WarnCall = {
  fields:
    | SweepAlertFields
    | SweepWarnFields
    | SweepRetentionFields
    | SweepLedgerRetentionFields
    | SweepInviteLapseFields
    | SweepCommentClaimFields
    | CommentClaimSettingsLogFields;
  msg?: string;
};

function captureLog(): { log: SweepLog; calls: WarnCall[] } {
  const calls: WarnCall[] = [];
  return { log: { warn: (fields, msg) => void calls.push({ fields, msg }) }, calls };
}

/** Seed `count` in-window failure rows (created_at defaults to now). */
async function seedInWindow(db: D1Like, count: number): Promise<void> {
  const store = createFailureStore(db);
  for (let i = 0; i < count; i++) {
    await store.record({ ...BASE, stage: "runner", error: `boom-${i}` });
  }
}

/** Seed one row OUTSIDE the trailing-24h window (25h ago). */
function seedOutsideWindow(db: D1Like & { raw: Database }): void {
  db.raw
    .query(
      `INSERT INTO review_failures (id, installation_id, owner, repo, pr_number, head_sha, stage, error, created_at)
       VALUES (?, ?, ?, ?, ?, ?, 'pipeline', 'old boom', datetime('now', '-25 hours'))`,
    )
    .run(crypto.randomUUID(), BASE.installation_id, BASE.owner, BASE.repo, BASE.pr_number, BASE.head_sha);
}

/** Minimal D1Like that records the query text and answers COUNT = 0. */
function recordingDb(captured: string[]): D1Like {
  return {
    prepare(query: string): D1StatementLike {
      captured.push(query);
      const stmt: D1StatementLike = {
        bind(..._values: unknown[]): D1StatementLike {
          return stmt;
        },
        async first<T = Record<string, unknown>>(): Promise<T | null> {
          // The only `first()` the sweep issues is the paging window read: an
          // absent MAX is "no recent alert".
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
  test("pins the AL-6 threshold/window/timeout constants", () => {
    // Derived from the queue's delivery budget: one fully-failed message leaves
    // QUEUE_MAX_ATTEMPTS rows, so a threshold one row above it keeps "one job
    // never alerts, the second one does".
    expect(SWEEP_FAILURE_THRESHOLD).toBe(QUEUE_MAX_ATTEMPTS + 1);
    expect(SWEEP_FAILURE_THRESHOLD).toBeGreaterThan(QUEUE_MAX_ATTEMPTS);
    expect(SWEEP_WINDOW_HOURS).toBe(24);
    expect(SWEEP_WEBHOOK_TIMEOUT_MS).toBe(3000);
  });

  test("counts review_failures with the trailing-24h window SQL", async () => {
    const captured: string[] = [];
    const result = await runSweep(recordingDb(captured));
    expect(captured[0]).toContain("DELETE FROM webhook_deliveries");
    // Migration 0039: the ledger's own bounded retention, terminal rows only.
    expect(captured[1]).toContain("DELETE FROM pull_requests");
    expect(captured[1]).toContain("state IN ('closed', 'merged')");
    expect(captured[2]).toContain("UPDATE workspace_invites");
    const countAt = captured.findIndex((query) => query.includes("FROM review_failures"));
    expect(captured[countAt]).toContain("created_at > datetime('now', '-24 hours')");
    // The maintenance signal is its own trailing-window read, in the same
    // window, right after the grouped one.
    expect(captured[countAt + 1]).toContain("stage = 'maintenance_deferred'");
    expect(captured[countAt + 1]).toContain("created_at > datetime('now', '-24 hours')");
    // A healthy window has no page to de-bounce, so nothing follows the reads:
    // no state write, no audit append.
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
    // Ages are relative to the real clock — a hard-coded calendar date slides
    // out of the comparison and turns this into a date bomb.
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
    // A quiet flip logs nothing.
    expect(calls).toHaveLength(0);
    expect(first).toEqual({
      failures24h: 0,
      thresholdBreached: false,
      invitesExpired: 2,
      webhook: "not_attempted",
    });
  });

  test("a backlog larger than one run's cap drains across successive runs, losing nothing", async () => {
    const db = failureDb();
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
    const backlog = SWEEP_INVITE_LAPSE_CAP + 2;
    for (let i = 0; i < backlog; i++) {
      // Spread across both workspaces: the flip is global, not workspace-scoped.
      insert.run(`lapsed-${i}`, i % 2 === 0 ? "default" : "ws-2", `lapsed-${i}`, "pending", lapsed, lapsed);
    }
    // A live pending row and an already-accepted one must survive every run.
    insert.run("live", "default", "live", "pending", live, live);
    insert.run("accepted", "ws-2", "accepted", "accepted", lapsed, lapsed);

    const { log, calls } = captureLog();
    const first = await runSweep(db, { log });
    expect(first.invitesExpired).toBe(SWEEP_INVITE_LAPSE_CAP);
    const pendingAfterFirst = db.raw
      .query("SELECT COUNT(*) AS n FROM workspace_invites WHERE status = 'pending' AND expires_at <= ?")
      .get(lapsed) as { n: number };
    expect(pendingAfterFirst.n).toBe(backlog - SWEEP_INVITE_LAPSE_CAP);

    // The remainder is not stranded: the next run picks it up.
    const second = await runSweep(db, { log });
    expect(second.invitesExpired).toBe(backlog - SWEEP_INVITE_LAPSE_CAP);
    const third = await runSweep(db, { log });
    expect(third.invitesExpired).toBe(0);

    // Nothing lost: every backlog row is `expired`, and the two non-lapsed
    // rows kept their own status.
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
    // A bounded flip is still a quiet one: no warn line until a failure.
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
    // The old row's login sorts LAST, so the login-ordered access path the
    // candidates had before the ORDER BY would reach it only after the whole
    // cohort — and a cap-sized inflow per run never gets that far.
    const oldestExpiry = ago(10 * 24 * 60);
    insert.run("oldest", "zzz-oldest", oldestExpiry, oldestExpiry);
    /** A cap-sized cohort of newer lapsed rows, all sharing one expiry. */
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
    // The cap went to the oldest rows: the 10-day-old row, then the cohort in
    // `id` order — NOT the login-ordered slice an unordered LIMIT returns.
    expect(first.invitesExpired).toBe(SWEEP_INVITE_LAPSE_CAP);
    expect(expired().slice(0, 2)).toEqual([{ id: "oldest" }, { id: "g1-0000" }]);
    expect(expired()).toHaveLength(SWEEP_INVITE_LAPSE_CAP);
    expect(lapsedPending()).toBe(1);

    // Keep the inflow arriving at cap rate: the backlog must still drain, and
    // the surviving leftover row is the NEWEST of the previous generation.
    feed(2, 3);
    const second = await runSweep(db, { log: captureLog().log });
    expect(second.invitesExpired).toBe(SWEEP_INVITE_LAPSE_CAP);
    expect(expired()).toContainEqual({ id: "g1-0499" });

    feed(3, 1);
    await runSweep(db, { log: captureLog().log });
    expect(lapsedPending()).toBeLessThanOrEqual(SWEEP_INVITE_LAPSE_CAP);
    expect(lapsedPending()).toBeGreaterThan(0);

    // Stop feeding and drain: nothing is stranded, oldest row included.
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
  test("retention: DELETE shape (30-day window, 500-row cap, no bound params) + retention_swept log carries the deleted count", async () => {
    const captured: string[] = [];
    const binds: unknown[][] = [];
    const db: D1Like = {
      prepare(query: string): D1StatementLike {
        captured.push(query);
        const stmt: D1StatementLike = {
          bind(...values: unknown[]): D1StatementLike {
            binds.push(values);
            return stmt;
          },
          async first<T = Record<string, unknown>>(): Promise<T | null> {
            // The sweep's only `first()` is the paging window read: no MAX =
            // no recent alert.
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
    // The retention DELETE is parameter-free — no `?` placeholders to bind.
    expect(captured[0]).not.toContain("?");
    // The only TWO-placeholder statement in the run is the invite-lapse flip:
    // its ISO clock plus the per-run row cap. Every other bound statement is a
    // single key (the paging window read) — a healthy run never reaches the
    // audit append.
    const inviteBound = binds.find((values) => values.length === 2);
    expect(inviteBound).toBeDefined();
    expect(inviteBound![1]).toBe(SWEEP_INVITE_LAPSE_CAP);
    expect(binds.every((values) => values.length === 1 || values.length === 2)).toBe(true);
    // The fake reports changes: 3 for EVERY statement, so both janitors log;
    // the delivery sweep's line comes first.
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

  test("retention deletes only rows older than 30 days (real D1)", async () => {
    const db = failureDb();
    db.raw
      .query(
        `INSERT INTO review_bots (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc, created_by, created_at, updated_at)
         VALUES ('app-1', 'retention-app', 9001, 'retention-app', 'enc', 'enc', 'tester', datetime('now'), datetime('now'))`,
      )
      .run();
    // Ages are relative to the real clock — a hard-coded calendar date slides
    // out of the 30-day window and turns this test into a date bomb.
    const insertDelivery = (id: string, ageDays: number): void => {
      db.raw
        .query(
          `INSERT INTO webhook_deliveries (id, bot_id, event_name, outcome, created_at)
           VALUES (?, 'app-1', 'pull_request', 'ok', datetime('now', ?))`,
        )
        .run(id, `-${ageDays} days`);
    };
    insertDelivery("old-1", 61); // 61 days old — swept
    insertDelivery("old-2", 31); // 31 days old (just past the boundary) — swept
    insertDelivery("fresh", 1); // 1 day old — kept
    const { log } = captureLog();
    const result = await runSweep(db, { log });
    const remaining = db.raw.query("SELECT id FROM webhook_deliveries ORDER BY id").all() as Array<{ id: string }>;
    expect(remaining.map((r) => r.id)).toEqual(["fresh"]);
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
    insertPr("pr-merged-old", 1, "merged", 120); // swept
    insertPr("pr-closed-old", 2, "closed", 91); // swept
    insertPr("pr-open-old", 3, "open", 120); // KEPT — still a live target
    insertPr("pr-merged-fresh", 4, "merged", 1); // KEPT — inside the window

    const { log, calls } = captureLog();
    await runSweep(db, { log });
    const remaining = db.raw
      .query("SELECT id FROM pull_requests ORDER BY id")
      .all() as Array<{ id: string }>;
    expect(remaining.map((row) => row.id)).toEqual(["pr-merged-fresh", "pr-open-old"]);
    // The delivery sweep deletes nothing here, so the ledger line is first.
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

  test("counts only in-window rows, across the infra-failure stages (parse + runner/sandbox/pipeline)", async () => {
    const db = failureDb();
    const store = createFailureStore(db);
    for (const stage of ["parse", "runner", "sandbox", "pipeline"] as const) {
      await store.record({ ...BASE, stage, error: `boom-${stage}` });
    }
    seedOutsideWindow(db); // 25h-old row must NOT be counted

    const result = await runSweep(db, { log: captureLog().log });
    expect(result.failures24h).toBe(4);
    expect(result.thresholdBreached).toBe(false);
  });

  // `recheck` marks a budget skip, a dead seat or one invalid document; `usage`
  // marks a usage_events insert that failed while the review kept going;
  // `rate-limit` marks a degraded-comment sweep throttled by GitHub while the
  // review itself stood. All three are attribution, not review failures, and
  // the paging count must ignore them identically — one parameterized case,
  // one set of assertions.
  for (const stage of ["recheck", "usage", "rate-limit"] as const) {
    test(`${stage} rows never page ops; a runner row still counts`, async () => {
      const db = failureDb();
      const store = createFailureStore(db);
      // Six degraded-but-successful rounds is a normal day: each writes one
      // excluded row and nothing else. None of them is a review failure.
      for (let i = 0; i < 6; i++) {
        await store.record({ ...BASE, stage, error: `degraded-${i}` });
      }
      const { log, calls } = captureLog();
      const quiet = await runSweep(db, { log });
      expect(quiet.failures24h).toBe(0);
      expect(quiet.thresholdBreached).toBe(false);
      expect(calls).toHaveLength(0);
      // The rows stay in D1 as attribution — only the paging count ignores them.
      expect(db.raw.query("SELECT COUNT(*) AS n FROM review_failures").get()).toEqual({ n: 6 });

      // A review failure beside them still counts, so the exclusion is by stage
      // and not a blanket silence.
      await store.record({ ...BASE, stage: "runner", error: "boom" });
      const counted = await runSweep(db, { log: captureLog().log });
      expect(counted.failures24h).toBe(1);
      expect(counted.thresholdBreached).toBe(false);
    });
  }

  test("a quota refusal does not page ops while a sandbox failure does, and the breakdown names it", async () => {
    const db = failureDb();
    const store = createFailureStore(db);
    // One tenant's exhausted month beside one real infrastructure failure: the
    // first is a dashboard failure (commercial ceiling), the second is an
    // incident. Only the second belongs in the global alert.
    await store.record({ ...BASE, stage: "quota", error: "quota exceeded" });
    await store.record({ ...BASE, stage: "sandbox", error: "container acquisition failed" });

    const { log, calls } = captureLog();
    const quiet = await runSweep(db, { log });
    expect(quiet).toEqual({
      failures24h: 1,
      thresholdBreached: false,
      invitesExpired: 0,
      webhook: "not_attempted",
    });
    expect(calls).toHaveLength(0);
    // The quota row is still a stored failure — only paging ignores it.
    expect(db.raw.query("SELECT COUNT(*) AS n FROM review_failures").get()).toEqual({ n: 2 });

    // Push the sandbox stage over the threshold: the payload's parts are the
    // excluded-nothing total, quota absent from both.
    for (let i = 0; i < SWEEP_FAILURE_THRESHOLD; i++) {
      await store.record({ ...BASE, stage: "sandbox", error: `boom-${i}` });
    }
    const { log: breachLog, calls: breachCalls } = captureLog();
    await runSweep(db, { log: breachLog });
    const alert = breachCalls[0]!.fields as SweepAlertFields;
    expect(alert.failures_24h).toBe(SWEEP_FAILURE_THRESHOLD + 1);
    expect(alert.stages).toEqual([{ stage: "sandbox", count: SWEEP_FAILURE_THRESHOLD + 1 }]);
  });

  test("the payload's stages preserve the query's ordered, non-empty stage groups", async () => {
    const db = failureDb();
    const store = createFailureStore(db);
    // Two included stages with unequal counts, inserted biggest-first: the
    // payload must follow the query's stage order, not the insertion order, and
    // must carry no empty group for an excluded stage.
    for (let i = 0; i < 5; i++) {
      await store.record({ ...BASE, stage: "sandbox", error: `sandbox-${i}` });
    }
    for (let i = 0; i < 3; i++) {
      await store.record({ ...BASE, stage: "parse", error: `parse-${i}` });
    }
    await store.record({ ...BASE, stage: "quota", error: "quota exceeded" });

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
    await store.record({ ...BASE, stage: "maintenance_deferred", error: "maintenance_window" });
    await store.record({ ...BASE, stage: "sandbox", error: "container acquisition failed" });

    const { log, calls } = captureLog();
    const result = await runSweep(db, { log });
    expect(result.failures24h).toBe(1);
    expect(calls).toHaveLength(0);
    expect(db.raw.query("SELECT COUNT(*) AS n FROM review_failures").get()).toEqual({ n: 2 });
  });

  test("a maintenance_deferred row rides the breach payload under its own key, leaving the total alone", async () => {
    const db = failureDb();
    const store = createFailureStore(db);
    await store.record({ ...BASE, stage: "maintenance_deferred", error: "maintenance_window" });
    await seedInWindow(db, SWEEP_FAILURE_THRESHOLD + 1);

    const { log, calls } = captureLog();
    const result = await runSweep(db, { log });
    // The deferral is not infrastructure: the total, the breach decision and the
    // breakdown are the same as without it.
    expect(result.failures24h).toBe(SWEEP_FAILURE_THRESHOLD + 1);
    expect(result.thresholdBreached).toBe(true);
    const alert = calls[0]!.fields as SweepAlertFields;
    expect(alert.maintenanceDeferred).toBe(1);
    expect(alert.failures_24h).toBe(SWEEP_FAILURE_THRESHOLD + 1);
    expect(alert.stages).toEqual([{ stage: "runner", count: SWEEP_FAILURE_THRESHOLD + 1 }]);
  });

  test("threshold boundary: ONE fully-failed message's rows do not alert", async () => {
    const db = failureDb();
    // The threshold's own case: a single DLQ'd job leaves exactly this many rows
    // (one per delivery), and one failed message must never page an operator.
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
      // The seeded rows are all `runner`: the breakdown is the total's parts.
      stages: [{ stage: "runner", count: SWEEP_FAILURE_THRESHOLD + 1 }],
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

/**
 * The AUDIT WINDOW (`alert.failure_paging` in `platform_audit_events`, compass
 * D17): the sweep posts at most once per `SWEEP_WINDOW_HOURS` and nothing is
 * latched. The newest recorded alert suppresses the POST; a delivered POST
 * appends the row. A missed alert is impossible because no stored state has to
 * be cleared before the next breach can page.
 */
describe("runSweep — paging audit window", () => {
  /** Every recorded paging alert, oldest first. */
  function alertRows(db: TestD1): Array<{ actor_login: string; detail_json: string; created_at: string }> {
    return db.raw
      .query("SELECT actor_login, detail_json, created_at FROM platform_audit_events WHERE action = ? ORDER BY created_at")
      .all(ALERT_PAGING_AUDIT_ACTION) as Array<{ actor_login: string; detail_json: string; created_at: string }>;
  }

  /** Plant an alert as an earlier sweep would have left it, `at` ISO-stamped. */
  function seedAlert(db: TestD1, at: string): void {
    db.raw
      .prepare(
        `INSERT INTO platform_audit_events
           (id, actor_login, action, target_type, target_id, detail_json, created_at)
         VALUES (?, 'sweep', ?, 'sweep', 'failure_paging', '{}', ?)`,
      )
      .run(crypto.randomUUID(), ALERT_PAGING_AUDIT_ACTION, at);
  }

  /** A sink that accepts every POST and counts the calls. */
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

    // Pinned clock: the suppression is "stamp strictly earlier than the
    // reading clock", so the second sweep must read a later millisecond than
    // the row the first one wrote.
    const start = Date.parse("2026-01-01T00:00:00.000Z");
    jest.useFakeTimers();
    jest.setSystemTime(start);
    try {
      const first = await runSweep(db, { alertUrl: "https://ops.example/hook", fetchImpl, log });
      expect(first.webhook).toBe("posted");
      expect(calls()).toBe(1);
      // Only a delivered alert is recorded, and the row names the sweep.
      expect(alertRows(db)).toHaveLength(1);
      expect(alertRows(db)[0]!.actor_login).toBe("sweep");
      expect(JSON.parse(alertRows(db)[0]!.detail_json)).toEqual({
        failures_24h: SWEEP_FAILURE_THRESHOLD + 1,
        stages: [{ stage: "runner", count: SWEEP_FAILURE_THRESHOLD + 1 }],
      });

      // Same breach, fresh sweep instance: the recorded alert is inside the
      // window, so nothing is posted and nothing is appended.
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

    // An alert older than the window is not a reason to stay quiet.
    db.raw.exec("DELETE FROM platform_audit_events");
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

    // Nothing was recorded, so the next breaching sweep posts once more — the
    // documented duplicate a failed append may cause.
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
    // A clock-ahead row must not silence paging until the wall clock catches up.
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
    // Seconds ahead is not a delivered alert either: only a past stamp counts.
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
    // Same-millisecond stamp: only a STRICTLY past alert proves a delivered
    // page, so an equality cannot suppress the alert owed by this window.
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

/**
 * Comment-claim outbox (migration 0048): a claim row whose worker-side send
 * never happened must reach the queue eventually, and a claim that never gets
 * consumed must stop being retried. Real migrated DDL for the table, a
 * recording queue double for the send.
 */
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

  /** Write the operator budgets straight into the runtime-config table. */
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
    // The window restarts at THIS send, so the next sweep cannot re-send it.
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

  test("a claim at the stored attempt cap expires instead of being re-sent", async () => {
    const db = failureDb();
    // The cap is an operator setting on the runtime-config surface, not a
    // source constant: a stored 1 expires a claim one attempt in.
    seedSettings(db, { maxAttempts: 1 });
    seedClaim(db, { attempts: 1 });
    const { queue, sent } = fakeQueue();
    const { log, calls } = captureLog();

    await runSweep(db, { log, queue });

    expect(sent).toHaveLength(0);
    // The tombstone survives (never deleted: it is the dedup proof) and drops
    // the payload it no longer needs.
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

    // The row stays `queued` for the next window, but the attempt is spent:
    // a send that can never succeed reaches the cap and expires instead of
    // being retried on every sweep.
    expect(claimRow(db)).toMatchObject({ state: "queued", attempts: 1 });
    expect(calls.at(-1)?.fields).toEqual({ event: "comment_claim_outbox", resent: 0, expired: 0, failed: 1 });
  });

  test("the stored retry window drives the scan, not a source constant", async () => {
    const db = failureDb();
    // 60 s old: fresh under the 300 s absent-row default, stale under a stored
    // 30 s window.
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

    // The second claim is drained by the next sweep, never dropped.
    await runSweep(db, { log: captureLog().log, queue });
    expect(sent).toHaveLength(2);
  });

  test("a degraded settings read falls back to the documented defaults with ONE warn", async () => {
    const db = failureDb();
    // One corrupt stored value degrades the whole trio (the store's trust rule).
    db.raw
      .prepare(
        `INSERT INTO review_runtime_settings (key, value, updated_at, updated_by)
         VALUES ('review.comment_claim.retry_ms', 'abc', '2026-11-05T00:00:00.000Z', 'fixture')`,
      )
      .run();
    seedClaim(db, { ageMs: 60_000 }); // still inside the documented 300 s window
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
