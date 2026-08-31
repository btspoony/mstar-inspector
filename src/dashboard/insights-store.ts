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
 *     the clamped value, so the window is consistent across all six
 *     aggregations.
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
 *
 * Recurring top (AL-22-1 candidate A): the plan-21 recurrence semantics
 * are INLINED here (count >= 2 distinct reviews, NULL fingerprints excluded
 * — the era gate, AC-21c) rather than imported, because dashboard modules
 * must not import store code. BIDIRECTIONAL ANCHOR: this SQL is a mirror of
 * `recurrenceByFingerprint` in src/store/artifact-store.ts — any semantic
 * change to one MUST be mirrored in the other, and the parity test
 * (tests/dashboard/insights-store.test.ts) locks them together.
 *
 * Determinism: every aggregation orders by count DESC then key ASC (NULL
 * keys sort first in SQLite ASC — findingsByCategory surfaces NULL
 * categories as `category: null`), weeklyTrend by week_start ASC,
 * recurringTop by count DESC then fingerprint ASC.
 */
/** Optional filters for the insights aggregation (AL-22-1). */
export type InsightsWindow = {
  /** Integer days, default 30; >90 is clamped to 90 at the store entry. */
  windowDays?: number;
  /** Restrict every aggregation to one owner/repo pair. */
  repo?: { owner: string; repo: string };
};

/** One severity bucket of findingsBySeverity. */
export type SeverityCount = { severity: string; count: number };
/** One category bucket of findingsByCategory (NULL = uncategorized finding). */
export type CategoryCount = { category: string | null; count: number };
/** One verdict bucket of verdictDistribution. */
export type VerdictCount = { verdict: string; count: number };
/** One Monday-anchored UTC week bucket of weeklyTrend. */
export type WeekBucket = { week_start: string; reviews: number; findings: number };
/** One recurrence group of recurringTop (plan-21 semantics, count >= 2). */
export type RecurringGroup = {
  fingerprint: string;
  title_sample: string;
  count: number;
  repos: string[];
};

/** The full insights aggregation shape (plan 22 Task 1 contract). */
export type Insights = {
  reviewsTotal: number;
  findingsBySeverity: SeverityCount[];
  findingsByCategory: CategoryCount[];
  verdictDistribution: VerdictCount[];
  weeklyTrend: WeekBucket[];
  recurringTop: RecurringGroup[];
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
 * Resolve the insights aggregation for the review store behind `db`.
 *
 * @param db   a D1 handle (real D1Database or the bun:sqlite test double)
 * @param opts windowDays (default 30, >90 clamped to 90) + optional
 *             owner/repo filter applied to EVERY aggregation
 */
export async function createInsightsStore(db: InsightsD1, opts: InsightsWindow = {}): Promise<Insights> {
  const windowDays = clampWindow(opts.windowDays);
  const repo = opts.repo;

  const where: string[] = [];
  const binds: unknown[] = [];
  if (repo !== undefined) {
    where.push("r.owner = ?", "r.repo = ?");
    binds.push(repo.owner, repo.repo);
  }
  where.push("r.reviewed_at >= datetime('now', '-' || ? || ' days')");
  binds.push(windowDays);
  const whereSql = where.join(" AND ");

  const [total, severities, categories, verdicts, trend, recurring] = await Promise.all([
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
           date(r.reviewed_at, '-' || ((strftime('%w', r.reviewed_at)+6)%7) || ' days') AS week_start,
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
         ORDER BY count DESC, f.fingerprint ASC`,
      )
      .bind(...binds)
      .all<{ fingerprint: string; title_sample: string; count: number; repos_csv: string | null }>(),
  ]);

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
  };
}
