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
 * StackedBarChart now); the stacked-chart SSR pins land with Task 3.
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

describe("chart sources keep the no-raw-hex token discipline (plan 63 global constraint)", () => {
  test("zero raw hex in the charts module — colors ride var(--token) only", () => {
    for (const file of ["StackedBarChart.tsx", "TrendChart.tsx", "charts.css"]) {
      const source = readFileSync(join(import.meta.dir, `../../src/spa/components/charts/${file}`), "utf8");
      expect(source, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });
});
