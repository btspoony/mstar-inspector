/**
 * Review round budget — the ONE derivation owner.
 *
 * Everything a queue-delivery review can spend is derived here from the
 * platform's Queue-consumer wall-clock cap and a named ledger of post-runner
 * step costs; the consumer (`src/pipeline/consumer.ts`) and the Check store
 * (`src/store/review-checks.ts`) import this module and NEVER import one
 * another for budget answers. Every value below is internal platform policy —
 * the cap is a platform hard limit, the ledger terms bill steps the pipeline
 * already owns — so nothing here is a configuration surface (AGENTS.md §
 * Configuration surfaces: a source constant is allowed for platform invariants
 * only, which is exactly what these are; the live terminalize setting the
 * reserve charges is read per message by the consumer and passed IN).
 *
 * The arithmetic (knowledge: best-practices/cf-queue-consumer-wall-clock):
 * a Queue consumer invocation is killed at 15 minutes, so one round's
 * `roundEnd = roundStartMs + capMs` (900_000ms in production) is the hard
 * stop, and the paid runner's PRE-RUNNER CUTOFF is `roundEnd - reserveMs`,
 * where `reserveMs = 224_000 + terminalizeMs` bills the whole post-runner
 * tail:
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

import type { ReviewLevel } from "../packages/shared/src/runtime";

/** Per-call bound for the bounded reads issued AFTER the paid runner (ms):
 * the recheck document, the recheck status, the report document and the
 * applied-model document — local file reads, never a git-sized window. */
export const POST_RUNNER_READ_TIMEOUT_MS = 30_000;
/**
 * Post-runner read WINDOWS per round — the count the reserve bills. FOUR
 * reads occupy THREE windows: `readRecheckDoc` issues the recheck document
 * and status reads in one `Promise.all`, then the report document and the
 * applied-model document each bill their own.
 */
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
/** Slack for the untimed steps (token mint, sandbox create, comment post, D1/KV puts). */
const GUARD_SLACK_MS = 120_000;

/**
 * The timed sandbox steps the admission guard bills, ONE conservative
 * `EXEC_TIMEOUT_GIT_MS` window each — the TTL's single source of truth.
 * A maximal round requires exactly this many bounded commands, and steps
 * that run under a tighter per-command bound still bill at 120s here — a
 * deliberate over-count, so the TTL stays conservative: the four PR-context
 * reads run under `PR_CONTEXT_EXEC_TIMEOUT_MS`, the post-runner reads under
 * `POST_RUNNER_READ_TIMEOUT_MS`. `full-diff` bills ONE complete diff stage:
 * the `gh pr diff` exec and the oversized fallback draw their timeouts from
 * the SAME deadline window, so the stage spends at most one 120s window
 * however it splits between the refused capture and the fallback — the
 * fallback adds no window and the TTL/backoff pins stay put. An uncounted
 * step lets the row expire while a legal review is still posting, so a new
 * one must fail the consumer suite until it is added here.
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
 * Wall-clock budget of ONE round, measured from the top of `processMessage`
 * (ms). Cloudflare caps a Queue consumer invocation at 15 minutes
 * (knowledge: best-practices/cf-queue-consumer-wall-clock), and that cap —
 * not the admission TTL, which only bounds how long the row may be held —
 * is the clock a best-effort step must fit inside. A platform invariant,
 * not a tuning knob.
 */
export const ROUND_BUDGET_MS = 900_000;

/**
 * Check execution window and attempt lease (ms): both share the SAME
 * platform cap as the round, so claim, adoption and recovery fencing cover
 * `execDeadline + reserve` measured from their actual origins. Derivation
 * outputs carry these as `checkWindowMs` / `checkLeaseMs`.
 */
export const CHECK_WINDOW_MS = ROUND_BUDGET_MS;

/** The Check terminalize setting's supported range (ms): the live value the reserve charges. */
export const TERMINALIZE_MIN_MS = 1_000;
export const TERMINALIZE_MAX_MS = 30_000;

/**
 * Runner wall-clock maximum per review level (ms) — the shipped ceiling the
 * derivation enforces, sized inside the worst-case pre-runner cutoff:
 * quick 480s, default 600s, deep 646s. `Record<ReviewLevel, …>` makes a
 * future level widen fail at compile time, never silently fall back.
 */
export const RUNNER_MAX_BUDGET_MS: Record<ReviewLevel, number> = {
  quick: 480_000,
  default: 600_000,
  deep: 646_000,
};

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
 * The single runner-budget derivation for one round. `roundStartMs` is the
 * instant `processMessage` entered; `capMs` is the round's cap (the platform
 * 900_000ms in production, smaller under test); `terminalizeMs` is the live
 * Check terminalize budget; `level` selects the tier maximum. Pure — the
 * caller supplies every instant.
 */
export type ReviewBudgetInputs = {
  roundStartMs: number;
  capMs: number;
  terminalizeMs: number;
  level: ReviewLevel;
};

/** The derived round clock and the windows other owners bill from it. */
export type ReviewBudget = {
  /** `roundStartMs + capMs`: the hard stop of this invocation. */
  roundEndMs: number;
  /** The live post-runner reserve (`224_000 + terminalizeMs` at the ledger above). */
  reserveMs: number;
  /**
   * `roundEndMs - reserveMs`: the absolute instant the paid runner must be
   * finished by. Every bounded pre-runner step declines against THIS cutoff,
   * so a round that spent its clock on the clone still keeps a real runner
   * window instead of failing the whole tier table.
   */
  runnerCutoffMs: number;
  /** `runnerCutoffMs - roundStartMs`: the most preparation may ever leave the runner. */
  preparationBudgetMs: number;
  /** This tier's shipped ceiling (ms) — the most the runner may ever request. */
  tierMaxMs: number;
  /**
   * Admission row TTL (seconds): must exceed the max review wall-clock —
   * every timed sandbox command (`GUARD_TIMED_SANDBOX_STEPS` × 120s), the
   * LEVEL's tier maximum, the whole inline-resolution budget (which runs
   * last), plus the untimed slack — so the row can never expire mid-review
   * and unblock a concurrent duplicate. 2292s quick, 2412s default, 2458s
   * deep — pinned exactly by the consumer suite, so a future step addition
   * re-breaks loudly.
   */
  guardTtlSeconds: number;
  /** Check execution window (ms): the platform cap — one row's run never outlives one invocation. */
  checkWindowMs: number;
  /** Check attempt lease (ms): the same platform cap, from the claim's own origin. */
  checkLeaseMs: number;
};

/** A derived allocation — the only shape a paid exec may start from. */
export type RunnerBudgetAnchor = {
  kind: "allocated";
  /** The tier ceiling this plan requests (a future size-based caller passes a smaller request). */
  requestedBudgetMs: number;
  /** `min(requested, cutoff - anchorMs)` — the ONE tier clamp in the whole pipeline. */
  effectiveBudgetMs: number;
  /** `anchorMs + effectiveBudgetMs`: the instant the exec, the input write and the runner all end at. */
  execDeadlineMs: number;
};

/** A spent cutoff: the exhausted window, never a fabricated positive timeout. */
export type RunnerBudgetRefusal = {
  kind: "exhausted";
  /** `cutoff - anchorMs` — how far underwater the window already is (≤ 0). */
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
  /** The request that overreached. */
  requestedBudgetMs: number;
  /** The tier ceiling the derivation enforces. */
  tierMaxMs: number;
};

export type RunnerBudgetOutcome = RunnerBudgetAnchor | RunnerBudgetRefusal | RunnerBudgetOversize;

/**
 * Derive the round's budget. The output names every window a consumer bills
 * from the same clock: the reserve, the absolute pre-runner cutoff, the
 * preparation budget, the tier maximum, the admission guard TTL, and the
 * Check window/lease that must cover `execDeadline + reserve`.
 */
export function deriveReviewBudget(inputs: ReviewBudgetInputs): ReviewBudget {
  const reserveMs = postRunnerReserveMs(inputs.terminalizeMs);
  const roundEndMs = inputs.roundStartMs + inputs.capMs;
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
 * Anchor the derived budget to the instant runner input is about to be
 * written (`anchorMs`). The request is the tier maximum — derivation policy;
 * a size-based allocation is a later caller's smaller `requestMs`. The single
 * `min()` lives HERE and nowhere else: neither the input write nor the exec
 * applies its own tier clamp or restarts the clock — both spend the same
 * `execDeadlineMs` passed on the wire. Two typed refusals: a `requestMs`
 * above `tierMaxMs` is `oversized` (the bound cannot be bypassed by asking),
 * and a nonpositive remainder is `exhausted`, so no paid exec ever starts
 * past the cutoff.
 */
export function anchorRunnerBudget(
  budget: ReviewBudget,
  anchorMs: number,
  requestMs?: number,
): RunnerBudgetOutcome {
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
