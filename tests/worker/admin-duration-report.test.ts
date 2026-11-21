/**
 * The operator's duration analysis report — the evidence for choosing the
 * attempt cap.
 *
 * These cases pin the three properties the report has to keep: the phase
 * buckets are disjoint and sum to the end-to-end interval; an empty window and
 * a missing boundary read as missing, never as a zero; and the publication
 * bucket runs to the attempt's own settlement, so a Check that concluded early
 * cannot truncate a still-due recovery.
 */
import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import { DURATION_REPORT_WINDOW_DAYS, phaseBuckets } from "../../src/admin/duration-report";
import { readAttemptHandoff, reserveAttemptHandoff } from "../../src/store/review-route-store";
import type { ReviewJobPayload } from "../../src/contracts/review-job";

const SESSION_SECRET = ["test", "duration", "report", "session", "32-bytes!"].join("-");
const OPERATOR = "Support-Bot";
const OPERATOR_KEY = OPERATOR.toLowerCase();
const DAY_MS = 86_400_000;

const PAYLOAD: ReviewJobPayload = {
  installation_id: 1,
  owner: "acme",
  repo: "widgets",
  pr_number: 7,
  head_sha: "a".repeat(40),
  action: "opened",
  triggered_by: "pull_request",
  botRef: { appId: "bot-1" },
  targetId: "target-1",
};

function envFor(db: TestD1): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} },
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} },
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "oauth-client-secret",
    DEPLOYMENT_MODE: "saas",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    PLATFORM_OPERATORS: OPERATOR_KEY,
    DB: db,
  } as unknown as Env;
}

function fixture(): TestD1 {
  const db = createMigratedTestD1();
  db.raw
    .prepare("INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES (?, ?, 'member', ?, NULL)")
    .run(crypto.randomUUID(), OPERATOR, new Date().toISOString());
  return db;
}

async function getReport(
  db: TestD1,
  query = "",
  login: string | null = OPERATOR,
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (login !== null) headers.Cookie = `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}`;
  return worker.fetch(
    new Request(`https://worker.local/_internal_admin/api/runtime/duration-report${query}`, { headers }),
    envFor(db),
  );
}

type AttemptSeed = {
  attemptId: string;
  /** The original Queue send stamp; `null` models a pre-0087 row. */
  enqueuedMs: number | null;
  admittedMs: number;
  /** A `persisted` launch row's instant: the durable result ended execution. */
  persistedMs?: number;
  settlingMs?: number | null;
  settledMs: number | null;
  settledEffects?: string[] | null;
};

/** One attempt: its handoff row, plus its launch row when a paid step ran. */
function seedAttempt(db: TestD1, seed: AttemptSeed): void {
  db.raw
    .prepare(
      `INSERT INTO review_attempt_handoffs
         (delivery_key, attempt_id, payload_json, state, deadline_ms, enqueued_ms,
          created_ms, updated_ms, settling_ms, settled_ms, settled_effects)
       VALUES (?, ?, ?, 'created', NULL, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      seed.attemptId,
      seed.attemptId,
      JSON.stringify(PAYLOAD),
      seed.enqueuedMs,
      seed.admittedMs,
      seed.admittedMs,
      seed.settlingMs ?? null,
      seed.settledMs,
      seed.settledEffects === undefined || seed.settledEffects === null
        ? null
        : JSON.stringify(seed.settledEffects),
    );
  if (seed.persistedMs !== undefined) {
    db.raw
      .prepare(
        `INSERT INTO review_launches
           (attempt_id, state, claimed_at_ms, launched_at_ms, persisted_at_ms, result_json, result_outcome)
         VALUES (?, 'persisted', ?, ?, ?, '{}', 'persisted')`,
      )
      .run(seed.attemptId, seed.admittedMs, seed.persistedMs, seed.persistedMs);
  }
}

describe("the phase buckets", () => {
  test("are disjoint and sum to the end-to-end interval", () => {
    const buckets = phaseBuckets({
      enqueuedMs: 1_000,
      admittedMs: 4_000,
      executionEndMs: 34_000,
      settledMs: 40_000,
    });
    expect(buckets).toEqual({
      queueWaitMs: 3_000,
      executionMs: 30_000,
      publicationMs: 6_000,
      totalMs: 39_000,
    });
    expect(buckets!.queueWaitMs + buckets!.executionMs + buckets!.publicationMs).toBe(buckets!.totalMs);
  });

  test("answer a missing or out-of-order boundary with null, never a zero", () => {
    expect(
      phaseBuckets({ enqueuedMs: null, admittedMs: 4_000, executionEndMs: 34_000, settledMs: 40_000 }),
    ).toBeNull();
    expect(
      phaseBuckets({ enqueuedMs: 1_000, admittedMs: 4_000, executionEndMs: null, settledMs: 40_000 }),
    ).toBeNull();
    expect(
      phaseBuckets({ enqueuedMs: 1_000, admittedMs: 4_000, executionEndMs: 34_000, settledMs: null }),
    ).toBeNull();
    // A result recorded before admission cannot be a phase boundary.
    expect(
      phaseBuckets({ enqueuedMs: 1_000, admittedMs: 4_000, executionEndMs: 3_000, settledMs: 40_000 }),
    ).toBeNull();
  });
});

describe("GET /_internal_admin/api/runtime/duration-report", () => {
  test("reports the stated window, the sample size and the tail percentiles", async () => {
    const db = fixture();
    const t0 = Date.now() - 3_600_000;
    // queue 2s / execution 30s / publication 8s
    seedAttempt(db, {
      attemptId: "attempt-a",
      enqueuedMs: t0,
      admittedMs: t0 + 2_000,
      persistedMs: t0 + 32_000,
      settledMs: t0 + 40_000,
    });
    // queue 5s / execution 10s / publication 15s
    seedAttempt(db, {
      attemptId: "attempt-b",
      enqueuedMs: t0 - 5_000,
      admittedMs: t0,
      persistedMs: t0 + 10_000,
      settledMs: t0 + 25_000,
    });
    // queue 0 / execution 20s / publication 1s
    seedAttempt(db, {
      attemptId: "attempt-c",
      enqueuedMs: t0,
      admittedMs: t0,
      persistedMs: t0 + 20_000,
      settledMs: t0 + 21_000,
    });

    const res = await getReport(db);
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      window: { days: number; startMs: number; endMs: number };
      sampleSize: number;
      total: unknown;
      phases: { queueWait: unknown; execution: unknown; publication: unknown };
      excluded: Record<string, number>;
      cutoff: unknown;
    };
    expect(body.window.days).toBe(DURATION_REPORT_WINDOW_DAYS);
    expect(body.window.endMs - body.window.startMs).toBe(DURATION_REPORT_WINDOW_DAYS * DAY_MS);
    expect(body.sampleSize).toBe(3);
    expect(body.total).toEqual({ p50Ms: 30_000, p90Ms: 40_000, maxMs: 40_000 });
    expect(body.phases.queueWait).toEqual({ p50Ms: 2_000, p90Ms: 5_000, maxMs: 5_000 });
    expect(body.phases.execution).toEqual({ p50Ms: 20_000, p90Ms: 30_000, maxMs: 30_000 });
    expect(body.phases.publication).toEqual({ p50Ms: 8_000, p90Ms: 15_000, maxMs: 15_000 });
    expect(body.excluded).toEqual({
      unsettled: 0,
      skipped: 0,
      missingQueueStamp: 0,
      missingPhaseBoundary: 0,
      invalid: 0,
    });
    expect(body.cutoff).toBeNull();
  });

  test("a candidate cap reports the observed cutoff and which phase crossed it", async () => {
    const db = fixture();
    const t0 = Date.now() - 3_600_000;
    // A: total 40s, first crossed in execution (2s + 30s > 28s)
    seedAttempt(db, {
      attemptId: "attempt-a",
      enqueuedMs: t0,
      admittedMs: t0 + 2_000,
      persistedMs: t0 + 32_000,
      settledMs: t0 + 40_000,
    });
    // B: total 30s, first crossed in publication (15s of publication)
    seedAttempt(db, {
      attemptId: "attempt-b",
      enqueuedMs: t0,
      admittedMs: t0 + 5_000,
      persistedMs: t0 + 15_000,
      settledMs: t0 + 30_000,
    });
    // C: total 21s, inside the cap
    seedAttempt(db, {
      attemptId: "attempt-c",
      enqueuedMs: t0,
      admittedMs: t0,
      persistedMs: t0 + 20_000,
      settledMs: t0 + 21_000,
    });

    const wide = (await (await getReport(db, "?capMs=28000")).json()) as {
      cutoff: {
        capMs: number;
        over: number;
        share: number | null;
        crossed: { queueWait: number; execution: number; publication: number };
      };
    };
    expect(wide.cutoff.capMs).toBe(28_000);
    expect(wide.cutoff.over).toBe(2);
    expect(wide.cutoff.share).toBeCloseTo(2 / 3);
    expect(wide.cutoff.crossed).toEqual({ queueWait: 0, execution: 1, publication: 1 });

    // A cap shorter than the queue wait is crossed in the queue, not execution.
    const narrow = (await (await getReport(db, "?capMs=3000")).json()) as typeof wide;
    expect(narrow.cutoff.over).toBe(3);
    expect(narrow.cutoff.crossed).toEqual({ queueWait: 1, execution: 2, publication: 0 });
  });

  test("surfaces missing boundaries as exclusions instead of zeroes", async () => {
    const db = fixture();
    const t0 = Date.now() - 3_600_000;
    // The one complete interval: queue 2s / execution 30s / publication 8s.
    seedAttempt(db, {
      attemptId: "complete",
      enqueuedMs: t0,
      admittedMs: t0 + 2_000,
      persistedMs: t0 + 32_000,
      settledMs: t0 + 40_000,
    });
    // A pre-0087 row: the Queue stamp was never persisted.
    seedAttempt(db, {
      attemptId: "no-queue-stamp",
      enqueuedMs: null,
      admittedMs: t0,
      persistedMs: t0 + 10_000,
      settledMs: t0 + 20_000,
    });
    // Settled, but neither a durable result nor a settlement start exists.
    seedAttempt(db, { attemptId: "no-boundary", enqueuedMs: t0, admittedMs: t0, settledMs: t0 + 5_000 });
    // A durable result BEFORE admission: the interval is not chronologically ordered.
    seedAttempt(db, {
      attemptId: "out-of-order",
      enqueuedMs: t0,
      admittedMs: t0 + 5_000,
      persistedMs: t0 + 2_000,
      settledMs: t0 + 9_000,
    });
    // Still running.
    seedAttempt(db, { attemptId: "unsettled", enqueuedMs: t0, admittedMs: t0, settledMs: null });
    // A moved-head skip never executed, so it has no phases at all.
    seedAttempt(db, {
      attemptId: "skipped",
      enqueuedMs: t0,
      admittedMs: t0,
      settledMs: t0 + 1_000,
      settledEffects: ["skip"],
    });

    const body = (await (await getReport(db)).json()) as {
      sampleSize: number;
      total: { p50Ms: number; p90Ms: number; maxMs: number } | null;
      excluded: Record<string, number>;
    };
    expect(body.sampleSize).toBe(1);
    // The excluded rows never contribute a zero: the single interval stands alone.
    expect(body.total).toEqual({ p50Ms: 40_000, p90Ms: 40_000, maxMs: 40_000 });
    expect(body.excluded).toEqual({
      unsettled: 1,
      skipped: 1,
      missingQueueStamp: 1,
      missingPhaseBoundary: 1,
      invalid: 1,
    });
  });

  test("an empty window reads as an empty sample, not as zeroes", async () => {
    const db = fixture();
    const t0 = Date.now() - 3_600_000;
    // Outside the window: neither counted nor zeroed.
    seedAttempt(db, {
      attemptId: "too-old",
      enqueuedMs: t0 - DURATION_REPORT_WINDOW_DAYS * DAY_MS,
      admittedMs: t0 - DURATION_REPORT_WINDOW_DAYS * DAY_MS + 1_000,
      persistedMs: t0 - DURATION_REPORT_WINDOW_DAYS * DAY_MS + 2_000,
      settledMs: t0 - DURATION_REPORT_WINDOW_DAYS * DAY_MS + 3_000,
    });

    const body = (await (await getReport(db, "?capMs=1200000")).json()) as {
      sampleSize: number;
      total: unknown;
      phases: { queueWait: unknown; execution: unknown; publication: unknown };
      excluded: Record<string, number>;
      cutoff: { over: number; share: number | null };
    };
    expect(body.sampleSize).toBe(0);
    expect(body.total).toBeNull();
    expect(body.phases).toEqual({ queueWait: null, execution: null, publication: null });
    expect(body.excluded).toEqual({
      unsettled: 0,
      skipped: 0,
      missingQueueStamp: 0,
      missingPhaseBoundary: 0,
      invalid: 0,
    });
    expect(body.cutoff.over).toBe(0);
    // A share of no sample is not 0%.
    expect(body.cutoff.share).toBeNull();
  });

  test("the publication bucket runs to settlement, past an early durable result", async () => {
    const db = fixture();
    const t0 = Date.now() - 3_600_000;
    // Result durable at +10s, settlement started at +30s (the failure path),
    // settled at +70s: execution ends at the EARLIER boundary and the whole
    // post-+10s span — the Check and the recovery — stays in the third bucket.
    seedAttempt(db, {
      attemptId: "recovered",
      enqueuedMs: t0,
      admittedMs: t0,
      persistedMs: t0 + 10_000,
      settlingMs: t0 + 30_000,
      settledMs: t0 + 70_000,
    });

    const body = (await (await getReport(db)).json()) as {
      phases: {
        execution: { p50Ms: number; p90Ms: number; maxMs: number };
        publication: { p50Ms: number; p90Ms: number; maxMs: number };
      };
    };
    expect(body.phases.execution).toEqual({ p50Ms: 10_000, p90Ms: 10_000, maxMs: 10_000 });
    expect(body.phases.publication).toEqual({ p50Ms: 60_000, p90Ms: 60_000, maxMs: 60_000 });
  });

  test("refuses an invalid candidate cap, and an unauthenticated caller sees the 404", async () => {
    const db = fixture();
    for (const query of ["?capMs=abc", "?capMs=0", "?capMs=-5", "?capMs=90000000"]) {
      expect((await getReport(db, query)).status, query).toBe(400);
    }
    expect((await getReport(db, "", null)).status).toBe(404);
    expect((await getReport(db, "", "not-an-operator")).status).toBe(404);
  });
});

describe("admission records the Queue send stamp once", () => {
  test("the first writer's enqueued_ms is kept for a redelivery", async () => {
    const db = createMigratedTestD1();
    const key = "delivery-duration";
    await reserveAttemptHandoff(db as never, {
      deliveryKey: key,
      attemptId: "attempt-1",
      payload: PAYLOAD,
      nowMs: 5_000,
      deadlineMs: 905_000,
      enqueuedMs: 1_234,
    });
    expect((await readAttemptHandoff(db as never, key))?.enqueuedMs).toBe(1_234);

    // A redelivery replays the same attempt: it may not move the origin.
    const replay = await reserveAttemptHandoff(db as never, {
      deliveryKey: key,
      attemptId: "attempt-2",
      payload: PAYLOAD,
      nowMs: 6_000,
      deadlineMs: 906_000,
      enqueuedMs: 4_321,
    });
    expect(replay.attemptId).toBe("attempt-1");
    expect(replay.enqueuedMs).toBe(1_234);
  });
});
