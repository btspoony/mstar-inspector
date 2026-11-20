/**
 * Budget-exhaustion vocabulary — the runner's structured stop signal and the
 * typed terminal outcome the Worker normalizes it into. Zero I/O, zero SDK
 * imports, safe to import from BOTH runtime faces (container Bun and
 * workerd), same rule as every `*-wire.ts` module here.
 *
 * Two separate documents, deliberately:
 *
 *  - `ReviewBudgetExhaustedSignal` (`mstar.review-budget-exhausted/v1`): the
 *    exit-0 stdout alternative the in-image runner emits when the runner's
 *    OWN deadline evidence stops review work — a fan-out seat its
 *    `task.maxRuntimeMs` cap aborted, or the deep parent turn stopped at the
 *    anchored outer deadline. The runner reports a FACT it observed (how many
 *    primary review seats it dispatched and how many the deadline stopped),
 *    nothing more: tier, budget and diff size are facts the Worker's budget
 *    owner already holds, and no model payload may supply this result — it is
 *    produced by runner code at the stdout boundary, never by a seat's yield.
 *    The Worker validates this separate schema BEFORE the envelope gate: safe
 *    integers, `0 <= stopped <= dispatched`, exact keys.
 *
 *  - `BudgetExhaustedOutcome` (`kind: "budget-exhausted"`): the typed
 *    TERMINAL EXECUTION OUTCOME the Worker resolves the signal, a consumer
 *    deadline refusal and a sandbox deadline kill into — outside the
 *    `mstar.review/v1` verdict envelope (the engine vocabulary keeps
 *    `incomplete` for genuinely partial non-budget publication; an exhausted
 *    budget is a failure record, never a verdict on the PR). `cause` names
 *    whose clock stopped the attempt, `budgetWindow` names which derived
 *    window the stop drew on. `tier` and `budgetMs` always come from THIS
 *    attempt's derivation; `seatsDispatched` / `seatsStopped` /
 *    `changedLines` are required keys with NULLABLE values — an unobserved
 *    fact stays `null`, never inferred from a tier, another attempt, or a
 *    zero.
 */

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

/** The signal document's exact key set — nothing else may ride it. */
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
  // The schema literal is the whole discriminator: without it the document
  // is unrelated stdout, whatever counts it carries. Keys must be exact OWN
  // names — `in` would admit inherited names like `constructor` as document
  // keys, so the key table is probed with `Object.hasOwn`.
  if (doc.schema !== REVIEW_BUDGET_EXHAUSTED_SCHEMA) return false;
  // Reads traverse the prototype, so the required keys must be own properties
  // too — `Object.keys` alone cannot see an inherited `seatsStopped`.
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
  /** The recheck round's settled document, or null; attached by the runtime before the throw propagates. */
  recheck: RecheckDoc | null = null;
  /** The recheck round's status, when a recheck round ran. */
  recheckStatus?: RecheckStatus;
  /** The provider/model the run's sessions actually served, when one did. */
  appliedModel?: string;
  /** Always null — a report seat needs a settled envelope and never runs on this path. */
  readonly report: ReportDoc | null = null;

  constructor(seatsDispatched: number, seatsStopped: number) {
    super(
      `review budget exhausted: runner deadline stopped ${seatsStopped} of ${seatsDispatched} dispatched seats`,
    );
    this.name = "RunnerBudgetExhausted";
    this.seatsDispatched = seatsDispatched;
    this.seatsStopped = seatsStopped;
  }

  /** The stdout document this stop publishes — validated by {@link isReviewBudgetExhaustedSignal} at the boundary. */
  signal(): ReviewBudgetExhaustedSignal {
    return {
      schema: REVIEW_BUDGET_EXHAUSTED_SCHEMA,
      seatsDispatched: this.seatsDispatched,
      seatsStopped: this.seatsStopped,
    };
  }
}
