/**
 * Plan 36 T1: `/dashboard` is the read-only overall-insights surface with
 * segmented ToggleGroup controls (window 7/30/90 + findings dimension).
 * Plan 30 T3 href helpers are unchanged and stay pinned below.
 * No DOM runner — same contract as plan 29 SPA tests.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { t } from "../../src/i18n";
import { insightsSummaryUrl } from "../../src/spa/pages/data";
import { HOME_WINDOWS, homeWindow, searchHref, verdictLine } from "../../src/spa/pages/homeModel";
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

const home = readFileSync(join(import.meta.dir, "../../src/spa/pages/Home.tsx"), "utf8");

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

  test("home fetch URL is the existing insights summary JSON face", () => {
    expect(insightsSummaryUrl({ window: "7", repo: "acme/web" })).toBe(
      "/dashboard/api/insights/summary?window=7&repo=acme%2Fweb",
    );
  });
});

describe("home segmented window model (plan 36 T1)", () => {
  test("segments are exactly the legal API subset 7/30/90", () => {
    expect(HOME_WINDOWS).toEqual(["7", "30", "90"]);
  });

  test("URL window is honored only when it is a segment; anything else falls back to 30", () => {
    expect(homeWindow("")).toBe("30");
    expect(homeWindow("?window=7")).toBe("7");
    expect(homeWindow("?window=30")).toBe("30");
    expect(homeWindow("?window=90")).toBe("90");
    // Legal API windows outside the segmented set must not leave the
    // ToggleGroup without an active segment.
    expect(homeWindow("?window=14")).toBe("30");
    expect(homeWindow("?window=abc")).toBe("30");
  });

  test("verdict line comes from the store payload", () => {
    expect(verdictLine(SUMMARY)).toBe("comment 3 · approve 1");
  });
});

describe("home assembly (plan 36 T1)", () => {
  test("home promotes the insights summary to `/` on the existing JSON face", () => {
    expect(home).toContain("insightsSummaryUrl({ window: windowDays, repo: \"\" })");
    expect(home).toContain("parseInsights");
    expect(home).not.toContain("AppsPage");
    expect(home).not.toContain("InsightsSidebar");
  });

  test("window and dimension switch via ToggleGroup — zero native controls on home", () => {
    expect(home).toContain("@/components/ui/toggle-group");
    expect(home).toContain("HOME_WINDOWS");
    expect(home).toContain('value="severity"');
    expect(home).toContain('value="category"');
    expect(home).not.toMatch(/<select[\s>]/);
    expect(home).not.toMatch(/<input[\s>]/);
    expect(home).not.toMatch(/<form[\s>]/);
    expect(home).not.toContain("pages.module.css");
    expect(home).not.toContain("Home.module.css");
  });

  test("cards and typography are shadcn/Tailwind token driven (no raw hex)", () => {
    expect(home).toContain("@/components/ui/card");
    expect(home).toContain("text-muted-foreground");
    expect(home).toContain("bg-primary");
    expect(home).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  test("window switches sync the `/dashboard` URL; empty radix re-click is ignored", () => {
    expect(home).toContain('searchHref("/dashboard", { window: next, repo: "" })');
    expect(home).toContain("window.history.replaceState");
  });

  test("the plan-30 home sidebar and its CSS module are retired", () => {
    expect(existsSync(join(import.meta.dir, "../../src/spa/pages/InsightsSidebar.tsx"))).toBe(false);
    expect(existsSync(join(import.meta.dir, "../../src/spa/Home.module.css"))).toBe(false);
  });
});

describe("home segmented copy (plan 36 T1 / AC9)", () => {
  test("new keys resolve in both locales", () => {
    expect(t("en", "home.insightsHeading")).toBe("Overall insights");
    expect(t("zh_CN", "home.insightsHeading")).toBe("总体洞察");
    expect(t("en", "insights.windowSegment")).toBe("Time window");
    expect(t("zh_CN", "insights.windowSegment")).toBe("时间窗口");
    expect(t("en", "insights.dimension")).toBe("Findings breakdown dimension");
    expect(t("zh_CN", "insights.dimension")).toBe("发现细分维度");
    expect(t("en", "insights.dimSeverity")).toBe("Severity");
    expect(t("zh_CN", "insights.dimSeverity")).toBe("严重程度");
    expect(t("en", "insights.dimCategory")).toBe("Category");
    expect(t("zh_CN", "insights.dimCategory")).toBe("类别");
  });

  test("day segment labels interpolate in both locales", () => {
    expect(t("en", "insights.daysShort", { count: 7 })).toBe("7d");
    expect(t("en", "insights.daysShort", { count: 90 })).toBe("90d");
    expect(t("zh_CN", "insights.daysShort", { count: 30 })).toBe("30 天");
  });

  test("home consumes the segmented keys and the shared insights copy", () => {
    for (const key of [
      "insights.windowSegment",
      "insights.daysShort",
      "insights.dimension",
      "insights.dimSeverity",
      "insights.dimCategory",
      "insights.findingsBySeverity",
      "insights.findingsByCategory",
      "insights.weeklyTrend",
      "insights.recurringFindings",
    ]) {
      expect(home).toContain(`"${key}"`);
    }
  });
});
