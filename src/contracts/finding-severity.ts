/**
 * The v1 merge-class vocabulary — the finding severities the ledger holds,
 * worst class first. ONE literal, because four layers must agree on it: the
 * record route validates its `severity` filter against it, the SPA builds its
 * filter chips from it, the insights distribution zero-fills its key set with
 * it, and the store's must-fix tally names a class from it. A chip the UI
 * offers is therefore always a value the route accepts, and a class added
 * here reaches every layer in one edit.
 *
 * Zero dependencies by design: the dashboard leaf boundary (AL-22-1) forbids
 * importing the store/pipeline/review layers, so the shared contract lives
 * here instead of being restated in each of them.
 */
export const FINDING_SEVERITIES = ["must-fix", "should-fix", "may-fix", "nit"] as const;

export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

/** The class the must-fix tally counts and the SPA's findings fold opens on. */
export const MUST_FIX_SEVERITY: FindingSeverity = FINDING_SEVERITIES[0];

/** The route's filter guard: a spelling outside the vocabulary has no predicate. */
export function isFindingSeverity(value: string): value is FindingSeverity {
  return (FINDING_SEVERITIES as readonly string[]).includes(value);
}
