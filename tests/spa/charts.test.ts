/**
 * Plan 63 T2 (B2/B3): chart primitives — BarChart + TrendChart on recharts
 * (AD-621). The plan-56 hand-rolled layout math and its direct pins
 * (linearScale/niceTicks/bandScale/… — formerly charts/layout.ts) retired
 * with the module: recharts owns the geometry now. The render faces are
 * pinned through react-dom/server SSR (no DOM needed — static markup
 * output, the plan-53 settings-layout idiom): role/aria faces, counts as
 * text (LabelList, discriminated from axis ticks via the recharts-label-
 * list section), the AD-561/601 semantic-family fill classes, the dual-
 * series legend, the localized date axis, >8-week label thinning, the
 * zero-data faces, and the token discipline (no raw hex in sources; fills
 * ride the charts.css class rules — never presentation-attribute var(),
 * knowledge ui-bugs/svg-var-presentation-attributes.md).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { BarChart, type BarChartItem } from "../../src/spa/components/charts/BarChart";
import { TrendChart, type TrendPoint } from "../../src/spa/components/charts/TrendChart";

const barChart = (items: BarChartItem[], ariaLabel = "Findings by severity") =>
  renderToStaticMarkup(createElement(BarChart, { items, ariaLabel }));

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

/**
 * The recharts-label-list section of a bar render — the bar-end count
 * texts are the only tspans after it (axis ticks render before), so count
 * pins against this slice can never be satisfied by tick text (plan 56
 * T2-M1 discrimination, re-expressed for the recharts face: recharts'
 * numeric tick sets include data values, e.g. max 9 → ticks 0/3/6/9/12).
 */
const valueLabels = (html: string): string => html.slice(html.indexOf("recharts-label-list"));

describe("BarChart SSR (plan 63 T2, recharts face)", () => {
  const items: BarChartItem[] = [
    { key: "must-fix", label: "must-fix", value: 7, color: "var(--red-700)" },
    { key: "nit", label: "nit", value: 3, color: "var(--gray-700)" },
  ];

  test("renders an svg role=img with the aria-label, counts as text, and token-class-filled bars", () => {
    const html = barChart(items);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Findings by severity"');
    // Counts coexist with the graphic as bar-end LabelList text — sliced to
    // the label-list section so an axis tick can never satisfy the pin
    // (max 7 → recharts ticks 0/2/4/6/8, so 7/3 are label-only anyway).
    expect(valueLabels(html)).toContain(">7</tspan>");
    expect(valueLabels(html)).toContain(">3</tspan>");
    // AD-561 colors ride the charts.css fill classes (B3): CSS class rules
    // where var() always resolves — never presentation-attribute var(),
    // never raw hex.
    expect(html).toContain('class="recharts-rectangle chart-fill-red-700"');
    expect(html).toContain('class="recharts-rectangle chart-fill-gray-700"');
    // Category labels stay visible tick text next to their bars — the
    // fixture label renders as an axis tick value (carried T2 review
    // minor: a bare substring pin can't tell a tick from any other text).
    expect(html).toMatch(/recharts-cartesian-axis-tick-value"[^>]*><tspan[^>]*>must-fix<\/tspan>/);
  });

  test("a non-zero bar width tracks the value scale (proportion face, plan-45 F-01 class)", () => {
    // max 7 → recharts domain [0..8]; plot width = 560 - 110 - 40 = 410 →
    // the value-7 bar spans 7/8 · 410 = 358.75 — a collapsed or
    // domain-saturated width can never satisfy this.
    expect(barChart(items)).toContain('width="358.75"');
  });

  test("long labels truncate with an ellipsis on the category axis", () => {
    // The full label rides the hover tooltip (recharts face); the visible
    // tick text keeps the deterministic 14-char truncation face.
    const html = barChart([{ key: "c", label: "an-unusually-long-category-name", value: 3 }]);
    expect(html).toContain("an-unusually-…");
  });

  test("a missing per-item color falls back to the neutral series class", () => {
    expect(barChart([{ key: "c", label: "cats", value: 1 }])).toContain(
      'class="recharts-rectangle chart-fill-blue-700"',
    );
  });

  test("token fills and text faces live as class rules in charts.css (B3 delivery)", () => {
    // Source-level guard at the strongest reachable layer for the bun pin
    // suite; the compiled-bundle grep (dist/spa/assets/index-*.css) is the
    // kill proof (idiom: knowledge tailwind4-compiled-css-traps.md).
    const css = readFileSync(join(import.meta.dir, "../../src/spa/components/charts/charts.css"), "utf8");
    expect(css).toContain(".chart-fill-red-700 { fill: var(--red-700); }");
    expect(css).toContain(".chart-fill-amber-700 { fill: var(--amber-700); }");
    expect(css).toContain(".chart-fill-gray-700 { fill: var(--gray-700); }");
    expect(css).toContain(".chart-fill-blue-700 { fill: var(--blue-700); }");
    // The v0.3 chrome faces: category labels carry the label-face weight;
    // counts and ticks render tabular figures (DESIGN.md numerals rule).
    expect(css).toContain("font-weight: 500");
    expect(css).toContain("font-variant-numeric: tabular-nums");
  });

  test("all-zero values keep a coherent zero face — never NaN (AC2)", () => {
    const html = barChart([{ key: "z", label: "zero", value: 0 }]);
    // The count still renders as text; recharts renders the zero-value bar
    // as an empty rectangle group (no zero-size geometry, no NaN domain).
    expect(valueLabels(html)).toContain(">0</tspan>");
    expect(html).not.toContain("<path");
  });

  test("empty input renders null — the page owns the readable empty state", () => {
    expect(barChart([])).toBe("");
  });
});

describe("TrendChart SSR (plan 63 T2, recharts face)", () => {
  const weeks: TrendPoint[] = [
    { week: "2026-08-17", reviews: 1, findings: 2 },
    { week: "2026-08-24", reviews: 3, findings: 4 },
  ];

  test("renders an svg role=img with the aria-label, the dual-series legend, and both fill classes", () => {
    const html = trendChart(weeks);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Weekly trend"');
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
    for (const file of ["BarChart.tsx", "TrendChart.tsx", "charts.css"]) {
      const source = readFileSync(join(import.meta.dir, `../../src/spa/components/charts/${file}`), "utf8");
      expect(source, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });
});
