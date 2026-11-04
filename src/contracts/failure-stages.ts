/**
 * The `review_failures.stage` ATTRIBUTION partition — single source of truth
 * (compass contracts B). The cron sweep and the dashboard both ask the same
 * question ("is this row a failure of the review?"), so the list is written
 * once here and interpolated into each query by `sqlStageList`; a hand-written
 * stage literal is what let the count/history asymmetry drift.
 *
 * Zero imports: `src/dashboard/**` may import this module but never
 * `store/pipeline/review` code (architect decision Q2, the same admission
 * `src/contracts/sandbox-images.ts` has), and `src/store/failure-store.ts`
 * re-exports the lists as its producer-vocabulary partition.
 */

/**
 * Stages whose rows record a review that CONTINUED — per-round attribution,
 * never a failure of the review itself. The two COUNT faces exclude this whole
 * set: the cron sweep's paging count and the dashboard's failure count (list
 * aggregate and detail `failure_count`). The dashboard's per-PR failure
 * HISTORY excludes nothing — both stages stay visible there, because each row
 * is the only surface for something D1 lost (`usage`: a dropped metered
 * attempt, `recheck`: a round that produced no usable document).
 */
export const PAGING_EXCLUDED_STAGES = Object.freeze(["recheck", "usage"] as const);

/**
 * Render a stage list as the literal body of a SQL `IN (…)` / `NOT IN (…)`
 * comparison (each stage single-quoted and comma-joined, e.g.
 * `'recheck', 'usage'`). Callers supply the operator and parentheses; this
 * helper only renders the list, so it is never valid as an operand sequence
 * of its own.
 */
export function sqlStageList(stages: readonly string[]): string {
  return stages.map((stage) => `'${stage}'`).join(", ");
}
