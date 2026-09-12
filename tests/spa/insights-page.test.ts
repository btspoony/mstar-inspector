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
 * Plan 60 T2/T3: the page joins the v0.3 language — SectionCard tiers,
 * heading-24 title, spacing-8 rhythm, the plan-57 state trio — and this
 * file carries the finalized AD-601 presentation-supersede ledger (T3.1).
 * The ledger holds exactly TWO entries, both with covering pins here:
 * (1) the plan-56 zero-review face → composed EmptyState (PM amendment in
 * the plan file, 2026-09-10), and (2) the recurringFindings wrapper face →
 * SectionCard tier="secondary" (PM-ratified T2 amendment, 2026-09-10 —
 * content/list form untouched; a bare Card renders Tier-1 elevation inside
 * the Tier-2 group). Everything else is retained zero-supersede; the
 * plan-36/49 URL↔filter pins stay byte-for-byte.
 * Plan 65 T3 (B8): the severity/category cards are daily stacked bar time
 * series (StackedBarChart) — the six aggregate-face pins restate on the
 * stacked faces (locked fill-class families, the gray uncategorized
 * fallback, "" coalescing one layer down in chartBuckets, per-card legend
 * slicing for the trend pins), and the aria/text coexistence floor (svg
 * <title> mirror, y-tick text, page-level summary rows) is pinned
 * positively. Per-bar LabelList counts are retired by design: stacked
 * totals read off the y ticks and the tooltip (plan Global Constraint).
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
 * severity counts sit outside the severity chart's tick set (max 7 →
 * recharts ticks 0/2/4/6/8), so a bar-end count pin can never be satisfied
 * by axis tick text there; the category counts 9/6 DO sit inside their
 * tick set (max 9 → ticks 0/3/6/9/12), so those pins slice to the chart's
 * recharts-label-list section (T2-M1 discrimination, recharts face). The
 * weekly buckets sum to 3 reviews · 6 findings — both off
 * `reviews_total: 4` — so the trend summary pin only passes if the line
 * derives from weekly_trend.
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
  // Plan 65 B3 made the field required (compile fix only — the stale
  // aggregate-chart face pins above are re-stated by Task 3's stacked
  // pins). The single day bucket mirrors the aggregate counts.
  findings_distribution: [
    {
      bucket_start: "2026-08-17",
      granularity: "day",
      by_severity: { "must-fix": 7, "should-fix": 5, nit: 3 },
      by_category: { logic: 9, uncategorized: 6 },
    },
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

/**
 * Plan 65: the stacked cards own an HTML legend row that PRECEDES each svg,
 * so svg-boundary slices miss the legend of their own card and pick up the
 * NEXT card's legend instead. The card regions slice by the SectionCardTitle
 * headings (legend + svg together); `chartSlices` above keeps the svg-only
 * isolation for assertions that must not see any legend text. `>Title</div>`
 * matches only the card title element — the same string inside an
 * aria-label or an svg <title> carries different delimiters.
 */
const cardSlice = (html: string, title: string, nextTitle?: string): string => {
  const start = html.indexOf(`>${title}</div>`);
  if (start === -1) throw new Error(`card title not found: ${title}`);
  const end = nextTitle === undefined ? html.length : html.indexOf(`>${nextTitle}</div>`);
  if (end === -1) throw new Error(`next card title not found: ${nextTitle}`);
  return html.slice(start, end);
};

/**
 * The y coordinate of one stacked segment path (recharts-rectangle face) —
 * used by the stacking-order pins. Throws when the segment is absent so a
 * drifted recharts markup fails loudly instead of comparing NaN.
 */
const segmentY = (html: string, name: string, fillClass: string): number => {
  const tag = new RegExp(`<path [^>]*name="${name}" class="recharts-rectangle ${fillClass}"[^>]*>`).exec(html)?.[0];
  const y = tag ? /\by="([0-9.]+)"/.exec(tag) : null;
  if (!y) throw new Error(`stacked segment not found: ${name} (${fillClass})`);
  return Number(y[1]);
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
    // Plan 65 T3 supersede: the aggregate BarChart import is retired — both
    // stat cards consume StackedBarChart, and the AD-601 severity family
    // maps to the charts.css fill classes in the page-layer
    // SEVERITY_BAR_COLORS (values are class tokens now; the var() resolution
    // lives in the charts.css rules into the token layer — never
    // presentation attributes). The no-raw-hex face is unchanged.
    expect(page).toContain("@/components/charts/StackedBarChart");
    expect(page).toContain("SEVERITY_BAR_COLORS");
    expect(page).toContain("chart-fill-red-700");
    expect(page).toContain("chart-fill-amber-700");
    expect(page).toContain("chart-fill-gray-700");
    expect(page).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  test("severity section renders as a stacked chart with the text coexistence floor (supersedes the plan-45 T1/F-01 + plan-56 label-list pins)", () => {
    // plan 45 pinned the CSS proportional severity bar (inline width
    // effective, no basis-full override). Plan 56 replaced that markup with
    // a chart; plan 63 moved the chart onto recharts (AD-621); plan 65 T3
    // (B8) restates the guarded faces on the daily stacked time series:
    // the severity token families stay locked, and the aria/text
    // coexistence floor survives the stacking — per-bar counts are retired
    // by design (stacked totals read off the y ticks and the tooltip; the
    // page-level summary rows keep the totals as text).
    const html = renderRecords("en");
    const severityCard = cardSlice(html, "Findings by severity", "Findings by category");
    // The svg <title> mirrors the section aria-label — the positive pin
    // (never a blank title, never aria-only).
    expect(severityCard).toContain("<title>Findings by severity</title>");
    // Stacked segments carry the locked AD-561/AD-601 token families via
    // the charts.css class rules — CSS declarations where var() always
    // resolves, never presentation-attribute var(), never raw hex.
    expect(severityCard).toContain('class="recharts-rectangle chart-fill-red-700"');
    expect(severityCard).toContain('class="recharts-rectangle chart-fill-amber-700"');
    expect(severityCard).toContain('class="recharts-rectangle chart-fill-gray-700"');
    // The severity labels stay visible (legend row), the day bucket renders
    // its date tick, and the y ticks keep the count scale readable as text
    // — recharts niceTicks for the 15-unit stack top → domain [0..16],
    // ticks 0/4/8/12/16 (tick values couple to recharts 2.15.4 — the
    // charts.test.ts header caveat applies).
    expect(severityCard).toContain("must-fix");
    expect(severityCard).toContain(">8/17</tspan>");
    expect(severityCard).toContain(">0</tspan>");
    expect(severityCard).toContain(">16</tspan>");
    // The page-level summary rows keep the window totals as text beside the
    // charts (the coexistence floor's page face).
    expect(html).toContain("Reviews: 4");
    // The old proportional-bar markup is gone entirely — no HTML element
    // carries an inline width any more (the recharts wrapper's own
    // style="width:100%" box is the chart frame, not a proportional bar).
    expect(html).not.toContain("basis-full");
    expect(html).not.toMatch(/<(span|div|p|li)[^>]*style="width/);
  });

  test("category chart: NULL category rides the uncategorized key with the gray stacked-last face", () => {
    const html = renderRecords("en");
    const severityCard = cardSlice(html, "Findings by severity", "Findings by category");
    const categoryCard = cardSlice(html, "Findings by category", "Weekly trend");
    expect(severityCard).not.toContain("uncategorized");
    // The NULL category renders under the i18n label in the legend, AFTER
    // the real category — legend order = stack order (AD-653: palette slugs
    // first, the gray fallback last/topmost).
    expect(categoryCard).toContain("logic");
    expect(categoryCard).toContain("uncategorized");
    const blue = categoryCard.indexOf("chart-swatch-blue-700");
    const uncategorized = categoryCard.indexOf(`>${t("en", "insights.uncategorized")}</span>`);
    expect(blue).toBeGreaterThanOrEqual(0);
    expect(blue).toBeLessThan(uncategorized);
    // The unknown slug rides the neutral blue-700 tone (the tail rule); the
    // NULL/uncategorized fallback is the gray-700 series — never one of the
    // severity accents.
    expect(categoryCard).toContain('name="logic" class="recharts-rectangle chart-fill-blue-700"');
    expect(categoryCard).toContain('name="uncategorized" class="recharts-rectangle chart-fill-gray-700"');
    expect(categoryCard).not.toContain("chart-fill-red-700");
    // Gray is stacked LAST (topmost segment): its y sits strictly above the
    // blue segment's (the stackId adjacency is pinned at the component
    // level in charts.test.ts).
    expect(segmentY(categoryCard, "uncategorized", "chart-fill-gray-700")).toBeLessThan(
      segmentY(categoryCard, "logic", "chart-fill-blue-700"),
    );
  });

  test("empty-string category coalesces to the uncategorized face (same as NULL, plan 56 QC F-004)", () => {
    // category: "" is schema-permitted (review/schema.ts) and persists —
    // before the falsy-coalescing fix it rendered a blank bar label. Plan
    // 65: the coalescing moved one layer down — chartBuckets merges the ""
    // grid key into the uncategorized series before the chart sees the
    // distribution — the visible face is unchanged.
    const data: InsightsSummary = {
      ...RECORDS,
      findings_by_category: [{ category: "", count: 2 }],
      findings_distribution: [
        {
          bucket_start: "2026-08-17",
          granularity: "day",
          by_severity: { "must-fix": 7, "should-fix": 5, nit: 3 },
          by_category: { "": 2 },
        },
      ],
    };
    const html = renderRecords("en", data);
    const categoryCard = cardSlice(html, "Findings by category", "Weekly trend");
    // The i18n label renders as the visible category text (legend row — the
    // stacked x axis is time, not categories) — never a blank label node,
    // and the svg-level <title> carries the section aria label.
    expect(categoryCard).toContain(`>${t("en", "insights.uncategorized")}</span>`);
    expect(categoryCard).not.toContain('chart-legend-label"></span>');
    expect(categoryCard).toContain('name="uncategorized" class="recharts-rectangle chart-fill-gray-700"');
    expect(categoryCard).not.toContain("<title></title>");
  });

  test("NULL and empty-string rows merge into ONE summed uncategorized series (bugbot duplicate-key fix)", () => {
    // The insights store groups NULL and "" as separate grid keys (only
    // NULL merges server-side; "" is schema-permitted); per-key series
    // mapping would render two identically labeled gray segments with
    // split counts. chartBuckets aggregates by the coalesced key before
    // mapping: exactly one uncategorized series carrying the summed count
    // (plan 56 QC F-004 semantics, one layer down).
    const data: InsightsSummary = {
      ...RECORDS,
      findings_by_category: [
        { category: "logic", count: 9 },
        { category: null, count: 6 },
        { category: "", count: 2 },
      ],
      findings_distribution: [
        {
          bucket_start: "2026-08-17",
          granularity: "day",
          by_severity: { "must-fix": 7, "should-fix": 5, nit: 3 },
          by_category: { logic: 9, "": 2, uncategorized: 6 },
        },
      ],
    };
    const html = renderRecords("en", data);
    const label = t("en", "insights.uncategorized");
    const categoryCard = cardSlice(html, "Findings by category", "Weekly trend");
    // Exactly one uncategorized legend item — the old per-row mapping
    // emitted two identically labeled bars (duplicate keys); the coalesced
    // label renders once.
    expect(categoryCard.split(`>${label}</span>`).length - 1).toBe(1);
    // Its stacked segment is the SUM 6+2=8, not either per-row count: the
    // merged render's gray segment is byte-identical to an explicit
    // 8-count series and differs from a 6-count one (the geometry path tag
    // carries no render-unique ids, so cross-render equality is exact).
    const graySegment = (fixture: InsightsSummary): string =>
      new RegExp('<path [^>]*name="uncategorized" class="recharts-rectangle chart-fill-gray-700"[^>]*>').exec(
        cardSlice(renderRecords("en", fixture), "Findings by category", "Weekly trend"),
      )?.[0] ?? "";
    const mergedGray = graySegment(data);
    const explicit = (count: number): InsightsSummary => ({
      ...data,
      findings_distribution: [
        {
          bucket_start: "2026-08-17",
          granularity: "day",
          by_severity: { "must-fix": 7, "should-fix": 5, nit: 3 },
          by_category: { logic: 9, uncategorized: count },
        },
      ],
    });
    expect(mergedGray).not.toBe("");
    expect(mergedGray).toBe(graySegment(explicit(8)));
    expect(mergedGray).not.toBe(graySegment(explicit(6)));
    // Two series total (logic + the merged fallback), not three.
    expect(categoryCard.split("<path").length - 1).toBe(2);
    // First-seen order holds: logic leads, the merged series follows it.
    expect(categoryCard.indexOf(">logic</span>")).toBeGreaterThan(-1);
    expect(categoryCard.indexOf(`>${label}</span>`)).toBeGreaterThan(categoryCard.indexOf(">logic</span>"));
  });

  test("trend chart: dual-series legend with the preserved AD-601 pair, localized date axis, bucket-derived totals", () => {
    const html = renderRecords("en");
    // Plan 65: the stacked severity/category cards own HTML legends too, so
    // the legend-order pins slice to the trend card (anchored by its title;
    // the summary line and legend live inside it) instead of the whole page
    // — on the full page the severity amber swatch precedes the trend
    // legend. Within the card the four markers are unique (the summary line
    // renders "…3 reviews · 6 findings", never a bare legend label).
    const trendCard = cardSlice(html, "Weekly trend", "Recurring findings");
    // Legend order pins the series→color pairing: the blue swatch precedes
    // the Reviews label, the amber swatch the Findings label.
    const blue = trendCard.indexOf("chart-swatch-blue-700");
    const reviews = trendCard.indexOf(">Reviews</span>");
    const amber = trendCard.indexOf("chart-swatch-amber-700");
    const findings = trendCard.indexOf(">Findings</span>");
    expect(blue).toBeGreaterThanOrEqual(0);
    expect(blue).toBeLessThan(reviews);
    expect(reviews).toBeLessThan(amber);
    expect(amber).toBeLessThan(findings);
    // Week date axis labels render inside the svg (en M/D format).
    const [, , trend] = chartSlices(html);
    expect(trend).toContain("8/17");
    expect(trend).toContain("8/24");
    // The summary line sums the weekly buckets (1+2 reviews, 2+4 findings);
    // both totals differ from the fixture's reviews_total=4, so the pin
    // only passes if the line derives from weekly_trend itself.
    expect(trendCard).toContain("In this window: 3 reviews · 6 findings");
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
    findings_distribution: [],
    recurring_top: [],
    repos: [],
  };
  // reviews_total 0 is the page-level empty: every stat card is suppressed.
  const ZERO_REVIEWS: InsightsSummary = { ...NO_CHART_DATA, reviews_total: 0 };

  test("reviews_total 0 → composed EmptyState guidance, never an empty-axis chart (bilingual; AD-601 supersede #1)", () => {
    // AD-601 presentation supersede #1 of 2 (ledger in the file header): the
    // plan-56 heading-card-only empty face became the plan-57 EmptyState
    // (plan 60 A4). The guarded regression faces still hold — readable
    // composed copy, every stat card suppressed, no chart svg anywhere.
    for (const locale of ["en", "zh_CN"] as const) {
      const html = renderRecords(locale, ZERO_REVIEWS);
      expect(html).toContain(t(locale, "insights.emptyTitle"));
      expect(html).toContain(t(locale, "insights.emptyDescription"));
      // The overview card is suppressed with the stat cards — no titles,
      // no svgs at all (the EmptyState carries no icon svg).
      expect(html).not.toContain(t(locale, "insights.heading"));
      expect(html).not.toContain(t(locale, "insights.noReviews"));
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
    findings_distribution: [],
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
      "insights.emptyTitle",
      "insights.emptyDescription",
    ]) {
      expect(page).toContain(`"${key}"`);
    }
  });
});

describe("records page on the v0.3 language (plan 60 T2, A2-A5)", () => {
  test("stat sections ride the SectionCard tier system (AD-591 consumption; covers AD-601 supersede #2)", () => {
    expect(page).toContain('../components/SectionCard"');
    // Exactly one primary (the stats overview) and four secondary (severity,
    // category, trend, recurring) surfaces — no hand-assembled tier classes.
    // The recurringFindings card's wrapper face → SectionCard tier=
    // "secondary" is AD-601 presentation supersede #2 (PM-ratified T2 plan
    // amendment, 2026-09-10): content, list form and copy untouched. This
    // pin is its covering test — the 4× secondary count fails if the card
    // reverts to a bare Card (Tier-1 elevation inside the Tier-2 group).
    expect(page.split('tier="primary"').length - 1).toBe(1);
    expect(page.split('tier="secondary"').length - 1).toBe(4);
    // The tier faces come from the wrapper, not page-level classNames.
    expect(page).not.toContain("shadow-(--shadow-card)");
    expect(page).not.toContain("border-(--gray-alpha-500)");
  });

  test("page title rides the heading-24 token step and the page rhythm is the spacing-8 token", () => {
    expect(page).toContain("text-(length:--typo-heading-24-size)");
    expect(page).toContain("leading-(--typo-heading-24-line)");
    expect(page).toContain("tracking-(--typo-heading-24-tracking)");
    expect(page).toContain("gap-(--spacing-8)");
  });

  test("page-level states ride the plan-57 trio (plan 60 A4)", () => {
    expect(page).toContain('components/state/PageSkeleton"');
    expect(page).toContain('components/state/EmptyState"');
    expect(page).toContain('components/state/ErrorState"');
    expect(page).toContain('kind="cards"');
    // The text notices are retired from this page (plan-38/44 channels stay
    // in PageNotice for other pages).
    expect(page).not.toContain("LoadingNotice");
    expect(page).not.toContain("LoadFailedNotice");
    // Skeleton is the initial load's face only — `data === null` gates it so
    // filter-change reloads keep the page (and focus) mounted.
    expect(page).toContain('state === "loading" && data === null');
    // ErrorState retry re-runs the load effect through the nonce.
    expect(page).toContain("setReloadNonce");
  });

  test("filter refetch rides an inline busy hint — never a blank main area (PR 41 bugbot)", () => {
    // The skeleton stays the initial load's face only: its gate is exactly
    // `state === "loading" && data === null`, so a refetch over retained
    // data can never swap the mounted page for the skeleton.
    expect(page).toContain('state === "loading" && data === null');
    expect(page).toContain('return <PageSkeleton locale={locale} kind="cards" />');
    // Refetch over retained data (filter change / retry) renders the slim
    // polite hint below the toolbar instead of a blank main area. The two
    // gates partition the loading state — one face each, no gap. The pins
    // read the JSX elements, not the prose comments around them.
    expect(page).toContain('state === "loading" && data !== null');
    expect(page).toContain('<p role="status" className="text-sm text-muted-foreground">');
    expect(page).toContain('common.loading');
    // The refetch is announced programmatically on the content region.
    expect(page).toContain('aria-busy={state === "loading"}');
    // The records view (charts) still mounts only on the ready state — the
    // hint is the refetch face, not a replacement for the data gate.
    expect(page).toContain('state === "ok" && data ?');
    // The retired PageNotice text faces stay off this page (channel pin
    // above) — the hint is page-local JSX on Tailwind tokens.
    expect(page).not.toContain("LoadingNotice");
    expect(page).not.toContain("LoadFailedNotice");
    expect(page).not.toContain("pages.module.css");
  });

  test("empty-state guidance keys resolve atomically in both locales", () => {
    for (const key of ["insights.emptyTitle", "insights.emptyDescription"] as const) {
      const en = t("en", key);
      const zh = t("zh_CN", key);
      expect(en.length, key).toBeGreaterThan(0);
      expect(zh.length, key).toBeGreaterThan(0);
      expect(zh, key).not.toBe(en);
    }
  });

  test("the composed overview card keeps the bilingual window face and gains tabular figures", () => {
    const html = renderRecords("en");
    expect(html).toContain("Window: last 30 days");
    expect(html).toContain("Reviews: 4");
    expect(html).toContain("Verdicts: comment 3 · approve 1");
    expect(page.split("tabular-nums").length - 1).toBeGreaterThanOrEqual(3);
  });
});
