/**
 * The `review_failures.stage` ATTRIBUTION partition — single source of truth
 * (compass contracts B). The cron sweep and the dashboard both ask the same
 * question ("is this row a failure of the review?"), so the lists are written
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
 * never a failure of the review itself. The paging count (cron sweep) and the
 * dashboard's failure count both exclude this whole set.
 */
export const PAGING_EXCLUDED_STAGES = Object.freeze(["recheck", "usage"] as const);

/**
 * The detail-history partition: the attribution set minus `usage`, whose row
 * is a lost metered record that still needs a surface. `recheck` is excluded
 * because its accounting already rides the published coverage line.
 */
export const HISTORY_EXCLUDED_STAGES = Object.freeze(["recheck"] as const);

/**
 * Render a stage list as a SQL `IN (…)` literal body (each stage
 * single-quoted and comma-joined). Callers own their operator, so
 * `NOT IN (${…})` and `< >`-style comparisons both read off this one
 * rendering.
 */
export function sqlStageList(stages: readonly string[]): string {
  return stages.map((stage) => `'${stage}'`).join(", ");
}
