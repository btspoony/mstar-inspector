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
 * never a failure of the review itself. Every COUNT and every list that pages
 * these rows excludes the whole set: the cron sweep's paging count, the
 * dashboard's failure count (list aggregate, detail `counts.failures`) and the
 * per-PR failure history. One rule on both faces, so a tab number never
 * disagrees with the pager below it. The rows stay in `review_failures` —
 * `usage` is the only record of a dropped metered attempt and `recheck` of a
 * round that produced no usable document — they are just not failures.
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
