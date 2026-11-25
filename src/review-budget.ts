/**
 * Review attempt budget — the ONE derivation owner.
 *
 * The hard stop is ONE absolute instant per attempt: `deadlineMs`, frozen when
 * the delivery is first admitted as that delivery's claim time plus the
 * operator's end-to-end cap, and carried on the attempt's durable records so a
 * resume reads it instead of re-deriving it. The cap is a system row in
 * `review_runtime_settings` (read here, absent-row default below); the Queue
 * consumer's 900 000 ms wall clock no longer bounds execution — it bounds
 * admission (`reviewGuardTtlSeconds`, the Check window), which is why
 * `ROUND_BUDGET_MS` survives as that platform invariant only.
 *
 * Everything a review can spend is derived here from that instant and a named
 * ledger of post-runner step costs; the consumer (`src/pipeline/consumer.ts`)
 * and the Check store (`src/store/review-checks.ts`) import this module and
 * NEVER import one another for budget answers. Every constant below is
 * internal platform policy — the ledger terms bill steps the pipeline already
 * owns — so none is a configuration surface (AGENTS.md § Configuration
 * surfaces; the live terminalize setting the reserve charges is read per
 * message by the consumer and passed IN).
 *
 * The arithmetic: the paid runner's PRE-RUNNER CUTOFF is
 * `deadlineMs - reserveMs`, where `reserveMs = 224_000 + terminalizeMs` bills
 * the whole post-runner tail:
 *
 *   post-runner bounded reads  POST_RUNNER_READ_BUDGET_MS     90_000
 *   inline resolution          INLINE_RESOLVE_BUDGET_MS       12_000
 *   Check begin hook           CHECK_HOOK_TIMEOUT_MS           2_000
 *   untimed worker-side tail   GUARD_SLACK_MS                120_000
 *   Check terminalize          live checkBudgets.terminalizeMs 1_000–30_000
 *                        ---------------------------------------------
 *                                                             234_000 at the
 *                                              10_000ms absent-row default
 *
 * so the cutoff is 675_000ms at the supported terminalize floor, 666_000ms at
 * the default and 646_000ms at the 30_000ms ceiling. `terminalizeMs` is the
 * message's LIVE budget — the same value the terminalize hook runs on — never
 * the documented default: an operator who raises the setting owes the
 * difference out of the runner window, not out of thin air. NOT a reserve
 * term: the `queued` → `in_progress` promotion and every pre-runner sandbox
 * step (clone, captures, numstat, the input write) spend the round's own
 * clock before the cutoff instead of being billed twice.
 *
 * Tier maxima are table policy sized INSIDE that cutoff for EVERY supported
 * terminalize value: deep takes the worst-case ceiling (646_000ms), default
 * keeps its frozen 10 minutes, and quick sits one 120_000ms step window below
 * default — `quick < default < deep <= cap - reserve` over the whole
 * [1_000, 30_000] range, so a larger deep value fails the table contract at
 * the supported maximum. The shipped table is a CEILING the derivation
 * enforces, not a reservation: a late start shrinks the effective budget the
 * single min() below grants, never the table.
 */

import { PR_REVIEW_TIER_BUDGETS } from "@mstar-harness/engine";

import { getReviewAttemptCap, type DegradedReason } from "./dashboard/runtime-config-store";
import type { DashboardD1 } from "./dashboard/users";
import { RUNNER_MAX_BUDGET_MS, type ReviewLevel } from "../packages/shared/src/runtime";
import type { BudgetExhaustedOutcome } from "../packages/shared/src/budget-exhausted-wire";

/**
 * The one warn a degraded cap read owes. Its fields are this module's payload,
 * so the consumer's log channel relays them without this module importing the
 * pipeline's field type.
 */
export type ReviewAttemptCapLogFields = {
  event: "review_attempt_cap_degraded";
  degraded_reason?: DegradedReason;
};

export type ReviewAttemptCapLog = {
  warn: (fields: ReviewAttemptCapLogFields, msg?: string) => void;
};

/**
 * The operator's end-to-end attempt cap, read ONCE when the attempt is created.
 * An absent row answers the documented default; a present-but-untrusted row or
 * a read failure THROWS after one structured warn, because admission must stay
 * retryable rather than invent a cap — an invented number would silently
 * shorten or extend every review that delivery owns.
 */
export async function readReviewAttemptCapMs(db: DashboardD1, log: ReviewAttemptCapLog): Promise<number> {
  const cap = await getReviewAttemptCap(db);
  if (cap.degraded) {
    log.warn(
      { event: "review_attempt_cap_degraded", degraded_reason: cap.reason },
      "review attempt cap read degraded — admission retries instead of inventing a cap",
    );
    throw new Error("review attempt cap is not readable — the delivery must be retried, not capped");
  }
  return cap.capMs;
}

/** Per-call bound for the bounded reads issued AFTER the paid runner (ms):
 * the recheck document, the recheck status, the report document and the
 * applied-model document — local file reads, never a git-sized window. The
 * token-usage read rides the applied-model read's concurrent window, so the
 * count stays the sequential WINDOWS the tail can owe. */
export const POST_RUNNER_READ_TIMEOUT_MS = 30_000;
const POST_RUNNER_READ_COUNT = 3;
/** Worst case the post-runner tail owes those reads (ms). 90_000 at the current count. */
export const POST_RUNNER_READ_BUDGET_MS = POST_RUNNER_READ_COUNT * POST_RUNNER_READ_TIMEOUT_MS;
/** Whole inline-resolution budget (ms) across every entry of one message. */
export const INLINE_RESOLVE_BUDGET_MS = 12_000;
/**
 * Check begin-hook bound (spec: "the begin hook has ≤2 requests / 2 seconds
 * of consumer wait"). It rides the same round clock as the runner and is
 * billed in the reserve.
 */
export const CHECK_HOOK_TIMEOUT_MS = 2_000;
/**
 * gh/git per-call exec bound (ms): every sandbox exec carries an explicit
 * timeout so a hung gh/git call fails deterministically instead of silently
 * eating a container — and the admission guard bills each timed step at this
 * one conservative window even when a step's own bound is tighter.
 */
export const EXEC_TIMEOUT_GIT_MS = 120_000;
const GUARD_SLACK_MS = 120_000;

/**
 * The timed sandbox steps the admission guard bills, ONE conservative
 * `EXEC_TIMEOUT_GIT_MS` window each — the TTL's single source of truth.
 * A maximal round requires this many billed windows, and windows that run
 * under a tighter per-command bound still bill at 120s here — a deliberate
 * over-count, so the TTL stays conservative: the four PR-context reads run
 * under `PR_CONTEXT_EXEC_TIMEOUT_MS`, the post-runner reads under
 * `POST_RUNNER_READ_TIMEOUT_MS`. Concurrent command groups bill ONE window:
 * the recheck document+status pair shares `recheck-reads`, and the
 * token-usage read rides `applied-model-read` the same way. `full-diff`
 * bills ONE complete diff stage: the `gh pr diff` exec and the oversized
 * fallback draw their timeouts from the SAME deadline window, so the stage
 * spends at most one 120s window however it splits between the refused
 * capture and the fallback — the fallback adds no window and the
 * TTL/backoff pins stay put. An uncounted window lets the row expire while
 * a legal review is still posting, so a new one must fail the consumer
 * suite until it is added here.
 */
export const GUARD_TIMED_SANDBOX_STEPS: readonly string[] = [
  "clone",
  "rev-parse",
  "compare-status",
  "full-diff",
  "increment-diff",
  "numstat",
  "pr-context-view",
  "pr-context-issue-1",
  "pr-context-issue-2",
  "pr-context-issue-3",
  "runner-input-write",
  "recheck-reads",
  "report-document-read",
  "applied-model-read",
];

/**
 * The Queue consumer's wall clock (ms), measured from the top of
 * `processMessage`. Cloudflare caps a Queue consumer invocation at 15 minutes
 * (knowledge: best-practices/cf-queue-consumer-wall-clock). Execution runs on
 * the Workflow route against the attempt's frozen deadline; this constant
 * bounds the ADMISSION path — the guard TTL and the Check window — and is a
 * platform invariant, not a tuning knob and no longer the review ceiling.
 */
export const ROUND_BUDGET_MS = 900_000;

/**
 * Check execution window and attempt lease (ms): both share the SAME
 * platform cap as the round, so claim, adoption and recovery fencing cover
 * `execDeadline + reserve` measured from their actual origins. Derivation
 * outputs carry these as `checkWindowMs` / `checkLeaseMs`.
 */
export const CHECK_WINDOW_MS = ROUND_BUDGET_MS;

/**
 * Tail every round keeps after the paid seats (ms): mirrors the runner's
 * `PUBLICATION_TAIL_MS` so a finished seat still has room to publish its
 * report and comment before the exec window closes.
 */
export const PUBLICATION_TAIL_MS = 60_000;

/**
 * Wall clock one review seat costs (ms), from the measured round distribution
 * rather than one round: over 30 days of successful reviews (n = 1361) the
 * duration sat at p50 304 584 ms, p90 508 800 ms and max 647 553 ms. A seat
 * priced at 150 s put the two-seat `default` floor at 360 s — above p50, below
 * p90 — so the floor cut into the slowest tenth of ordinary rounds. The
 * observed failure was sharper than that: one head was stopped at 362 s and
 * then passed inside the same budget. A tier runs `maxSeats` concurrent model
 * calls plus their tool turns, so pricing one call underfunds every round.
 */
export const PER_SEAT_ALLOCATION_MS = 220_000;

function seatPricedFloorMs(level: ReviewLevel): number {
  return Math.min(
    PUBLICATION_TAIL_MS + PR_REVIEW_TIER_BUDGETS[level].maxSeats * PER_SEAT_ALLOCATION_MS,
    RUNNER_MAX_BUDGET_MS[level],
  );
}

export const RUNNER_BUDGET_FLOOR_MS: Record<ReviewLevel, number> = {
  quick: seatPricedFloorMs("quick"),
  default: seatPricedFloorMs("default"),
  deep: seatPricedFloorMs("deep"),
};

/**
 * Work units at which the request reaches the tier maximum. Real PRs cluster
 * at 100–1,000 changed lines, so 5,000 is reachable; the old 20,000-unit
 * boundary reached them too, but added only about 2.4–24 s at 100–1,000
 * units — too little to change what a round could finish. A sizing anchor,
 * not a throughput measurement.
 */
export const SIZE_SATURATION_WORK_UNITS = 5_000;



/** Runner maximum for `level` — the naming SSOT consumers log against. */
export function runnerTimeoutMs(level: ReviewLevel): number {
  return RUNNER_MAX_BUDGET_MS[level];
}

/**
 * Admission row TTL (seconds) for `level`: the guard must outlive the whole
 * review, so it bills every timed sandbox step, the tier maximum, the inline
 * resolution tail and the untimed slack — 2292s quick, 2412s default, 2458s
 * deep. Pinned by the consumer suite, so a future step addition re-breaks.
 */
export function reviewGuardTtlSeconds(level: ReviewLevel): number {
  return Math.ceil(
    (RUNNER_MAX_BUDGET_MS[level] +
      GUARD_TIMED_SANDBOX_STEPS.length * EXEC_TIMEOUT_GIT_MS +
      INLINE_RESOLVE_BUDGET_MS +
      GUARD_SLACK_MS) /
      1000,
  );
}

const GUARD_RELEASE_MARGIN_S = 60;

/**
 * Admission row TTL (seconds) for ONE attempt: the level's own ceiling, or what
 * the attempt's frozen deadline still needs — whichever is longer. The operator
 * cap may exceed the level's ceiling-derived TTL, so the row that serialises
 * the PR is widened to the attempt's actual hard stop instead of drifting
 * below it.
 */
export function reviewGuardTtlForDeadline(deadlineMs: number, nowMs: number, level: ReviewLevel): number {
  const attemptTtl = Math.ceil(Math.max(0, deadlineMs - nowMs) / 1000) + GUARD_RELEASE_MARGIN_S;
  return Math.max(reviewGuardTtlSeconds(level), attemptTtl);
}

/** What every round still owes AFTER the paid runner (ms); see the header table. */
export function postRunnerReserveMs(terminalizeMs: number): number {
  return (
    POST_RUNNER_READ_BUDGET_MS +
    INLINE_RESOLVE_BUDGET_MS +
    CHECK_HOOK_TIMEOUT_MS +
    GUARD_SLACK_MS +
    terminalizeMs
  );
}

/**
 * The single runner-budget derivation for one attempt. `deadlineMs` is the
 * attempt's FROZEN absolute deadline (queue send stamp + the operator cap,
 * read once at admission and stored on the attempt — never re-derived here);
 * `roundStartMs` is the instant this preparation entry began, so the windows
 * other owners bill can still say what is left of it; `terminalizeMs` is the
 * live Check terminalize budget; `level` selects the tier maximum. Pure — the
 * caller supplies every instant.
 */
export type ReviewBudgetInputs = {
  roundStartMs: number;
  deadlineMs: number;
  terminalizeMs: number;
  level: ReviewLevel;
};

/** The derived round clock and the windows other owners bill from it. */
export type ReviewBudget = {
  roundEndMs: number;
  reserveMs: number;
  runnerCutoffMs: number;
  preparationBudgetMs: number;
  tierMaxMs: number;
  guardTtlSeconds: number;
  checkWindowMs: number;
  checkLeaseMs: number;
};

/** A derived allocation — the only shape a paid exec may start from. */
export type RunnerBudgetAnchor = {
  kind: "allocated";
  requestedBudgetMs: number;
  effectiveBudgetMs: number;
  execDeadlineMs: number;
};

/** A spent cutoff: the exhausted window, never a fabricated positive timeout. */
export type RunnerBudgetRefusal = {
  kind: "exhausted";
  remainingMs: number;
};

/**
 * A request above the tier maximum: refused inside the ONE derivation, never
 * silently clamped to the table. The `requestedMs <= tierMaxMs` half of the
 * invariant holds because no allocation can carry a request the tier never
 * granted.
 */
export type RunnerBudgetOversize = {
  kind: "oversized";
  requestedBudgetMs: number;
  tierMaxMs: number;
};

/**
 * A malformed explicit request: non-finite or non-positive. Refused at the
 * shared entry BEFORE the tier bound and the cutoff math — a `NaN` request
 * must never ride the comparisons into an `allocated` with a `NaN` deadline,
 * and an explicit `0`/`negative` is `invalid`, not the `exhausted` a live
 * window would report.
 */
export type RunnerBudgetInvalid = {
  kind: "invalid";
  requestedBudgetMs: number;
};

export type RunnerBudgetOutcome = RunnerBudgetAnchor | RunnerBudgetRefusal | RunnerBudgetOversize | RunnerBudgetInvalid;

/**
 * The size facts of the SELECTED numstat (full or incremental — the consumer
 * reads it once for the seat partition and passes it through unchanged),
 * computed in the parser's single pass: `changedLines` is the textual
 * adds+deletions sum the attempt reports verbatim; `workUnits` is the
 * per-file-minimum unit count the request sizes from — one unit per
 * changed line, minimum one per file, so a binary `-/-` or zero-text row
 * still pays its unit. `null` is a known-unknown size, never a zero.
 */
export type ReviewDiffSize = {
  changedLines: number;
  workUnits: number;
};

/**
 * Parse the selected numstat stdout into `ReviewDiffSize`. `git apply
 * --numstat` emits one `<add>\t<del>\t<path>` row per file, every row
 * newline-terminated; a binary file prints `-\t-\t<path>`. `changedLines`
 * is the textual adds+deletions sum; `workUnits` sums one unit per changed
 * line, minimum one per file (a binary or `0\t0` row contributes 0 textual
 * lines and still pays its unit). Both scalars accumulate in this ONE
 * pass — there is no per-file array and no second traversal.
 *
 * `null` is a KNOWN-UNKNOWN size — never a fabricated count and never a
 * zero — returned when:
 *  - the stdout never arrived (`undefined`);
 *  - the stdout is empty while `provenEmpty` is false (empty-but-not-proven:
 *    an unproven empty read cannot be told apart from a lost or truncated
 *    one; only `provenEmpty`, the same round's diff-file evidence, settles
 *    that the diff itself is empty);
 *  - a non-empty stdout is not newline-terminated (the stream cut mid-row
 *    — a truncated tail row must not silently size the diff);
 *  - any row is malformed: other than the three expected fields, a path
 *    field absent or empty after trimming, or a count that is neither
 *    `-\t-` (binary) nor a non-empty digits-only non-negative integer;
 *  - any count or running total cannot be represented exactly as a safe
 *    integer — a value `Number()` rounds or a sum that overflows
 *    `Number.MAX_SAFE_INTEGER` is unknown size, never a corrupted count
 *    that would size the diff small.
 */
export function parseNumstatSize(
  stdout: string | undefined,
  provenEmpty: boolean,
): ReviewDiffSize | null {
  if (stdout === undefined) return null;
  const rows = stdout.split("\n");
  if (rows[rows.length - 1] === "") rows.pop();
  if (rows.length === 0) {
    return provenEmpty ? { changedLines: 0, workUnits: 0 } : null;
  }
  if (!stdout.endsWith("\n")) return null;
  let changedLines = 0;
  let workUnits = 0;
  for (const row of rows) {
    const fields = row.split("\t");
    const [adds = "", dels = "", path = ""] = fields;
    if (fields.length !== 3 || path.trim() === "") return null;
    if (adds === "-" && dels === "-") {
      workUnits += 1;
      if (!Number.isSafeInteger(workUnits)) return null;
      continue;
    }
    if (!/^\d+$/.test(adds) || !/^\d+$/.test(dels)) return null;
    const added = Number(adds);
    const deleted = Number(dels);
    if (!Number.isSafeInteger(added) || !Number.isSafeInteger(deleted)) {
      return null;
    }
    changedLines += added + deleted;
    workUnits += Math.max(1, added + deleted);
    if (!Number.isSafeInteger(changedLines) || !Number.isSafeInteger(workUnits)) {
      return null;
    }
  }
  return { changedLines, workUnits };
}

/**
 * A computed size-aware request: `floor(tier) + (tierMax - floor(tier)) *
 * units/5_000`, units saturated at `SIZE_SATURATION_WORK_UNITS`. The caller
 * feeds `requestedBudgetMs` into `anchorRunnerBudget` as `requestMs` — the
 * ONE tier clamp still lives there.
 */
export type RunnerBudgetRequest = {
  kind: "requested";
  requestedBudgetMs: number;
  workUnits: number | null;
};

/** The size-aware request, or the reused `invalid` refusal on malformed size input. */
export type RunnerBudgetRequestOutcome = RunnerBudgetRequest | RunnerBudgetInvalid;


/**
 * Derive the round's budget. The output names every window a consumer bills
 * from the same clock: the reserve, the absolute pre-runner cutoff, the
 * preparation budget, the tier maximum, the admission guard TTL, and the
 * Check window/lease that must cover `execDeadline + reserve`.
 */
export function deriveReviewBudget(inputs: ReviewBudgetInputs): ReviewBudget {
  const reserveMs = postRunnerReserveMs(inputs.terminalizeMs);
  const roundEndMs = inputs.deadlineMs;
  const runnerCutoffMs = roundEndMs - reserveMs;
  return {
    roundEndMs,
    reserveMs,
    runnerCutoffMs,
    preparationBudgetMs: runnerCutoffMs - inputs.roundStartMs,
    tierMaxMs: RUNNER_MAX_BUDGET_MS[inputs.level],
    guardTtlSeconds: reviewGuardTtlSeconds(inputs.level),
    checkWindowMs: CHECK_WINDOW_MS,
    checkLeaseMs: CHECK_WINDOW_MS,
  };
}

/**
 * Convert the selected numstat's size into the runner's requested budget —
 * the deterministic request that `anchorRunnerBudget` clamps against the
 * live cutoff; it never overrides the tier ceiling and never decides the
 * outcome. Capped linear interpolation in whole ms:
 *
 *   workUnits         = Σ max(1, linesInFile)   (binary/zero-text files pay 1)
 *   requestedMs(null) = tierMaxMs
 *   requestedMs       = floor(level)
 *                     + floor((tierMaxMs - floor(level)) * min(workUnits, 5_000) / 5_000)
 *
 * Zero work requests the floor; 5,000 units and beyond request exactly the
 * tier maximum — adjacent sizes ramp smoothly, there are no buckets; a tier
 * whose seat-priced floor clamps to its ceiling has no ramp at all. `null`
 * (numstat absent or unavailable) requests the tier maximum: an unmeasurable
 * diff is never short-changed, and the numstat is never fetched twice.
 *
 * Malformed size input — a non-integer or negative count, or a `changedLines`
 * that disagrees with the file lines — is refused with the existing
 * `invalid` vocabulary: invalid data is not treated as empty, and a
 * corrupted size must not launder into a request the review would trust.
 */
export function requestRunnerBudget(
  level: ReviewLevel,
  size: ReviewDiffSize | null,
): RunnerBudgetRequestOutcome {
  const tierMaxMs = RUNNER_MAX_BUDGET_MS[level];
  if (size === null) {
    return { kind: "requested", requestedBudgetMs: tierMaxMs, workUnits: null };
  }
  const { changedLines, workUnits } = size;
  const malformed =
    !Number.isSafeInteger(changedLines) ||
    changedLines < 0 ||
    !Number.isSafeInteger(workUnits) ||
    workUnits < changedLines;
  if (malformed) {
    return { kind: "invalid", requestedBudgetMs: Number.NaN };
  }
  const saturatedUnits = Math.min(workUnits, SIZE_SATURATION_WORK_UNITS);
  const floorMs = RUNNER_BUDGET_FLOOR_MS[level];
  const requestedBudgetMs =
    floorMs +
    Math.floor(((tierMaxMs - floorMs) * saturatedUnits) / SIZE_SATURATION_WORK_UNITS);
  return { kind: "requested", requestedBudgetMs, workUnits };
}

/**
 * Which limit an allocation's effective window actually came from: the
 * request — the level's own budget, whether the tier ceiling or a size-aware
 * request inside it — or the round's remaining window, which the single
 * `min()` above clamped it to. This is the ONLY place that distinction is
 * read, so the Check category and its operator copy cannot disagree.
 */
export function allocationCappedBy(anchor: {
  requestedBudgetMs: number;
  effectiveBudgetMs: number;
}): BudgetExhaustedOutcome["cappedBy"] {
  return anchor.effectiveBudgetMs < anchor.requestedBudgetMs ? "remaining-window" : "level-budget";
}

/**
 * Anchor the derived budget to the instant runner input is about to be
 * written (`anchorMs`). The request is the tier maximum — derivation policy;
 * a size-based allocation is a later caller's smaller `requestMs`. The single
 * `min()` lives HERE and nowhere else: neither the input write nor the exec
 * applies its own tier clamp or restarts the clock — both spend the same
 * `execDeadlineMs` passed on the wire. Three typed refusals: an explicit
 * `requestMs` that is non-finite or non-positive is `invalid` (rejected at
 * the entry, before any comparison can launder it into a deadline), a
 * request above `tierMaxMs` is `oversized` (the bound cannot be bypassed by
 * asking), and a nonpositive remainder is `exhausted`, so no paid exec ever
 * starts past the cutoff.
 */
export function anchorRunnerBudget(
  budget: ReviewBudget,
  anchorMs: number,
  requestMs?: number,
): RunnerBudgetOutcome {
  if (requestMs !== undefined && (!Number.isFinite(requestMs) || requestMs <= 0)) {
    return { kind: "invalid", requestedBudgetMs: requestMs };
  }
  const requestedBudgetMs = requestMs ?? budget.tierMaxMs;
  if (requestedBudgetMs > budget.tierMaxMs) {
    return { kind: "oversized", requestedBudgetMs, tierMaxMs: budget.tierMaxMs };
  }
  const effectiveBudgetMs = Math.min(requestedBudgetMs, budget.runnerCutoffMs - anchorMs);
  if (effectiveBudgetMs <= 0) {
    return { kind: "exhausted", remainingMs: budget.runnerCutoffMs - anchorMs };
  }
  return {
    kind: "allocated",
    requestedBudgetMs,
    effectiveBudgetMs,
    execDeadlineMs: anchorMs + effectiveBudgetMs,
  };
}
