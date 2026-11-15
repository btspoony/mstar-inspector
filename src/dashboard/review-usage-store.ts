/**
 * Shared-bot review usage — the read-only aggregation behind the workspace
 * settings card and the operator usage table (spec
 * [bot scope and claiming](../../docs/specs/feature/bot-scope-and-claiming.md)
 * § Review usage).
 *
 * ONE statement serves both faces: it starts from `workspaces`, joins the
 * review tree through the target's bot, and binds the caller's workspace as
 * `?3` (`NULL` = every live workspace). The workspace face takes the single
 * row it returns; the operator face takes all of them.
 *
 * Attribution is the target's, never the review's: `reviews.target_id` →
 * `review_targets.workspace_id`, and the shared/own split is the BOT's
 * `review_bots.scope`, so a shared bot's own workspace still counts its
 * reviews as shared. A row with no `target_id` has no bot either (migration
 * `0057_review_targets.sql` attributes history only where `bot_id` is NOT
 * NULL), so it has no workspace to count against and is excluded.
 *
 * The window is a UTC calendar month of `reviews.reviewed_at` — the instant
 * the review row was recorded, never the request. The bounds are plain text
 * (`YYYY-MM-DD HH:MM:SS`, the format SQLite's `datetime('now')` writes), so
 * the predicate is a range scan of `idx_reviews_reviewed_at` and never wraps
 * the column in `strftime`.
 *
 * Soft deletion is filtered for the workspace (the row must exist on the
 * face) and NOT for targets or bots: the count is what happened, and a parked
 * target keeps its month.
 */
import type { DashboardD1 } from "./users";

/** One workspace's review totals for one UTC month. */
export type WorkspaceReviewUsage = {
  workspaceId: string;
  workspaceName: string;
  workspaceSlug: string;
  sharedReviews: number;
  ownReviews: number;
};

/**
 * The month a usage face reports: the label it shows and the half-open bounds
 * the statement binds. Both bounds are UTC, and `end` is the next month's
 * first instant, so a review stamped exactly at `end` belongs to the next
 * month — no local-time bucketing, no rolling window.
 */
export type ReviewUsageMonth = { month: string; start: string; end: string };

/** The UTC calendar month `now` falls in, as the label plus its half-open bounds. */
export function reviewUsageMonth(now: Date): ReviewUsageMonth {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  // `YYYY-MM-DD HH:MM:SS` is the stamp format `reviews.reviewed_at` stores.
  const stamp = (at: Date) => at.toISOString().slice(0, 19).replace("T", " ");
  const start = stamp(new Date(Date.UTC(year, month, 1)));
  return {
    month: start.slice(0, 7),
    start,
    end: stamp(new Date(Date.UTC(year, month + 1, 1))),
  };
}

/**
 * The one aggregation. Binds `?1`/`?2` the month's half-open bounds and `?3`
 * the workspace id (`NULL` = every live workspace, still in this one shape).
 *
 * `LEFT JOIN` on both the target and the window: a live workspace with no
 * target, or a target with no review this month, still answers a row with
 * zeros instead of disappearing — the operator face must list every live
 * workspace, including the ones that spent nothing. Both sums therefore test
 * `r.id IS NOT NULL` as well as the bot's scope: without it the unmatched
 * target row would contribute one to whichever column its bot belongs to, so
 * a target with no review (or a parked one) would read as a review.
 *
 * The order is total: `workspaces.name` is not UNIQUE (only `slug` is,
 * migration 0026), so the id closes the last key and two same-named
 * workspaces cannot swap places between reloads.
 */
const REVIEW_USAGE_SQL = `
  SELECT w.id   AS workspace_id,
         w.name AS workspace_name,
         w.slug AS workspace_slug,
         COALESCE(SUM(CASE WHEN r.id IS NOT NULL AND b.scope =  'shared' THEN 1 ELSE 0 END), 0) AS shared_reviews,
         COALESCE(SUM(CASE WHEN r.id IS NOT NULL AND b.scope <> 'shared' THEN 1 ELSE 0 END), 0) AS own_reviews
    FROM workspaces w
    LEFT JOIN review_targets t ON t.workspace_id = w.id
    LEFT JOIN reviews r
           ON r.target_id = t.id
          AND r.reviewed_at >= ?1 AND r.reviewed_at < ?2
    LEFT JOIN review_bots b ON b.id = t.bot_id
   WHERE w.deleted_at IS NULL
     AND (?3 IS NULL OR w.id = ?3)
   GROUP BY w.id, w.name, w.slug
   ORDER BY shared_reviews DESC, own_reviews DESC, w.name ASC, w.id ASC`;

/** The statement's row shape (SQLite's snake_case aliases). */
type ReviewUsageRow = {
  workspace_id: string;
  workspace_name: string;
  workspace_slug: string;
  shared_reviews: number;
  own_reviews: number;
};

/**
 * The review totals of `workspaceId` for `window`, or of every live workspace
 * when it is `null`. The caller passes the id it resolved from the request; a
 * value from the path is never this parameter.
 */
export async function readReviewUsage(
  db: DashboardD1,
  window: ReviewUsageMonth,
  workspaceId: string | null,
): Promise<WorkspaceReviewUsage[]> {
  const res = await db
    .prepare(REVIEW_USAGE_SQL)
    .bind(window.start, window.end, workspaceId)
    .all<ReviewUsageRow>();
  return res.results.map((row) => ({
    workspaceId: row.workspace_id,
    workspaceName: row.workspace_name,
    workspaceSlug: row.workspace_slug,
    sharedReviews: Number(row.shared_reviews),
    ownReviews: Number(row.own_reviews),
  }));
}
