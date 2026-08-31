/**
 * Plan 22 Task 1 tests: the dashboard insights aggregation store
 * (src/dashboard/insights-store.ts) — the review-health panel's read face.
 *
 * Locked surface (AL-22-1):
 *   - createInsightsStore(db, { windowDays, repo? }) resolves to
 *     { reviewsTotal, findingsBySeverity, findingsByCategory,
 *       verdictDistribution, weeklyTrend, recurringTop }.
 *   - windowDays: integer days, default 30; >90 is CLAMPED to 90 at the
 *     store entry (the single clamp point); non-integer/negative values are
 *     the ROUTE's 400 (T2) — the store never sees them in production.
 *   - weeklyTrend buckets by Monday-anchored UTC week via the portable
 *     `date(reviewed_at, '-' || ((strftime('%w', reviewed_at)+6)%7) || ' days')`
 *     expression (no %G/%V dependency, AL-22-1).
 *   - recurringTop inlines the plan-21 recurrence semantics (count >= 2
 *     distinct reviews, NULL fingerprints excluded) — parity-locked against
 *     store.recurrenceByFingerprint below (bidirectional anchor with
 *     src/store/artifact-store.ts).
 *   - Module boundary (candidate A): the store declares its own narrow D1
 *     face locally — zero imports from store/pipeline/review.
 *
 * Fixtures seed through raw INSERTs (explicit reviewed_at control — the
 * window and week-bucket tests need timestamps, which store.put's
 * datetime('now') default cannot provide). The bun:sqlite double applies
 * migrations 0001..0010 (tests/store/helpers.ts — the full current shape;
 * 0011/0012 do not exist in this branch).
 */
import { describe, expect, test } from "bun:test";
import { createInsightsStore } from "../../src/dashboard/insights-store";
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

/**
 * UTC datetime string N days before now, hour forced to 12:00 UTC — the
 * same `YYYY-MM-DD HH:MM:SS` format SQLite datetime('now') writes. The
 * fixed hour keeps the date part stable across the test's runtime.
 */
function reviewedAt(daysAgo: number): string {
  const d = new Date(Date.now() - daysAgo * 86_400_000);
  d.setUTCHours(12, 0, 0, 0);
  return d.toISOString().slice(0, 19).replace("T", " ");
}

/**
 * Monday-anchored week start (UTC, YYYY-MM-DD) for a SQLite datetime
 * string — a JS mirror of the store's bucketing expression, so expected
 * values are computed from the SAME seeded timestamps (no clock race).
 */
function mondayOf(dt: string): string {
  const [y, m, d] = dt.split(" ")[0]!.split("-").map(Number);
  const dow = new Date(Date.UTC(y!, m! - 1, d!)).getUTCDay();
  const daysToMonday = (dow + 6) % 7;
  return new Date(Date.UTC(y!, m! - 1, d! - daysToMonday)).toISOString().slice(0, 10);
}

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
  },
): void {
  db.raw
    .query(
      `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, reviewed_at, verdict, summary_md, envelope)
       VALUES (?, 123, ?, ?, ?, 'sha', ?, ?, 's', '{}')`,
    )
    .run(opts.id, opts.owner, opts.repo, opts.pr_number, opts.reviewedAt, opts.verdict);
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

  test("recurringTop matches plan-21 semantics (count >= 2, NULL excluded, repos aggregated)", async () => {
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

  test("empty database → zero counts and empty arrays (no division, no NULL rows)", async () => {
    const db = createMigratedTestD1();

    const insights = await createInsightsStore(db);

    expect(insights).toEqual({
      reviewsTotal: 0,
      findingsBySeverity: [],
      findingsByCategory: [],
      verdictDistribution: [],
      weeklyTrend: [],
      recurringTop: [],
    });
  });

  test("NULL fingerprints never enter recurringTop (era gate parity with plan 21)", async () => {
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
});
