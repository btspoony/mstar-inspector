/**
 * Plan 36 T2: `/dashboard/insights` is the review-records surface —
 * segmented window (INSIGHTS_WINDOWS) + shadcn Select repo filter.
 * Plan 40 T2: the behavioral pins for the records-page helpers (window
 * normalization, searchHref, verdictLine) were rehomed here after the
 * insights-home module retired — they now live in pages/data.ts.
 * Plan 49 T2: the URL↔filter re-sync pins — after same-route navigation or
 * history traversal the filter state re-derives from the location.
 * Plan 56 T3: the three stat sections render as charts (components/charts).
 * This file pins the assembled page faces — chart wiring (AD-561 token
 * colors, bar-end counts discriminated from axis ticks, dual-series legend,
 * localized date axis, role/aria), the empty faces (never an empty-axis
 * svg), and the bilingual copy; the plan-45 proportional-bar pin is
 * superseded in place.
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

/**
 * Plan 56 T2 fixture: v1 severity vocabulary + a NULL category row. The
 * counts sit outside each chart's own niceTicks set (severity max 7 → ticks
 * 0/2/4/6/8; category max 9 → ticks 0/5/10), so a bar-end count pin can
 * never be satisfied by axis tick text (T2-M1 strengthening); the weekly
 * buckets sum to 3 reviews · 6 findings — both off `reviews_total: 4` — so
 * the trend summary pin only passes if the line derives from weekly_trend.
 */
const RECORDS: InsightsSummary = {
  window_days: 30,
  reviews_total: 4,
  findings_by_severity: [
    { severity: "must-fix", count: 7 },
    { severity: "should-fix", count: 5 },
    { severity: "nit", count: 3 },
  ],
  findings_by_category: [
    { category: "logic", count: 9 },
    { category: null, count: 6 },
  ],
  verdict_distribution: [
    { verdict: "comment", count: 3 },
    { verdict: "approve", count: 1 },
  ],
  weekly_trend: [
    { week_start: "2026-08-17", reviews: 1, findings: 2 },
    { week_start: "2026-08-24", reviews: 2, findings: 4 },
  ],
  recurring_top: [],
  repos: [],
};

const renderRecords = (locale: "en" | "zh_CN", data: InsightsSummary = RECORDS) =>
  renderToStaticMarkup(createElement(InsightsRecordsView, { locale, data }));

/**
 * The page renders exactly three chart svgs (severity, category, trend — no
 * other svg lives in InsightsRecordsView); the slices isolate each chart so
 * count/legend/aria assertions cannot collide with a sibling chart's text.
 * The exact-count guard also fails loudly on a stray fourth svg (which
 * would otherwise be silently absorbed and shift every slice's scope).
 */
const chartSlices = (html: string): [string, string, string] => {
  const slices = html.split("<svg");
  const [severity, category, trend] = slices.slice(1);
  if (slices.length !== 4 || !severity || !category || !trend) {
    throw new Error(`expected exactly three chart svgs on the records page, got ${slices.length - 1}`);
  }
  return [severity, category, trend];
};

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
    const [severity] = chartSlices(html);
    // Counts coexist with the graphic as bar-end text (color is never the
    // only carrier). The fixture counts 7/5/3 sit outside the chart's own
    // tick set (niceTicks(7) = 0/2/4/6/8), so only a rendered bar-end label
    // — never an axis tick — can satisfy these (T2-M1).
    expect(severity).toContain(">7</text>");
    expect(severity).toContain(">5</text>");
    expect(severity).toContain(">3</text>");
    // Bars carry the locked AD-561 tokens and the severity label stays
    // visible next to their bar. Colors ride var(--token) through the
    // style attribute (CSS declarations, where var() resolves).
    expect(severity).toContain('style="fill:var(--red-700)"');
    expect(severity).toContain('style="fill:var(--amber-700)"');
    expect(severity).toContain('style="fill:var(--gray-700)"');
    expect(severity).toContain("must-fix");
    // The old proportional-bar markup is gone entirely.
    expect(html).not.toContain("basis-full");
    expect(html).not.toContain('style="width');
  });

  test("category chart: NULL category rides the uncategorized key with the neutral series face", () => {
    const [severity, category] = chartSlices(renderRecords("en"));
    expect(severity).not.toContain("uncategorized");
    // The NULL category row renders under the i18n label, next to the real
    // category; counts 9/6 sit outside the chart's tick set (niceTicks(9) =
    // 0/5/10), so these are bar-end labels, not ticks (T2-M1).
    expect(category).toContain("uncategorized");
    expect(category).toContain("logic");
    expect(category).toContain(">9</text>");
    expect(category).toContain(">6</text>");
    // No per-item color is passed → the chart's neutral series token
    // (AD-561 default), never one of the severity accents.
    expect(category).toContain('style="fill:var(--blue-700)"');
    expect(category).not.toContain('style="fill:var(--red-700)"');
  });

  test("empty-string category coalesces to the uncategorized face (same as NULL, plan 56 QC F-004)", () => {
    // category: "" is schema-permitted (review/schema.ts) and persists —
    // before the falsy-coalescing fix it rendered a blank bar label.
    const data: InsightsSummary = { ...RECORDS, findings_by_category: [{ category: "", count: 2 }] };
    const [, category] = chartSlices(renderRecords("en", data));
    // The i18n label renders as visible text (and as the title) — never a
    // blank text node with an empty <title>.
    expect(category).toContain(`>${t("en", "insights.uncategorized")}</text>`);
    expect(category).toContain(`<title>${t("en", "insights.uncategorized")}</title>`);
    expect(category).not.toContain("<title></title>");
  });

  test("NULL and empty-string rows merge into ONE summed uncategorized bar (bugbot duplicate-key fix)", () => {
    // The insights query groups NULL and "" as separate rows; per-row
    // coalescing mapped both onto the same uncategorized key — two
    // identically labeled bars with duplicate React keys and split counts.
    // The rows must aggregate by the coalesced key before mapping: exactly
    // one uncategorized bar carrying the summed count.
    const data: InsightsSummary = {
      ...RECORDS,
      findings_by_category: [
        { category: "logic", count: 9 },
        { category: null, count: 6 },
        { category: "", count: 2 },
      ],
    };
    const [, category] = chartSlices(renderRecords("en", data));
    const label = t("en", "insights.uncategorized");
    // Exactly one uncategorized bar — the old per-row mapping emitted two
    // <title>uncategorized</title> labels (duplicate keys).
    expect(category.split(`<title>${label}</title>`).length - 1).toBe(1);
    // Its count is the SUM 6+2=8, not either per-row count (both old bar-end
    // labels are gone; 8/6/2 all sit outside the tick set niceTicks(9) =
    // 0/5/10, so these pins read bar-end labels only, never ticks).
    expect(category).toContain(">8</text>");
    expect(category).not.toContain(">6</text>");
    expect(category).not.toContain(">2</text>");
    // Two bars total (logic + merged uncategorized), not three.
    expect(category.split("<rect").length - 1).toBe(2);
    // First-seen order holds: logic leads, the merged bar follows it.
    expect(category.indexOf("<title>logic</title>")).toBeGreaterThan(-1);
    expect(category.indexOf(`<title>${label}</title>`)).toBeGreaterThan(category.indexOf("<title>logic</title>"));
  });

  test("trend chart: dual-series legend with AD-561 colors, localized date axis, bucket-derived totals", () => {
    const html = renderRecords("en");
    const [, , trend] = chartSlices(html);
    // Legend order pins the series→color pairing: the blue-700 swatch
    // precedes the Reviews label, the amber-700 swatch the Findings label.
    const blue = trend.indexOf('style="fill:var(--blue-700)"');
    const reviews = trend.indexOf(">Reviews</text>");
    const amber = trend.indexOf('style="fill:var(--amber-700)"');
    const findings = trend.indexOf(">Findings</text>");
    expect(blue).toBeGreaterThanOrEqual(0);
    expect(blue).toBeLessThan(reviews);
    expect(reviews).toBeLessThan(amber);
    expect(amber).toBeLessThan(findings);
    // Week date axis labels render inside the svg (en M/D format).
    expect(trend).toContain("8/17");
    expect(trend).toContain("8/24");
    // The summary line sums the weekly buckets (1+2 reviews, 2+4 findings);
    // both totals differ from the fixture's reviews_total=4, so the pin
    // only passes if the line derives from weekly_trend itself.
    expect(html).toContain("In this window: 3 reviews · 6 findings");
  });

  test("each chart svg carries role=img with its section's aria-label (AC4)", () => {
    const [severity, category, trend] = chartSlices(renderRecords("en"));
    expect(severity).toContain('role="img"');
    expect(severity).toContain('aria-label="Findings by severity"');
    expect(category).toContain('role="img"');
    expect(category).toContain('aria-label="Findings by category"');
    expect(trend).toContain('role="img"');
    expect(trend).toContain('aria-label="Weekly trend"');
  });

  test("records surfaces localize bilingually (plan 56 T2)", () => {
    const zh = renderRecords("zh_CN");
    expect(zh).toContain("窗口内共 3 次审查 · 6 个发现");
    // The date axis follows the page locale — zh format only, with no en
    // M/D fallback (pins the locale prop reaching TrendChart).
    expect(zh).toContain("8月17日");
    expect(zh).not.toContain("8/17");
    // The NULL category label and the chart aria-labels localize too.
    expect(zh).toContain("未分类");
    expect(zh).toContain('aria-label="按严重程度统计的发现"');
  });

  test("records fetch opts into the repos aggregation (plan 36 QC F-001)", () => {
    expect(page).toContain("insightsSummaryUrl(search, true)");
  });

  test("off-set window deep links are rewritten on mount (plan 36 QC F-002)", () => {
    expect(page).toContain("normalizeWindowSearch");
    expect(page).toContain("window.history.replaceState");
  });
});

describe("records page chart empty faces (plan 56 T3 / AC2)", () => {
  // Same window/verdict payload as RECORDS, but every chart-fed array empty.
  const NO_CHART_DATA: InsightsSummary = {
    window_days: 30,
    reviews_total: 4,
    findings_by_severity: [],
    findings_by_category: [],
    verdict_distribution: [{ verdict: "comment", count: 3 }],
    weekly_trend: [],
    recurring_top: [],
    repos: [],
  };
  // reviews_total 0 is the page-level empty: every stat card is suppressed.
  const ZERO_REVIEWS: InsightsSummary = { ...NO_CHART_DATA, reviews_total: 0 };

  test("reviews_total 0 → heading card only: readable empty copy, never an empty-axis chart (bilingual)", () => {
    for (const locale of ["en", "zh_CN"] as const) {
      const html = renderRecords(locale, ZERO_REVIEWS);
      expect(html).toContain(t(locale, "insights.heading"));
      expect(html).toContain(t(locale, "insights.noReviews"));
      // All four stat cards are suppressed — no titles, no svgs at all.
      expect(html).not.toContain(t(locale, "insights.findingsBySeverity"));
      expect(html).not.toContain(t(locale, "insights.findingsByCategory"));
      expect(html).not.toContain(t(locale, "insights.weeklyTrend"));
      expect(html).not.toContain(t(locale, "insights.recurringFindings"));
      expect(html).not.toContain("<svg");
    }
  });

  test("reviews without findings/trend rows → per-section empty copy instead of bare charts (bilingual)", () => {
    for (const locale of ["en", "zh_CN"] as const) {
      const html = renderRecords(locale, NO_CHART_DATA);
      // Severity and category cards each fall back to the noFindings copy.
      expect(html.split(t(locale, "insights.noFindings")).length - 1).toBe(2);
      // The trend card falls back to the noReviews copy — the zero-totals
      // summary line must not render alongside it.
      expect(html).toContain(t(locale, "insights.noReviews"));
      const zeroSummary = t(locale, "insights.trendSummary", {
        reviews: t(locale, "insights.reviews", { count: 0 }),
        findings: t(locale, "insights.findings", { count: 0 }),
      });
      expect(html).not.toContain(zeroSummary);
      // No chart got rendered against empty data.
      expect(html).not.toContain("<svg");
    }
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
      "insights.noFindings",
      "insights.uncategorized",
      "insights.seriesReviews",
      "insights.seriesFindings",
      "insights.trendSummary",
    ]) {
      expect(page).toContain(`"${key}"`);
    }
  });
});
