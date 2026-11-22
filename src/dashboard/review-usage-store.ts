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
  const stamp = (at: Date) => at.toISOString().slice(0, 19).replace("T", " ");
  const start = stamp(new Date(Date.UTC(year, month, 1)));
  return {
    month: start.slice(0, 7),
    start,
    end: stamp(new Date(Date.UTC(year, month + 1, 1))),
  };
}

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
