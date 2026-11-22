/**
 * The operator's review-duration distribution (plan `operator-duration-cap`,
 * Task 3): the window, the sample size, percentiles, the three disjoint phase
 * buckets and a candidate cap's observed cutoff.
 *
 * Population: attempts ADMITTED in the window. The COHORT a percentile may use
 * is "`settled_ms` written and the settlement's own completion record present",
 * with one conditional guard: where the attempt froze a Check pair, that pair
 * must read terminal at or before that instant (a Check that concludes later,
 * or a row the database does not hold, means the settlement instant truncated
 * the interval). An attempt that froze no Check has no Check obligation to
 * observe, and is measured. The record says only this much:
 * THIS SETTLEMENT considered the publication obligation discharged. It does not
 * say every obligation of the attempt was proven closed, nor that the delivery
 * idempotency key is valid — that is a transporter fact, not part of the
 * interval, and nothing in this module certifies it. Everything else is counted
 * under one of the five reasons below
 * and never supplied as a zero, because "not measured" and "took no time" are
 * different answers — and only a proven interval may steer the operator's cap.
 *
 * The buckets are the attempt's own durable stamps, half-open:
 *   queue wait            [enqueued_ms, created_ms)
 *   execution             [created_ms, min(persisted_at_ms, settling_ms))
 *   publication/recovery  [min(persisted_at_ms, settling_ms), settled_ms)
 *
 * `persisted_at_ms` is the launch row's durable RESULT (execution ended), and
 * `settling_ms` is the failure settlement's own start; when both exist the
 * EARLIER is the boundary, so a failure after the result was persisted is still
 * charged to execution, not to recovery. A launch row with no result has no
 * execution boundary at all — the settlement's start is not a substitute for an
 * outcome the attempt never recorded. `settled_ms` is written only when the
 * obligations the attempt incurred are discharged: after the publication lane
 * closed and, where the attempt froze a Check, after that Check concluded. An
 * attempt that froze none has no Check lane to wait for, so a frozen Check that
 * concluded while a publication recovery was still due cannot truncate the
 * third bucket.
 */
import type { D1Like } from "../store/types";

/** The report's stated window: complete attempts admitted in the last 30 days. */
export const DURATION_REPORT_WINDOW_DAYS = 30;

const DAY_MS = 86_400_000;

/** One attempt's four durable boundaries, any of which may be missing. */
export type DurationInterval = {
  enqueuedMs: number | null;
  admittedMs: number;
  /** The durable result (or the failure settlement's start); `null` = not measured. */
  executionEndMs: number | null;
  settledMs: number | null;
};

export type DurationBuckets = {
  queueWaitMs: number;
  executionMs: number;
  publicationMs: number;
  totalMs: number;
};

export type DurationPercentiles = { p50Ms: number; p90Ms: number; maxMs: number };

/**
 * Why an admitted attempt is not in the cohort. The reasons are fixed by the
 * plan's §7.9a ruling, and each names a fact this module reads:
 *
 * - `check-open-at-settle` — the attempt froze a Check pair whose row is
 *   missing, still open, or concluded AFTER the instant it claims to have
 *   settled: its end boundary is not proven.
 * - `no-settlement-record` — the attempt settled before migration 0085 added
 *   `settled_effects`, or its record is unreadable, so nothing states what that
 *   settlement discharged. Excluded BY RULE: the delivery-time idempotency key
 *   says what the transporter did, is unobservable after its TTL, and is never
 *   used as a completion witness.
 * - `no-boundary` — no usable start or end instant: no launch row, a pre-0087
 *   row without its queue stamp, no durable result (the settlement's start is
 *   not an outcome), or boundaries that do not run forwards.
 * - `unsettled` — the record itself is not closed: no settlement instant, or a
 *   launch row whose state says no outcome was ever confirmed.
 * - `pre-prepare` — a definite create rejection: the attempt never reached
 *   prepare, so it never had an attempt boundary to measure.
 */
export type DurationExclusionReason =
  | "check-open-at-settle"
  | "no-settlement-record"
  | "no-boundary"
  | "unsettled"
  | "pre-prepare";

/** Every reason, so a caller renders all five counts and never one total. */
export type DurationReportExclusions = Record<DurationExclusionReason, number>;

export type DurationReportCutoff = {
  capMs: number;
  /** Complete attempts whose end-to-end interval exceeds the cap. */
  over: number;
  /** `over / sampleSize`; `null` when the sample is empty (not `0`). */
  share: number | null;
  /** Which phase's cumulative boundary first passed the cap. */
  crossed: { queueWait: number; execution: number; publication: number };
};

export type DurationReport = {
  window: { days: number; startMs: number; endMs: number };
  /** Complete intervals — the denominator of every percentile and cutoff. */
  sampleSize: number;
  /** `null` when nothing completed in the window: an empty sample, not zeros. */
  total: DurationPercentiles | null;
  phases: {
    queueWait: DurationPercentiles | null;
    execution: DurationPercentiles | null;
    publication: DurationPercentiles | null;
  };
  excluded: DurationReportExclusions;
  cutoff: DurationReportCutoff | null;
};

/**
 * The three disjoint phases and their sum. `null` when a boundary is missing or
 * the boundaries do not run forwards: the report counts that attempt as
 * excluded instead of inventing a zero for the unmeasured phase.
 */
export function phaseBuckets(interval: DurationInterval): DurationBuckets | null {
  const { enqueuedMs, admittedMs, executionEndMs, settledMs } = interval;
  if (enqueuedMs === null || executionEndMs === null || settledMs === null) return null;
  const queueWaitMs = admittedMs - enqueuedMs;
  const executionMs = executionEndMs - admittedMs;
  const publicationMs = settledMs - executionEndMs;
  if (queueWaitMs < 0 || executionMs < 0 || publicationMs < 0) return null;
  return { queueWaitMs, executionMs, publicationMs, totalMs: settledMs - enqueuedMs };
}

/** Nearest-rank percentiles: each answer is an observed duration, never an average. */
function percentiles(values: readonly number[]): DurationPercentiles | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const at = (percent: number): number =>
    sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil((percent / 100) * sorted.length) - 1))]!;
  return { p50Ms: at(50), p90Ms: at(90), maxMs: sorted[sorted.length - 1]! };
}

function cutoffOf(buckets: readonly DurationBuckets[], capMs: number): DurationReportCutoff {
  const crossed = { queueWait: 0, execution: 0, publication: 0 };
  let over = 0;
  for (const bucket of buckets) {
    if (bucket.totalMs <= capMs) continue;
    over += 1;
    if (bucket.queueWaitMs > capMs) crossed.queueWait += 1;
    else if (bucket.queueWaitMs + bucket.executionMs > capMs) crossed.execution += 1;
    else crossed.publication += 1;
  }
  return { capMs, over, share: buckets.length === 0 ? null : over / buckets.length, crossed };
}

type DurationRow = {
  /** The handoff's create state: `failed` is a definite create rejection. */
  handoff_state: string;
  enqueued_ms: number | null;
  created_ms: number;
  settling_ms: number | null;
  settled_ms: number | null;
  /** The settlement's completion record — the durable proof it discharged its lane. */
  settled_effects: string | null;
  persisted_at_ms: number | null;
  /** `null` when the attempt never had a launch row. */
  launch_state: string | null;
  /** The Check pair the attempt froze, and that Check row's terminal instant. */
  check_key: string | null;
  check_terminal_ms: number | null;
};

/** The earlier measured end of execution; `null` when no durable result exists. */
function executionEndOf(row: DurationRow): number | null {
  if (row.persisted_at_ms === null) return null;
  if (row.settling_ms === null) return row.persisted_at_ms;
  return Math.min(row.persisted_at_ms, row.settling_ms);
}

/** Does the row hold the settlement's completion record? */
function hasSettlementRecord(raw: string | null): boolean {
  if (raw === null) return false;
  try {
    return Array.isArray(JSON.parse(raw));
  } catch {
    // An unreadable record is SILENT, not empty: it proves nothing either way.
    return false;
  }
}

/**
 * Did the Check pair the attempt froze conclude by the instant it settled? An
 * attempt that froze no pair has no Check obligation to observe, so the guard
 * passes. Otherwise the frozen pair is the only fact that says a Check exists; a
 * terminal row is the only fact that says it concluded, and it must have
 * concluded no later than the claimed settlement — otherwise the claimed end
 * truncated the interval. A missing row is not proof: the Check may simply not
 * be written yet.
 */
function checkClosedAt(row: DurationRow, settledMs: number): boolean {
  if (row.check_key === null) return true;
  return row.check_terminal_ms !== null && row.check_terminal_ms <= settledMs;
}

/**
 * Read the report. `capMs` is the operator's candidate (analysis only — this
 * module never writes configuration and owns no key).
 */
export async function readReviewDurationReport(
  db: D1Like,
  input: { nowMs: number; capMs: number | null },
): Promise<DurationReport> {
  const startMs = input.nowMs - DURATION_REPORT_WINDOW_DAYS * DAY_MS;
  // `review_launches.attempt_id` is a primary key and `review_checks` is UNIQUE
  // on (attempt_key, generation), so neither join can multiply a handoff row.
  // The pair is the one the attempt FROZE (`attempt_key`/`attempt_generation`),
  // never the owed-settlement columns (`check_*`) those live beside.
  const rows = await db
    .prepare(
      `SELECT h.state AS handoff_state, h.enqueued_ms, h.created_ms, h.settling_ms, h.settled_ms,
              h.settled_effects,
              l.state AS launch_state, l.persisted_at_ms, l.attempt_key AS check_key,
              c.terminal_ms AS check_terminal_ms
         FROM review_attempt_handoffs h
         LEFT JOIN review_launches l ON l.attempt_id = h.attempt_id
         LEFT JOIN review_checks c
           ON c.attempt_key = l.attempt_key AND c.generation = l.attempt_generation
        WHERE h.created_ms >= ?1 AND h.created_ms < ?2`,
    )
    .bind(startMs, input.nowMs)
    .all<DurationRow>();

  const excluded: DurationReportExclusions = {
    "check-open-at-settle": 0,
    "no-settlement-record": 0,
    "no-boundary": 0,
    unsettled: 0,
    "pre-prepare": 0,
  };
  const buckets: DurationBuckets[] = [];
  for (const row of rows.results) {
    if (row.launch_state === null) {
      // No launch row: there is no execution boundary to measure from. A
      // definite create rejection never reached prepare, so it is named by that
      // fact instead of borrowing the boundary reason.
      if (row.handoff_state === "failed") excluded["pre-prepare"] += 1;
      else if (row.settled_ms === null) excluded.unsettled += 1;
      else excluded["no-boundary"] += 1;
      continue;
    }
    if (row.settled_ms === null) {
      excluded.unsettled += 1;
      continue;
    }
    if (!checkClosedAt(row, row.settled_ms)) {
      excluded["check-open-at-settle"] += 1;
      continue;
    }
    // The settlement's start is not an outcome: a row without a durable result
    // has no execution end at all. The launch row's state says whether the
    // attempt ever confirmed one.
    const executionEndMs = executionEndOf(row);
    if (executionEndMs === null) {
      if (row.launch_state === "launched") excluded.unsettled += 1;
      else excluded["no-boundary"] += 1;
      continue;
    }
    const bucket =
      row.enqueued_ms === null
        ? null
        : phaseBuckets({
            enqueuedMs: row.enqueued_ms,
            admittedMs: row.created_ms,
            executionEndMs,
            settledMs: row.settled_ms,
          });
    if (bucket === null) {
      excluded["no-boundary"] += 1;
      continue;
    }
    // The record is the settlement's own statement that the publication
    // obligation it incurred was discharged: `settled_ms` is written together
    // with it, only when the required set for that lane is complete. It is not a
    // statement about the delivery key. A settled row without one was written
    // before migration 0085, and nothing else witnesses what it discharged.
    if (!hasSettlementRecord(row.settled_effects)) {
      excluded["no-settlement-record"] += 1;
      continue;
    }
    buckets.push(bucket);
  }

  return {
    window: { days: DURATION_REPORT_WINDOW_DAYS, startMs, endMs: input.nowMs },
    sampleSize: buckets.length,
    total: percentiles(buckets.map((bucket) => bucket.totalMs)),
    phases: {
      queueWait: percentiles(buckets.map((bucket) => bucket.queueWaitMs)),
      execution: percentiles(buckets.map((bucket) => bucket.executionMs)),
      publication: percentiles(buckets.map((bucket) => bucket.publicationMs)),
    },
    excluded,
    cutoff: input.capMs === null ? null : cutoffOf(buckets, input.capMs),
  };
}
