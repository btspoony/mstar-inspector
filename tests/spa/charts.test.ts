/**
 * Plan 56 T1: chart primitives — BarChart + TrendChart (AD-563) and their
 * pure layout math. The geometry helpers are pinned directly (scale edges,
 * all-zero domains, tick selection, >8-week thinning, truncation, localized
 * week labels); the render components are pinned behaviorally through
 * react-dom/server SSR (no DOM needed — static markup output, the plan-53
 * settings-layout idiom): role/aria-label faces, counts as text, legend
 * entries, the zero-data null face, and the no-raw-hex token discipline
 * (mirrors the insights-page pin; AD-561 colors ride var(--token)).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  BAND_RATIO,
  bandScale,
  barRows,
  formatWeekLabel,
  groupedBars,
  linearScale,
  niceTicks,
  thinXLabels,
  truncateLabel,
} from "../../src/spa/components/charts/layout";
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

describe("chart layout pure functions (plan 56 T1 / AD-563)", () => {
  test("linearScale maps 0..max onto the range and collapses all-zero domains to constant 0", () => {
    expect(linearScale(10, 100)(5)).toBe(50);
    expect(linearScale(10, 100)(0)).toBe(0);
    // Single point / max value → full range.
    expect(linearScale(7, 14)(7)).toBe(14);
    // All-zero and negative max → 0, never NaN/Infinity (AC2).
    expect(linearScale(0, 100)(5)).toBe(0);
    expect(linearScale(-3, 100)(5)).toBe(0);
  });

  test("niceTicks picks integer 1/2/5-ladder steps covering the max; all-zero → [0]", () => {
    expect(niceTicks(0)).toEqual([0]);
    expect(niceTicks(1)).toEqual([0, 1]);
    expect(niceTicks(3)).toEqual([0, 1, 2, 3]);
    expect(niceTicks(7)).toEqual([0, 2, 4, 6, 8]);
    expect(niceTicks(10)).toEqual([0, 5, 10]);
    expect(niceTicks(90)).toEqual([0, 50, 100]);
  });

  test("bandScale insets each weekly band inside its slot", () => {
    expect(BAND_RATIO).toBe(0.7);
    // 4 slots of 25, band width 17.5, centered → band 1 starts at 28.75.
    expect(bandScale(4, 100)(1)).toBe(28.75);
    // Single week: the one band is inset from the plot edge.
    expect(bandScale(1, 100)(0)).toBe(15);
  });

  test("groupedBars centers the series group inside the band (two rects per week, AD-562)", () => {
    const { width, offsets } = groupedBars(2, 17.5);
    expect(width).toBe(7);
    // Group width 14 centered in the 17.5 band → 1.75 gutter each side, so
    // the band midpoint (the date-label anchor) is the group's center
    // (plan 56 QC F-002 label/group alignment).
    expect(offsets).toEqual([1.75, 8.75]);
  });

  test("barRows centers each bar in its row slot", () => {
    expect(barRows(3, 28, 16)).toEqual([
      { y: 6, height: 16 },
      { y: 34, height: 16 },
      { y: 62, height: 16 },
    ]);
    expect(barRows(0, 28, 16)).toEqual([]);
  });

  test("thinXLabels keeps every week up to the cap, then every other week (first stays labeled)", () => {
    expect(thinXLabels(5)).toEqual([0, 1, 2, 3, 4]);
    expect(thinXLabels(8)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    // The 8→9 boundary: thinning first engages, both endpoints stay labeled.
    expect(thinXLabels(9)).toEqual([0, 2, 4, 6, 8]);
    expect(thinXLabels(10)).toEqual([0, 2, 4, 6, 8]);
    expect(thinXLabels(13)).toEqual([0, 2, 4, 6, 8, 10, 12]);
  });

  test("truncateLabel cuts long labels to maxChars with an ellipsis and keeps short ones intact", () => {
    expect(truncateLabel("short", 14)).toBe("short");
    expect(truncateLabel("an-unusually-long-category", 14)).toBe("an-unusually-…");
    expect(truncateLabel("exactly14chars", 14)).toBe("exactly14chars");
  });

  test("formatWeekLabel localizes ISO week starts without Intl (deterministic across runtimes)", () => {
    expect(formatWeekLabel("2026-08-17", "en")).toBe("8/17");
    expect(formatWeekLabel("2026-08-17", "zh_CN")).toBe("8月17日");
    // Non-ISO values fall back to the raw string rather than throwing.
    expect(formatWeekLabel("2026-08", "en")).toBe("2026-08");
  });
});

describe("BarChart SSR (plan 56 T1)", () => {
  const items: BarChartItem[] = [
    { key: "must-fix", label: "must-fix", value: 7, color: "var(--red-700)" },
    { key: "nit", label: "nit", value: 3, color: "var(--gray-700)" },
  ];

  test("renders an svg role=img with the aria-label, counts as text, and token-filled bars", () => {
    const html = barChart(items);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Findings by severity"');
    // Counts coexist with the graphic: the value sits in the markup as text.
    // 3 sits outside the chart's own tick set (niceTicks(7) = [0,2,4,6,8]),
    // so only a bar-end label — never an axis tick — can satisfy this.
    expect(html).toContain(">7</text>");
    expect(html).toContain(">3</text>");
    // AD-561 colors ride var(--token) through the style attribute (CSS
    // declarations, where var() resolves), never raw hex.
    expect(html).toContain('style="fill:var(--red-700)"');
    expect(html).toContain('style="fill:var(--gray-700)"');
    // Category labels are visible text next to their bars.
    expect(html).toContain("must-fix");
  });

  test("a non-zero bar width tracks the linear scale (proportion face, plan-45 F-01 class)", () => {
    // items: max 7 → ticks [0,2,4,6,8]; domain top 8, plotW = 560-118-40 =
    // 402 → the value-7 bar spans 7/8 · 402 = 351.75 — a collapsed or
    // domain-saturated width can never satisfy this.
    expect(barChart(items)).toContain('width="351.75"');
  });

  test("long labels truncate with an ellipsis and keep the full text as a title", () => {
    const html = barChart([{ key: "c", label: "an-unusually-long-category-name", value: 3 }]);
    expect(html).toContain("an-unusually-…");
    expect(html).toContain("<title>an-unusually-long-category-name</title>");
  });

  test("a missing per-item color falls back to the neutral series token", () => {
    expect(barChart([{ key: "c", label: "cats", value: 1 }])).toContain('style="fill:var(--blue-700)"');
  });

  test("all-zero values render zero-width bars — never NaN (AC2)", () => {
    expect(barChart([{ key: "z", label: "zero", value: 0 }])).toContain('width="0"');
  });

  test("empty input renders null — the page owns the readable empty state", () => {
    expect(barChart([])).toBe("");
  });
});

describe("TrendChart SSR (plan 56 T1 / AD-562)", () => {
  const weeks: TrendPoint[] = [
    { week: "2026-08-17", reviews: 1, findings: 0 },
    { week: "2026-08-24", reviews: 3, findings: 4 },
  ];

  test("renders an svg role=img with the aria-label and both legend entries", () => {
    const html = trendChart(weeks);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Weekly trend"');
    expect(html).toContain('style="fill:var(--blue-700)"');
    expect(html).toContain('style="fill:var(--amber-700)"');
    expect(html).toContain("Reviews");
    expect(html).toContain("Findings");
  });

  test("each week band carries the two grouped rects (reviews + findings)", () => {
    const html = trendChart(weeks);
    expect(html.split("<rect").length - 1).toBe(2 /* legend swatches */ + 2 /* weeks */ * 2 /* series */);
  });

  test("a non-zero rect height tracks the linear scale (proportion face, plan-45 F-01 class)", () => {
    // weeks: max 4 → ticks [0,1,2,3,4]; PLOT_H = 190-28-20 = 142 → the
    // findings-4 rect spans the full plot height — a collapsed height can
    // never satisfy this.
    expect(trendChart(weeks)).toContain('height="142"');
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

  test("all-zero series stay a coherent chart: ticks at 0, zero-height rects, legend intact (AC2)", () => {
    const html = trendChart([{ week: "2026-08-17", reviews: 0, findings: 0 }]);
    expect(html).toContain(">0</text>");
    expect(html).toContain('height="0"');
    expect(html).toContain("Reviews");
    expect(html).toContain("Findings");
  });

  test("a single week renders one full band with both series (no division blowups)", () => {
    const html = trendChart([{ week: "2026-08-17", reviews: 2, findings: 1 }]);
    // 2 legend swatches + 1 week × 2 series.
    expect(html.split("<rect").length - 1).toBe(4);
    expect(html).toContain("8/17");
  });

  test("empty input renders null — the page owns the readable empty state", () => {
    expect(trendChart([])).toBe("");
  });
});

describe("chart sources keep the no-raw-hex token discipline (plan 56 global constraint)", () => {
  test("zero raw hex in the charts module — colors ride var(--token) only", () => {
    for (const file of ["BarChart.tsx", "TrendChart.tsx", "layout.ts"]) {
      const source = readFileSync(join(import.meta.dir, `../../src/spa/components/charts/${file}`), "utf8");
      expect(source, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });
});
