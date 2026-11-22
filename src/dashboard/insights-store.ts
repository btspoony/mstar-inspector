import { FINDING_SEVERITIES } from "../contracts/finding-severity";
import { dayGrid, weekGrid } from "./insights-dates";

/**
 * The tenant scope of an aggregation, mirroring `LedgerScope` in the ledger
 * store: a target arm binds its id AND the workspace that must own it; a
 * workspace arm resolves to a subquery over the workspace's live targets.
 * Either arm binds a CONSTANT number of values — never one per target (D1's
 * parameter cap). REQUIRED: there is no unscoped tenant insights read. Rows
 * with `target_id` NULL (legacy unattributed) stay excluded.
 */
export type InsightsScope =
  | { kind: "target"; targetId: string; workspaceId: string }
  | { kind: "workspace"; workspaceId: string };

/** Optional filters for the insights aggregation (AL-22-1). */
export type InsightsWindow = InsightsScope & {
  windowDays?: number;
  repo?: { owner: string; repo: string };
  includeRepos?: boolean;
};

/** One severity bucket of findingsBySeverity. */
export type SeverityCount = { severity: string; count: number };
/** One verdict bucket of verdictDistribution. */
export type VerdictCount = { verdict: string; count: number };
/** One Monday-anchored UTC week bucket of weeklyTrend. */
export type WeekBucket = { week_start: string; reviews: number; findings: number };
/**
 * One UTC day bucket of dailyTrend (additive `daily_trend`, window-bucketing
 * contract 2026-09-20) — the day-granularity mirror of WeekBucket: the same
 * count semantics, bucketed by day.
 */
export type DayBucket = { day_start: string; reviews: number; findings: number };
/**
 * One per-bucket distribution row of findingsDistribution (AD-652).
 * Wire shape is snake_case and passes through the route untouched, mirroring
 * the other store types.
 */
export type FindingsDistributionBucket = {
  bucket_start: string;
  granularity: "day" | "week";
  by_severity: Record<string, number>;
};

/** The full insights aggregation shape. */
export type Insights = {
  reviewsTotal: number;
  findingsBySeverity: SeverityCount[];
  verdictDistribution: VerdictCount[];
  weeklyTrend: WeekBucket[];
  dailyTrend: DayBucket[];
  repos: string[];
  findingsDistribution: FindingsDistributionBucket[];
};

type InsightsStatement = {
  bind(...values: unknown[]): InsightsStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
};

/** Narrow D1 face the insights store depends on (read-only). */
export type InsightsD1 = {
  prepare(query: string): InsightsStatement;
};

/** The clamped window (default 30, >90 → 90) — the single clamp point. */
export function clampWindow(windowDays: number | undefined): number {
  return windowDays === undefined ? 30 : Math.min(windowDays, 90);
}

const WEEK_BUCKET_SQL = "date(r.reviewed_at, '-' || ((strftime('%w', r.reviewed_at)+6)%7) || ' days')";

/**
 * Resolve the insights aggregation for the review store behind `db`.
 *
 * @param db   a D1 handle (real D1Database or the bun:sqlite test double)
 * @param opts windowDays (default 30, >90 clamped to 90) + optional
 *             owner/repo filter + the REQUIRED tenant `scope` (one target, or
 *             the workspace's live targets), each applied to EVERY
 *             aggregation; the scope also narrows the opt-in `repos` list and
 *             excludes legacy `target_id` NULL rows. A workspace with no live
 *             target resolves to the zero-filled shape.
 */
export async function createInsightsStore(db: InsightsD1, opts: InsightsWindow): Promise<Insights> {
  const windowDays = clampWindow(opts.windowDays);
  const repo = opts.repo;
  const includeRepos = opts.includeRepos ?? false;

  const granularity: FindingsDistributionBucket["granularity"] = windowDays > 30 ? "week" : "day";
  const bucketSql = granularity === "week" ? WEEK_BUCKET_SQL : "date(r.reviewed_at)";

  const windowEraWhere = "r.reviewed_at >= datetime('now', '-' || ? || ' days') AND r.envelope IS NOT NULL";

  const tenantWhere =
    opts.kind === "workspace"
      ? "r.target_id IN (SELECT t.id FROM review_targets t WHERE t.workspace_id = ? AND t.deleted_at IS NULL)"
      : "r.target_id = ? AND EXISTS (SELECT 1 FROM review_targets t WHERE t.id = r.target_id AND t.workspace_id = ? AND t.deleted_at IS NULL)";
  const tenantBinds =
    opts.kind === "workspace"
      ? [opts.workspaceId]
      : [opts.targetId, opts.workspaceId];

  const where: string[] = [];
  const binds: unknown[] = [];
  if (repo !== undefined) {
    where.push("r.owner = ?", "r.repo = ?");
    binds.push(repo.owner, repo.repo);
  }
  where.push(tenantWhere, windowEraWhere);
  binds.push(...tenantBinds, windowDays);
  const whereSql = where.join(" AND ");

  const repoQuery = includeRepos
    ? db
        .prepare(
          `SELECT DISTINCT r.owner || '/' || r.repo AS repo
           FROM reviews r
           WHERE ${tenantWhere} AND ${windowEraWhere}
           ORDER BY repo ASC`,
        )
        .bind(...tenantBinds, windowDays)
        .all<{ repo: string }>()
    : Promise.resolve({ results: [] as { repo: string }[] });

  type DayTrendRow = { day_start: string; reviews: number; findings: number };
  const dailyTrendQuery =
    granularity === "day"
      ? db
          .prepare(
            `SELECT
               ${bucketSql} AS day_start,
               COUNT(DISTINCT r.id) AS reviews,
               COUNT(f.id) AS findings
             FROM reviews r
             LEFT JOIN findings f ON f.review_id = r.id
             WHERE ${whereSql}
             GROUP BY day_start`,
          )
          .bind(...binds)
          .all<DayTrendRow>()
      : Promise.resolve({ results: [] as DayTrendRow[] });

  const [total, severities, verdicts, trend, distributionSeverities, repoRows, dailyTrendRows] =
    await Promise.all([
    db
      .prepare(`SELECT COUNT(*) AS total FROM reviews r WHERE ${whereSql}`)
      .bind(...binds)
      .first<{ total: number }>(),
    db
      .prepare(
        `SELECT f.severity AS severity, COUNT(*) AS count
         FROM findings f JOIN reviews r ON r.id = f.review_id
         WHERE ${whereSql}
         GROUP BY f.severity
         ORDER BY count DESC, f.severity ASC`,
      )
      .bind(...binds)
      .all<{ severity: string; count: number }>(),
    db
      .prepare(
        `SELECT r.verdict AS verdict, COUNT(*) AS count
         FROM reviews r
         WHERE ${whereSql}
         GROUP BY r.verdict
         ORDER BY count DESC, r.verdict ASC`,
      )
      .bind(...binds)
      .all<{ verdict: string; count: number }>(),
    db
      .prepare(
        `SELECT
           ${WEEK_BUCKET_SQL} AS week_start,
           COUNT(DISTINCT r.id) AS reviews,
           COUNT(f.id) AS findings
         FROM reviews r
         LEFT JOIN findings f ON f.review_id = r.id
         WHERE ${whereSql}
         GROUP BY week_start
         ORDER BY week_start ASC`,
      )
      .bind(...binds)
      .all<{ week_start: string; reviews: number; findings: number }>(),
    db
      .prepare(
        `SELECT ${bucketSql} AS bucket_start, f.severity AS severity, COUNT(*) AS count
         FROM findings f JOIN reviews r ON r.id = f.review_id
         WHERE ${whereSql}
         GROUP BY bucket_start, f.severity`,
      )
      .bind(...binds)
      .all<{ bucket_start: string; severity: string; count: number }>(),
    repoQuery,
    dailyTrendQuery,
  ]);

  const grid = granularity === "week" ? weekGrid(windowDays) : dayGrid(windowDays);
  const starts = [
    ...new Set([...grid, ...distributionSeverities.results.map((row) => row.bucket_start)]),
  ].sort();
  const distributionBuckets = new Map<string, FindingsDistributionBucket>(
    starts.map((bucket_start) => [
      bucket_start,
      {
        bucket_start,
        granularity,
        by_severity: Object.fromEntries(FINDING_SEVERITIES.map((key) => [key, 0])),
      },
    ]),
  );
  for (const row of distributionSeverities.results) {
    const bucket = distributionBuckets.get(row.bucket_start)!;
    bucket.by_severity[row.severity] = (bucket.by_severity[row.severity] ?? 0) + row.count;
  }

  let dailyTrend: DayBucket[] = [];
  if (granularity === "day") {
    const dayStarts = [
      ...new Set([...dayGrid(windowDays), ...dailyTrendRows.results.map((row) => row.day_start)]),
    ].sort();
    const dailyBuckets = new Map(
      dayStarts.map((day_start) => [day_start, { day_start, reviews: 0, findings: 0 }]),
    );
    for (const row of dailyTrendRows.results) {
      const bucket = dailyBuckets.get(row.day_start)!;
      bucket.reviews = row.reviews;
      bucket.findings = row.findings;
    }
    dailyTrend = dayStarts.map((day_start) => dailyBuckets.get(day_start)!);
  }

  return {
    reviewsTotal: total?.total ?? 0,
    findingsBySeverity: severities.results,
    verdictDistribution: verdicts.results,
    weeklyTrend: trend.results,
    dailyTrend,
    repos: repoRows.results.map((row) => row.repo).filter((name) => name.length > 0),
    findingsDistribution: starts.map((bucket_start) => distributionBuckets.get(bucket_start)!),
  };
}
