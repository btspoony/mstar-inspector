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
