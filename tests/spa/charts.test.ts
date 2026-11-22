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
import { CHART_SLOTS, chartClasses, type ChartSlot } from "../../src/spa/components/charts/chartSlots";

const CHARTS_CSS = readFileSync(
  join(import.meta.dir, "../../src/spa/components/charts/charts.css"),
  "utf8",
);

function resolveDeclared(classList: string, prop: string): string | undefined {
  for (const cls of classList.split(/\s+/).filter(Boolean)) {
    const rule = new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`).exec(CHARTS_CSS)?.[1];
    const value = rule === undefined ? null : new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`).exec(rule)?.[1];
    if (value !== null && value !== undefined) return value.trim();
  }
  return undefined;
}

const swatchClasses = (html: string): string[] =>
  [...html.matchAll(/<span class="(chart-legend-swatch[^"]*)"/g)].map((m) => m[1]!);

const seriesClasses = (html: string): string[] =>
  [...html.matchAll(/<path [^>]*class="([^"]*)"/g)].map((m) => m[1]!);

const trendChart = (
  points: TrendPoint[],
  overrides: { seriesLabels?: { reviews: string; findings: string }; ariaLabel?: string } = {},
) =>
  renderToStaticMarkup(
    createElement(TrendChart, {
      points,
      seriesLabels: overrides.seriesLabels ?? { reviews: "Reviews", findings: "Findings" },
      ariaLabel: overrides.ariaLabel ?? "Weekly trend",
    }),
  );

describe("TrendChart SSR (recharts face)", () => {
  const weeks: TrendPoint[] = [
    { week: "2026-08-17", reviews: 1, findings: 2 },
    { week: "2026-08-24", reviews: 3, findings: 4 },
  ];

  test("renders an svg role=img with the aria-label, the dual-series legend, and both faces of each slot", () => {
    const html = trendChart(weeks);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Weekly trend"');
    expect(html).toContain("<title>Weekly trend</title>");
    const reviews = html.indexOf(">Reviews</span>");
    const findings = html.indexOf(">Findings</span>");
    const swatches = swatchClasses(html);
    expect(swatches).toHaveLength(2);
    const firstSwatch = html.indexOf(swatches[0]!);
    const secondSwatch = html.indexOf(swatches[1]!);
    expect(firstSwatch).toBeGreaterThanOrEqual(0);
    expect(firstSwatch).toBeLessThan(reviews);
    expect(reviews).toBeLessThan(secondSwatch);
    expect(secondSwatch).toBeLessThan(findings);
    expect(resolveDeclared(swatches[0]!, "background-color")).toBe("var(--chart-5-mark)");
    expect(resolveDeclared(swatches[1]!, "background-color")).toBe("var(--chart-3-mark)");
    const fills = new Set(seriesClasses(html).map((classes) => resolveDeclared(classes, "fill")));
    expect(fills).toEqual(new Set(["var(--chart-5)", "var(--chart-3)"]));
    for (const [swatch, slot] of [[swatches[0]!, 5], [swatches[1]!, 3]] as const) {
      expect(resolveDeclared(swatch, "background-color")).not.toBe(
        resolveDeclared(chartClasses(slot).fill, "fill"),
      );
    }
  });

  test("each week carries the two grouped series bars (2 weeks × 2 series)", () => {
    expect(trendChart(weeks).split("<path").length - 1).toBe(4);
  });

  test("a non-zero bar height tracks the value scale (proportion face, F-01 class)", () => {
    expect(trendChart(weeks)).toMatch(
      new RegExp(`<path [^>]*height="142"[^>]*class="recharts-rectangle ${chartClasses(3).fill}"`),
    );
  });

  test("date labels are the pinned M/D format in every locale (2026-09-16 user-feedback pin)", () => {
    const html = trendChart(weeks);
    expect(html).toContain("8/17");
    expect(html).not.toContain("月");
  });

  test("more than 8 weeks thins to every-other-week date labels", () => {
    const mondays = ["06-29", "07-06", "07-13", "07-20", "07-27", "08-03", "08-10", "08-17", "08-24", "08-31"];
    const dense: TrendPoint[] = mondays.map((week) => ({ week: `2026-${week}`, reviews: 1, findings: 1 }));
    const html = trendChart(dense);
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

describe("StackedBarChart SSR (stacked face)", () => {
  const severityBuckets: DistributionBucket[] = [
    {
      bucket_start: "2026-08-17",
      granularity: "day",
      by_severity: { "must-fix": 7, "should-fix": 5, "may-fix": 4, nit: 3 },
    },
  ];
  const severitySeries: StackedSeries[] = [
    { key: "must-fix", label: "must-fix", slot: 4 },
    { key: "should-fix", label: "should-fix", slot: 3 },
    { key: "may-fix", label: "may-fix", slot: 6 },
    { key: "nit", label: "nit", slot: 5 },
  ];

  const stackedChart = (
    buckets: DistributionBucket[],
    series: StackedSeries[],
    overrides: { ariaLabel?: string } = {},
  ) =>
    renderToStaticMarkup(
      createElement(StackedBarChart, {
        buckets,
        series,
        ariaLabel: overrides.ariaLabel ?? "Findings by severity",
      }),
    );

  const segment = (html: string, slot: ChartSlot): { y: number; height: number } => {
    const fill = chartClasses(slot).fill;
    const tag = new RegExp(`<path [^>]*class="recharts-rectangle ${fill}"[^>]*>`).exec(html)?.[0];
    const y = tag ? /\by="([0-9.]+)"/.exec(tag) : null;
    const height = tag ? /\bheight="([0-9.]+)"/.exec(tag) : null;
    if (!tag || !y || !height) throw new Error(`stacked segment not found: slot ${slot}`);
    return { y: Number(y[1]), height: Number(height[1]) };
  };

  test("renders role=img with the aria-label, the svg <title> mirror, and the legend row in series order", () => {
    const html = stackedChart(severityBuckets, severitySeries);
    expect(html).toContain('role="img"');
    expect(html).toContain('aria-label="Findings by severity"');
    expect(html).toContain("<title>Findings by severity</title>");
    const swatches = swatchClasses(html);
    const labels = ["must-fix", "should-fix", "may-fix", "nit"];
    expect(swatches).toHaveLength(labels.length);
    let cursor = -1;
    for (const [index, label] of labels.entries()) {
      const swatchAt = html.indexOf(swatches[index]!, cursor + 1);
      const labelAt = html.indexOf(`>${label}</span>`, cursor + 1);
      expect(swatchAt, label).toBeGreaterThan(cursor);
      expect(swatchAt, label).toBeLessThan(labelAt);
      cursor = labelAt;
      expect(resolveDeclared(swatches[index]!, "background-color"), label).toBe(
        `var(--chart-${severitySeries[index]!.slot}-mark)`,
      );
    }
  });

  test("stacked segments carry the series fill faces and the tooltip series names", () => {
    const html = stackedChart(severityBuckets, severitySeries);
    const resolved = new Set(seriesClasses(html).map((classes) => resolveDeclared(classes, "fill")));
    expect(resolved).toEqual(new Set(severitySeries.map((series) => `var(--chart-${series.slot})`)));
    expect(html).toContain('name="must-fix"');
    expect(html).toContain('name="should-fix"');
    expect(html).toContain('name="may-fix"');
    expect(html).toContain('name="nit"');
  });

  test("stackId stacking face: segments pile bottom-up in series order, heights track the values", () => {
    const html = stackedChart(severityBuckets, severitySeries);
    const must = segment(html, 4);
    const should = segment(html, 3);
    const may = segment(html, 6);
    const nit = segment(html, 5);
    expect(must.y + must.height).toBeCloseTo(146);
    expect(should.y + should.height).toBeCloseTo(must.y);
    expect(may.y + may.height).toBeCloseTo(should.y);
    expect(nit.y + nit.height).toBeCloseTo(may.y);
    expect(must.height / nit.height).toBeCloseTo(7 / 3);
    expect(should.height / nit.height).toBeCloseTo(5 / 3);
    expect(may.height / nit.height).toBeCloseTo(4 / 3);
  });

  test("zero-count buckets stay on the axis (time continuity) without geometry", () => {
    const buckets: DistributionBucket[] = [
      {
        bucket_start: "2026-08-17",
        granularity: "day",
        by_severity: { "must-fix": 0, "should-fix": 0, "may-fix": 0, nit: 0 },
      },
      {
        bucket_start: "2026-08-18",
        granularity: "day",
        by_severity: { "must-fix": 2, "should-fix": 1, "may-fix": 1, nit: 1 },
      },
    ];
    const html = stackedChart(buckets, severitySeries);
    expect(html).toContain(">8/17</tspan>");
    expect(html).toContain(">8/18</tspan>");
    expect(html.split("<path").length - 1).toBe(4);
  });

  test("day and week buckets share one axis face; the pinned M/D label holds for both", () => {
    const weekBuckets: DistributionBucket[] = [
      {
        bucket_start: "2026-08-17",
        granularity: "week",
        by_severity: { "must-fix": 1, "should-fix": 0, "may-fix": 0, nit: 0 },
      },
    ];
    expect(stackedChart(weekBuckets, severitySeries)).toContain("8/17");
    expect(stackedChart(weekBuckets, severitySeries)).not.toContain("月");
  });

  test("more than 8 buckets thin to every-other date labels; 8 or fewer keep every label", () => {
    const days = ["08-10", "08-11", "08-12", "08-13", "08-14", "08-15", "08-16", "08-17", "08-18", "08-19"];
    const bucket = (bucket_start: string): DistributionBucket => ({
      bucket_start,
      granularity: "day",
      by_severity: { "must-fix": 1, "should-fix": 0, "may-fix": 0, nit: 0 },
    });
    const dense = stackedChart(days.map((day) => bucket(`2026-${day}`)), severitySeries);
    expect(dense).toContain("8/10");
    expect(dense).toContain("8/18");
    expect(dense).not.toContain("8/11");
    expect(dense).not.toContain("8/19");
    const full = stackedChart(days.slice(0, 8).map((day) => bucket(`2026-${day}`)), severitySeries);
    expect(full).toContain("8/10");
    expect(full).toContain("8/11");
    expect(full).toContain("8/13");
    expect(full).toContain("8/17");
  });

  test("a hostile series label renders as escaped text on every label surface (legend + tooltip name)", () => {
    const hostileSeries: StackedSeries[] = [
      { key: "<img src=x>", label: "<img src=x>", slot: 5 },
      { key: "<script>alert(1)</script>", label: "<script>alert(1)</script>", slot: 1 },
    ];
    const hostileBuckets: DistributionBucket[] = [
      {
        bucket_start: "2026-08-17",
        granularity: "day",
        by_severity: { "<img src=x>": 2, "<script>alert(1)</script>": 5 },
      },
    ];
    const html = stackedChart(hostileBuckets, hostileSeries);
    expect(html).toContain(">&lt;img src=x&gt;</span>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).toContain('name="&lt;img src=x&gt;"');
    expect(html).not.toContain("<img");
    expect(html).not.toContain("<script");
  });

  test("a hostile bucket_start renders as escaped tick text — the non-ISO fallback stays a React text node", () => {
    const html = stackedChart(
      [
        {
          bucket_start: "<script>alert(1)</script>",
          granularity: "day",
          by_severity: { "must-fix": 2, "should-fix": 0, "may-fix": 0, nit: 0 },
        },
      ],
      severitySeries,
    );
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script");
  });

  test("the tooltip is token-styled: contentStyle/labelStyle ride the SSR face, itemStyle is source-pinned", () => {
    const html = stackedChart(severityBuckets, severitySeries);
    expect(html).toContain("recharts-default-tooltip");
    const tooltip = html.slice(html.indexOf("recharts-default-tooltip"));
    expect(tooltip).toContain("background-color:var(--surface-card)");
    expect(tooltip).toContain("border:1px solid var(--border-default)");
    expect(tooltip).toContain("border-radius:6px");
    expect(tooltip).toContain(
      'class="recharts-tooltip-label" style="margin:0;color:var(--text-primary);font-weight:500"',
    );
    const source = readFileSync(join(import.meta.dir, "../../src/spa/components/charts/StackedBarChart.tsx"), "utf8");
    expect(source).toContain('itemStyle={{ color: "var(--text-secondary)" }}');
  });

  test("empty buckets or empty series render null — the page owns the readable empty state", () => {
    expect(stackedChart([], severitySeries)).toBe("");
    expect(stackedChart(severityBuckets, [])).toBe("");
  });
});

describe("chart sources keep the no-raw-hex token discipline (global constraint)", () => {
  test("zero raw hex in the charts module — colors ride var(--token) only", () => {
    for (const file of ["StackedBarChart.tsx", "TrendChart.tsx", "charts.css"]) {
      const source = readFileSync(join(import.meta.dir, `../../src/spa/components/charts/${file}`), "utf8");
      expect(source, file).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });
});

describe("the closed chart vocabulary has two faces per slot (D14)", () => {
  test("every slot's fill reads --chart-{n} and its swatch reads --chart-{n}-mark", () => {
    for (const slot of CHART_SLOTS) {
      const { fill, swatch } = chartClasses(slot);
      expect(resolveDeclared(fill, "fill"), fill).toBe(`var(--chart-${slot})`);
      expect(resolveDeclared(swatch, "background-color"), swatch).toBe(`var(--chart-${slot}-mark)`);
      expect(resolveDeclared(swatch, "background-color")).not.toBe(resolveDeclared(fill, "fill"));
    }
    expect(CHARTS_CSS).toContain("font-variant-numeric: tabular-nums");
    expect(CHARTS_CSS).toContain("font-weight: 500");
  });

  test("the stylesheet answers exactly the six slots — no seventh family", () => {
    const declared = [...CHARTS_CSS.matchAll(/\.chart-(?:fill|swatch)-[a-z0-9-]+/g)].map((m) => m[0]);
    const expected = CHART_SLOTS.flatMap((slot) => {
      const { fill, swatch } = chartClasses(slot);
      return [`.${fill}`, `.${swatch}`];
    });
    expect(declared.sort()).toEqual(expected.sort());
  });

  test("a series value outside the six slots does not typecheck", () => {
    const inRange: StackedSeries = { key: "k", label: "k", slot: 6 };
    // note: 7 is outside chart-1..6: a chart cannot name a face
    // @ts-expect-error
    // note: the stylesheet does not answer.
    const outOfRange: StackedSeries = { key: "k", label: "k", slot: 7 };
    // @ts-expect-error
    // note: the slot union has no zero.
    const zero: ChartSlot = 0;
    // note: The teeth are the two `@ts-expect-error` lines above (a value outside
    // the union is a compile error); the runtime asserts the same facts as
    // numbers, so a widened slot type shows up here too.
    expect(inRange.slot).toBe(6);
    expect([outOfRange.slot as number, zero as number]).toEqual([7, 0]);
    expect(CHART_SLOTS).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
