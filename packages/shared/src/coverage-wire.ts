/**
 * The seat-coverage block the runner adds to a successful review output
 * (plan review-partial-delivery): which seats completed, why the round
 * stopped, and what was left unreviewed. Present on every successful run
 * (all seats completed → `stoppedReason: null`, `unreviewed: []`); a round
 * where no seat produced output carries NO coverage — that round is a
 * failure, not a partial review.
 *
 * This is transport metadata next to the engine envelope, never an envelope
 * field: `mstar.review/v1` is closed and its schema does not grow.
 */

/** One seat (and its scope) the round did not review. */
export type ReviewSeatUnreviewed = { seat: string; scope: readonly string[] };

/** The run's seat coverage, as the contract defines it. */
export type ReviewCoverage = {
  seatsTotal: number;
  seatsCompleted: number;
  /** `cap` when the round was stopped by the time cap, null when every seat finished. */
  stoppedReason: "cap" | null;
  unreviewed: readonly ReviewSeatUnreviewed[];
};

const COVERAGE_KEYS: Record<string, true> = {
  seatsTotal: true,
  seatsCompleted: true,
  stoppedReason: true,
  unreviewed: true,
};

const isNonEmptyString = (value: unknown): value is string =>
  typeof value === "string" && value.trim() !== "";

const isScopeList = (value: unknown): value is string[] =>
  Array.isArray(value) && value.every((entry) => isNonEmptyString(entry));

const isUnreviewedList = (value: unknown): value is ReviewSeatUnreviewed[] =>
  Array.isArray(value) &&
  value.every((entry) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) return false;
    const seat = entry as Record<string, unknown>;
    return (
      Object.keys(seat).length === 2 &&
      Object.hasOwn(seat, "seat") &&
      Object.hasOwn(seat, "scope") &&
      isNonEmptyString(seat.seat) &&
      isScopeList(seat.scope)
    );
  });

/**
 * The whole coverage guard: the exact key set, safe-integer counts with
 * `1 <= seatsCompleted <= seatsTotal`, the closed `stoppedReason` vocabulary
 * and well-formed `unreviewed` entries. A block that breaks the shape is not
 * a runner fact — the caller treats it as no coverage at all.
 */
export function isReviewCoverage(value: unknown): value is ReviewCoverage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const doc = value as Record<string, unknown>;
  if (Object.keys(doc).length !== Object.keys(COVERAGE_KEYS).length) return false;
  for (const key of Object.keys(COVERAGE_KEYS)) {
    if (!Object.hasOwn(doc, key)) return false;
  }
  const { seatsTotal, seatsCompleted, stoppedReason, unreviewed } = doc;
  return (
    typeof seatsTotal === "number" &&
    typeof seatsCompleted === "number" &&
    Number.isSafeInteger(seatsTotal) &&
    Number.isSafeInteger(seatsCompleted) &&
    seatsTotal >= 1 &&
    seatsCompleted >= 1 &&
    seatsCompleted <= seatsTotal &&
    (stoppedReason === null || stoppedReason === "cap") &&
    isUnreviewedList(unreviewed)
  );
}

/** How many scope entries one seat line shows before folding into a count. */
const MAX_SCOPE_ENTRIES = 3;
/** How many seats the not-reviewed list shows before folding into a count. */
const MAX_SEAT_ENTRIES = 3;

const scopeText = (scope: readonly string[]): string => {
  const shown = scope.slice(0, MAX_SCOPE_ENTRIES);
  const overflow = scope.length - shown.length;
  return (
    shown.join(", ") + (overflow > 0 ? `, +${overflow} more file${overflow === 1 ? "" : "s"}` : "")
  );
};

/**
 * The ONE partial-coverage sentence: the Check summary and the published body
 * render THIS text, so the two faces can never disagree about coverage (plan
 * constraint). Empty when the round was not partial (full coverage, or no
 * coverage at all) — a caller renders nothing then.
 */
export function partialSeatCoverageLine(coverage: ReviewCoverage | null | undefined): string {
  if (coverage === null || coverage === undefined) return "";
  if (coverage.seatsCompleted < 1 || coverage.seatsCompleted >= coverage.seatsTotal) return "";
  const stopped = coverage.stoppedReason === "cap" ? "; stopped by cap" : "";
  const seats = coverage.unreviewed.slice(0, MAX_SEAT_ENTRIES);
  const seatOverflow = coverage.unreviewed.length - seats.length;
  const unreviewed =
    seats.length === 0
      ? ""
      : ` — not reviewed: ${seats.map((seat) => `${seat.seat} (${scopeText(seat.scope)})`).join(", ")}` +
        (seatOverflow > 0 ? `, +${seatOverflow} more seat${seatOverflow === 1 ? "" : "s"}` : "");
  return `Reviewed ${coverage.seatsCompleted}/${coverage.seatsTotal} seats${stopped}${unreviewed}`;
}
