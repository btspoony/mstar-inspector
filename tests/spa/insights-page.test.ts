/**
 * Plan 36 T2: `/dashboard/insights` is the review-records surface —
 * segmented window (INSIGHTS_WINDOWS) + shadcn Select repo filter.
 * Plan 40 T2: the behavioral pins for the records-page helpers (window
 * normalization, searchHref, verdictLine) were rehomed here after the
 * insights-home module retired — they now live in pages/data.ts.
 * No DOM runner — same source-scan contract as plan 29 SPA tests.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { t } from "../../src/i18n";
import {
  INSIGHTS_WINDOWS,
  insightsWindow,
  normalizeWindowSearch,
  searchHref,
  verdictLine,
  type InsightsSummary,
} from "../../src/spa/pages/data";

const page = readFileSync(join(import.meta.dir, "../../src/spa/pages/InsightsPage.tsx"), "utf8");

describe("records page assembly (plan 36 T2)", () => {
  test("window switch is the INSIGHTS_WINDOWS segmented ToggleGroup", () => {
    expect(INSIGHTS_WINDOWS).toEqual(["7", "30", "90"]);
    expect(page).toContain("@/components/ui/toggle-group");
    expect(page).toContain("INSIGHTS_WINDOWS");
    expect(page).toContain("insightsWindow");
  });

  test("repo filter is shadcn Select — zero native controls", () => {
    expect(page).toContain("@/components/ui/select");
    expect(page).toContain("INSIGHTS_REPO_ALL");
    expect(page).toContain("insightsRepoOptions");
    expect(page).toContain('searchHref("/dashboard/insights"');
    expect(page).not.toMatch(/<select[\s>]/);
    expect(page).not.toMatch(/<input[\s>]/);
    expect(page).not.toMatch(/<form[\s>]/);
    expect(page).not.toContain("pages.module.css");
    expect(page).not.toContain('name="repo"');
    expect(page).not.toContain("filterRepoPlaceholder");
    expect(page).not.toContain("insights.apply");
  });

  test("cards and typography are shadcn/Tailwind token driven (no raw hex)", () => {
    expect(page).toContain("@/components/ui/card");
    expect(page).toContain("text-muted-foreground");
    expect(page).toContain("bg-primary");
    expect(page).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  test("records fetch opts into the repos aggregation (plan 36 QC F-001)", () => {
    expect(page).toContain("insightsSummaryUrl(search, true)");
  });

  test("off-set window deep links are rewritten on mount (plan 36 QC F-002)", () => {
    expect(page).toContain("normalizeWindowSearch");
    expect(page).toContain("window.history.replaceState");
  });
});

describe("records page helpers (rehomed plan 30 T3 + plan 36 T1 pins)", () => {
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
    repos: [],
  };

  test("searchHref omits the default 30-day window and empty repo", () => {
    expect(searchHref("/dashboard/insights", { window: "30", repo: "" })).toBe("/dashboard/insights");
  });

  test("searchHref passes window and repo through to the records URL", () => {
    expect(searchHref("/dashboard/insights", { window: "7", repo: "acme/web" })).toBe(
      "/dashboard/insights?window=7&repo=acme%2Fweb",
    );
  });

  test("URL window is honored only when it is a segment; anything else falls back to 30", () => {
    expect(insightsWindow("")).toBe("30");
    expect(insightsWindow("?window=7")).toBe("7");
    expect(insightsWindow("?window=30")).toBe("30");
    expect(insightsWindow("?window=90")).toBe("90");
    // Legal API windows outside the segmented set must not leave the
    // ToggleGroup without an active segment.
    expect(insightsWindow("?window=14")).toBe("30");
    expect(insightsWindow("?window=abc")).toBe("30");
  });

  test("normalizeWindowSearch rewrites off-set windows to the default segment (plan 36 QC F-002)", () => {
    // Already a segment → unchanged (no URL rewrite needed).
    expect(normalizeWindowSearch("")).toBe("");
    expect(normalizeWindowSearch("?window=7")).toBe("?window=7");
    expect(normalizeWindowSearch("?window=30")).toBe("?window=30");
    expect(normalizeWindowSearch("?window=90&repo=acme/web")).toBe("?window=90&repo=acme/web");
    // Off-set legal window → normalized to 30 (the default, omitted).
    expect(normalizeWindowSearch("?window=60")).toBe("");
    expect(normalizeWindowSearch("?window=14&repo=acme/web")).toBe("?repo=acme%2Fweb");
    // Non-numeric window → same normalization path.
    expect(normalizeWindowSearch("?window=abc")).toBe("");
  });

  test("verdict line comes from the store payload", () => {
    expect(verdictLine(SUMMARY)).toBe("comment 3 · approve 1");
  });
});

describe("records page copy (plan 36 T2 / AC9)", () => {
  test("records heading and repo Select keys resolve in both locales", () => {
    expect(t("en", "insights.recordsHeading")).toBe("Review records");
    expect(t("zh_CN", "insights.recordsHeading")).toBe("审查记录");
    expect(t("en", "insights.filterRepoAll")).toBe("All");
    expect(t("zh_CN", "insights.filterRepoAll")).toBe("全部");
    expect(t("en", "insights.filterRepo")).toBe("Repo");
    expect(t("zh_CN", "insights.filterRepo")).toBe("仓库");
  });

  test("the page consumes the records keys and shared window copy", () => {
    for (const key of [
      "insights.recordsHeading",
      "insights.filterRepo",
      "insights.filterRepoAll",
      "insights.windowSegment",
      "insights.daysShort",
      "insights.noReviews",
    ]) {
      expect(page).toContain(`"${key}"`);
    }
  });
});
