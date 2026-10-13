/**
 * Unit tests: the dashboard insights aggregation store
 * (src/dashboard/insights-store.ts) — the review-health panel's read face.
 *
 * Locked surface (AL-22-1):
 *   - createInsightsStore(db, { windowDays, repo? }) resolves to
 *     { reviewsTotal, findingsBySeverity, findingsByCategory,
 *       verdictDistribution, weeklyTrend, dailyTrend, recurringTop,
 *       findingsDistribution }.
 *   - windowDays: integer days, default 30; >90 is CLAMPED to 90 at the
 *     store entry (the single clamp point); non-integer/negative values are
 *     the ROUTE's 400 (T2) — the store never sees them in production.
 *   - weeklyTrend buckets by Monday-anchored UTC week via the portable
 *     `date(reviewed_at, '-' || ((strftime('%w', reviewed_at)+6)%7) || ' days')`
 *     expression (no %G/%V dependency, AL-22-1).
 * - findingsDistribution (AD-652 — additive): zero-filled
 *     day/week grid derived ONLY from the clamped window (<= 30 → day,
 *     else week); week buckets reuse the weeklyTrend week definition.
 * - dailyTrend (additive `daily_trend`, window-bucketing contract
 *     2026-09-20): weeklyTrend's count semantics at day granularity,
 *     zero-filled over dayGrid — only for day windows (clamped <= 30);
 *     week windows return [] and prepare no extra query.
 * - recurringTop inlines the recurrence semantics (count >= 2
 *     distinct reviews, NULL fingerprints excluded) — parity-locked against
 *     store.recurrenceByFingerprint below (bidirectional anchor with
 *     src/store/artifact-store.ts).
 *   - Module boundary (candidate A): the store declares its own narrow D1
 *     face locally — zero imports from store/pipeline/review.
 *
 * Fixtures seed through raw INSERTs (explicit reviewed_at control — the
 * window and week-bucket tests need timestamps, which store.put's
 * datetime('now') default cannot provide). The bun:sqlite double applies
 * migrations 0001..0014 (tests/store/helpers.ts — the full current shape;
 * 0011/0012 arrive via the integration merge). The shared date helpers
 * (reviewedAt / mondayOf) live in src/dashboard/insights-dates.ts — the
 * single copy used by the store test, the T2 route test, and the T3 UI test
 * (QC W-C).
 */
import { describe, expect, test } from "bun:test";
import { createInsightsStore } from "../../src/dashboard/insights-store";
import { reviewedAt, mondayOf, dayGrid, weekGrid } from "../../src/dashboard/insights-dates";
import { computeFindingFingerprint } from "../../src/store/fingerprint";
import { recurrenceByFingerprint } from "../../src/store/artifact-store";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";

/** Fingerprint shared by the recurring fixture findings (same path/bucket/title). */
const FP_X = computeFindingFingerprint({
  mergeClass: "should-fix",
  category: "logic",
  file_path: "src/a.ts",
  line_start: 10,
  title: "Null deref risk",
});
/** A fingerprint only one fixture finding carries. */
const FP_Y = computeFindingFingerprint({
  mergeClass: "should-fix",
  category: "logic",
  file_path: "src/c.ts",
  line_start: 1,
  title: "Unhandled error",
});
/** Another single-occurrence fingerprint. */
const FP_Z = computeFindingFingerprint({
  mergeClass: "nit",
  category: "style",
  file_path: "src/d.ts",
  line_start: 1,
  title: "Trailing space",
});

type SeedFinding = {
  id: string;
  severity: string;
  category: string | null;
  title: string;
  fingerprint: string | null;
};

/** Raw-insert one review + its findings (explicit reviewed_at / verdict). */
function insertReview(
  db: TestD1,
  opts: {
    id: string;
    owner: string;
    repo: string;
    pr_number: number;
    reviewedAt: string;
    verdict: string;
    findings: SeedFinding[];
    /** v1 rows carry the envelope; M1-era rows pass null (era-gate tests). */
    envelope?: string | null;
    /**
     * `github_apps.id` row PK attribution. Omitted → `app_id` NULL, the
     * legacy unattributed shape (pre-app rows / the appId-filter tests).
     */
    appId?: string;
  },
): void {
  db.raw
    .query(
      `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, reviewed_at, verdict, summary_md, envelope, app_id)
       VALUES (?, 123, ?, ?, ?, 'sha', ?, ?, 's', ?, ?)`,
    )
    .run(opts.id, opts.owner, opts.repo, opts.pr_number, opts.reviewedAt, opts.verdict, opts.envelope === undefined ? "{}" : opts.envelope, opts.appId ?? null);
  for (const f of opts.findings) {
    db.raw
      .query(
        `INSERT INTO findings (id, review_id, severity, category, title, body, fingerprint)
         VALUES (?, ?, ?, ?, ?, 'b', ?)`,
      )
      .run(f.id, opts.id, f.severity, f.category, f.title, f.fingerprint);
  }
}

/**
 * The canonical multi-review multi-finding fixture:
 *   - r-a acme/widgets PR 1, 1 day ago, "needs fixes": must-fix/logic FP_X,
 *     should-fix/logic FP_Y
 *   - r-b acme/widgets PR 2, 8 days ago, "approved": must-fix/logic FP_X,
 *     nit/style FP_Z
 *   - r-c other/lib PR 3, 15 days ago, "needs fixes": should-fix/NULL-category FP_X
 * 1/8/15 days ago are exactly 7 days apart → three distinct Monday-anchored
 * weeks, all inside the default 30-day window.
 */
function seedFixture(db: TestD1): void {
  insertReview(db, {
    id: "r-a",
    owner: "acme",
    repo: "widgets",
    pr_number: 1,
    reviewedAt: reviewedAt(1),
    verdict: "needs fixes",
    findings: [
      { id: "f-a1", severity: "must-fix", category: "logic", title: "Null deref risk", fingerprint: FP_X },
      { id: "f-a2", severity: "should-fix", category: "logic", title: "Unhandled error", fingerprint: FP_Y },
    ],
  });
  insertReview(db, {
    id: "r-b",
    owner: "acme",
    repo: "widgets",
    pr_number: 2,
    reviewedAt: reviewedAt(8),
    verdict: "approved",
    findings: [
      { id: "f-b1", severity: "must-fix", category: "logic", title: "Null deref risk", fingerprint: FP_X },
      { id: "f-b2", severity: "nit", category: "style", title: "Trailing space", fingerprint: FP_Z },
    ],
  });
  insertReview(db, {
    id: "r-c",
    owner: "other",
    repo: "lib",
    pr_number: 3,
    reviewedAt: reviewedAt(15),
    verdict: "needs fixes",
    findings: [{ id: "f-c1", severity: "should-fix", category: null, title: "Null deref risk", fingerprint: FP_X }],
  });
  // M1-era row (Bugbot wave-1): envelope NULL + old vocab (critical/comment)
  // — must be excluded from EVERY aggregate by the era gate
  // (`envelope IS NOT NULL` ⇔ v1 row, migration 0002), not by the window or
  // repo filter. NULL fingerprint keeps the recurrence parity lock with
  // store.recurrenceByFingerprint intact (both sides exclude it).
  insertReview(db, {
    id: "r-m1",
    owner: "acme",
    repo: "widgets",
    pr_number: 4,
    // Same timestamp as r-a: the era gate (not the week window) is what
    // excludes the row — reviewedAt(1) is deterministic across calendar
    // weeks, where -1/-2 days can straddle the Monday boundary.
    reviewedAt: reviewedAt(1),
    verdict: "comment",
    envelope: null,
    findings: [{ id: "f-m1", severity: "critical", category: "security", title: "Old era finding", fingerprint: null }],
  });
}

describe("createInsightsStore", () => {
  test("aggregates severity/category/verdict/reviews over the window (default 30)", async () => {
    const db = createMigratedTestD1();
    seedFixture(db);

    const insights = await createInsightsStore(db);

    expect(insights.reviewsTotal).toBe(3);
    // count DESC, then severity ASC (deterministic).
    expect(insights.findingsBySeverity).toEqual([
      { severity: "must-fix", count: 2 },
      { severity: "should-fix", count: 2 },
      { severity: "nit", count: 1 },
    ]);
    // count DESC, then category ASC — SQLite sorts NULL first.
    expect(insights.findingsByCategory).toEqual([
      { category: "logic", count: 3 },
      { category: null, count: 1 },
      { category: "style", count: 1 },
    ]);
    expect(insights.verdictDistribution).toEqual([
      { verdict: "needs fixes", count: 2 },
      { verdict: "approved", count: 1 },
    ]);
  });

  test("M1-era rows (envelope NULL, old vocab) are excluded from every aggregate (era gate)", async () => {
    const db = createMigratedTestD1();
    seedFixture(db);

    const insights = await createInsightsStore(db);

    // Old-vocab severity/verdict/category never surface in any aggregate.
    expect(insights.findingsBySeverity.some((s) => s.severity === "critical")).toBe(false);
    expect(insights.verdictDistribution.some((v) => v.verdict === "comment")).toBe(false);
    expect(insights.findingsByCategory.some((c) => c.category === "security")).toBe(false);
    // The M1 review shares r-a's timestamp — the era gate, not the window,
    // is what keeps it out of weeklyTrend: the week containing that
    // timestamp shows ONLY r-a's counts (reviews: 1, findings: 2), never
    // r-m1's (which would make it reviews: 2, findings: 3).
    expect(insights.weeklyTrend.find((w) => w.week_start === mondayOf(reviewedAt(1)))).toEqual({
      week_start: mondayOf(reviewedAt(1)),
      reviews: 1,
      findings: 2,
    });
    // NULL fingerprint + envelope NULL → never in recurringTop.
    expect(insights.recurringTop).toEqual([
      { fingerprint: FP_X, title_sample: "Null deref risk", count: 3, repos: ["acme/widgets", "other/lib"] },
    ]);
  });

  test("weeklyTrend buckets by Monday-anchored UTC week, ascending", async () => {
    const db = createMigratedTestD1();
    seedFixture(db);

    const insights = await createInsightsStore(db);

    const weekA = mondayOf(reviewedAt(1));
    const weekB = mondayOf(reviewedAt(8));
    const weekC = mondayOf(reviewedAt(15));
    // 7 days apart → three distinct weeks; assert that explicitly.
    expect(new Set([weekA, weekB, weekC]).size).toBe(3);

    expect(insights.weeklyTrend).toEqual([
      { week_start: weekC, reviews: 1, findings: 1 },
      { week_start: weekB, reviews: 1, findings: 2 },
      { week_start: weekA, reviews: 1, findings: 2 },
    ]);
  });

  test("recurringTop matches the recurrence semantics (count >= 2, NULL excluded, repos aggregated)", async () => {
    const db = createMigratedTestD1();
    seedFixture(db);

    const insights = await createInsightsStore(db);

    expect(insights.recurringTop).toEqual([
      { fingerprint: FP_X, title_sample: "Null deref risk", count: 3, repos: ["acme/widgets", "other/lib"] },
    ]);
  });

  test("repo filter restricts every aggregation to one owner/repo pair", async () => {
    const db = createMigratedTestD1();
    seedFixture(db);

    const insights = await createInsightsStore(db, { repo: { owner: "acme", repo: "widgets" } });

    expect(insights.reviewsTotal).toBe(2);
    expect(insights.findingsBySeverity).toEqual([
      { severity: "must-fix", count: 2 },
           { severity: "nit", count: 1 },
      { severity: "should-fix", count: 1 },
    ]);
    expect(insights.findingsByCategory).toEqual([
      { category: "logic", count: 3 },
      { category: "style", count: 1 },
    ]);
    expect(insights.verdictDistribution).toEqual([
           { verdict: "approved", count: 1 },
      { verdict: "needs fixes", count: 1 },
    ]);
    expect(insights.weeklyTrend).toHaveLength(2);
    expect(insights.recurringTop).toEqual([
      { fingerprint: FP_X, title_sample: "Null deref risk", count: 2, repos: ["acme/widgets"] },
    ]);
  });

  test("window excludes out-of-window reviews; >90 clamps to 90 (single clamp point)", async () => {
    const db = createMigratedTestD1();
    insertReview(db, {
      id: "r-recent",
      owner: "acme",
      repo: "widgets",
      pr_number: 1,
      reviewedAt: reviewedAt(1),
      verdict: "needs fixes",
      findings: [{ id: "f-1", severity: "must-fix", category: "logic", title: "Null deref risk", fingerprint: FP_X }],
    });
    insertReview(db, {
      id: "r-mid",
      owner: "acme",
      repo: "widgets",
      pr_number: 2,
      reviewedAt: reviewedAt(50),
      verdict: "needs fixes",
      findings: [{ id: "f-2", severity: "must-fix", category: "logic", title: "Null deref risk", fingerprint: FP_X }],
    });
    insertReview(db, {
      id: "r-old",
      owner: "acme",
      repo: "widgets",
      pr_number: 3,
      reviewedAt: reviewedAt(100),
      verdict: "needs fixes",
      findings: [{ id: "f-3", severity: "must-fix", category: "logic", title: "Null deref risk", fingerprint: FP_X }],
    });

    // Default window (30): only the 1-day-old review → count 1 → no recurrence.
    const d30 = await createInsightsStore(db);
    expect(d30.reviewsTotal).toBe(1);
    expect(d30.recurringTop).toEqual([]);

    // windowDays=60: 1d + 50d in, 100d out → count 2.
    const d60 = await createInsightsStore(db, { windowDays: 60 });
    expect(d60.reviewsTotal).toBe(2);
    expect(d60.recurringTop).toEqual([
      { fingerprint: FP_X, title_sample: "Null deref risk", count: 2, repos: ["acme/widgets"] },
    ]);

    // windowDays=200 clamps to 90: 100d still out → identical to 60.
    const clamped = await createInsightsStore(db, { windowDays: 200 });
    expect(clamped.reviewsTotal).toBe(2);
    expect(clamped.recurringTop).toEqual(d60.recurringTop);
  });

  test("empty database → zero counts, empty arrays, zero-filled day grid (no division, no NULL rows)", async () => {
    const db = createMigratedTestD1();

    const insights = await createInsightsStore(db);

    expect(insights).toEqual({
      reviewsTotal: 0,
      findingsBySeverity: [],
      findingsByCategory: [],
      verdictDistribution: [],
      weeklyTrend: [],
      // the daily trend (additive `daily_trend`) is the same zero-filled
      // day grid on the empty day window.
      dailyTrend: dayGrid(30).map((day_start) => ({ day_start, reviews: 0, findings: 0 })),
      recurringTop: [],
      repos: [],
      // the distribution grid is zero-count-honest, not empty —
      // every UTC day of the default 30-day window, all zeros, with only the
      // "uncategorized" fallback in the (empty) category union.
      findingsDistribution: dayGrid(30).map((bucket_start) => ({
        bucket_start,
        granularity: "day" as const,
        by_severity: { "must-fix": 0, "should-fix": 0, nit: 0 },
        by_category: { uncategorized: 0 },
      })),
    });
  });

  test("NULL fingerprints never enter recurringTop (era gate parity)", async () => {
    const db = createMigratedTestD1();
    insertReview(db, {
      id: "r-1",
      owner: "acme",
      repo: "widgets",
      pr_number: 1,
      reviewedAt: reviewedAt(1),
      verdict: "needs fixes",
      findings: [{ id: "f-1", severity: "must-fix", category: "logic", title: "Null deref risk", fingerprint: FP_X }],
    });
    insertReview(db, {
      id: "r-2",
      owner: "acme",
      repo: "widgets",
      pr_number: 2,
      reviewedAt: reviewedAt(2),
      verdict: "needs fixes",
      findings: [{ id: "f-2", severity: "must-fix", category: "logic", title: "Null deref risk", fingerprint: FP_X }],
    });
    // A NULL-fingerprint finding that would join the group IF it carried one.
    insertReview(db, {
      id: "r-3",
      owner: "acme",
      repo: "widgets",
      pr_number: 3,
      reviewedAt: reviewedAt(3),
      verdict: "needs fixes",
      findings: [{ id: "f-3", severity: "must-fix", category: "logic", title: "Null deref risk", fingerprint: null }],
    });

    const insights = await createInsightsStore(db);
    expect(insights.recurringTop).toEqual([
      { fingerprint: FP_X, title_sample: "Null deref risk", count: 2, repos: ["acme/widgets"] },
    ]);
  });

  test("recurringTop is parity-locked against store.recurrenceByFingerprint (bidirectional anchor)", async () => {
    const db = createMigratedTestD1();
    seedFixture(db);

    const insights = await createInsightsStore(db, { windowDays: 30 });
    const storeRows = await recurrenceByFingerprint(db, { window_days: 30 });
    expect(insights.recurringTop).toEqual(storeRows);

    const filtered = await createInsightsStore(db, { windowDays: 30, repo: { owner: "acme", repo: "widgets" } });
    const filteredStoreRows = await recurrenceByFingerprint(db, {
      window_days: 30,
      repo: { owner: "acme", repo: "widgets" },
    });
    expect(filtered.recurringTop).toEqual(filteredStoreRows);
  });
  test("recurringTop is bounded: 15 qualifying fingerprints → exactly the top 10 (W-E)", async () => {
    const db = createMigratedTestD1();
    // 15 distinct fingerprints with counts 15..2 — the top 10 by count DESC
    // (fp-01..fp-10) must be returned; fp-11..fp-15 are cut by LIMIT 10.
    const counts = [15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 2];
    let seq = 0;
    counts.forEach((count, i) => {
      const fp = `fp-${String(i + 1).padStart(2, "0")}`;
      for (let k = 0; k < count; k++) {
        seq += 1;
        insertReview(db, {
          id: `r-${String(seq).padStart(3, "0")}`,
          owner: "acme",
          repo: "widgets",
          pr_number: seq,
          reviewedAt: reviewedAt(1),
          verdict: "needs fixes",
          findings: [
            {
              id: `f-${String(seq).padStart(3, "0")}`,
              severity: "must-fix",
              category: "logic",
              title: `Recurring ${fp}`,
              fingerprint: fp,
            },
          ],
        });
      }
    });

    const insights = await createInsightsStore(db);
    expect(insights.recurringTop).toHaveLength(10);
    expect(insights.recurringTop.map((g) => g.fingerprint)).toEqual(
      Array.from({ length: 10 }, (_, i) => `fp-${String(i + 1).padStart(2, "0")}`),
    );
    expect(insights.recurringTop[0]).toEqual({
      fingerprint: "fp-01",
      title_sample: "Recurring fp-01",
      count: 15,
      repos: ["acme/widgets"],
    });
    expect(insights.recurringTop[9]).toEqual({
      fingerprint: "fp-10",
      title_sample: "Recurring fp-10",
      count: 6,
      repos: ["acme/widgets"],
    });
  });

  /**
   * Relative week-boundary anchor (S-1 residual remedy): the most recent
   * Sunday strictly before today, in UTC. Independent calendar arithmetic on
   * the real clock — platform `getUTCDay()` (0 = Sunday) plus epoch-day math;
   * it neither calls the store's `mondayOf` mirror nor replicates the SQL
   * `strftime('%w')` expression, so a shared off-by-one cannot hide in the
   * helper either. The pair is exact to the second: `sundayLast` is the final
   * second of that Sunday, `mondayFirst` the first second of the following
   * Monday — always 1..7 days in the past, so the pair stays inside the
   * default 30-day window for every "today" (today-is-Sunday and
   * today-is-Monday included).
   */
  function weekBoundaryAnchor(): {
    sundayLast: string;
    mondayFirst: string;
    prevWeekStart: string;
    nextWeekStart: string;
    prevDayStart: string;
    nextDayStart: string;
  } {
    const DAY_MS = 86_400_000;
    const now = new Date();
    const utcMidnight = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());
    // 1..7 days back to the most recent Sunday (7 when today IS Sunday, so
    // the anchor is never "today" and both timestamps are strictly past).
    const sundayDaysAgo = ((now.getUTCDay() + 6) % 7) + 1;
    const sunday = utcMidnight - sundayDaysAgo * DAY_MS;
    const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
    const isoStamp = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
    return {
      sundayLast: isoStamp(sunday + DAY_MS - 1000), // 23:59:59 that Sunday
      mondayFirst: isoStamp(sunday + DAY_MS), // 00:00:00 the following Monday
      prevWeekStart: isoDate(sunday - 6 * DAY_MS), // Monday opening that Sunday's week
      nextWeekStart: isoDate(sunday + DAY_MS), // the boundary Monday itself
      prevDayStart: isoDate(sunday),
      nextDayStart: isoDate(sunday + DAY_MS),
    };
  }

  test("weeklyTrend Monday anchor at the live week boundary (S-1)", async () => {
    const db = createMigratedTestD1();
    // Relative boundary anchor (the old hard-coded 2026-09-06/07 pair slides
    // out of the 30d window every ~30 days): the pair is the most recent past
    // Sunday's LAST second and the following Monday's FIRST second. The last
    // second of Sunday belongs to the week starting the previous Monday; the
    // first second of Monday starts the NEXT week — two ADJACENT weeks — so
    // an off-by-one in the SQL weekday expression still fails this exact
    // two-row key match, and so does the same mistake mirrored into JS.
    const a = weekBoundaryAnchor();
    insertReview(db, {
      id: "r-sun",
      owner: "acme",
      repo: "widgets",
      pr_number: 1,
      reviewedAt: a.sundayLast,
      verdict: "needs fixes",
      findings: [{ id: "f-sun", severity: "must-fix", category: "logic", title: "Null deref risk", fingerprint: FP_X }],
    });
    insertReview(db, {
      id: "r-mon",
      owner: "acme",
      repo: "widgets",
      pr_number: 2,
      reviewedAt: a.mondayFirst,
      verdict: "needs fixes",
      findings: [{ id: "f-mon", severity: "must-fix", category: "logic", title: "Null deref risk", fingerprint: FP_X }],
    });

    const insights = await createInsightsStore(db);
    expect(insights.weeklyTrend).toEqual([
      { week_start: a.prevWeekStart, reviews: 1, findings: 1 },
      { week_start: a.nextWeekStart, reviews: 1, findings: 1 },
    ]);
  });

  test("dailyTrend day boundary at the live day boundary (S-1 extension)", async () => {
    const db = createMigratedTestD1();
    // The same relative boundary pair as the weekly S-1 pin above: the day
    // bucket is the plain UTC date (`date(r.reviewed_at)` — the distribution
    // day expression, never a second one), so the Sunday's last second lands
    // on the Sunday and the Monday's first second on the Monday — adjacent
    // day buckets. The exact per-key match still catches a shared
    // day-expression mistake that a mirror-only test would pass.
    const a = weekBoundaryAnchor();
    insertReview(db, {
      id: "r-dsun",
      owner: "acme",
      repo: "widgets",
      pr_number: 1,
      reviewedAt: a.sundayLast,
      verdict: "needs fixes",
      findings: [{ id: "f-dsun", severity: "must-fix", category: "logic", title: "Null deref risk", fingerprint: FP_X }],
    });
    insertReview(db, {
      id: "r-dmon",
      owner: "acme",
      repo: "widgets",
      pr_number: 2,
      reviewedAt: a.mondayFirst,
      verdict: "needs fixes",
      findings: [{ id: "f-dmon", severity: "must-fix", category: "logic", title: "Null deref risk", fingerprint: FP_X }],
    });

    const insights = await createInsightsStore(db);
    expect(insights.dailyTrend.find((b) => b.day_start === a.prevDayStart)).toEqual({
      day_start: a.prevDayStart,
      reviews: 1,
      findings: 1,
    });
    expect(insights.dailyTrend.find((b) => b.day_start === a.nextDayStart)).toEqual({
      day_start: a.nextDayStart,
      reviews: 1,
      findings: 1,
    });
  });

  // --- (additive `daily_trend`) ---------------------------------------

  test("dailyTrend: zero-filled day grid on a day window, ascending, page-total parity", async () => {
    const db = createMigratedTestD1();
    seedFixture(db);

    const insights = await createInsightsStore(db, { windowDays: 7 });

    // Day window → the full N+1 grid (today-7 .. today, both ends inclusive),
    // ascending — every day the window predicate can return, zero-filled.
    expect(insights.dailyTrend.map((b) => b.day_start)).toEqual(dayGrid(7));
    // Only r-a (1d ago) is in-window: its day carries reviews 1 / findings 2
    // (era-gated r-m1 shares the timestamp and adds nothing); every other day
    // is honestly zero. r-b (8d) and r-c (15d) sit outside the 7-day window.
    const at = (daysAgo: number) =>
      insights.dailyTrend.find((b) => b.day_start === reviewedAt(daysAgo).slice(0, 10))!;
    expect(at(1)).toEqual({ day_start: reviewedAt(1).slice(0, 10), reviews: 1, findings: 2 });
    expect(at(0)).toEqual({ day_start: reviewedAt(0).slice(0, 10), reviews: 0, findings: 0 });
    expect(at(7)).toEqual({ day_start: reviewedAt(7).slice(0, 10), reviews: 0, findings: 0 });
    // Zero-loss invariant: grid totals == page totals.
    expect(insights.reviewsTotal).toBe(1);
    expect(insights.dailyTrend.reduce((acc, b) => acc + b.reviews, 0)).toBe(insights.reviewsTotal);
    expect(insights.dailyTrend.reduce((acc, b) => acc + b.findings, 0)).toBe(2);
  });

  test("dailyTrend: week window returns [] with no day-bucket query; weekly_trend pin unchanged", async () => {
    const db = createMigratedTestD1();
    seedFixture(db);

    // Counting wrappers around the same D1 double — one run per window.
    const dayQueries: string[] = [];
    const dayInsights = await createInsightsStore(
      {
        prepare: (query: string) => {
          dayQueries.push(query);
          return db.prepare(query);
        },
      },
      { windowDays: 30 },
    );
    const weekQueries: string[] = [];
    const weekInsights = await createInsightsStore(
      {
        prepare: (query: string) => {
          weekQueries.push(query);
          return db.prepare(query);
        },
      },
      { windowDays: 90 },
    );

    // Week windows produce exactly [] — the 90d trend card reads the frozen
    // weekly_trend key instead.
    expect(weekInsights.dailyTrend).toEqual([]);
    // weekly_trend output is byte-identical to its long-standing pin on the
    // same window: the frozen key is untouched by the new face.
    expect(weekInsights.weeklyTrend).toEqual([
      { week_start: mondayOf(reviewedAt(15)), reviews: 1, findings: 1 },
      { week_start: mondayOf(reviewedAt(8)), reviews: 1, findings: 2 },
      { week_start: mondayOf(reviewedAt(1)), reviews: 1, findings: 2 },
    ]);
    // Zero added query cost: the week run prepares exactly the day run's
    // statements MINUS the one additive day-bucket query.
    expect(dayQueries.some((query) => query.includes("AS day_start"))).toBe(true);
    expect(weekQueries.every((query) => !query.includes("AS day_start"))).toBe(true);
    expect(weekQueries.length).toBe(dayQueries.length - 1);
  });

  test("repos aggregation is opt-in: skipped ([]) without includeRepos, populated with it (QC F-001)", async () => {
    const db = createMigratedTestD1();
    seedFixture(db);

    const without = await createInsightsStore(db);
    expect(without.repos).toEqual([]);

    const withRepos = await createInsightsStore(db, { includeRepos: true });
    expect(withRepos.repos).toEqual(["acme/widgets", "other/lib"]);
  });

  test("repos is the window-scoped distinct set, independent of the repo filter", async () => {
    const db = createMigratedTestD1();
    seedFixture(db);
    insertReview(db, {
      id: "r-old",
      owner: "old",
      repo: "gone",
      pr_number: 9,
      reviewedAt: reviewedAt(100),
      verdict: "needs fixes",
      findings: [{ id: "f-old", severity: "must-fix", category: "logic", title: "Old", fingerprint: FP_X }],
    });
    insertReview(db, {
      id: "r-m1-only",
      owner: "era",
      repo: "legacy",
      pr_number: 10,
      reviewedAt: reviewedAt(1),
      verdict: "comment",
      envelope: null,
      findings: [{ id: "f-m1-only", severity: "critical", category: "security", title: "Old era", fingerprint: null }],
    });

    const all = await createInsightsStore(db, { includeRepos: true });
    expect(all.repos).toEqual(["acme/widgets", "other/lib"]);

    const filtered = await createInsightsStore(db, { repo: { owner: "acme", repo: "widgets" }, includeRepos: true });
    expect(filtered.reviewsTotal).toBe(2);
    expect(filtered.repos).toEqual(["acme/widgets", "other/lib"]);

    const clamped = await createInsightsStore(db, { windowDays: 200, includeRepos: true });
    expect(clamped.repos).toEqual(["acme/widgets", "other/lib"]);
  });

  // --- (AD-652): findingsDistribution --------------------------------

  test("findingsDistribution: day grid over the default window, zero-filled, ASC", async () => {
    const db = createMigratedTestD1();
    seedFixture(db);

    const insights = await createInsightsStore(db);

    const grid = insights.findingsDistribution;
    // windowDays <= 30 → "day" on every bucket.
    expect(grid.every((b) => b.granularity === "day")).toBe(true);
    // The full intersecting grid: today-30 .. today, ascending.
    expect(grid.map((b) => b.bucket_start)).toEqual(dayGrid(30));
    // Stable series keys on EVERY bucket — severity is the fixed merge-class
    // set, category the window-level union + "uncategorized" fallback last.
    for (const bucket of grid) {
      expect(Object.keys(bucket.by_severity)).toEqual(["must-fix", "should-fix", "nit"]);
      expect(Object.keys(bucket.by_category)).toEqual(["logic", "style", "uncategorized"]);
    }
    // Bucket lookup keyed by the seed timestamp's own UTC date (independent
    // derivation — reviewedAt pins hour 12:00 UTC, so the date part is stable).
    const at = (daysAgo: number) =>
      grid.find((b) => b.bucket_start === reviewedAt(daysAgo).slice(0, 10))!;
    // r-a (1d ago): must-fix/logic + should-fix/logic.
    expect(at(1)).toMatchObject({
      by_severity: { "must-fix": 1, "should-fix": 1, nit: 0 },
      by_category: { logic: 2, style: 0, uncategorized: 0 },
    });
    // r-b (8d ago): must-fix/logic + nit/style.
    expect(at(8)).toMatchObject({
      by_severity: { "must-fix": 1, "should-fix": 0, nit: 1 },
      by_category: { logic: 1, style: 1, uncategorized: 0 },
    });
    // r-c (15d ago): should-fix, NULL category → the uncategorized fallback.
    expect(at(15)).toMatchObject({
      by_severity: { "must-fix": 0, "should-fix": 1, nit: 0 },
      by_category: { logic: 0, style: 0, uncategorized: 1 },
    });
    // A no-review day is honestly zero — and era-gated r-m1 (critical /
    // security, envelope NULL, same timestamp as r-a) contributes nothing.
    expect(at(2)).toEqual({
      bucket_start: reviewedAt(2).slice(0, 10),
      granularity: "day",
      by_severity: { "must-fix": 0, "should-fix": 0, nit: 0 },
      by_category: { logic: 0, style: 0, uncategorized: 0 },
    });
    // Totals across the grid equal the page-level finding count (5 v1
    // findings; the era-gated 6th never distributes).
    const sum = (record: Record<string, number>) => Object.values(record).reduce((a, c) => a + c, 0);
    expect(grid.reduce((acc, b) => acc + sum(b.by_severity), 0)).toBe(5);
    expect(grid.reduce((acc, b) => acc + sum(b.by_category), 0)).toBe(5);
  });

  test("findingsDistribution: week grid for windowDays=90, same week definition as weeklyTrend", async () => {
    const db = createMigratedTestD1();
    seedFixture(db);

    const insights = await createInsightsStore(db, { windowDays: 90 });

    const grid = insights.findingsDistribution;
    // windowDays > 30 → "week" on every bucket.
    expect(grid.every((b) => b.granularity === "week")).toBe(true);
    // Every bucket_start is a Monday (UTC) — independent weekday check, no
    // mirror involved.
    for (const bucket of grid) {
      expect(new Date(`${bucket.bucket_start}T00:00:00Z`).getUTCDay()).toBe(1);
    }
    // The grid spans every Monday intersecting the (clamped) window, first
    // and last partial.
    expect(grid.map((b) => b.bucket_start)).toEqual(weekGrid(90));
    expect(grid[0]!.bucket_start).toBe(mondayOf(reviewedAt(90)));
    expect(grid[grid.length - 1]!.bucket_start).toBe(mondayOf(reviewedAt(0)));
    // Same week definition as weekly_trend: per-week severity/category sums
    // match that week's weekly_trend findings count.
    const sum = (record: Record<string, number>) => Object.values(record).reduce((a, c) => a + c, 0);
    for (const week of insights.weeklyTrend) {
      const bucket = grid.find((b) => b.bucket_start === week.week_start)!;
      expect(sum(bucket.by_severity)).toBe(week.findings);
      expect(sum(bucket.by_category)).toBe(week.findings);
    }
    // Era-gated r-m1 never inflates any week bucket: the grid total stays at
    // the 5 v1 findings.
    expect(grid.reduce((acc, b) => acc + sum(b.by_severity), 0)).toBe(5);
  });

  test("findingsDistribution: granularity derives only from the clamped window", async () => {
    const db = createMigratedTestD1();

    for (const [windowDays, granularity] of [
      [0, "day"],
      [7, "day"],
      [30, "day"],
      [31, "week"],
      [90, "week"],
      [200, "week"], // clamps to 90 at the store entry → week
    ] as const) {
      const insights = await createInsightsStore(db, { windowDays });
      expect(
        insights.findingsDistribution.every((b) => b.granularity === granularity),
        `window=${windowDays}`,
      ).toBe(true);
    }

    // window=200 clamps to 90 → the grid is identical to an explicit 90.
    const clamped = await createInsightsStore(db, { windowDays: 200 });
    const explicit = await createInsightsStore(db, { windowDays: 90 });
    expect(clamped.findingsDistribution).toEqual(explicit.findingsDistribution);
  });

  test("findingsDistribution respects the repo filter", async () => {
    const db = createMigratedTestD1();
    seedFixture(db);

    const insights = await createInsightsStore(db, { repo: { owner: "acme", repo: "widgets" } });

    // r-c (other/lib, 15d ago, NULL category) drops out: the window-level
    // category union shrinks to acme's {logic, style} + uncategorized, and
    // the 15d bucket goes honestly all-zero.
    for (const bucket of insights.findingsDistribution) {
      expect(Object.keys(bucket.by_category)).toEqual(["logic", "style", "uncategorized"]);
    }
    const at = (daysAgo: number) =>
      insights.findingsDistribution.find((b) => b.bucket_start === reviewedAt(daysAgo).slice(0, 10))!;
    expect(at(15)).toMatchObject({
      by_severity: { "must-fix": 0, "should-fix": 0, nit: 0 },
      by_category: { logic: 0, style: 0, uncategorized: 0 },
    });
    expect(at(1)).toMatchObject({
      by_severity: { "must-fix": 1, "should-fix": 1, nit: 0 },
      by_category: { logic: 2, style: 0, uncategorized: 0 },
    });
  });

  // --- appId filter (per-App insights data face) ----------------------

  /**
   * App-scoped fixture: r-a attributed to app-a, r-b to app-b, r-c left
   * `app_id` NULL (legacy unattributed row). Same three weeks as seedFixture.
   */
  function seedAppFixture(db: TestD1): void {
    // github_apps rows for the FK — the ids are the appId option's values.
    for (const [id, ghId] of [["app-a", 1001], ["app-b", 1002]] as const) {
      db.raw
        .query(
          `INSERT INTO github_apps
             (id, slug, github_app_id, name, private_key_enc, webhook_secret_enc,
              created_by, status, deleted_at, created_at, updated_at)
           VALUES (?, ?, ?, ?, 'enc', 'enc', 'tester', 'active', NULL, datetime('now'), datetime('now'))`,
        )
        .run(id, id, ghId, id);
    }
    insertReview(db, {
      id: "r-a",
      owner: "acme",
      repo: "widgets",
      pr_number: 1,
      reviewedAt: reviewedAt(1),
      verdict: "needs fixes",
      appId: "app-a",
      findings: [{ id: "f-a1", severity: "must-fix", category: "logic", title: "Null deref risk", fingerprint: FP_X }],
    });
    insertReview(db, {
      id: "r-b",
      owner: "acme",
      repo: "portal",
      pr_number: 2,
      reviewedAt: reviewedAt(8),
      verdict: "approved",
      appId: "app-b",
      findings: [{ id: "f-b1", severity: "nit", category: "style", title: "Trailing space", fingerprint: FP_Z }],
    });
    insertReview(db, {
      id: "r-c",
      owner: "other",
      repo: "lib",
      pr_number: 3,
      reviewedAt: reviewedAt(15),
      verdict: "needs fixes",
      // no appId → legacy app_id NULL row
      findings: [{ id: "f-c1", severity: "should-fix", category: null, title: "Null deref risk", fingerprint: FP_X }],
    });
  }

  test("appId restricts every aggregation to one app: other apps and legacy app_id NULL rows excluded", async () => {
    const db = createMigratedTestD1();
    seedAppFixture(db);

    const insights = await createInsightsStore(db, { appId: "app-a" });

    expect(insights.reviewsTotal).toBe(1);
    expect(insights.findingsBySeverity).toEqual([{ severity: "must-fix", count: 1 }]);
    expect(insights.findingsByCategory).toEqual([{ category: "logic", count: 1 }]);
    expect(insights.verdictDistribution).toEqual([{ verdict: "needs fixes", count: 1 }]);
    // Only app-a's week survives the filter.
    expect(insights.weeklyTrend).toEqual([
      { week_start: mondayOf(reviewedAt(1)), reviews: 1, findings: 1 },
    ]);
    // Distribution: app-b (8d) and legacy (15d) buckets go honestly zero,
    // and the category union carries only app-a's observed keys.
    const at = (daysAgo: number) =>
      insights.findingsDistribution.find((b) => b.bucket_start === reviewedAt(daysAgo).slice(0, 10))!;
    expect(at(1)).toMatchObject({
      by_severity: { "must-fix": 1, "should-fix": 0, nit: 0 },
      by_category: { logic: 1, uncategorized: 0 },
    });
    expect(at(8)).toMatchObject({ by_severity: { "must-fix": 0, nit: 0 } });
    expect(at(15)).toMatchObject({ by_severity: { "must-fix": 0, "should-fix": 0 } });
    expect(Object.keys(insights.findingsDistribution[0]!.by_category)).toEqual(["logic", "uncategorized"]);
  });

  test("appId + includeRepos: repos lists only the app's own repos, never other apps'", async () => {
    const db = createMigratedTestD1();
    seedAppFixture(db);

    const insights = await createInsightsStore(db, { appId: "app-a", includeRepos: true });

    expect(insights.repos).toEqual(["acme/widgets"]);
  });

  test("without appId, outputs match the pre-appId pinned expectations (zero-diff pin)", async () => {
    const db = createMigratedTestD1();
    seedAppFixture(db);

    const insights = await createInsightsStore(db, { includeRepos: true });

    // All three rows count (app attribution is invisible without the filter).
    expect(insights.reviewsTotal).toBe(3);
    expect(insights.findingsBySeverity).toEqual([
      { severity: "must-fix", count: 1 },
      { severity: "nit", count: 1 },
      { severity: "should-fix", count: 1 },
    ]);
    expect(insights.verdictDistribution).toEqual([
      { verdict: "needs fixes", count: 2 },
      { verdict: "approved", count: 1 },
    ]);
    expect(insights.weeklyTrend).toHaveLength(3);
    expect(insights.repos).toEqual(["acme/portal", "acme/widgets", "other/lib"]);
  });
});
