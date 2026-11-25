
import type { RecheckDoc, RecheckStatus } from "./recheck-wire";
import type { ReportDoc } from "./report-wire";
import type { ReviewLevel } from "./runtime";

/** The signal document's schema literal — the whole discriminator. */
export const REVIEW_BUDGET_EXHAUSTED_SCHEMA = "mstar.review-budget-exhausted/v1" as const;

/**
 * What the runner reports on stdout when its own deadline evidence stops the
 * review: the exact `{ schema, seatsDispatched, seatsStopped }` document.
 * Counts name PRIMARY review seats only — the quick/default fan-out seats or
 * the one deep parent (whose own `task` children are invisible to the
 * caller); the optional recheck and report seats are never dispatched or
 * counted here.
 */
export type ReviewBudgetExhaustedSignal = {
  schema: typeof REVIEW_BUDGET_EXHAUSTED_SCHEMA;
  seatsDispatched: number;
  seatsStopped: number;
};

/**
 * The typed budget-exhausted outcome — ONE vocabulary for every way a wall
 * clock can end a review attempt before it produced an envelope:
 *   - `cause` — whose clock stopped the attempt: the in-image runner's own
 *     deadline (`runner-deadline`), the Worker's derived cutoff declining a
 *     step (`consumer-deadline`), or the sandbox exec killed at its deadline
 *     (`sandbox-kill`);
 *   - `budgetWindow` — which derived window the stop drew on: the runner
 *     window frozen before the input write (`runner`), or the already derived
 *     preparation window that expired before the runner ever received an
 *     allocation (`preparation`);
 *   - `tier` / `budgetMs` — this attempt's derived tier and effective budget,
 *     always present (required facts, never unobserved);
 *   - `seatsDispatched` / `seatsStopped` / `changedLines` — observed facts,
 *     `null` when this attempt never produced them (a pre-dispatch decline
 *     may prove `0`/`0`; a hard kill with no runner evidence may prove
 *     nothing).
 */
export type BudgetExhaustedOutcome = {
  kind: "budget-exhausted";
  cause: "runner-deadline" | "consumer-deadline" | "sandbox-kill";
  budgetWindow: "runner" | "preparation";
  tier: ReviewLevel;
  budgetMs: number;
  seatsDispatched: number | null;
  seatsStopped: number | null;
  changedLines: number | null;
};

const SIGNAL_KEYS: Record<string, true> = { schema: true, seatsDispatched: true, seatsStopped: true };

/**
 * The whole signal guard: the schema literal, the exact key set, and safe
 * integer counts with `0 <= seatsStopped <= seatsDispatched`. A document that
 * claims the literal but breaks the counts is NOT a runner fact — reject it
 * rather than admit a count the runner could not have reported.
 */
export function isReviewBudgetExhaustedSignal(value: unknown): value is ReviewBudgetExhaustedSignal {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const doc = value as Record<string, unknown>;
  if (doc.schema !== REVIEW_BUDGET_EXHAUSTED_SCHEMA) return false;
  for (const key of Object.keys(SIGNAL_KEYS)) {
    if (!Object.hasOwn(doc, key)) return false;
  }
  if (Object.keys(doc).some((key) => !Object.hasOwn(SIGNAL_KEYS, key))) return false;
  const { seatsDispatched, seatsStopped } = doc;
  return (
    typeof seatsDispatched === "number" &&
    typeof seatsStopped === "number" &&
    Number.isSafeInteger(seatsDispatched) &&
    Number.isSafeInteger(seatsStopped) &&
    seatsStopped >= 0 &&
    seatsStopped <= seatsDispatched
  );
}

/**
 * The run's terminal budget stop: the review cannot produce an envelope, so
 * `runReview` throws this carrying the signal FACTS it observed — the counts
 * are required (the runner only throws when it knows them) and are what the
 * CLI's exit-0 stdout alternative serializes. The recheck seat's settled
 * attribution and the applied model ride the same object so the CLI can write
 * their side documents exactly as it would on an envelope path (they are not
 * part of the signal document — the signal's key set is closed).
 */
export class RunnerBudgetExhausted extends Error {
  readonly seatsDispatched: number;
  readonly seatsStopped: number;
  recheck: RecheckDoc | null = null;
  recheckStatus?: RecheckStatus;
  appliedModel?: string;
  readonly report: ReportDoc | null = null;

  constructor(seatsDispatched: number, seatsStopped: number) {
    super(
      `review budget exhausted: runner deadline stopped ${seatsStopped} of ${seatsDispatched} dispatched seats`,
    );
    this.name = "RunnerBudgetExhausted";
    this.seatsDispatched = seatsDispatched;
    this.seatsStopped = seatsStopped;
  }

  signal(): ReviewBudgetExhaustedSignal {
    return {
      schema: REVIEW_BUDGET_EXHAUSTED_SCHEMA,
      seatsDispatched: this.seatsDispatched,
      seatsStopped: this.seatsStopped,
    };
  }
}

/**
 * A review that produced NO usable seat output, and was not stopped by the cap.
 * It is a genuine failure (the CLI exits non-zero, the worker records
 * `review.budget.runner_spent`), but the side facts gathered before the seats
 * settled are still real: a settled recheck round validated older findings and
 * its document must not disappear with the main review. Same transport shape as
 * `RunnerBudgetExhausted` — the error carries the facts, the CLI writes them.
 */
export class ReviewNoOutputFailure extends Error {
  recheck: RecheckDoc | null = null;
  recheckStatus?: RecheckStatus;

  constructor(readonly cause: string) {
    super(`review produced no usable seat output: ${cause}`);
    this.name = "ReviewNoOutputFailure";
  }
}
