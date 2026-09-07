/**
 * Plan 36 T2: `/dashboard/insights` is the review-records surface —
 * segmented window (INSIGHTS_WINDOWS) + shadcn Select repo filter.
 * Plan 40 T2: the behavioral pins for the records-page helpers (window
 * normalization, searchHref, verdictLine) were rehomed here after the
 * insights-home module retired — they now live in pages/data.ts.
 * Plan 49 T2: the URL↔filter re-sync pins — after same-route navigation or
 * history traversal the filter state re-derives from the location.
 * No DOM runner — same source-scan contract as plan 29 SPA tests.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../../src/i18n";
import { InsightsRecordsView } from "../../src/spa/pages/InsightsPage";
import {
  INSIGHTS_WINDOWS,
  insightsWindow,
  normalizeWindowSearch,
  parseInsightsSearch,
  searchHref,
  verdictLine,
  type InsightsSummary,
} from "../../src/spa/pages/data";

const page = readFileSync(join(import.meta.dir, "../../src/spa/pages/InsightsPage.tsx"), "utf8");
const router = readFileSync(join(import.meta.dir, "../../src/spa/router.tsx"), "utf8");

/** Plan 56 T2 fixture: v1 severity vocabulary + a NULL category row. */
const RECORDS: InsightsSummary = {
  window_days: 30,
  reviews_total: 4,
  findings_by_severity: [
    { severity: "must-fix", count: 3 },
    { severity: "should-fix", count: 2 },
    { severity: "nit", count: 1 },
  ],
  findings_by_category: [
    { category: "logic", count: 4 },
    { category: null, count: 2 },
  ],
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

const renderRecords = (locale: "en" | "zh_CN") =>
  renderToStaticMarkup(createElement(InsightsRecordsView, { locale, data: RECORDS }));

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
    // Plan 56 T2 supersede: the plan-45 proportional bar (bg-primary) is
    // retired — the stat sections render as charts whose series colors ride
    // var(--token) through the page-layer AD-561 mapping; the no-raw-hex
    // face is unchanged.
    expect(page).toContain("@/components/charts/BarChart");
    expect(page).toContain("SEVERITY_BAR_COLORS");
    expect(page).toContain("var(--red-700)");
    expect(page).toContain("var(--amber-700)");
    expect(page).toContain("var(--gray-700)");
    expect(page).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  test("severity section renders as a chart with counts as text (supersedes plan 45 T1/F-01 pin)", () => {
    // plan 45 pinned the CSS proportional severity bar (inline width
    // effective, no basis-full override). Plan 56 T2 replaces that markup
    // with the BarChart SVG, so the pin is superseded in place — the
    // regression face it guarded (severity counts visibly rendering, token
    // discipline) must still hold in the new chart DOM.
    const html = renderRecords("en");
    // Counts coexist with the graphic as bar-end text (color is never the
    // only carrier), bars carry the locked AD-561 tokens.
    expect(html).toContain(">3</text>");
    expect(html).toContain(">2</text>");
    expect(html).toContain('fill="var(--red-700)"');
    expect(html).toContain('fill="var(--amber-700)"');
    expect(html).toContain('fill="var(--gray-700)"');
    expect(html).toContain("must-fix");
    // The old proportional-bar markup is gone entirely.
    expect(html).not.toContain("basis-full");
    expect(html).not.toContain('style="width');
  });

  test("category NULL keeps the uncategorized label; trend card carries totals, legend, and dates", () => {
    const html = renderRecords("en");
    expect(html).toContain("uncategorized");
    expect(html).toContain("logic");
    // Window totals line (text counts coexisting with the trend chart).
    expect(html).toContain("In this window: 4 reviews · 4 findings");
    // Legend entries and localized date axis labels render in the SVG.
    expect(html).toContain("Reviews");
    expect(html).toContain("Findings");
    expect(html).toContain("8/17");
  });

  test("records surfaces localize bilingually (plan 56 T2)", () => {
    const zh = renderRecords("zh_CN");
    expect(zh).toContain("窗口内共 4 次审查 · 4 个发现");
    expect(zh).toContain("8月17日");
  });

  test("records fetch opts into the repos aggregation (plan 36 QC F-001)", () => {
    expect(page).toContain("insightsSummaryUrl(search, true)");
  });

  test("off-set window deep links are rewritten on mount (plan 36 QC F-002)", () => {
    expect(page).toContain("normalizeWindowSearch");
    expect(page).toContain("window.history.replaceState");
  });
});

describe("records page URL↔filter re-sync (plan 49 T2 / F-15-02)", () => {
  test("same-route navigation re-derives the filter from the now-bare location (synthetic popstate)", () => {
    // Sidebar Insights click on a filtered view: navigate() pushes the bare
    // path (query stripped) and then dispatches a synthetic popstate — the
    // page must listen for it, or the URL and the applied filter diverge.
    expect(router).toContain('window.history.pushState(null, "", href)');
    expect(router).toContain('new PopStateEvent("popstate")');
    expect(page).toContain('window.addEventListener("popstate"');
    // The handler re-derives through the one shared location derivation —
    // the same pinned-helper read that seeds the mount initializer (no
    // forked parsing): bare location ⇒ default segment, filter reset.
    expect(page).toContain("useState<InsightsSearch>(insightsSearchFromLocation)");
    expect(page).toContain("setSearch(insightsSearchFromLocation())");
    expect(page).toContain("window: insightsWindow(window.location.search)");
    expect(page).toContain("repo: parseInsightsSearch(window.location.search).repo");
  });

  test("history back/forward re-derives the filter to match the entry's query (native popstate)", () => {
    // Traversal fires popstate with the entry's ?window=/?repo= in place;
    // the same listener re-derives so the controls match the address bar.
    expect(page).toContain('window.addEventListener("popstate"');
    expect(page).toContain('window.removeEventListener("popstate", onPop)');
    // Derivation outcomes across both entry shapes (via the pinned helpers):
    expect(insightsWindow("")).toBe("30");
    expect(parseInsightsSearch("").repo).toBe("");
    expect(insightsWindow("?window=7")).toBe("7");
    const restored = parseInsightsSearch("?window=7&repo=acme/web");
    expect(restored.window).toBe("7");
    expect(restored.repo).toBe("acme/web");
  });

  test("in-page edits stay outside the listener — commitSearch is replaceState, no re-sync loop", () => {
    expect(page).toContain("window.history.replaceState");
    expect(page).not.toContain("dispatchEvent");
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
      "insights.seriesReviews",
      "insights.seriesFindings",
      "insights.trendSummary",
    ]) {
      expect(page).toContain(`"${key}"`);
    }
  });
});
