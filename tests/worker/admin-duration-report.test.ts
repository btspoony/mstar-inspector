/**
 * note: The operator's duration analysis report — the evidence for choosing the
 * attempt cap.
 *
 * These cases pin the properties the report has to keep: the phase buckets are
 * disjoint and sum to the end-to-end interval; an empty window and a missing
 * boundary read as missing, never as a zero; and the cohort is only the
 * attempts whose settlement instant is written, whose settlement recorded the
 * publication obligation as discharged, and whose frozen Check reads terminal
 * by then — everything else lands in one of the five reasons the plan fixed.
 * The last block pins that narrow claim on the surfaces that state it.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
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
/** note: The App a seeded Check row belongs to; `review_checks.bot_id` is a foreign key. */
const APP_ID = "11111111-2222-3333-4444-555555555555";
const APP_NUMERIC_ID = 1001;

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
  db.raw
    .prepare(
      `INSERT INTO review_bots
         (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, deleted_at, created_at, updated_at)
       VALUES (?, 'duration-bot', ?, 'duration-bot', 'enc', 'enc', ?, 'active', NULL,
               datetime('now'), datetime('now'))`,
    )
    .run(APP_ID, APP_NUMERIC_ID, OPERATOR);
  return db;
}

async function getReport(db: TestD1, query = "", login: string | null = OPERATOR): Promise<Response> {
  const headers: Record<string, string> = {};
  if (login !== null) headers.Cookie = `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}`;
  return worker.fetch(
    new Request(`https://worker.local/_internal_admin/api/runtime/duration-report${query}`, { headers }),
    envFor(db),
  );
}

type AttemptSeed = {
  attemptId: string;
  /** note: The handoff's create state; `failed` is a definite create rejection. */
  handoffState?: "owed" | "ambiguous" | "created" | "failed";
  /** note: The delivery's head: the idempotency claim's identity. */
  headSha?: string;
  /** note: The original Queue send stamp; `null` models a pre-0087 row. */
  enqueuedMs: number | null;
  admittedMs: number;
  /** note: A `persisted` launch row's instant: the durable result ended execution. */
  persistedMs?: number;
  /** note: A `failed` launch row: the paid step returned a nonzero status. */
  failedMs?: number;
  /** note: A launch row whose paid step never produced a result (state `launched`). */
  launchedOnly?: boolean;
  settlingMs?: number | null;
  settledMs: number | null;
  /** note: The effects the settlement made durable — its record of which lane closed. */
  settledEffects?: string[] | null;
  /** note: The Check pair the attempt froze, and that Check row's terminal instant. */
  check?: { key: string; generation: number; terminalMs: number | null };
  /** note: A frozen pair whose Check row the database does not hold. */
  omitCheckRow?: boolean;
};

/** note: One attempt: its handoff row, plus its launch row when a paid step ran. */
function seedAttempt(db: TestD1, seed: AttemptSeed): void {
  const payload: ReviewJobPayload = { ...PAYLOAD, head_sha: seed.headSha ?? PAYLOAD.head_sha };
  // note: A settlement written today always records the lane it closed;
  // `settledEffects: null` models the pre-0085 record that says nothing.
  const settlementRecord =
    seed.settledEffects === undefined
      ? seed.settledMs === null
        ? null
        : JSON.stringify(["publication"])
      : seed.settledEffects === null
        ? null
        : JSON.stringify(seed.settledEffects);
  db.raw
    .prepare(
      `INSERT INTO review_attempt_handoffs
         (delivery_key, attempt_id, payload_json, state, deadline_ms, enqueued_ms,
          created_ms, updated_ms, settling_ms, settled_ms, settled_effects)
       VALUES (?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      seed.attemptId,
      seed.attemptId,
      JSON.stringify(payload),
      seed.handoffState ?? "created",
      seed.enqueuedMs,
      seed.admittedMs,
      seed.admittedMs,
      seed.settlingMs ?? null,
      seed.settledMs,
      settlementRecord,
    );
  const hasLaunch =
    seed.persistedMs !== undefined ||
    seed.failedMs !== undefined ||
    seed.launchedOnly === true ||
    seed.check !== undefined;
  if (!hasLaunch) return;
  const launchState =
    seed.failedMs !== undefined ? "failed" : seed.persistedMs === undefined ? "launched" : "persisted";
  db.raw
    .prepare(
      `INSERT INTO review_launches
         (attempt_id, state, claimed_at_ms, launched_at_ms, persisted_at_ms, failed_at_ms,
          result_json, result_outcome, attempt_key, attempt_generation)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      seed.attemptId,
      launchState,
      seed.admittedMs,
      seed.admittedMs,
      seed.persistedMs ?? null,
      seed.failedMs ?? null,
      seed.persistedMs === undefined ? null : "{}",
      launchState === "persisted" ? "persisted" : launchState === "failed" ? "failed" : null,
      seed.check?.key ?? null,
      seed.check?.generation ?? null,
    );
  if (seed.check === undefined || seed.omitCheckRow === true) return;
  db.raw
    .prepare(
      `INSERT INTO review_checks
         (id, bot_id, github_app_id, installation_id, owner, repo, pr_number, head_sha,
          triggered_by, action, attempt_key, generation, external_id, create_state,
          execution_deadline_ms, desired, observed, recovery_state, attempts, terminal_ms,
          created_ms, updated_ms)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'duration-report', 'review', ?, ?, ?, 'not-sent',
               ?, 'in_progress', 'unknown', 'pending', 0, ?, ?, ?)`,
    )
    .run(
      crypto.randomUUID(),
      APP_ID,
      APP_NUMERIC_ID,
      payload.installation_id,
      payload.owner,
      payload.repo,
      payload.pr_number,
      payload.head_sha,
      seed.check.key,
      seed.check.generation,
      `ext-${seed.attemptId}`,
      seed.admittedMs + 4 * DAY_MS,
      seed.check.terminalMs,
      seed.admittedMs,
      seed.check.terminalMs ?? seed.admittedMs,
    );
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
    // note: A result recorded before admission cannot be a phase boundary.
    expect(
      phaseBuckets({ enqueuedMs: 1_000, admittedMs: 4_000, executionEndMs: 3_000, settledMs: 40_000 }),
    ).toBeNull();
  });
});

describe("GET /_internal_admin/api/runtime/duration-report", () => {
  test("reports the stated window, the sample size and the tail percentiles", async () => {
    const db = fixture();
    const t0 = Date.now() - 3_600_000;
    // note: queue 2s / execution 30s / publication 8s
    seedAttempt(db, {
      attemptId: "attempt-a",
      enqueuedMs: t0,
      admittedMs: t0 + 2_000,
      persistedMs: t0 + 32_000,
      settledMs: t0 + 40_000,
    });
    // note: queue 5s / execution 10s / publication 15s
    seedAttempt(db, {
      attemptId: "attempt-b",
      enqueuedMs: t0 - 5_000,
      admittedMs: t0,
      persistedMs: t0 + 10_000,
      settledMs: t0 + 25_000,
    });
    // note: queue 0 / execution 20s / publication 1s
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
      "check-open-at-settle": 0,
      "no-settlement-record": 0,
      "no-boundary": 0,
      unsettled: 0,
      "pre-prepare": 0,
    });
    expect(body.cutoff).toBeNull();
  });

  test("a candidate cap reports the observed cutoff and which phase crossed it", async () => {
    const db = fixture();
    const t0 = Date.now() - 3_600_000;
    // note: A: total 40s, first crossed in execution (2s + 30s > 28s)
    seedAttempt(db, {
      attemptId: "attempt-a",
      enqueuedMs: t0,
      admittedMs: t0 + 2_000,
      persistedMs: t0 + 32_000,
      settledMs: t0 + 40_000,
    });
    // note: B: total 30s, first crossed in publication (15s of publication)
    seedAttempt(db, {
      attemptId: "attempt-b",
      enqueuedMs: t0,
      admittedMs: t0 + 5_000,
      persistedMs: t0 + 15_000,
      settledMs: t0 + 30_000,
    });
    // note: C: total 21s, inside the cap
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

    // note: A cap shorter than the queue wait is crossed in the queue, not execution.
    const narrow = (await (await getReport(db, "?capMs=3000")).json()) as typeof wide;
    expect(narrow.cutoff.over).toBe(3);
    expect(narrow.cutoff.crossed).toEqual({ queueWait: 1, execution: 2, publication: 0 });
  });

  test("counts every unusable boundary as no-boundary instead of a zero", async () => {
    const db = fixture();
    const t0 = Date.now() - 3_600_000;
    // note: The one complete interval: queue 2s / execution 30s / publication 8s.
    seedAttempt(db, {
      attemptId: "complete",
      enqueuedMs: t0,
      admittedMs: t0 + 2_000,
      persistedMs: t0 + 32_000,
      settledMs: t0 + 40_000,
    });
    // note: A pre-0087 row: the Queue stamp was never persisted.
    seedAttempt(db, {
      attemptId: "no-queue-stamp",
      enqueuedMs: null,
      admittedMs: t0,
      persistedMs: t0 + 10_000,
      settledMs: t0 + 20_000,
    });
    // note: Settled with no launch row at all (a moved-head skip leaves this shape).
    seedAttempt(db, { attemptId: "no-launch", enqueuedMs: t0, admittedMs: t0, settledMs: t0 + 5_000 });
    // note: A durable result BEFORE admission: the interval is not chronologically ordered.
    seedAttempt(db, {
      attemptId: "out-of-order",
      enqueuedMs: t0,
      admittedMs: t0 + 5_000,
      persistedMs: t0 + 2_000,
      settledMs: t0 + 9_000,
    });

    const body = (await (await getReport(db)).json()) as {
      sampleSize: number;
      total: { p50Ms: number; p90Ms: number; maxMs: number } | null;
      excluded: Record<string, number>;
    };
    expect(body.sampleSize).toBe(1);
    // note: The excluded rows never contribute a zero: the single interval stands alone.
    expect(body.total).toEqual({ p50Ms: 40_000, p90Ms: 40_000, maxMs: 40_000 });
    expect(body.excluded).toEqual({
      "check-open-at-settle": 0,
      "no-settlement-record": 0,
      "no-boundary": 3,
      unsettled: 0,
      "pre-prepare": 0,
    });
  });

  test("a settled attempt with no durable result is not measured: the settling start is not a boundary", async () => {
    const db = fixture();
    const t0 = Date.now() - 3_600_000;
    // note: The settlement started at +20s but the paid step never recorded a result:
    // the launch row's own state says no outcome was ever confirmed.
    seedAttempt(db, {
      attemptId: "outcome-unconfirmed",
      enqueuedMs: t0,
      admittedMs: t0,
      launchedOnly: true,
      settlingMs: t0 + 20_000,
      settledMs: t0 + 30_000,
    });
    // note: A confirmed FAILURE with no result: the outcome is known, the boundary is
    // not — `failed_at_ms` names the failure, never the end of the interval.
    seedAttempt(db, {
      attemptId: "confirmed-failure",
      enqueuedMs: t0,
      admittedMs: t0,
      failedMs: t0 + 20_000,
      settlingMs: t0 + 25_000,
      settledMs: t0 + 30_000,
    });

    const body = (await (await getReport(db)).json()) as {
      sampleSize: number;
      total: unknown;
      excluded: Record<string, number>;
    };
    expect(body.sampleSize).toBe(0);
    expect(body.total).toBeNull();
    expect(body.excluded).toEqual({
      "check-open-at-settle": 0,
      "no-settlement-record": 0,
      "no-boundary": 1,
      unsettled: 1,
      "pre-prepare": 0,
    });
  });

  test("unsettled: an admitted attempt with no settlement instant is counted, not zeroed", async () => {
    const db = fixture();
    const t0 = Date.now() - 3_600_000;
    // note: Live work: a launch row and a durable result, but no settlement yet.
    seedAttempt(db, {
      attemptId: "running",
      enqueuedMs: t0,
      admittedMs: t0,
      persistedMs: t0 + 10_000,
      settledMs: null,
    });
    // note: Work that has not started a paid step either.
    seedAttempt(db, { attemptId: "admitted", enqueuedMs: t0, admittedMs: t0, settledMs: null });

    const body = (await (await getReport(db)).json()) as {
      sampleSize: number;
      total: unknown;
      excluded: Record<string, number>;
    };
    expect(body.sampleSize).toBe(0);
    expect(body.total).toBeNull();
    expect(body.excluded).toEqual({
      "check-open-at-settle": 0,
      "no-settlement-record": 0,
      "no-boundary": 0,
      unsettled: 2,
      "pre-prepare": 0,
    });
  });

  test("pre-prepare: a definite create rejection is named, not merged with no-boundary", async () => {
    const db = fixture();
    const t0 = Date.now() - 3_600_000;
    // note: The consumer writes the handoff's `failed` state on a definite create
    // rejection and never proceeds to prepare: no launch row, no settlement.
    seedAttempt(db, { attemptId: "create-rejected", handoffState: "failed", enqueuedMs: t0, admittedMs: t0, settledMs: null });
    // note: The same MISSING launch row on an attempt that was created normally is a
    // boundary problem, not a pre-prepare failure: the two stay distinct.
    seedAttempt(db, { attemptId: "settled-without-launch", enqueuedMs: t0, admittedMs: t0, settledMs: t0 + 5_000 });

    const body = (await (await getReport(db)).json()) as { excluded: Record<string, number> };
    expect(body.excluded).toEqual({
      "check-open-at-settle": 0,
      "no-settlement-record": 0,
      "no-boundary": 1,
      unsettled: 0,
      "pre-prepare": 1,
    });
  });

  test("check-open-at-settle: a Check not proven closed at the settle instant is not measured", async () => {
    const db = fixture();
    const t0 = Date.now() - 3_600_000;
    // note: A Check that concludes AFTER the claimed settlement: the claimed end
    // truncated the interval, so its duration is not provable.
    seedAttempt(db, {
      attemptId: "check-late",
      enqueuedMs: t0,
      admittedMs: t0,
      persistedMs: t0 + 30_000,
      settledMs: t0 + 40_000,
      check: { key: "check-late", generation: 1, terminalMs: t0 + 55_000 },
    });
    // note: A Check still open at the claimed settlement.
    seedAttempt(db, {
      attemptId: "check-open",
      enqueuedMs: t0,
      admittedMs: t0,
      persistedMs: t0 + 30_000,
      settledMs: t0 + 40_000,
      check: { key: "check-open", generation: 1, terminalMs: null },
    });
    // note: A frozen pair whose Check row the database does not hold: missing is not
    // proof of a conclusion.
    seedAttempt(db, {
      attemptId: "check-missing",
      enqueuedMs: t0,
      admittedMs: t0,
      persistedMs: t0 + 30_000,
      settledMs: t0 + 40_000,
      check: { key: "check-missing", generation: 1, terminalMs: null },
      omitCheckRow: true,
    });

    const body = (await (await getReport(db)).json()) as {
      sampleSize: number;
      total: unknown;
      excluded: Record<string, number>;
    };
    expect(body.sampleSize).toBe(0);
    expect(body.total).toBeNull();
    expect(body.excluded).toEqual({
      "check-open-at-settle": 3,
      "no-settlement-record": 0,
      "no-boundary": 0,
      unsettled: 0,
      "pre-prepare": 0,
    });
  });

  test("a Check concluded at or before the settle instant keeps its interval", async () => {
    const db = fixture();
    const t0 = Date.now() - 3_600_000;
    // note: Concluded before the settlement: the obligation is proven closed.
    seedAttempt(db, {
      attemptId: "check-early",
      enqueuedMs: t0,
      admittedMs: t0,
      persistedMs: t0 + 20_000,
      settledMs: t0 + 40_000,
      check: { key: "check-early", generation: 1, terminalMs: t0 + 30_000 },
    });
    // note: Concluded AT the settlement instant: the boundary is inclusive.
    seedAttempt(db, {
      attemptId: "check-at-settle",
      enqueuedMs: t0,
      admittedMs: t0,
      persistedMs: t0 + 20_000,
      settledMs: t0 + 40_000,
      check: { key: "check-at-settle", generation: 1, terminalMs: t0 + 40_000 },
    });
    // note: A launch row with NO frozen pair owes no Check at all.
    seedAttempt(db, {
      attemptId: "no-check",
      enqueuedMs: t0,
      admittedMs: t0,
      persistedMs: t0 + 20_000,
      settledMs: t0 + 40_000,
    });

    const body = (await (await getReport(db)).json()) as {
      sampleSize: number;
      total: unknown;
      excluded: Record<string, number>;
    };
    expect(body.sampleSize).toBe(3);
    expect(body.total).toEqual({ p50Ms: 40_000, p90Ms: 40_000, maxMs: 40_000 });
    expect(body.excluded).toEqual({
      "check-open-at-settle": 0,
      "no-settlement-record": 0,
      "no-boundary": 0,
      unsettled: 0,
      "pre-prepare": 0,
    });
  });

  test("no-settlement-record: a settlement without its completion record is excluded by rule", async () => {
    const db = fixture();
    const t0 = Date.now() - 3_600_000;
    // note: A settlement written before migration 0085: `settled_ms` exists, the
    // record that would prove what it discharged does not. Nothing else can
    // witness it, so the rows are excluded.
    seedAttempt(db, {
      attemptId: "legacy-a",
      enqueuedMs: t0,
      admittedMs: t0,
      persistedMs: t0 + 20_000,
      settledMs: t0 + 30_000,
      settledEffects: null,
    });
    seedAttempt(db, {
      attemptId: "legacy-b",
      enqueuedMs: t0,
      admittedMs: t0,
      persistedMs: t0 + 20_000,
      settledMs: t0 + 40_000,
      settledEffects: null,
    });

    const body = (await (await getReport(db)).json()) as {
      sampleSize: number;
      total: unknown;
      excluded: Record<string, number>;
    };
    expect(body.sampleSize).toBe(0);
    expect(body.total).toBeNull();
    expect(body.excluded).toEqual({
      "check-open-at-settle": 0,
      "no-settlement-record": 2,
      "no-boundary": 0,
      unsettled: 0,
      "pre-prepare": 0,
    });
  });

  test("the completion record is the discharge, for either lane", async () => {
    const db = fixture();
    const t0 = Date.now() - 3_600_000;
    // note: A success lane: `publication` is the transition that closed the claim.
    seedAttempt(db, {
      attemptId: "success-lane",
      enqueuedMs: t0,
      admittedMs: t0,
      persistedMs: t0 + 20_000,
      settledMs: t0 + 30_000,
      settledEffects: ["publication"],
    });
    // note: A failure lane: its `claim-stamp` is the discharge of its own obligation.
    seedAttempt(db, {
      attemptId: "failed-lane",
      enqueuedMs: t0,
      admittedMs: t0,
      persistedMs: t0 + 20_000,
      settledMs: t0 + 30_000,
      settledEffects: ["failure-row", "claim-stamp"],
    });

    // note: Both are measured: the record the settlement wrote IS the proof, and it
    // never expires with a delivery-time key.
    const body = (await (await getReport(db)).json()) as {
      sampleSize: number;
      excluded: Record<string, number>;
    };
    expect(body.sampleSize).toBe(2);
    expect(body.excluded).toEqual({
      "check-open-at-settle": 0,
      "no-settlement-record": 0,
      "no-boundary": 0,
      unsettled: 0,
      "pre-prepare": 0,
    });
  });

  test("the five reasons account for every admitted attempt, one row at a time", async () => {
    const db = fixture();
    const t0 = Date.now() - 3_600_000;
    seedAttempt(db, {
      attemptId: "measured",
      headSha: "e".repeat(40),
      enqueuedMs: t0,
      admittedMs: t0,
      persistedMs: t0 + 20_000,
      settledMs: t0 + 30_000,
      settledEffects: ["publication"],
    });
    seedAttempt(db, {
      attemptId: "check-open",
      enqueuedMs: t0,
      admittedMs: t0,
      persistedMs: t0 + 20_000,
      settledMs: t0 + 30_000,
      check: { key: "check-open", generation: 1, terminalMs: null },
    });
    seedAttempt(db, {
      attemptId: "no-settlement-record",
      headSha: "b".repeat(40),
      enqueuedMs: t0,
      admittedMs: t0,
      persistedMs: t0 + 20_000,
      settledMs: t0 + 30_000,
      settledEffects: null,
    });
    seedAttempt(db, { attemptId: "queueless", enqueuedMs: null, admittedMs: t0, persistedMs: t0 + 20_000, settledMs: t0 + 30_000 });
    seedAttempt(db, { attemptId: "running", enqueuedMs: t0, admittedMs: t0, persistedMs: t0 + 10_000, settledMs: null });
    seedAttempt(db, { attemptId: "create-rejected", handoffState: "failed", enqueuedMs: t0, admittedMs: t0, settledMs: null });

    // note: The legacy row has no completion record, so its discharge is unproven.
    const body = (await (await getReport(db)).json()) as {
      sampleSize: number;
      excluded: Record<string, number>;
    };
    const excluded = body.excluded;
    expect(excluded).toEqual({
      "check-open-at-settle": 1,
      "no-settlement-record": 1,
      "no-boundary": 1,
      unsettled: 1,
      "pre-prepare": 1,
    });
    // note: Every admitted row is either measured or counted exactly once.
    expect(body.sampleSize + Object.values(excluded).reduce((sum, n) => sum + n, 0)).toBe(6);
  });

  test("an empty window reads as an empty sample, not as zeroes", async () => {
    const db = fixture();
    const t0 = Date.now() - 3_600_000;
    // note: Outside the window: neither counted nor zeroed.
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
      "check-open-at-settle": 0,
      "no-settlement-record": 0,
      "no-boundary": 0,
      unsettled: 0,
      "pre-prepare": 0,
    });
    expect(body.cutoff.over).toBe(0);
    // note: A share of no sample is not 0%.
    expect(body.cutoff.share).toBeNull();
  });

  test("the publication bucket runs to settlement, past an early durable result", async () => {
    const db = fixture();
    const t0 = Date.now() - 3_600_000;
    // note: Result durable at +10s, settlement started at +30s (the failure path),
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
  test("the first writer's enqueued_ms is kept for a redelivery, and an absent stamp stays absent", async () => {
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

    // note: A redelivery replays the same attempt: it may not move the origin.
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

    // note: No platform stamp: the row carries no origin, and the report counts it as
    // a missing boundary instead of measuring a fabricated zero-length wait.
    const unstamped = await reserveAttemptHandoff(db as never, {
      deliveryKey: "delivery-duration-unstamped",
      attemptId: "attempt-3",
      payload: PAYLOAD,
      nowMs: 7_000,
      deadlineMs: 907_000,
      enqueuedMs: null,
    });
    expect(unstamped.enqueuedMs).toBeNull();
  });
});

describe("what the surfaces claim the settlement record proves", () => {
  function surfaceText(relative: string): string {
    return readFileSync(new URL(relative, import.meta.url), "utf8");
  }

  test("the release note and module header claim only the settlement's discharge, never every obligation", () => {
    const release = surfaceText("../../.changes/unreleased/operator-duration-report.md");
    const module = surfaceText("../../src/admin/duration-report.ts");

    // note: The settlement record says THIS settlement considered the publication
    // obligation discharged. "Every obligation proven closed" is a claim a
    // persisted row cannot support.
    for (const text of [release, module]) {
      expect(text).not.toContain("obligations are proven closed");
      expect(text).not.toContain("义务全部证明关闭");
      expect(text).not.toContain("every obligation of that attempt proven closed");
    }
    expect(release).toContain("that settlement recorded the publication obligation as discharged");
    expect(release).toContain("该次结算把发布义务记为已解除");
    expect(module).toContain("considered the publication obligation discharged");
    // note: The Check guard is conditional — the code measures an attempt that froze
    // no Check at all — so no surface may imply every sample has one.
    expect(release).toContain("where the attempt has a frozen Check");
    expect(release).toContain("尝试若有冻结的 Check");
    expect(module).toContain("where the attempt froze a Check pair");
    expect(module).toContain("froze no Check");
    // note: The settlement's own wait is conditional too: no frozen Check means no
    // Check lane to wait for.
    expect(module).toContain("attempt that froze none has no Check lane to wait for");
  });
});
