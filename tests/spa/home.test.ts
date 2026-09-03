/**
 * Plan 30 T1+T3: home workbench helpers, sidebar copy, responsive classes.
 * No DOM runner — same contract as plan 29 SPA tests.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { t } from "../../src/i18n";
import { insightsSummaryUrl } from "../../src/spa/pages/data";
import { latestWeek, searchHref, verdictLine } from "../../src/spa/pages/homeModel";
import type { InsightsSummary } from "../../src/spa/pages/data";

const SUMMARY: InsightsSummary = {
  window_days: 30,
  reviews_total: 4,
  findings_by_severity: [
    { severity: "high", count: 3 },
    { severity: "low", count: 1 },
  ],
  findings_by_category: [],
  verdict_distribution: [
    { verdict: "comment", count: 3 },
    { verdict: "approve", count: 1 },
  ],
  weekly_trend: [
    { week_start: "2026-08-17", reviews: 1, findings: 0 },
    { week_start: "2026-08-24", reviews: 3, findings: 4 },
  ],
  recurring_top: [],
};

describe("home search hrefs (plan 30 T3)", () => {
  test("omits the default 30-day window", () => {
    expect(searchHref("/dashboard", { window: "30", repo: "" })).toBe("/dashboard");
    expect(searchHref("/dashboard/insights", { window: "30", repo: "" })).toBe("/dashboard/insights");
  });

  test("passes window and repo through to home and the full insights page", () => {
    expect(searchHref("/dashboard", { window: "7", repo: "acme/web" })).toBe(
      "/dashboard?window=7&repo=acme%2Fweb",
    );
    expect(searchHref("/dashboard/insights", { window: "7", repo: "acme/web" })).toBe(
      "/dashboard/insights?window=7&repo=acme%2Fweb",
    );
  });

  test("sidebar fetch URL is the existing insights summary JSON face", () => {
    expect(insightsSummaryUrl({ window: "7", repo: "acme/web" })).toBe(
      "/dashboard/api/insights/summary?window=7&repo=acme%2Fweb",
    );
  });
});

describe("insights sidebar summary (plan 30 T3)", () => {
  test("verdict line and latest week come from the store payload", () => {
    expect(verdictLine(SUMMARY)).toBe("comment 3 · approve 1");
    expect(latestWeek(SUMMARY)).toEqual({ week_start: "2026-08-24", reviews: 3, findings: 4 });
    expect(latestWeek({ ...SUMMARY, weekly_trend: [] })).toBeNull();
  });

  test("copy is dictionary-backed in both locales", () => {
    expect(t("en", "home.insightsHeading")).toBe("Overall insights");
    expect(t("zh_CN", "home.insightsHeading")).toBe("总体洞察");
    expect(t("en", "home.viewFull")).toBe("View full insights →");
    expect(t("zh_CN", "home.viewFull")).toBe("查看完整洞察 →");
    const trend = latestWeek(SUMMARY);
    expect(trend).not.toBeNull();
    expect(
      t("en", "home.trendHint", {
        week: trend!.week_start,
        reviews: t("en", "insights.reviews", { count: trend!.reviews }),
        findings: t("en", "insights.findings", { count: trend!.findings }),
      }),
    ).toBe("Latest week 2026-08-24: 3 reviews · 4 findings");
    expect(t("en", "insights.reviewsTotal", { count: SUMMARY.reviews_total })).toBe("Reviews: 4");
    expect(t("en", "insights.verdicts", { line: verdictLine(SUMMARY) })).toBe(
      "Verdicts: comment 3 · approve 1",
    );
  });
});

describe("home assembly (plan 30 T1)", () => {
  test("Home reuses AppsPage and mounts the insights sidebar", () => {
    const home = readFileSync(join(import.meta.dir, "../../src/spa/pages/Home.tsx"), "utf8");
    expect(home).toContain("AppsPage");
    expect(home).toContain("InsightsSidebar");
    expect(home).toContain('aria-label={t(boot.locale, "apps.heading")}');
    expect(home).toContain('aria-label={t(boot.locale, "home.insightsHeading")}');
  });

  test("sidebar loads the existing insights summary JSON face", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/InsightsSidebar.tsx"), "utf8");
    expect(source).toContain("fetchJson(insightsSummaryUrl(search))");
    expect(source).toContain('searchHref("/dashboard/insights"');
    expect(source).toContain("home.viewFull");
  });

  test("create CTA is always in the header; empty list has no ops controls", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/AppsPage.tsx"), "utf8");
    expect(source).toContain("payload.apps.length === 0");
    expect(source).toContain("CreateAppButton");
    expect(source).not.toContain("/pause");
    expect(source).not.toContain("/disable");
    expect(source).not.toContain("/delete");
    expect(source).toContain("/dashboard/apps/${app.slug}/settings");
  });

  test("desktop ≥900px is 2fr + 1fr; mobile stacks", () => {
    const css = readFileSync(join(import.meta.dir, "../../src/spa/Home.module.css"), "utf8");
    expect(css).toContain("flex-direction: column");
    expect(css).toContain("@media (min-width: 900px)");
    expect(css).toContain("grid-template-columns: 2fr 1fr");
  });
});
