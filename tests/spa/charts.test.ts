/**
 * Plan 63 T2 (B2/B3): chart primitives — TrendChart on recharts (AD-621).
 * The plan-56 hand-rolled layout math and its direct pins
 * (linearScale/niceTicks/bandScale/… — formerly charts/layout.ts) retired
 * with the module: recharts owns the geometry now. The render faces are
 * pinned through react-dom/server SSR (no DOM needed — static markup
 * output, the plan-53 settings-layout idiom): role/aria faces, the dual-
 * series legend, the localized date axis, >8-week label thinning, the
 * zero-data faces, and the token discipline (no raw hex in sources; fills
 * ride the charts.css class rules — never presentation-attribute var(),
 * knowledge ui-bugs/svg-var-presentation-attributes.md).
 *
 * Plan 65 T2 (B4): the aggregate BarChart and its describe block retired
 * with the component (the insights severity/category cards consume
 * StackedBarChart now).
 * Plan 65 T3 (B8): the stacked-chart SSR pins — StackedBarChart renders the
 * same terminal stacked geometry through the idiom below (createElement in
 * this .ts file, the TrendChart face): the series-ordered HTML legend row,
 * the per-segment fill classes + tooltip series names, the stackId
 * bottom-up adjacency, the svg <title> mirror, the zero-count buckets kept
 * on the axis (time continuity, AC-C), and the day/week label face. The
 * severity/category page faces ride the InsightsPage pins in
 * insights-page.test.ts.
 * Plan 65 QC fix-1: the plan-63 pins the BarChart retirement dropped
 * restate on the stacked face — the charts.css token-binding pin (every
 * live fill class / swatch twin has its token rule; the axis text faces),
 * the hostile-label SSR escape pin (legend + tooltip name + tick faces),
 * plus the tooltip token-styling pin (contentStyle/labelStyle SSR face,
 * itemStyle source-pinned) and the >8-bucket thinning twin of the
 * TrendChart pin.
 *
 * The recharts-internal class names pinned below (recharts-rectangle,
 * recharts-cartesian-axis-tick-value) couple to recharts 2.15.4: a
 * recharts upgrade must re-verify these chart pins (the T1.1 probe pins
 * render shape, not these class names).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { TrendChart, type TrendPoint } from "../../src/spa/components/charts/TrendChart";
import {
  StackedBarChart,
  type DistributionBucket,
  type StackedSeries,
} from "../../src/spa/components/charts/StackedBarChart";

const trendChart = (
  points: TrendPoint[],
  overrides: { locale?: "en" | "zh_CN"; seriesLabels?: { reviews: string; findings: string }; ariaLabel?: string } = {},
) =>
  renderToStaticMarkup(
    createElement(TrendChart, {
      points,
      locale: overrides.locale ?? "en",
      seriesLabels: overrides.seriesLabels ?? { reviews: "Reviews", findings: "Findings" },
      ariaLabel: overrides.ariaLabel ?? "Weekly trend",
    }),
  );

describe("TrendChart SSR (plan 63 T2, recharts face)", () => {
  const weeks: TrendPoint[] = [
    { week: "2026-08-17", reviews: 1, findings: 2 },
    { week: "2026-08-24", reviews: 3, findings: 4 },
  ];

  test("renders an svg role=img with the aria-label, the dual-series legend, and both fill classes", () => {
    const html = trendChart(weeks);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Weekly trend"');
    // Same svg <title> mirror pin as the BarChart face (recharts Surface
    // forwards `title` → `<title>`): dropping the prop fails here too.
    expect(html).toContain("<title>Weekly trend</title>");
    // Legend order pins the series→color pairing: the blue swatch precedes
    // the Reviews label, the amber swatch the Findings label (HTML legend
    // row above the chart).
    const blue = html.indexOf("chart-swatch-blue-700");
    const reviews = html.indexOf(">Reviews</span>");
    const amber = html.indexOf("chart-swatch-amber-700");
    const findings = html.indexOf(">Findings</span>");
    expect(blue).toBeGreaterThanOrEqual(0);
    expect(blue).toBeLessThan(reviews);
    expect(reviews).toBeLessThan(amber);
    expect(amber).toBeLessThan(findings);
    // The bars carry the same preserved AD-601 pair (reviews=blue-700,
    // findings=amber-700) via the shared fill classes.
    expect(html).toContain('class="recharts-rectangle chart-fill-blue-700"');
    expect(html).toContain('class="recharts-rectangle chart-fill-amber-700"');
  });

  test("each week carries the two grouped series bars (2 weeks × 2 series)", () => {
    // Legend swatches are HTML spans now — every <path> is series geometry.
    expect(trendChart(weeks).split("<path").length - 1).toBe(4);
  });

  test("a non-zero bar height tracks the value scale (proportion face, plan-45 F-01 class)", () => {
    // max 4 → recharts domain [0..4]; plot height = 166 - 4 - 20 = 142 →
    // the findings-4 rect spans the full plot height — a collapsed height
    // can never satisfy this.
    expect(trendChart(weeks)).toMatch(/<path [^>]*height="142"[^>]*class="recharts-rectangle chart-fill-amber-700"/);
  });

  test("date x labels are localized by the locale prop", () => {
    expect(trendChart(weeks)).toContain("8/17");
    expect(trendChart(weeks, { locale: "zh_CN" })).toContain("8月17日");
    expect(trendChart(weeks, { locale: "zh_CN" })).not.toContain("8/17");
  });

  test("more than 8 weeks thins to every-other-week date labels", () => {
    // Real consecutive weeks: 6/29 .. 8/31 (10 Mondays).
    const mondays = ["06-29", "07-06", "07-13", "07-20", "07-27", "08-03", "08-10", "08-17", "08-24", "08-31"];
    const dense: TrendPoint[] = mondays.map((week) => ({ week: `2026-${week}`, reviews: 1, findings: 1 }));
    const html = trendChart(dense);
    // Even indices labeled (6/29, 7/13, 7/27, 8/10, 8/24); odd weeks dropped.
    expect(html).toContain("6/29");
    expect(html).toContain("7/13");
    expect(html).toContain("8/24");
    expect(html).not.toContain("7/6");
    expect(html).not.toContain("8/31");
  });

  test("all-zero series stay a coherent chart: zero tick, no geometry, legend intact (AC2)", () => {
    const html = trendChart([{ week: "2026-08-17", reviews: 0, findings: 0 }]);
    expect(html).toContain(">0</tspan>");
    expect(html).not.toContain("<path");
    expect(html).toContain("Reviews");
    expect(html).toContain("Findings");
  });

  test("a single week renders both series (no division blowups)", () => {
    const html = trendChart([{ week: "2026-08-17", reviews: 2, findings: 1 }]);
    expect(html.split("<path").length - 1).toBe(2);
    expect(html).toContain("8/17");
  });

  test("empty input renders null — the page owns the readable empty state", () => {
    expect(trendChart([])).toBe("");
  });
});

describe("StackedBarChart SSR (plan 65 B8, stacked face)", () => {
  const severityBuckets: DistributionBucket[] = [
    {
      bucket_start: "2026-08-17",
      granularity: "day",
      by_severity: { "must-fix": 7, "should-fix": 5, nit: 3 },
      by_category: {},
    },
  ];
  const severitySeries: StackedSeries[] = [
    { key: "must-fix", label: "must-fix", fillClass: "chart-fill-red-700" },
    { key: "should-fix", label: "should-fix", fillClass: "chart-fill-amber-700" },
    { key: "nit", label: "nit", fillClass: "chart-fill-gray-700" },
  ];

  const stackedChart = (
    buckets: DistributionBucket[],
    series: StackedSeries[],
    overrides: { locale?: "en" | "zh_CN"; ariaLabel?: string } = {},
  ) =>
    renderToStaticMarkup(
      createElement(StackedBarChart, {
        buckets,
        series,
        locale: overrides.locale ?? "en",
        ariaLabel: overrides.ariaLabel ?? "Findings by severity",
      }),
    );

  /** The y/height of one stacked segment path (recharts-rectangle face). */
  const segment = (html: string, fillClass: string): { y: number; height: number } => {
    const tag = new RegExp(`<path [^>]*class="recharts-rectangle ${fillClass}"[^>]*>`).exec(html)?.[0];
    const y = tag ? /\by="([0-9.]+)"/.exec(tag) : null;
    const height = tag ? /\bheight="([0-9.]+)"/.exec(tag) : null;
    if (!tag || !y || !height) throw new Error(`stacked segment not found: ${fillClass}`);
    return { y: Number(y[1]), height: Number(height[1]) };
  };

  test("renders role=img with the aria-label, the svg <title> mirror, and the legend row in series order", () => {
    const html = stackedChart(severityBuckets, severitySeries);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Findings by severity"');
    // Same svg <title> mirror pin as the TrendChart face (recharts Surface
    // forwards `title` → `<title>`): dropping the prop fails here too.
    expect(html).toContain("<title>Findings by severity</title>");
    // Legend order = stack order: the red swatch precedes the must-fix
    // label, amber precedes should-fix, gray precedes nit (the HTML legend
    // row above the chart — the plan-56 TrendChart face).
    const red = html.indexOf("chart-swatch-red-700");
    const mustFix = html.indexOf(">must-fix</span>");
    const amber = html.indexOf("chart-swatch-amber-700");
    const shouldFix = html.indexOf(">should-fix</span>");
    const gray = html.indexOf("chart-swatch-gray-700");
    const nit = html.indexOf(">nit</span>");
    expect(red).toBeGreaterThanOrEqual(0);
    expect(red).toBeLessThan(mustFix);
    expect(mustFix).toBeLessThan(amber);
    expect(amber).toBeLessThan(shouldFix);
    expect(shouldFix).toBeLessThan(gray);
    expect(gray).toBeLessThan(nit);
  });

  test("stacked segments carry the series fill classes and the tooltip series names", () => {
    const html = stackedChart(severityBuckets, severitySeries);
    // Colors ride the charts.css class rules only — never presentation
    // attributes, never raw hex (the no-raw-hex source scan below covers
    // the module; these pins lock the rendered class face).
    expect(html).toContain('class="recharts-rectangle chart-fill-red-700"');
    expect(html).toContain('class="recharts-rectangle chart-fill-amber-700"');
    expect(html).toContain('class="recharts-rectangle chart-fill-gray-700"');
    // Exact counts ride the tooltip — every segment path carries its series
    // name so the hover face can name the number it holds.
    expect(html).toContain('name="must-fix"');
    expect(html).toContain('name="should-fix"');
    expect(html).toContain('name="nit"');
  });

  test("stackId stacking face: segments pile bottom-up in series order, heights track the values", () => {
    const html = stackedChart(severityBuckets, severitySeries);
    const must = segment(html, "chart-fill-red-700");
    const should = segment(html, "chart-fill-amber-700");
    const nit = segment(html, "chart-fill-gray-700");
    // The first series sits on the axis (plot bottom = 166 - 20 axis) and
    // every next series starts exactly where the previous one ends.
    expect(must.y + must.height).toBeCloseTo(146);
    expect(should.y + should.height).toBeCloseTo(must.y);
    expect(nit.y + nit.height).toBeCloseTo(should.y);
    // Heights track the values (7/5/3), not the stack order — a segment
    // carrying the wrong key's count cannot satisfy both ratios.
    expect(must.height / nit.height).toBeCloseTo(7 / 3);
    expect(should.height / nit.height).toBeCloseTo(5 / 3);
  });

  test("zero-count buckets stay on the axis (time continuity) without geometry", () => {
    const buckets: DistributionBucket[] = [
      {
        bucket_start: "2026-08-17",
        granularity: "day",
        by_severity: { "must-fix": 0, "should-fix": 0, nit: 0 },
        by_category: {},
      },
      {
        bucket_start: "2026-08-18",
        granularity: "day",
        by_severity: { "must-fix": 2, "should-fix": 1, nit: 1 },
        by_category: {},
      },
    ];
    const html = stackedChart(buckets, severitySeries);
    // Both date ticks render — the empty day is an honest grid column,
    // never filtered off the axis (AC-C).
    expect(html).toContain(">8/17</tspan>");
    expect(html).toContain(">8/18</tspan>");
    // Geometry only where counts exist: one column × three stacked
    // segments (zero-height rects never render).
    expect(html.split("<path").length - 1).toBe(3);
  });

  test("day and week buckets share one axis face; the locale localizes the labels", () => {
    // The 90d window's Monday-anchored week buckets (granularity "week")
    // render the identical axis grammar as day buckets.
    const weekBuckets: DistributionBucket[] = [
      {
        bucket_start: "2026-08-17",
        granularity: "week",
        by_severity: { "must-fix": 1, "should-fix": 0, nit: 0 },
        by_category: {},
      },
    ];
    expect(stackedChart(weekBuckets, severitySeries)).toContain("8/17");
    const zh = stackedChart(weekBuckets, severitySeries, { locale: "zh_CN" });
    expect(zh).toContain("8月17日");
    expect(zh).not.toContain("8/17");
  });

  test("more than 8 buckets thin to every-other date labels; 8 or fewer keep every label", () => {
    // The StackedBarChart twin of the TrendChart >8-weeks pin above (the
    // component docblock promises "the TrendChart semantics" for
    // interval={data.length > 8 ? 1 : 0}): a 90d window renders 13-14 week
    // buckets and a 30d window 31 day buckets — both thin.
    const days = ["08-10", "08-11", "08-12", "08-13", "08-14", "08-15", "08-16", "08-17", "08-18", "08-19"];
    const bucket = (bucket_start: string): DistributionBucket => ({
      bucket_start,
      granularity: "day",
      by_severity: { "must-fix": 1, "should-fix": 0, nit: 0 },
      by_category: {},
    });
    const dense = stackedChart(days.map((day) => bucket(`2026-${day}`)), severitySeries);
    // Even indices labeled (8/10 .. 8/18); odd days dropped.
    expect(dense).toContain("8/10");
    expect(dense).toContain("8/18");
    expect(dense).not.toContain("8/11");
    expect(dense).not.toContain("8/19");
    // Exactly 8 buckets (the threshold) keep every label — including the
    // odd-index days thinning would drop.
    const full = stackedChart(days.slice(0, 8).map((day) => bucket(`2026-${day}`)), severitySeries);
    expect(full).toContain("8/10");
    expect(full).toContain("8/11");
    expect(full).toContain("8/13");
    expect(full).toContain("8/17");
  });

  test("a hostile category label renders as escaped text on every label surface (legend + tooltip name)", () => {
    // XSS pin (plan-63 qc2-S-3, restated for plan 65): category labels are
    // open-set wire strings (review/schema.ts) that travel MORE surfaces
    // now — the HTML legend text and the tooltip series name — plus the
    // axis tick face via a hostile bucket_start (next pin). All travel the
    // React text/attribute path: hostile markup surfaces escaped, never a
    // raw <img>/<script> element in the chart output.
    const hostileSeries: StackedSeries[] = [
      { key: "<img src=x>", label: "<img src=x>", fillClass: "chart-fill-blue-700" },
      { key: "<script>alert(1)</script>", label: "<script>alert(1)</script>", fillClass: "chart-fill-teal-700" },
    ];
    const hostileBuckets: DistributionBucket[] = [
      {
        bucket_start: "2026-08-17",
        granularity: "day",
        by_severity: {},
        by_category: { "<img src=x>": 2, "<script>alert(1)</script>": 5 },
      },
    ];
    const html = stackedChart(hostileBuckets, hostileSeries);
    // The legend label span renders the escaped text…
    expect(html).toContain(">&lt;img src=x&gt;</span>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    // …and the tooltip series name attribute (the Bar's name prop, the
    // pinned hover-face carrier) is attribute-escaped, not raw.
    expect(html).toContain('name="&lt;img src=x&gt;"');
    // No raw element from either surface.
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
  });

  test("a hostile bucket_start renders as escaped tick text — the non-ISO fallback stays a React text node", () => {
    // formatBucketDateLabel regex-accepts only ISO dates and falls back to
    // the raw string for anything else — the fallback must stay a React
    // text node (escaped), never raw markup on the axis face.
    const html = stackedChart(
      [
        {
          bucket_start: "<script>alert(1)</script>",
          granularity: "day",
          by_severity: { "must-fix": 2, "should-fix": 0, nit: 0 },
          by_category: {},
        },
      ],
      severitySeries,
    );
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script");
  });

  test("the tooltip is token-styled: contentStyle/labelStyle ride the SSR face, itemStyle is source-pinned", () => {
    // Plan component ruling (BarChart.tsx precedent): the recharts default
    // tooltip must be re-faced onto tokens — itemStyle is MANDATORY
    // (recharts' default list text is unreadable on the dark card).
    // contentStyle/labelStyle merge into the statically rendered wrapper
    // (recharts-internal class names — the file-header 2.15.4 coupling
    // caveat applies); the item list only renders on hover, so itemStyle
    // is pinned at the source level, its strongest statically-reachable
    // layer.
    const html = stackedChart(severityBuckets, severitySeries);
    expect(html).toContain("recharts-default-tooltip");
    const tooltip = html.slice(html.indexOf("recharts-default-tooltip"));
    expect(tooltip).toContain("background-color:var(--card)");
    expect(tooltip).toContain("border:1px solid var(--border)");
    expect(tooltip).toContain("border-radius:6px");
    expect(tooltip).toContain('class="recharts-tooltip-label" style="margin:0;color:var(--gray-1000);font-weight:500"');
    const source = readFileSync(join(import.meta.dir, "../../src/spa/components/charts/StackedBarChart.tsx"), "utf8");
    expect(source).toContain('itemStyle={{ color: "var(--gray-900)" }}');
  });

  test("empty buckets or empty series render null — the page owns the readable empty state", () => {
    expect(stackedChart([], severitySeries)).toBe("");
    expect(stackedChart(severityBuckets, [])).toBe("");
  });
});

describe("chart sources keep the no-raw-hex token discipline (plan 63 global constraint)", () => {
  test("zero raw hex in the charts module — colors ride var(--token) only", () => {
    for (const file of ["StackedBarChart.tsx", "TrendChart.tsx", "charts.css"]) {
      const source = readFileSync(join(import.meta.dir, `../../src/spa/components/charts/${file}`), "utf8");
      expect(source, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });
});

describe("token fills and text faces live as class rules in charts.css (plan-63 B3 pin, restated plan 65)", () => {
  test("every live fill class and swatch twin binds to a token rule in charts.css; the axis faces exist", () => {
    // Source-binding pin (restates the plan-63 BarChart-era pin the
    // stacked migration retired with its describe block): the SSR pins
    // above lock the rendered class ATTRIBUTES, which still pass if a fill
    // RULE is deleted from charts.css — segments would silently fall to
    // recharts' default black while the legend swatch twin keeps its
    // token color. The closed fill vocabulary (charts.css: the page maps
    // into this set only) is asserted rule-by-rule.
    const css = readFileSync(join(import.meta.dir, "../../src/spa/components/charts/charts.css"), "utf8");
    for (const family of ["red", "amber", "gray", "blue", "teal", "purple", "pink"]) {
      expect(css, `chart-fill-${family}-700`).toContain(`.chart-fill-${family}-700 { fill: var(--${family}-700); }`);
      expect(css, `chart-swatch-${family}-700`).toContain(
        `.chart-swatch-${family}-700 { background-color: var(--${family}-700); }`,
      );
    }
    // The v0.3 chrome faces: tick text renders tabular figures (DESIGN.md
    // numerals rule) and the legend label carries the label-face weight.
    expect(css).toContain("font-variant-numeric: tabular-nums");
    expect(css).toContain("font-weight: 500");
  });
});
