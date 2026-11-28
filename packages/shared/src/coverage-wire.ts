/** Seat coverage: see docs/specs/feature/review-lifecycle.md § 7.8. */

/**
 * One seat (and its scope) the round did not review, with WHY it stopped in
 * the bounded slug vocabulary: `cap` for the time cap, `failed` for any other
 * stop, `failed:<slug>` when a cause is known. Per-seat reasons are what make a
 * MIXED round (one capped, one failed) unambiguous.
 */
export type ReviewSeatUnreviewed = { seat: string; scope: readonly string[]; reason: string };

/** The run's seat coverage, as the contract defines it. */
export type ReviewCoverage = {
  seatsTotal: number;
  seatsCompleted: number;
  stoppedReason: "cap" | "failed" | null;
  unreviewed: readonly ReviewSeatUnreviewed[];
};

const REASON_MAX_CHARS = 40;

const REASON_RE = /^(?:cap|failed|failed:[\w.:=-]+)$/;

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
      Object.keys(seat).length === 3 &&
      Object.hasOwn(seat, "seat") &&
      Object.hasOwn(seat, "scope") &&
      Object.hasOwn(seat, "reason") &&
      isNonEmptyString(seat.seat) &&
      isScopeList(seat.scope) &&
      typeof seat.reason === "string" &&
      seat.reason.length <= REASON_MAX_CHARS &&
      REASON_RE.test(seat.reason)
    );
  });

/**
 * The whole coverage guard: the exact key set, safe-integer counts with
 * `0 <= seatsCompleted <= seatsTotal` (0 is legal: a round whose seats were
 * all stopped still publishes the payloads they salvaged), the closed `stoppedReason` vocabulary,
 * well-formed `unreviewed` entries, and the block's INTERNAL truth:
 * full (every seat finished) → no stop reason and no entries; partial → a stop
 * reason and exactly one entry per missing seat; a `cap` headline requires at
 * least one capped entry. A block that types well but contradicts itself is
 * not a runner fact — the caller treats it as no coverage at all.
 */
export function isReviewCoverage(value: unknown): value is ReviewCoverage {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const doc = value as Record<string, unknown>;
  if (Object.keys(doc).length !== Object.keys(COVERAGE_KEYS).length) return false;
  for (const key of Object.keys(COVERAGE_KEYS)) {
    if (!Object.hasOwn(doc, key)) return false;
  }
  const { seatsTotal, seatsCompleted, stoppedReason, unreviewed } = doc;
  if (
    typeof seatsTotal !== "number" ||
    typeof seatsCompleted !== "number" ||
    !Number.isSafeInteger(seatsTotal) ||
    !Number.isSafeInteger(seatsCompleted) ||
    seatsTotal < 1 ||
    seatsCompleted < 0 ||
    seatsCompleted > seatsTotal ||
    (stoppedReason !== null && stoppedReason !== "cap" && stoppedReason !== "failed") ||
    !isUnreviewedList(unreviewed)
  ) {
    return false;
  }
  const missing = seatsTotal - seatsCompleted;
  if (missing === 0) return stoppedReason === null && unreviewed.length === 0;
  if (stoppedReason === null || unreviewed.length !== missing) return false;
  if (stoppedReason === "cap") return unreviewed.some((entry) => entry.reason === "cap");
  return unreviewed.every((entry) => entry.reason !== "cap");
}

const MAX_SCOPE_ENTRIES = 3;
const MAX_SEAT_ENTRIES = 3;

const displayText = (text: string): string =>
  text
    .replace(/<!--\s*mstar-inspector:[a-zA-Z-]+:v1[^>]*-->/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[<>]/g, (angle) => (angle === "<" ? "‹" : "›"))
    .replace(/\\/g, "\\\\")
    .replace(/[`[\]()*_|]/g, (meta) => `\\${meta}`)
    .replace(/^#/, "\\#");

const scopeText = (scope: readonly string[]): string => {
  const shown = scope.slice(0, MAX_SCOPE_ENTRIES);
  const overflow = scope.length - shown.length;
  return (
    shown.map(displayText).join(", ") + (overflow > 0 ? `, +${overflow} more file${overflow === 1 ? "" : "s"}` : "")
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
  if (coverage.seatsCompleted >= coverage.seatsTotal) return "";
  const stopped =
    coverage.stoppedReason === "cap"
      ? "; stopped by cap"
      : coverage.stoppedReason === "failed"
        ? "; stopped by a seat failure"
        : "";
  const seats = coverage.unreviewed.slice(0, MAX_SEAT_ENTRIES);
  const seatOverflow = coverage.unreviewed.length - seats.length;
  const unreviewed =
    seats.length === 0
      ? ""
      : ` — not reviewed: ${seats
          .map((seat) => {
            const scope = scopeText(seat.scope);
            const suffix = seat.reason === coverage.stoppedReason ? "" : seat.reason;
            if (suffix === "") return `${displayText(seat.seat)} (${scope})`;
            return `${displayText(seat.seat)} (${scope === "" ? suffix : `${scope}; ${suffix}`})`;
          })
          .join(", ")}` +
        (seatOverflow > 0 ? `, +${seatOverflow} more seat${seatOverflow === 1 ? "" : "s"}` : "");
  return `Reviewed ${coverage.seatsCompleted}/${coverage.seatsTotal} seats${stopped}${unreviewed}`;
}
