import { describe, expect, test } from "bun:test";
import { createInsightsStore } from "../../src/dashboard/insights-store";
import { reviewedAt, mondayOf, dayGrid, weekGrid } from "../../src/dashboard/insights-dates";
import { computeFindingFingerprint } from "../../src/store/fingerprint";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";

const FP_X = computeFindingFingerprint({
  mergeClass: "should-fix",
  category: "logic",
  file_path: "src/a.ts",
  line_start: 10,
  title: "Null deref risk",
});
const FP_Y = computeFindingFingerprint({
  mergeClass: "should-fix",
  category: "logic",
  file_path: "src/c.ts",
  line_start: 1,
  title: "Unhandled error",
});
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

const WORKSPACE = "default";
const FIXTURE_TARGET = "target-fixture";
const FIXTURE_SCOPE = { kind: "target", targetId: FIXTURE_TARGET, workspaceId: WORKSPACE } as const;

function seedTenant(db: TestD1, targetId: string, botId: string): void {
  const now = "2026-01-01T00:00:00.000Z";
  const githubAppId = [...botId].reduce((acc, ch) => (acc * 31 + ch.charCodeAt(0)) % 1_000_000, 7);
  db.raw
    .prepare(
      `INSERT OR IGNORE INTO review_bots
         (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, created_at, updated_at)
       VALUES (?, NULL, ?, ?, 'v1.primary.aXZpdi.cHJldGV4dA==', 'v1.primary.aXZpdi.cHJldGV4dA==',
               'octocat', 'active', ?, ?)`,
    )
    .run(botId, githubAppId, botId, now, now);
  db.raw
    .prepare(
      `INSERT OR IGNORE INTO review_targets (id, workspace_id, bot_id, name, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'fixture', ?, ?)`,
    )
    .run(targetId, WORKSPACE, botId, botId, now, now);
}

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
    envelope?: string | null;
    targetId?: string | null;
  },
): void {
  const targetId = opts.targetId === undefined ? FIXTURE_TARGET : opts.targetId;
  seedTenant(db, targetId ?? "target-legacy", `app-${targetId ?? "legacy"}`);
  db.raw
    .query(
      `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, reviewed_at, verdict, summary_md, envelope, bot_id, target_id)
       VALUES (?, 123, ?, ?, ?, 'sha', ?, ?, 's', ?, ?, ?)`,
    )
    .run(
      opts.id,
      opts.owner,
      opts.repo,
      opts.pr_number,
      opts.reviewedAt,
      opts.verdict,
      opts.envelope === undefined ? "{}" : opts.envelope,
      null,
      targetId,
    );
  for (const f of opts.findings) {
    db.raw
      .query(
        `INSERT INTO findings (id, review_id, severity, category, title, body, fingerprint)
         VALUES (?, ?, ?, ?, ?, 'b', ?)`,
      )
      .run(f.id, opts.id, f.severity, f.category, f.title, f.fingerprint);
  }
}

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
  insertReview(db, {
    id: "r-m1",
    owner: "acme",
    repo: "widgets",
    pr_number: 4,
    reviewedAt: reviewedAt(1),
    verdict: "comment",
    envelope: null,
    findings: [{ id: "f-m1", severity: "critical", category: "security", title: "Old era finding", fingerprint: null }],
  });
}

describe("createInsightsStore", () => {
  test("aggregates severity/verdict/reviews over the window (default 30)", async () => {
    const db = createMigratedTestD1();
    seedFixture(db);

    const insights = await createInsightsStore(db, FIXTURE_SCOPE);

    expect(insights.reviewsTotal).toBe(3);
    expect(insights.findingsBySeverity).toEqual([
      { severity: "must-fix", count: 2 },
      { severity: "should-fix", count: 2 },
      { severity: "nit", count: 1 },
    ]);
    expect(insights.verdictDistribution).toEqual([
      { verdict: "needs fixes", count: 2 },
      { verdict: "approved", count: 1 },
    ]);
  });

  test("M1-era rows (envelope NULL, old vocab) are excluded from every aggregate (era gate)", async () => {
    const db = createMigratedTestD1();
    seedFixture(db);

    const insights = await createInsightsStore(db, FIXTURE_SCOPE);

    expect(insights.findingsBySeverity.some((s) => s.severity === "critical")).toBe(false);
    expect(insights.verdictDistribution.some((v) => v.verdict === "comment")).toBe(false);
    expect(insights.weeklyTrend.find((w) => w.week_start === mondayOf(reviewedAt(1)))).toEqual({
      week_start: mondayOf(reviewedAt(1)),
      reviews: 1,
      findings: 2,
    });
  });

  test("weeklyTrend buckets by Monday-anchored UTC week, ascending", async () => {
    const db = createMigratedTestD1();
    seedFixture(db);

    const insights = await createInsightsStore(db, FIXTURE_SCOPE);

    const weekA = mondayOf(reviewedAt(1));
    const weekB = mondayOf(reviewedAt(8));
    const weekC = mondayOf(reviewedAt(15));
    expect(new Set([weekA, weekB, weekC]).size).toBe(3);

    expect(insights.weeklyTrend).toEqual([
      { week_start: weekC, reviews: 1, findings: 1 },
      { week_start: weekB, reviews: 1, findings: 2 },
      { week_start: weekA, reviews: 1, findings: 2 },
    ]);
  });

  test("repo filter restricts every aggregation to one owner/repo pair", async () => {
    const db = createMigratedTestD1();
    seedFixture(db);

    const insights = await createInsightsStore(db, { ...FIXTURE_SCOPE, repo: { owner: "acme", repo: "widgets" } });

    expect(insights.reviewsTotal).toBe(2);
    expect(insights.findingsBySeverity).toEqual([
      { severity: "must-fix", count: 2 },
           { severity: "nit", count: 1 },
      { severity: "should-fix", count: 1 },
    ]);
    expect(insights.verdictDistribution).toEqual([
           { verdict: "approved", count: 1 },
      { verdict: "needs fixes", count: 1 },
    ]);
    expect(insights.weeklyTrend).toHaveLength(2);
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

    const d30 = await createInsightsStore(db, FIXTURE_SCOPE);
    expect(d30.reviewsTotal).toBe(1);
    expect(d30.findingsBySeverity).toEqual([{ severity: "must-fix", count: 1 }]);

    const d60 = await createInsightsStore(db, { ...FIXTURE_SCOPE, windowDays: 60 });
    expect(d60.reviewsTotal).toBe(2);
    expect(d60.findingsBySeverity).toEqual([{ severity: "must-fix", count: 2 }]);

    const clamped = await createInsightsStore(db, { ...FIXTURE_SCOPE, windowDays: 200 });
    expect(clamped.reviewsTotal).toBe(2);
    expect(clamped.findingsBySeverity).toEqual(d60.findingsBySeverity);
  });

  test("empty database → zero counts, empty arrays, zero-filled day grid (no division, no NULL rows)", async () => {
    const db = createMigratedTestD1();

    const insights = await createInsightsStore(db, FIXTURE_SCOPE);

    expect(insights).toEqual({
      reviewsTotal: 0,
      findingsBySeverity: [],
      verdictDistribution: [],
      weeklyTrend: [],
      dailyTrend: dayGrid(30).map((day_start) => ({ day_start, reviews: 0, findings: 0 })),
      repos: [],
      findingsDistribution: dayGrid(30).map((bucket_start) => ({
        bucket_start,
        granularity: "day" as const,
        by_severity: { "must-fix": 0, "should-fix": 0, "may-fix": 0, nit: 0 },
      })),
    });
  });


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
    const sundayDaysAgo = ((now.getUTCDay() + 6) % 7) + 1;
    const sunday = utcMidnight - sundayDaysAgo * DAY_MS;
    const isoDate = (ms: number): string => new Date(ms).toISOString().slice(0, 10);
    const isoStamp = (ms: number): string => new Date(ms).toISOString().slice(0, 19).replace("T", " ");
    return {
      sundayLast: isoStamp(sunday + DAY_MS - 1000),
      mondayFirst: isoStamp(sunday + DAY_MS),
      prevWeekStart: isoDate(sunday - 6 * DAY_MS),
      nextWeekStart: isoDate(sunday + DAY_MS),
      prevDayStart: isoDate(sunday),
      nextDayStart: isoDate(sunday + DAY_MS),
    };
  }

  test("weeklyTrend Monday anchor at the live week boundary (S-1)", async () => {
    const db = createMigratedTestD1();
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

    const insights = await createInsightsStore(db, FIXTURE_SCOPE);
    expect(insights.weeklyTrend).toEqual([
      { week_start: a.prevWeekStart, reviews: 1, findings: 1 },
      { week_start: a.nextWeekStart, reviews: 1, findings: 1 },
    ]);
  });

  test("dailyTrend day boundary at the live day boundary (S-1 extension)", async () => {
    const db = createMigratedTestD1();
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

    const insights = await createInsightsStore(db, FIXTURE_SCOPE);
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


  test("dailyTrend: zero-filled day grid on a day window, ascending, page-total parity", async () => {
    const db = createMigratedTestD1();
    seedFixture(db);

    const insights = await createInsightsStore(db, { ...FIXTURE_SCOPE, windowDays: 7 });

    expect(insights.dailyTrend.map((b) => b.day_start)).toEqual(dayGrid(7));
    const at = (daysAgo: number) =>
      insights.dailyTrend.find((b) => b.day_start === reviewedAt(daysAgo).slice(0, 10))!;
    expect(at(1)).toEqual({ day_start: reviewedAt(1).slice(0, 10), reviews: 1, findings: 2 });
    expect(at(0)).toEqual({ day_start: reviewedAt(0).slice(0, 10), reviews: 0, findings: 0 });
    expect(at(7)).toEqual({ day_start: reviewedAt(7).slice(0, 10), reviews: 0, findings: 0 });
    expect(insights.reviewsTotal).toBe(1);
    expect(insights.dailyTrend.reduce((acc, b) => acc + b.reviews, 0)).toBe(insights.reviewsTotal);
    expect(insights.dailyTrend.reduce((acc, b) => acc + b.findings, 0)).toBe(2);
  });

  test("dailyTrend: week window returns [] with no day-bucket query; weekly_trend pin unchanged", async () => {
    const db = createMigratedTestD1();
    seedFixture(db);

    const dayQueries: string[] = [];
    const dayInsights = await createInsightsStore(
      {
        prepare: (query: string) => {
          dayQueries.push(query);
          return db.prepare(query);
        },
      },
      { ...FIXTURE_SCOPE, windowDays: 30 },
    );
    const weekQueries: string[] = [];
    const weekInsights = await createInsightsStore(
      {
        prepare: (query: string) => {
          weekQueries.push(query);
          return db.prepare(query);
        },
      },
      { ...FIXTURE_SCOPE, windowDays: 90 },
    );

    expect(weekInsights.dailyTrend).toEqual([]);
    expect(weekInsights.weeklyTrend).toEqual([
      { week_start: mondayOf(reviewedAt(15)), reviews: 1, findings: 1 },
      { week_start: mondayOf(reviewedAt(8)), reviews: 1, findings: 2 },
      { week_start: mondayOf(reviewedAt(1)), reviews: 1, findings: 2 },
    ]);
    expect(dayQueries.some((query) => query.includes("AS day_start"))).toBe(true);
    expect(weekQueries.every((query) => !query.includes("AS day_start"))).toBe(true);
    expect(weekQueries.length).toBe(dayQueries.length - 1);
  });

  test("repos aggregation is opt-in: skipped ([]) without includeRepos, populated with it (QC F-001)", async () => {
    const db = createMigratedTestD1();
    seedFixture(db);

    const without = await createInsightsStore(db, FIXTURE_SCOPE);
    expect(without.repos).toEqual([]);

    const withRepos = await createInsightsStore(db, { ...FIXTURE_SCOPE, includeRepos: true });
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

    const all = await createInsightsStore(db, { ...FIXTURE_SCOPE, includeRepos: true });
    expect(all.repos).toEqual(["acme/widgets", "other/lib"]);

    const filtered = await createInsightsStore(db, { ...FIXTURE_SCOPE, repo: { owner: "acme", repo: "widgets" }, includeRepos: true });
    expect(filtered.reviewsTotal).toBe(2);
    expect(filtered.repos).toEqual(["acme/widgets", "other/lib"]);

    const clamped = await createInsightsStore(db, { ...FIXTURE_SCOPE, windowDays: 200, includeRepos: true });
    expect(clamped.repos).toEqual(["acme/widgets", "other/lib"]);
  });


  test("findingsDistribution: day grid over the default window, zero-filled, ASC", async () => {
    const db = createMigratedTestD1();
    seedFixture(db);

    const insights = await createInsightsStore(db, FIXTURE_SCOPE);

    const grid = insights.findingsDistribution;
    expect(grid.every((b) => b.granularity === "day")).toBe(true);
    expect(grid.map((b) => b.bucket_start)).toEqual(dayGrid(30));
    for (const bucket of grid) {
      expect(Object.keys(bucket)).toEqual(["bucket_start", "granularity", "by_severity"]);
      expect(Object.keys(bucket.by_severity)).toEqual(["must-fix", "should-fix", "may-fix", "nit"]);
    }
    const at = (daysAgo: number) =>
      grid.find((b) => b.bucket_start === reviewedAt(daysAgo).slice(0, 10))!;
    expect(at(1)).toMatchObject({
      by_severity: { "must-fix": 1, "should-fix": 1, nit: 0 },
    });
    expect(at(8)).toMatchObject({
      by_severity: { "must-fix": 1, "should-fix": 0, nit: 1 },
    });
    expect(at(15)).toMatchObject({
      by_severity: { "must-fix": 0, "should-fix": 1, nit: 0 },
    });
    expect(at(2)).toEqual({
      bucket_start: reviewedAt(2).slice(0, 10),
      granularity: "day",
      by_severity: { "must-fix": 0, "should-fix": 0, "may-fix": 0, nit: 0 },
    });
    const sum = (record: Record<string, number>) => Object.values(record).reduce((a, c) => a + c, 0);
    expect(grid.reduce((acc, b) => acc + sum(b.by_severity), 0)).toBe(5);
  });

  test("findingsDistribution: week grid for windowDays=90, same week definition as weeklyTrend", async () => {
    const db = createMigratedTestD1();
    seedFixture(db);

    const insights = await createInsightsStore(db, { ...FIXTURE_SCOPE, windowDays: 90 });

    const grid = insights.findingsDistribution;
    expect(grid.every((b) => b.granularity === "week")).toBe(true);
    for (const bucket of grid) {
      expect(new Date(`${bucket.bucket_start}T00:00:00Z`).getUTCDay()).toBe(1);
    }
    expect(grid.map((b) => b.bucket_start)).toEqual(weekGrid(90));
    expect(grid[0]!.bucket_start).toBe(mondayOf(reviewedAt(90)));
    expect(grid[grid.length - 1]!.bucket_start).toBe(mondayOf(reviewedAt(0)));
    const sum = (record: Record<string, number>) => Object.values(record).reduce((a, c) => a + c, 0);
    for (const week of insights.weeklyTrend) {
      const bucket = grid.find((b) => b.bucket_start === week.week_start)!;
      expect(sum(bucket.by_severity)).toBe(week.findings);
    }
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
      [200, "week"],
    ] as const) {
      const insights = await createInsightsStore(db, { ...FIXTURE_SCOPE, windowDays });
      expect(
        insights.findingsDistribution.every((b) => b.granularity === granularity),
        `window=${windowDays}`,
      ).toBe(true);
    }

    const clamped = await createInsightsStore(db, { ...FIXTURE_SCOPE, windowDays: 200 });
    const explicit = await createInsightsStore(db, { ...FIXTURE_SCOPE, windowDays: 90 });
    expect(clamped.findingsDistribution).toEqual(explicit.findingsDistribution);
  });

  test("findingsDistribution respects the repo filter", async () => {
    const db = createMigratedTestD1();
    seedFixture(db);

    const insights = await createInsightsStore(db, { ...FIXTURE_SCOPE, repo: { owner: "acme", repo: "widgets" } });

    const at = (daysAgo: number) =>
      insights.findingsDistribution.find((b) => b.bucket_start === reviewedAt(daysAgo).slice(0, 10))!;
    expect(at(15)).toMatchObject({
      by_severity: { "must-fix": 0, "should-fix": 0, nit: 0 },
    });
    expect(at(1)).toMatchObject({
      by_severity: { "must-fix": 1, "should-fix": 1, nit: 0 },
    });
  });


  function seedAppFixture(db: TestD1): void {
    insertReview(db, {
      id: "r-a",
      owner: "acme",
      repo: "widgets",
      pr_number: 1,
      reviewedAt: reviewedAt(1),
      verdict: "needs fixes",
      targetId: "target-a",
      findings: [{ id: "f-a1", severity: "must-fix", category: "logic", title: "Null deref risk", fingerprint: FP_X }],
    });
    insertReview(db, {
      id: "r-b",
      owner: "acme",
      repo: "portal",
      pr_number: 2,
      reviewedAt: reviewedAt(8),
      verdict: "approved",
      targetId: "target-b",
      findings: [{ id: "f-b1", severity: "nit", category: "style", title: "Trailing space", fingerprint: FP_Z }],
    });
    insertReview(db, {
      id: "r-c",
      owner: "other",
      repo: "lib",
      pr_number: 3,
      reviewedAt: reviewedAt(15),
      verdict: "needs fixes",
      targetId: null,
      findings: [{ id: "f-c1", severity: "should-fix", category: null, title: "Null deref risk", fingerprint: FP_X }],
    });
  }

  const SCOPE_A = { kind: "target", targetId: "target-a", workspaceId: WORKSPACE } as const;

  test("the target filter excludes every other target's rows and the legacy NULL rows", async () => {
    const db = createMigratedTestD1();
    seedAppFixture(db);

    const insights = await createInsightsStore(db, SCOPE_A);

    expect(insights.reviewsTotal).toBe(1);
    expect(insights.findingsBySeverity).toEqual([{ severity: "must-fix", count: 1 }]);
    expect(insights.verdictDistribution).toEqual([{ verdict: "needs fixes", count: 1 }]);
    expect(insights.weeklyTrend).toEqual([
      { week_start: mondayOf(reviewedAt(1)), reviews: 1, findings: 1 },
    ]);
    const at = (daysAgo: number) =>
      insights.findingsDistribution.find((b) => b.bucket_start === reviewedAt(daysAgo).slice(0, 10))!;
    expect(at(1)).toMatchObject({
      by_severity: { "must-fix": 1, "should-fix": 0, "may-fix": 0, nit: 0 },
    });
    expect(at(8)).toMatchObject({
      by_severity: { "must-fix": 0, "should-fix": 0, "may-fix": 0, nit: 0 },
    });
    expect(at(15)).toMatchObject({
      by_severity: { "must-fix": 0, "should-fix": 0, "may-fix": 0, nit: 0 },
    });
  });

  test("the repo list is scoped to the target too: other targets' repos never appear", async () => {
    const db = createMigratedTestD1();
    seedAppFixture(db);

    const insights = await createInsightsStore(db, { ...SCOPE_A, includeRepos: true });

    expect(insights.repos).toEqual(["acme/widgets"]);
  });

  test("a target id paired with a workspace that does not own it aggregates to nothing", async () => {
    const db = createMigratedTestD1();
    seedAppFixture(db);

    const insights = await createInsightsStore(db, {
      kind: "target",
      targetId: "target-a",
      workspaceId: "another-workspace",
      includeRepos: true,
    });

    expect(insights.reviewsTotal).toBe(0);
    expect(insights.findingsBySeverity).toEqual([]);
    expect(insights.verdictDistribution).toEqual([]);
    expect(insights.weeklyTrend).toEqual([]);
    expect(insights.repos).toEqual([]);
  });

  test("the workspace scope aggregates every live target and nothing else", async () => {
    const db = createMigratedTestD1();
    seedAppFixture(db);

    const insights = await createInsightsStore(db, {
      kind: "workspace",
      workspaceId: WORKSPACE,
      includeRepos: true,
    });

    expect(insights.reviewsTotal).toBe(2);
    expect(insights.findingsBySeverity).toEqual([
      { severity: "must-fix", count: 1 },
      { severity: "nit", count: 1 },
    ]);
    expect(insights.verdictDistribution).toEqual([
      { verdict: "approved", count: 1 },
      { verdict: "needs fixes", count: 1 },
    ]);
    expect(insights.repos).toEqual(["acme/portal", "acme/widgets"]);
  });

  test("a workspace with no live target reads nothing and answers like an empty database", async () => {
    const empty = createMigratedTestD1();
    const seeded = createMigratedTestD1();
    seedAppFixture(seeded);

    seeded.raw.prepare("UPDATE review_targets SET deleted_at = datetime('now')").run();
    const insights = await createInsightsStore(seeded, { kind: "workspace", workspaceId: WORKSPACE });

    expect(insights).toEqual(await createInsightsStore(empty, FIXTURE_SCOPE));
  });

  test("the workspace scope emits the SAME SQL whatever its target count", async () => {
    const statements = async (targets: number): Promise<string[]> => {
      const db = createMigratedTestD1();
      for (let i = 0; i < targets; i += 1) {
        insertReview(db, {
          id: `r-${i}`,
          owner: "acme",
          repo: `repo-${i}`,
          pr_number: i + 1,
          reviewedAt: reviewedAt(1),
          verdict: "approved",
          targetId: `target-${i}`,
          findings: [],
        });
      }
      const seen: string[] = [];
      const counting = {
        prepare(query: string) {
          seen.push(query);
          return db.prepare(query);
        },
      };
      await createInsightsStore(counting, { kind: "workspace", workspaceId: WORKSPACE, includeRepos: true });
      return seen;
    };

    const one = await statements(1);
    const three = await statements(3);
    expect(three).toEqual(one);
    const scoped = one.filter((query) => query.includes("review_targets"));
    expect(scoped.length).toBeGreaterThan(0);
    for (const query of scoped) {
      const subquery = query.slice(query.indexOf("review_targets"));
      expect(subquery.slice(0, subquery.indexOf(")")).match(/\?/g)?.length).toBe(1);
    }
  });
});
