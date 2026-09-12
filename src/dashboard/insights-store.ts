/**
 * Dashboard insights aggregation store (plan 22 Task 1) — the review-health
 * panel's read face over the central review store.
 *
 * Module boundary (AL-22-1 candidate A, LOCKED): this is a dashboard leaf —
 * it declares its own narrow D1 face locally (types only, zero imports from
 * store/pipeline/review). A real `D1Database`, the bun:sqlite test double
 * (tests/store/helpers.ts), and the store layer's `D1Like` all satisfy it
 * structurally. Read-only: prepare/bind/first/all, no batch.
 *
 * Window semantics (AL-22-1):
 *   - `windowDays` is an integer number of days, default 30.
 *   - Values > 90 are CLAMPED to 90 here — the single clamp point. The
 *     clamp is applied once at the store entry and every query below binds
 *     the clamped value, so the window is consistent across every
 *     aggregation.
 *   - Non-integer / negative values are the ROUTE's 400 (plan 22 Task 2) —
 *     the store never sees them in production and does not re-validate.
 *   - The window predicate is `reviews.reviewed_at >= datetime('now', '-' ||
 *     ? || ' days')` — the same expression the plan-21 store-layer query
 *     uses (src/store/artifact-store.ts recurrenceByFingerprint), same
 *     format as the column default.
 *
 * Weekly trend (AL-22-1): Monday-anchored UTC week buckets via the portable
 *   `date(reviewed_at, '-' || ((strftime('%w', reviewed_at)+6)%7) || ' days')`
 *   expression — %w is available on every SQLite version (no %G/%V
 *   dependency). `week_start` is the Monday `YYYY-MM-DD`; `reviews` counts
 *   distinct reviews in the bucket, `findings` counts their findings (a
 *   review with zero findings still contributes 1 to `reviews` — LEFT JOIN).
 *   The expression lives in the WEEK_BUCKET_SQL constant shared verbatim by
 *   the plan-65 distribution week buckets — two week definitions here would
 *   be a plan-65 STOP face.
 *
 * Findings distribution (plan 65, AD-652 — additive only): two more GROUP BY
 *   queries (bucket × severity, bucket × category) reusing the shared
 *   whereSql and the findings×reviews JOIN. Bucket = UTC day
 *   (`date(r.reviewed_at)`, same UTC domain as the window predicate) or the
 *   weekly_trend week expression, selected by the CLAMPED window
 *   (windowDays > 30 → "week", else "day" — UI segments 7/30 → day, 90 →
 *   week). The zero-filled grid is generated in JS by insights-dates.ts
 *   (dayGrid / weekGrid): every bucket the window predicate can return,
 *   first/last partial. `by_severity` carries the fixed v1 merge-class key
 *   set per bucket; `by_category` carries the window-level union of observed
 *   categories plus the single "uncategorized" fallback for NULL categories
 *   — series keys are stable across buckets, so the SPA never re-unions.
 *
 * Bounded top (QC W-E): the insights face adds `LIMIT 10` — "top" is a
 * bounded list by product definition, and the bound caps the JSON payload
 * and the panel's rendered rows. `recurrenceByFingerprint` stays unbounded
 * (its consumer slices as needed); the parity test uses a shared fixture
 * with one group, so the LIMIT does not break the lock.
 *
 * Era gate (Bugbot wave-1): every aggregation filters
 * `reviews.envelope IS NOT NULL` — the migration-0002 lock
 * (`envelope IS NOT NULL` ⇔ v1 row). M1-era rows (critical|warning|
 * suggestion|info severity, comment|request_changes|approve verdict) must
 * never mix into the v1 merge-class vocab; the gate is applied once in the
 * shared WHERE and therefore covers every aggregation.
 *
 * Determinism: every aggregation orders by count DESC then key ASC (NULL
 * keys sort first in SQLite ASC — findingsByCategory surfaces NULL
 * categories as `category: null`), weeklyTrend by week_start ASC,
 * recurringTop by count DESC then fingerprint ASC. The plan-65 distribution
 * buckets ascend by bucket_start (the JS-generated grid defines the order).
 *
 * The bucket-grid generators (dayGrid / weekGrid) come from
 * src/dashboard/insights-dates.ts — the single copy of the bucket-boundary
 * math (plan 65 B1), still zero imports from store/pipeline/review.
 */
import { dayGrid, weekGrid } from "./insights-dates";

/** Optional filters for the insights aggregation (AL-22-1). */
export type InsightsWindow = {
  /** Integer days, default 30; >90 is clamped to 90 at the store entry. */
  windowDays?: number;
  /** Restrict every aggregation to one owner/repo pair. */
  repo?: { owner: string; repo: string };
  /**
   * Opt-in window-scoped distinct `repos` aggregation (plan 36 QC F-001).
   * Skipped (resolves to []) unless requested — only the insights records
   * surface opts in (its repo Select); default summary reads must not pay
   * the DISTINCT scan+sort.
   */
  includeRepos?: boolean;
};

/** One severity bucket of findingsBySeverity. */
export type SeverityCount = { severity: string; count: number };
/** One category bucket of findingsByCategory (NULL = uncategorized finding). */
export type CategoryCount = { category: string | null; count: number };
/** One verdict bucket of verdictDistribution. */
export type VerdictCount = { verdict: string; count: number };
/** One Monday-anchored UTC week bucket of weeklyTrend. */
export type WeekBucket = { week_start: string; reviews: number; findings: number };
/**
 * One per-bucket distribution row of findingsDistribution (plan 65, AD-652).
 * Wire shape is snake_case and passes through the route untouched, mirroring
 * the other store types.
 */
export type FindingsDistributionBucket = {
  /** UTC bucket start `YYYY-MM-DD` — a day, or a Monday for week buckets. */
  bucket_start: string;
  /** "day" for clamped windowDays <= 30, "week" above (AD-652 mapping). */
  granularity: "day" | "week";
  /**
   * Zero-filled per bucket over the FIXED v1 merge-class key set
   * ({must-fix, should-fix, nit}) — page-level series vocabulary.
   */
  by_severity: Record<string, number>;
  /**
   * Zero-filled per bucket over the window-level union of observed category
   * values (ASC) plus the single "uncategorized" fallback for NULL — stable
   * series keys across every bucket of the response.
   */
  by_category: Record<string, number>;
};
/** One recurrence group of recurringTop (plan-21 semantics, count >= 2). */
export type RecurringGroup = {
  fingerprint: string;
  title_sample: string;
  count: number;
  repos: string[];
};

/** The full insights aggregation shape (plan 22 Task 1 + plan 36 T2). */
export type Insights = {
  reviewsTotal: number;
  findingsBySeverity: SeverityCount[];
  findingsByCategory: CategoryCount[];
  verdictDistribution: VerdictCount[];
  weeklyTrend: WeekBucket[];
  recurringTop: RecurringGroup[];
  /**
   * Window-scoped distinct `owner/repo` values with at least one v1 review
   * (plan 36 T2). Sorted ascending. Independent of `opts.repo` — the Select
   * option set is always the full in-window set, never the filtered subset.
   */
  repos: string[];
  /**
   * Per-bucket findings distribution (plan 65, AD-652 — additive): the
   * daily/weekly stacked-chart face. Ordered bucket_start ASC; every bucket
   * intersecting the clamped window is present (zero-filled where no
   * findings), first/last partial.
   */
  findingsDistribution: FindingsDistributionBucket[];
};

/** Narrow D1 statement face, declared locally (dashboard leaf — zero imports). */
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

/**
 * The single Monday-anchored UTC week-bucket expression (AL-22-1), shared
 * verbatim by weeklyTrend and the plan-65 distribution week buckets — two
 * week definitions in this file would be a plan-65 STOP face. The JS mirror
 * (`mondayOf`, via insights-dates.ts `weekGrid`) stays in lockstep (S-1 pin).
 */
const WEEK_BUCKET_SQL = "date(r.reviewed_at, '-' || ((strftime('%w', r.reviewed_at)+6)%7) || ' days')";

/**
 * Fixed per-bucket severity key set of the distribution (plan 65, AD-652):
 * the v1 merge-class vocab the era gate guarantees. Declared locally — the
 * dashboard leaf boundary (AL-22-1) forbids importing it from src/review.
 */
const DISTRIBUTION_SEVERITY_KEYS = ["must-fix", "should-fix", "nit"] as const;

/**
 * Resolve the insights aggregation for the review store behind `db`.
 *
 * @param db   a D1 handle (real D1Database or the bun:sqlite test double)
 * @param opts windowDays (default 30, >90 clamped to 90) + optional
 *             owner/repo filter applied to EVERY aggregation
 */
export async function createInsightsStore(db: InsightsD1, opts: InsightsWindow = {}): Promise<Insights> {
  const windowDays = clampWindow(opts.windowDays);
  const repo = opts.repo;
  const includeRepos = opts.includeRepos ?? false;

  // Plan 65 (AD-652): the distribution granularity derives ONLY from the
  // clamped window — the UI's 7/30-day segments map to day buckets, 90 days
  // (and any 31–89 direct URL entry) maps to weeks. Window parsing itself is
  // untouched (plan 22 QC W-C face).
  const granularity: FindingsDistributionBucket["granularity"] = windowDays > 30 ? "week" : "day";
  // Week buckets reuse the weekly_trend expression (WEEK_BUCKET_SQL) — never
  // a second week definition; day buckets are the UTC date, the same domain
  // as the window predicate.
  const bucketSql = granularity === "week" ? WEEK_BUCKET_SQL : "date(r.reviewed_at)";

  // Shared window + era-gate predicates — the single source of truth. The
  // era gate (migration 0002 lock): `reviews.envelope IS NOT NULL` ⇔ v1 row;
  // M1-era rows (old severity/verdict vocab) must never mix into the v1
  // merge-class aggregations. The opt-in repos query reuses this
  // (deliberately omitting only the repo filter) so the two cannot drift
  // (plan 36 QC F-003).
  const windowEraWhere = "r.reviewed_at >= datetime('now', '-' || ? || ' days') AND r.envelope IS NOT NULL";

  const where: string[] = [];
  const binds: unknown[] = [];
  if (repo !== undefined) {
    where.push("r.owner = ?", "r.repo = ?");
    binds.push(repo.owner, repo.repo);
  }
  where.push(windowEraWhere);
  binds.push(windowDays);
  const whereSql = where.join(" AND ");

  // Plan 36 T2: window-scoped distinct repos for the records Select.
  // Opt-in (plan 36 QC F-001) — skipped unless includeRepos, so the home
  // surface never pays the DISTINCT scan+sort. Deliberately ignores
  // opts.repo — the option set is the in-window universe, not the
  // currently filtered subset. Shares windowEraWhere so the window + era
  // gate predicates cannot drift from the other aggregations (F-003).
  const repoQuery = includeRepos
    ? db
        .prepare(
          `SELECT DISTINCT r.owner || '/' || r.repo AS repo
           FROM reviews r
           WHERE ${windowEraWhere}
           ORDER BY repo ASC`,
        )
        .bind(windowDays)
        .all<{ repo: string }>()
    : Promise.resolve({ results: [] as { repo: string }[] });

  const [total, severities, categories, verdicts, trend, recurring, distributionSeverities, distributionCategories, repoRows] =
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
        `SELECT f.category AS category, COUNT(*) AS count
         FROM findings f JOIN reviews r ON r.id = f.review_id
         WHERE ${whereSql}
         GROUP BY f.category
         ORDER BY count DESC, f.category ASC`,
      )
      .bind(...binds)
      .all<{ category: string | null; count: number }>(),
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
    // BIDIRECTIONAL ANCHOR ↔ src/store/artifact-store.ts recurrenceByFingerprint:
    // inline duplicate of the plan-21 recurrence semantics (count >= 2
    // distinct reviews, NULL fingerprints excluded, repos = distinct
    // owner/repo pairs, title_sample = MIN). Mirror any change in BOTH
    // places; the parity test locks them.
    db
      .prepare(
        `SELECT
          f.fingerprint AS fingerprint,
          MIN(f.title) AS title_sample,
          COUNT(DISTINCT f.review_id) AS count,
          GROUP_CONCAT(DISTINCT r.owner || '/' || r.repo) AS repos_csv
        FROM findings f
        JOIN reviews r ON r.id = f.review_id
        WHERE f.fingerprint IS NOT NULL AND ${whereSql}
        GROUP BY f.fingerprint
        HAVING COUNT(DISTINCT f.review_id) >= 2
        ORDER BY count DESC, f.fingerprint ASC
        LIMIT 10`,
      )
      .bind(...binds)
      .all<{ fingerprint: string; title_sample: string; count: number; repos_csv: string | null }>(),
    // Plan 65 (AD-652): the two additive distribution GROUP BYs — same
    // whereSql + findings×reviews JOIN as the page-level aggregates (same
    // cost class), bucketed by day or week. No ORDER BY: the JS grid
    // assembles and orders the buckets deterministically below.
    db
      .prepare(
        `SELECT ${bucketSql} AS bucket_start, f.severity AS severity, COUNT(*) AS count
         FROM findings f JOIN reviews r ON r.id = f.review_id
         WHERE ${whereSql}
         GROUP BY bucket_start, f.severity`,
      )
      .bind(...binds)
      .all<{ bucket_start: string; severity: string; count: number }>(),
    db
      .prepare(
        `SELECT ${bucketSql} AS bucket_start, f.category AS category, COUNT(*) AS count
         FROM findings f JOIN reviews r ON r.id = f.review_id
         WHERE ${whereSql}
         GROUP BY bucket_start, f.category`,
      )
      .bind(...binds)
      .all<{ bucket_start: string; category: string | null; count: number }>(),
    repoQuery,
  ]);

  // Plan 65 (AD-652): assemble the zero-filled distribution grid. The grid
  // (dayGrid/weekGrid) is every bucket the window predicate can return;
  // observed bucket starts are unioned in so that a SQL/JS calendar drift
  // could only ever surface as an extra honest bucket, never silently
  // dropped counts. Severity keys are the fixed merge-class set; category
  // keys are the window-level union (ASC) + "uncategorized" — identical on
  // every bucket, so series keys are stable for the SPA.
  const grid = granularity === "week" ? weekGrid(windowDays) : dayGrid(windowDays);
  const starts = [
    ...new Set([
      ...grid,
      ...distributionSeverities.results.map((row) => row.bucket_start),
      ...distributionCategories.results.map((row) => row.bucket_start),
    ]),
  ].sort();
  const categoryKeys = [
    ...new Set(
      distributionCategories.results
        .map((row) => row.category)
        .filter((category): category is string => category !== null),
    ),
  ].sort();
  const distributionBuckets = new Map<string, FindingsDistributionBucket>(
    starts.map((bucket_start) => [
      bucket_start,
      {
        bucket_start,
        granularity,
        by_severity: Object.fromEntries(DISTRIBUTION_SEVERITY_KEYS.map((key) => [key, 0])),
        by_category: Object.fromEntries([...categoryKeys, "uncategorized"].map((key) => [key, 0])),
      },
    ]),
  );
  for (const row of distributionSeverities.results) {
    const bucket = distributionBuckets.get(row.bucket_start)!;
    // Vocab coupling (plan 65 qc fix-1): a future severity vocabulary must
    // extend DISTRIBUTION_SEVERITY_KEYS (here), the page SEVERITY_SERIES
    // (InsightsPage.tsx), and the wire-guard docblock (spa/pages/data.ts)
    // together — this accumulation would otherwise grow keys the page's
    // closed series silently ignore. Unreachable today: mergeClass is
    // z.enum-locked at ingest (review/schema.ts) and the era gate excludes
    // non-v1 rows.
    bucket.by_severity[row.severity] = (bucket.by_severity[row.severity] ?? 0) + row.count;
  }
  for (const row of distributionCategories.results) {
    const bucket = distributionBuckets.get(row.bucket_start)!;
    const key = row.category ?? "uncategorized";
    bucket.by_category[key] = (bucket.by_category[key] ?? 0) + row.count;
  }

  return {
    reviewsTotal: total?.total ?? 0,
    findingsBySeverity: severities.results,
    findingsByCategory: categories.results,
    verdictDistribution: verdicts.results,
    weeklyTrend: trend.results,
    recurringTop: recurring.results.map((row) => ({
      fingerprint: row.fingerprint,
      title_sample: row.title_sample,
      count: row.count,
      repos: (row.repos_csv ?? "").split(",").filter((repoName) => repoName.length > 0).sort(),
    })),
    repos: repoRows.results.map((row) => row.repo).filter((name) => name.length > 0),
    findingsDistribution: starts.map((bucket_start) => distributionBuckets.get(bucket_start)!),
  };
}
