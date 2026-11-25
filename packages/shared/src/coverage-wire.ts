/**
 * The seat-coverage block the runner adds to a successful review output:
 * which seats completed, why the round stopped, and what was left
 * unreviewed. A present block always asserts a full or partial coverage —
 * all seats finished → `stoppedReason: null`, `unreviewed: []`.
 *
 * Absence is NOT failure — it means the round does not assert coverage.
 * Exactly two legal absences exist:
 *
 * - the DEEP tier, whose seats are task-dispatched in a way the runner
 *   cannot observe, so a deep run asserts nothing about coverage at all;
 * - a round where no seat produced usable output (the runner cannot even
 *   see what it lost) — that round is a failure THROUGH THE FAILURE PATH,
 *   never a partial review, and the coverage block simply never claims a
 *   coverage for it.
 *
 * Consumers must treat a missing block as "not asserted": neither success
 * evidence nor failure evidence.
 *
 * This is transport metadata next to the engine envelope, never an envelope
 * field: `mstar.review/v1` is closed and its schema does not grow.
 */

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
  /**
   * The round's dominant stop class: `cap` when any seat was stopped by the
   * time cap (the allocation cause outranks the rest), else `failed` when any
   * seat was lost another way, null when every seat finished.
   */
  stoppedReason: "cap" | "failed" | null;
  unreviewed: readonly ReviewSeatUnreviewed[];
};

/** How long one per-seat reason slug may be, matching the runner's stage bound. */
const REASON_MAX_CHARS = 40;

/** The closed per-seat reason vocabulary: `cap`, `failed`, `failed:<slug>`. */
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
 * `1 <= seatsCompleted <= seatsTotal`, the closed `stoppedReason` vocabulary,
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
    seatsCompleted < 1 ||
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

/** How many scope entries one seat line shows before folding into a count. */
const MAX_SCOPE_ENTRIES = 3;
/** How many seats the not-reviewed list shows before folding into a count. */
const MAX_SEAT_ENTRIES = 3;

/**
 * Display normalization for repository-controlled text (seat names and file
 * paths — a hostile diff can put anything in either): single-line, no
 * Inspector marker syntax, no angle brackets, and no live Markdown control
 * syntax. This is done HERE, inside the one shared formatter, so the Check
 * summary and the published body render the EXACT same sentence — the
 * body's later marker strip can never diverge from the summary's unaugmented
 * render, and a path or seat name can never escape its plain-text position:
 * both surfaces render the text as Markdown, so the control characters are
 * backslash-escaped (the backslash first, or the escapes would escape each
 * other).
 */
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
  if (coverage.seatsCompleted < 1 || coverage.seatsCompleted >= coverage.seatsTotal) return "";
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
            // The headline already names the round's dominant class, so a
            // per-seat suffix is shown only when it ADDS information (a mixed
            // round's other cause, or a failure detail).
            const suffix = seat.reason === coverage.stoppedReason ? "" : seat.reason;
            if (suffix === "") return `${displayText(seat.seat)} (${scope})`;
            return `${displayText(seat.seat)} (${scope === "" ? suffix : `${scope}; ${suffix}`})`;
          })
          .join(", ")}` +
        (seatOverflow > 0 ? `, +${seatOverflow} more seat${seatOverflow === 1 ? "" : "s"}` : "");
  return `Reviewed ${coverage.seatsCompleted}/${coverage.seatsTotal} seats${stopped}${unreviewed}`;
}
