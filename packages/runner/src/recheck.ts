/**
 * Bounded recheck model seat (spec review-lifecycle §7.8) —
 * the concurrent side channel that reassesses previously published findings
 * while the normal review seats run, without touching the mstar.review/v1
 * envelope, the seat prompts, or the deep parent's yield stream.
 *
 * Wire vocabulary (types, limits, `validateRecheckDoc`) is IMPORTED from the
 * zero-runtime-dependency contract `packages/shared/src/recheck-wire.ts` — the single
 * normative CODE copy of spec §7.3. Nothing here restates it. The sandbox
 * image mirrors the repository's `packages/` layout for this import
 * (`COPY packages/shared/src`, sandbox-image/Dockerfile; the admission is
 * guarded by tests/review/runtime-boundary.test.ts).
 *
 * Budget (spec §7.8): existing outer runner caps remain quick/default
 * 600,000ms and deep 840,000ms. The seat's cap is the anchored TIER's own
 * clock (`PR_REVIEW_TIER_BUDGETS[level].wallClockMinutes` — quick 300,000ms,
 * default 600,000ms, deep 900,000ms), bounded by
 * `outerDeadline - now - PUBLICATION_TAIL_MS` so publication keeps its tail;
 * `recheckBudget(outerDeadline, now, cap)` then clamps to that cap and to
 * `outerDeadline - now - 5000`, 0 = skip (below 30,000ms remaining). The
 * runner anchors the ABSOLUTE outer deadline once per process
 * (`anchorRecheckDeadline(startMs, level, outerDeadlineEpochMs?)` — a supplied
 * deadline replaces the tier cap, so a shortened round plans against the exec
 * it really runs under, and a start delayed by the input parse still ends at
 * that same instant); the seat evaluates
 * `currentRecheckBudget(Date.now())` at start so a late start shrinks toward
 * the shared deadline — a fresh cap after the normal review is structurally
 * impossible (the seat only ever starts concurrently, and the caller awaits
 * it on that same budget; it aborts the seat only on review failure or when
 * the outer deadline leaves no room). `RECHECK_MAX_RUNTIME_MS` survives only
 * as `recheckBudget`'s DEFAULT cap: a seat that must read up to 25 prior
 * findings cannot work inside a fixed 180s while the review seats get the
 * tier's full clock (I-000431).
 *
 * Failure contract: ANY seat failure/timeout/invalid payload logs one
 * structured stderr event and resolves `{ doc: null, status }` — it never
 * throws and never loses the review. The status document is the attributable
 * record (outcome + reason + error) the runner writes for D1; the stderr
 * event stays for container logs. Validation is `validateRecheckDoc`
 * against the FITTED assignment the seat received (a slice the fit omitted
 * is not citable proof), fail-closed at document level, row-level drops named
 * in `status.rejected_row_ids` and counted by `status.rejected`; the strict
 * outputSchema only enforces shape.
 *
 * Shared soft clock: the same `anchorRecheckDeadline` call also anchors the
 * tier's SOFT clock, and `remainingSoftMinutes(now)` is its pure view — one
 * anchor per review serves both the recheck budget (outer, hard) and the seat
 * dispatch head (soft).
 */
import type { ToolSession } from "@oh-my-pi/pi-coding-agent";
import { runStructuredSubagent, type StructuredSubagentResult } from "@oh-my-pi/pi-coding-agent/task/structured-subagent";
import { PR_REVIEW_TIER_BUDGETS } from "@mstar-harness/engine";
import {
  fitRecheckInput,
  recheckAssignment,
  RECHECK_ASSIGNMENT_MAX_BYTES,
  RECHECK_MAX_RUNTIME_MS,
  RECHECK_MIN_REMAINING_MS,
  RECHECK_STATUS_ERROR_MAX_CHARS,
  validateRecheckDoc,
  type EvidenceSlice,
  type RecheckDoc,
  type RecheckGateResult,
  type RecheckInput,
  type RecheckStatus,
  type RecheckStatusReason,
} from "../../shared/src/recheck-wire";
import { redactSecretShapes } from "../../shared/src/secret-shapes";
import type { ReviewLevel } from "../../shared/src/runtime";

// The ask's prose, its fit and its default budget are the shared wire module's
// pure rule (the consumer fits the same rule); they stay exported here for the
// runner's own callers.
export { recheckAssignment, RECHECK_ASSIGNMENT_MAX_BYTES };

/**
 * Strict shape schema for the recheck seat's structured yield. The enum
 * literals mirror the closed §7.3 vocabularies — the fail-closed SSOT for
 * every value rule (reason/disposition pairing, evidence proof, HEAD
 * equality, row membership) stays `validateRecheckDoc`; strict mode here
 * only guarantees the SHAPE before that validator runs.
 */
export const RECHECK_OUTPUT_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["schema", "headSha", "results"],
  properties: {
    schema: { enum: ["mstar.recheck/v1"] },
    headSha: { type: "string" },
    results: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["rowId", "disposition", "reason", "evidence", "relatedCurrentFindingIndexes"],
        properties: {
          rowId: { type: "string" },
          disposition: { enum: ["addressed", "dismissed", "unverifiable"] },
          reason: {
            enum: [
              "verified-fix",
              "non-fix-dismissal",
              "conflict",
              "identity-drift",
              "no-evidence",
              "omitted",
              "invalid-output",
              "budget",
              "context-incomplete",
              "stale-head",
            ],
          },
          evidence: {
            type: ["object", "null"],
            additionalProperties: false,
            required: ["kind", "sliceId", "startLine", "endLine", "quote", "explanation"],
            properties: {
              kind: { enum: ["current-code", "removed-code", "replaced-code"] },
              sliceId: { type: "string" },
              startLine: { type: "integer" },
              endLine: { type: "integer" },
              quote: { type: "string" },
              explanation: { type: "string" },
            },
          },
          relatedCurrentFindingIndexes: { type: "array", items: { type: "integer" } },
        },
      },
    },
  },
} as const;

/** The §7.8 start margin subtracted from the outer deadline (`-5000`). */
const RECHECK_START_MARGIN_MS = 5_000;

/**
 * Outer runner caps per review level (spec §7.8) — the same frozen table as
 * the consumer's RUNNER_TIMEOUT_MS (quick/default 600,000ms, deep 840,000ms).
 * Restated HERE because the in-image runner graph cannot import the workerd
 * consumer face; the values are pinned by spec §7.8. Exported so the module's
 * tests derive their expectations from this table instead of retyping it.
 */
export const OUTER_RUNNER_CAP_MS: Record<ReviewLevel, number> = {
  quick: 600_000,
  default: 600_000,
  deep: 840_000,
};

/**
 * The absolute outer deadline the runner anchored for this process
 * (`anchorRecheckDeadline`); `undefined` = no anchor (direct runtime/test
 * use) — the seat then gets the tier's unanchored budget: its cap bounded by
 * the unanchored outer guard less the publication tail.
 */
let anchoredDeadlineMs: number | undefined;

/**
 * The review's SHARED soft clock: the start instant the runner anchored plus
 * the tier it runs at. Distinct from `anchoredDeadlineMs` above — that one is
 * the OUTER exec guard (a hard budget the recheck seat derives from), while
 * this is the tier's soft convergence target (`PR_REVIEW_TIER_BUDGETS
 * [level].wallClockMinutes`): reaching it changes nothing structurally and
 * aborts nothing, it only tells a seat how much of the review's clock is left.
 * Anchored by the SAME call as the outer deadline (one clock per review, never
 * a second origin). `undefined` = no anchor (direct runtime/test use).
 */
let anchoredSoftStartMs: number | undefined;
let anchoredSoftLevel: ReviewLevel | undefined;

/**
 * Anchor the ABSOLUTE outer review deadline for this process:
 * the runner calls this ONCE per process at start (`startMs` = process
 * start, `level` = review tier). The recheck seat's budget is derived from
 * this deadline, so the seat can never outlive — or restart past — the
 * review's own wall-clock cap. `outerDeadlineEpochMs` is the caller's own exec
 * deadline in `Date.now()` ms when it supplies one (a shortened round): the
 * anchor takes that instant VERBATIM and never re-derives it from `now`, so a
 * start delayed by the input parse still ends where the exec ends instead of
 * pushing the deadline back by the delay. An instant already in the past
 * anchors a SPENT budget — `remainingOuterMs` goes negative and every seat cap
 * clamps to its floor, with `PUBLICATION_TAIL_MS` still reserved.
 * ABSENT = `startMs + OUTER_RUNNER_CAP_MS[level]`. Re-anchoring overrides
 * (assignment, not error).
 */
export function anchorRecheckDeadline(startMs: number, level: ReviewLevel, outerDeadlineEpochMs?: number): void {
  anchoredDeadlineMs = outerDeadlineEpochMs ?? startMs + OUTER_RUNNER_CAP_MS[level];
  // Same instant, same call: the soft clock shares the outer deadline's origin
  // — one anchor per review, never a second one.
  anchoredSoftStartMs = startMs;
  anchoredSoftLevel = level;
}

/**
 * Drop every anchor: the process returns to the unanchored state (the default
 * tier's full cap from "now", the default tier's full soft cap). Tests use it
 * between cases instead of choreographing a "neutral" far-future anchor, so no
 * case depends on another's leftover state — bun's module registry is
 * process-global, so that state is shared across test files.
 */
export function resetRecheckAnchor(): void {
  anchoredDeadlineMs = undefined;
  anchoredSoftStartMs = undefined;
  anchoredSoftLevel = undefined;
}

/**
 * Minutes left of the tier's SHARED soft wall-clock cap at `nowMs` — the
 * figure that rides a seat's dispatch head and the deep parent's assignment.
 * Pure `(anchor, now)` derivation (no ambient clock); NEGATIVE = the review is
 * already over its tier cap, reported as an overrun rather than clamped to 0
 * (the cap is a convergence target, never a hard stop). Unanchored → the
 * tier's full cap. `level` overrides the anchored tier for callers that
 * dispatch a different tier than the process anchor. Tier minutes come from
 * the engine budget table — the single numeric source.
 */
export function remainingSoftMinutes(nowMs: number, level?: ReviewLevel): number {
  const tier = level ?? anchoredSoftLevel ?? "default";
  const capMinutes = PR_REVIEW_TIER_BUDGETS[tier].wallClockMinutes;
  const startMs = anchoredSoftStartMs ?? nowMs;
  // Exact remaining time, never quantized: whole minutes are a DISPLAY concern
  // (a seat prompt reads in minutes), so rounding lives at the render site and
  // this value stays a correct elapsed source. Exact at the anchor, strictly
  // decreasing as `now` advances, and negative the moment the review is past
  // its cap — never clamped to 0 the way the outer budget is.
  return capMinutes - (nowMs - startMs) / 60_000;
}

/**
 * Milliseconds left of the OUTER exec guard at `nowMs` — the budget a seat's
 * hard cap derives from, as opposed to the soft convergence target
 * `remainingSoftMinutes` reports. Same anchor and same purity; unanchored
 * (direct runtime/test use) → the tier's full cap from `nowMs`, mirroring
 * `currentRecheckBudget`'s convention. `level` only picks that unanchored
 * cap, so it defaults to the anchored tier — an anchored caller need not name
 * one.
 */
export function remainingOuterMs(nowMs: number, level: ReviewLevel = anchoredSoftLevel ?? "default"): number {
  return (anchoredDeadlineMs ?? nowMs + OUTER_RUNNER_CAP_MS[level]) - nowMs;
}

/**
 * The tail of the outer guard a seat leaves for the runner's own work after it
 * stops (merge, synthesize, validate, publish) — reserved by both the review
 * seat fan-out and the recheck seat. A seat that claimed it could deliver its
 * findings after the run had already published.
 */
export const PUBLICATION_TAIL_MS = 60_000;

/**
 * The recheck budget available at `nowMs` given the anchored deadline and
 * TIER. The cap is the tier's own wall clock
 * (`PR_REVIEW_TIER_BUDGETS[level].wallClockMinutes`) — the same clock the
 * review seats run on, because a recheck round re-reads up to 25 published
 * findings and a fixed 180s killed it mid-read (I-000431) — bounded by
 * `outerDeadline - now - PUBLICATION_TAIL_MS` so the tail keeps its
 * publication room. Unanchored → the tier's unanchored budget, its cap bounded
 * by the unanchored outer guard less the publication tail, mirroring
 * `remainingOuterMs`. Pure view over `recheckBudget` — exported for tests;
 * `runRecheckSeat` calls it internally.
 */
export function currentRecheckBudget(nowMs: number): number {
  const level = anchoredSoftLevel ?? "default";
  const outerDeadlineMs = anchoredDeadlineMs ?? nowMs + OUTER_RUNNER_CAP_MS[level];
  const tierCapMs = PR_REVIEW_TIER_BUDGETS[level].wallClockMinutes * 60_000;
  return recheckBudget(
    outerDeadlineMs,
    nowMs,
    Math.min(tierCapMs, outerDeadlineMs - nowMs - PUBLICATION_TAIL_MS),
  );
}

/**
 * Recheck wall-clock budget (spec §7.8): `min(capMs, outerDeadline - now -
 * 5000)`; 0 = skip. Below `RECHECK_MIN_REMAINING_MS` of remaining budget the
 * seat is skipped entirely — a seat that cannot plausibly finish must not eat
 * the tail of the outer deadline. The floor is the contract constant (spec
 * §7.3), never a re-typed literal. `capMs` defaults to
 * `RECHECK_MAX_RUNTIME_MS`, the fixed fallback for a caller with no tier.
 */
export function recheckBudget(
  outerDeadlineMs: number,
  nowMs: number,
  capMs: number = RECHECK_MAX_RUNTIME_MS,
): number {
  if (!Number.isFinite(outerDeadlineMs) || !Number.isFinite(nowMs) || !Number.isFinite(capMs)) return 0;
  const budget = Math.min(capMs, outerDeadlineMs - nowMs - RECHECK_START_MARGIN_MS);
  if (budget < RECHECK_MIN_REMAINING_MS) return 0;
  return budget;
}

/**
 * Redact secret-shaped spans, then bound the result — never the reverse: a
 * secret straddling the cut would survive as a fragment. The patterns are the
 * SHARED canonical list (`packages/shared/src/secret-shapes.ts`): the runner
 * is packaged beside `packages/shared` in the sandbox image and cannot import
 * the Worker's `src/pipeline/redact.ts`, so it consumes the same list instead
 * of keeping a narrower copy of its own.
 */
function redactedStatusError(text: string): string {
  return redactSecretShapes(text).slice(0, RECHECK_STATUS_ERROR_MAX_CHARS);
}

/**
 * The one attribution chain every failed recheck exit shares: the validator's
 * own text, then the child's cap reason, then its own error, then its stderr
 * tail, then its exit code. A capped child settles with `exitCode: 1` and no
 * `error`/stderr and the SDK only says `unavailable` (I-000431), so the first
 * two sources are what names the seat's wall clock instead of a bare status.
 * `""` means the child settled with no attributable evidence at all — each
 * caller then supplies its own last-resort floor, so absence of evidence is
 * never recorded as if it were the child's answer.
 */
function recheckFailureEvidence(single: Partial<StructuredSubagentResult["result"]>): string {
  // Duck-typed: a foreign settled shape must not throw out of the catch, so
  // every field read is type-checked rather than trusted — including the exit
  // code, which no template literal can coerce for a symbol.
  const structuredError = single.structuredOutput?.error;
  return (
    (typeof structuredError === "string" ? structuredError : "") ||
    (typeof single.abortReason === "string" ? single.abortReason : "") ||
    (typeof single.error === "string" ? single.error : "") ||
    (typeof single.stderr === "string" ? single.stderr.slice(-200) : "") ||
    (typeof single.exitCode === "number" ? `exit ${single.exitCode}` : "")
  );
}

/**
 * The settled child result a rejection carries, when it is usable evidence:
 * only a non-null, non-array object. A foreign shape (a string, an array, a
 * null) is absence of evidence, so the catch falls back to the rejection's
 * own message instead of letting that shape erase it.
 */
function settledChildResult(error: unknown): Partial<StructuredSubagentResult["result"]> | undefined {
  const settled = (error as { result?: unknown } | null | undefined)?.result;
  return typeof settled === "object" && settled !== null && !Array.isArray(settled)
    ? (settled as Partial<StructuredSubagentResult["result"]>)
    : undefined;
}

/**
 * The strict-validated payload a settled result carries, when it is usable —
 * the ONE payload test the resolved and the rejected path share.
 */
function usableRecheckData(single: Partial<StructuredSubagentResult["result"]> | undefined): unknown {
  const structured = single?.structuredOutput;
  return structured?.status === "valid" && structured.data !== undefined ? structured.data : undefined;
}

/** Unwrap the strict-validated structured payload of the recheck child. */
function recheckStructuredData(single: Partial<StructuredSubagentResult["result"]>): unknown {
  // The payload decides: a child that reports `error` while yielding a usable
  // document keeps it, so `error` only supplies attribution when the payload
  // is unusable.
  const data = usableRecheckData(single);
  if (data !== undefined) return data;
  const evidence = recheckFailureEvidence(single) || "exit unknown";
  if (single.error) {
    throw new Error(`recheck seat failed: ${evidence}`);
  }
  throw new Error(
    `recheck seat produced no valid structured output (status ${single.structuredOutput?.status ?? "absent"}): ` +
      evidence,
  );
}

/** What the seat always resolves: the document (or null) plus the attributable status. */
export type RecheckSeatResult = { doc: RecheckDoc | null; status: RecheckStatus };

/**
 * The status a gate-accepted round reports (spec §7.8). Two empty shapes share
 * one verdict: every submitted row was dropped by the gate (`all-rows-rejected`),
 * or the seat answered a non-empty target list with zero rows (`empty-result`).
 * Either way the round produced nothing usable, so it is a FAILED round — the
 * consumer writes its `review_failures` row and blames the sent rows
 * `invalid-output`. Reporting `ok` would make such a round indistinguishable
 * from a clean one, and its rows would read "never ran".
 * Exported so that split is testable without the seat's SDK session.
 */
export function recheckRoundStatus(
  gate: Extract<RecheckGateResult, { ok: true }>,
  targetCount: number,
  headSha: string,
): RecheckStatus {
  // A row without an identity (non-object / no usable rowId) cannot be named;
  // it is counted in `rejected_unnamed` so the Worker can still attribute it by
  // position among the rows it sent — the drop is never silently lost.
  const rejectedRowIds = gate.rejected
    .flatMap((row) => (row.rowId === null ? [] : [row.rowId]))
    .sort();
  const allRowsRejected = gate.doc.results.length === 0 && gate.rejected.length > 0;
  const emptyResult =
    gate.doc.results.length === 0 && gate.rejected.length === 0 && targetCount > 0;
  const failureReason: RecheckStatusReason | null = allRowsRejected
    ? "all-rows-rejected"
    : emptyResult
      ? "empty-result"
      : null;
  return {
    schema: "mstar.recheck-status/v1",
    headSha,
    outcome: failureReason === null ? "ok" : "failed",
    reason: failureReason,
    rejected: rejectedRowIds.length,
    rejected_row_ids: rejectedRowIds,
    rejected_unnamed: gate.rejected.length - rejectedRowIds.length,
    error: null,
  };
}

/**
 * Run the bounded recheck seat (spec §7.8) against `session` —
 * the caller owns concurrency (started alongside the review work, awaited on
 * its own budget; `signal` aborts it on review failure or an exhausted outer
 * deadline) and this function NEVER
 * throws: every exit path resolves `{ doc, status }`, where `doc` is null
 * unless a validated document came back and `status` says why. The budget is
 * evaluated from the anchored outer deadline at start; 0 = skip (logged, no
 * seat started).
 */
export async function runRecheckSeat(input: {
  session: ToolSession;
  input: RecheckInput;
  model: string[];
  signal: AbortSignal;
  /** The operator's ask budget; absent → `RECHECK_ASSIGNMENT_MAX_BYTES`. */
  assignmentMaxBytes?: number;
  /** The structured-seat runner; tests inject a fake instead of mocking the SDK. */
  runSeat?: typeof runStructuredSubagent;
}): Promise<RecheckSeatResult> {
  const headSha = input.input.headSha;
  const assignmentMaxBytes = input.assignmentMaxBytes ?? RECHECK_ASSIGNMENT_MAX_BYTES;
  const runSeat = input.runSeat ?? runStructuredSubagent;
  const nowMs = Date.now();
  const maxRuntimeMs = currentRecheckBudget(nowMs);
  if (maxRuntimeMs === 0) {
    // `cause` splits the two skips that both report the closed `reason:
    // "budget"`: this one is the transient tail (the outer deadline is
    // already spent) and is re-evaluated on the next round, never a
    // configuration fault the operator must fix. The status error carries the
    // same cause so the durable document (and the failure row built from it)
    // tells the two apart without a new wire field. Both figures are the ones
    // the skip was decided on: what the outer deadline actually left, and the
    // outer time the seat's minimum budget plus the publication tail needs.
    const error = redactedStatusError(
      `recheck seat skipped (tail): the review's outer deadline left ${remainingOuterMs(nowMs)}ms, ` +
        `the seat needs at least ${RECHECK_MIN_REMAINING_MS + PUBLICATION_TAIL_MS}ms`,
    );
    console.error(JSON.stringify({ event: "recheck_skipped", reason: "budget", cause: "tail", error }));
    return { doc: null, status: { schema: "mstar.recheck-status/v1", headSha, outcome: "skipped", reason: "budget", rejected: 0, rejected_row_ids: [], rejected_unnamed: 0, error } };
  }
  const ask = fitRecheckInput(input.input, assignmentMaxBytes);
  if (!ask.ok) {
    // Targets + discussion alone overrun the seat's context budget: no seat
    // could hold the ask, so dispatching would only burn the window and lose
    // the round to an absent yield (I-000396). `budget` is the closed reason
    // for "the seat never got room" — the consumer accounts every sent row
    // `unverifiable`/`budget` and blames none of them. `cause: "config"` says
    // the shortfall is in what THIS round must ask (its targets + discussion)
    // against the configured budget, not in the clock: it is per-round, since
    // a smaller ask can fit, and raising `review.recheck.assignment_max_bytes`
    // is what fits an ask that keeps overrunning.
    const error = redactedStatusError(
      `recheck seat skipped (config): assignment exceeds the seat's context budget: targets + discussion need ` +
        `at least ${ask.requiredBytes} bytes, the budget is ${assignmentMaxBytes}`,
    );
    console.error(JSON.stringify({ event: "recheck_skipped", reason: "budget", cause: "config", error }));
    return { doc: null, status: { schema: "mstar.recheck-status/v1", headSha, outcome: "skipped", reason: "budget", rejected: 0, rejected_row_ids: [], rejected_unnamed: 0, error } };
  }
  if (ask.omittedSlices > 0) {
    // The ask fits but the catalog was starved: the round still runs, so
    // without this line a systematically tight budget shows up only as
    // unexplained `context-incomplete` rows in the published review.
    console.error(
      JSON.stringify({ event: "recheck_fitted", omitted: ask.omittedSlices, budget: assignmentMaxBytes }),
    );
  }
  let gate: RecheckGateResult;
  try {
    const result = await runSeat({
      session: input.session,
      invocationKind: "task",
      assignment: recheckAssignment(ask.input),
      agent: "mstar-review-seat",
      model: input.model,
      outputSchema: RECHECK_OUTPUT_SCHEMA,
      schemaMode: "strict",
      enableLsp: false,
      enableIrc: false,
      maxRuntimeMs,
      signal: input.signal,
    });
    // Validate against the catalog the seat was ASKED with, not the round's
    // full one: a slice the fit omitted is proof the seat never received, so
    // citing it must drop that row here rather than count it `addressed`.
    gate = validateRecheckDoc(recheckStructuredData(result.result), ask.input);
  } catch (error) {
    // A by-design abort is a CONTRACT exit, not a lost round: the caller
    // cancels this seat on review failure or when the outer deadline leaves
    // no room (spec §7.8), so the round answered nothing because it was
    // stopped — never because the model failed. `skipped`/`aborted` keeps the
    // worker from writing a failure row or blaming the rows it never answered.
    if (input.signal.aborted) {
      console.error(JSON.stringify({ event: "recheck_seat_aborted", reason: "aborted" }));
      return { doc: null, status: { schema: "mstar.recheck-status/v1", headSha, outcome: "skipped", reason: "aborted", rejected: 0, rejected_row_ids: [], rejected_unnamed: 0, error: null } };
    }
    // The SDK rejects with `StructuredSubagentError`, whose duck-typed
    // `{ result }` carries the settled child's yield; read it here so the
    // never-throws path imports no SDK internals. Only a plain object counts
    // as evidence — a foreign shape falls back to the rejection's own message
    // rather than erasing it.
    const settled = settledChildResult(error);
    // A valid yield is never discarded: the child finished and attached its
    // document before a post-settle SDK step failed, so it passes the very
    // same validation boundary (and gate-derived status) as a resolved round.
    const yielded = usableRecheckData(settled);
    if (yielded !== undefined) {
      gate = validateRecheckDoc(yielded, ask.input);
    } else {
      const message = redactedStatusError(
        (settled === undefined ? "" : recheckFailureEvidence(settled)) ||
          (error instanceof Error ? error.message : String(error)) ||
          "exit unknown",
      );
      console.error(JSON.stringify({ event: "recheck_seat_failed", error: message }));
      return { doc: null, status: { schema: "mstar.recheck-status/v1", headSha, outcome: "failed", reason: "seat-failed", rejected: 0, rejected_row_ids: [], rejected_unnamed: 0, error: message } };
    }
  }
  if (!gate.ok) {
    const error = redactedStatusError(gate.error);
    console.error(JSON.stringify({ event: "recheck_seat_failed", error: `recheck document failed validation: ${error}` }));
    return { doc: null, status: { schema: "mstar.recheck-status/v1", headSha, outcome: "failed", reason: "invalid-document", rejected: 0, rejected_row_ids: [], rejected_unnamed: 0, error } };
  }
  return {
    doc: gate.doc,
    status: recheckRoundStatus(gate, input.input.targets.length, headSha),
  };
}
