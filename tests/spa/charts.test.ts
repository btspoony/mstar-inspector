import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { installDom } from "./dom";
import { CHART_SLOTS, chartClasses, type ChartSlot } from "../../src/spa/components/charts/chartSlots";
import type { DistributionBucket, StackedSeries } from "../../src/spa/components/charts/StackedBarChart";
import type { TrendPoint } from "../../src/spa/components/charts/TrendChart";

// recharts 3 reads its SSR flag when the module is imported and renders an
// empty wrapper until a layout effect reports the chart size. Install the DOM
// first, then import the chart modules (and recharts through them).
const { win, cleanup } = installDom("http://localhost/");
afterAll(cleanup);

const { TrendChart } = await import("../../src/spa/components/charts/TrendChart");
const { StackedBarChart } = await import("../../src/spa/components/charts/StackedBarChart");

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

async function mountDom(el: ReactElement): Promise<{
  container: HTMLElement;
  cleanup: () => Promise<void>;
}> {
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => root.render(el));
  return {
    container: container as unknown as HTMLElement,
    cleanup: async () => {
      await act(async () => root.unmount());
      container.remove();
    },
  };
}

const mount = async (el: ReactElement): Promise<string> => {
  const { container, cleanup: unmount } = await mountDom(el);
  const html = container.innerHTML;
  await unmount();
  return html;
};

const trendChart = (
  points: TrendPoint[],
  overrides: { seriesLabels?: { reviews: string; findings: string }; ariaLabel?: string } = {},
) =>
  mount(
    createElement(TrendChart, {
      points,
      seriesLabels: overrides.seriesLabels ?? { reviews: "Reviews", findings: "Findings" },
      ariaLabel: overrides.ariaLabel ?? "Weekly trend",
    }),
  );

describe("TrendChart render (recharts face)", () => {
  const weeks: TrendPoint[] = [
    { week: "2026-08-17", reviews: 1, findings: 2 },
    { week: "2026-08-24", reviews: 3, findings: 4 },
  ];

  test("renders an svg role=img with the aria-label, the dual-series legend, and both faces of each slot", async () => {
    const html = await trendChart(weeks);
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

  test("each week carries the two grouped series bars (2 weeks × 2 series)", async () => {
    expect((await trendChart(weeks)).split("<path").length - 1).toBe(4);
  });

  test("a non-zero bar height tracks the value scale (proportion face, F-01 class)", async () => {
    expect(await trendChart(weeks)).toMatch(
      new RegExp(`<path [^>]*class="recharts-rectangle ${chartClasses(3).fill}"[^>]*height="142"`),
    );
  });

  test("date labels are the pinned M/D format in every locale (2026-09-16 user-feedback pin)", async () => {
    const html = await trendChart(weeks);
    expect(html).toContain("8/17");
    expect(html).not.toContain("月");
  });

  test("more than 8 weeks thins to every-other-week date labels", async () => {
    const mondays = ["06-29", "07-06", "07-13", "07-20", "07-27", "08-03", "08-10", "08-17", "08-24", "08-31"];
    const dense: TrendPoint[] = mondays.map((week) => ({ week: `2026-${week}`, reviews: 1, findings: 1 }));
    const html = await trendChart(dense);
    expect(html).toContain("6/29");
    expect(html).toContain("7/13");
    expect(html).toContain("8/24");
    expect(html).not.toContain("7/6");
    expect(html).not.toContain("8/31");
  });

  test("all-zero series stay a coherent chart: zero tick, no geometry, legend intact (AC2)", async () => {
    const html = await trendChart([{ week: "2026-08-17", reviews: 0, findings: 0 }]);
    expect(html).toContain(">0</tspan>");
    expect(html).not.toContain("<path");
    expect(html).toContain("Reviews");
    expect(html).toContain("Findings");
  });

  test("a single week renders both series (no division blowups)", async () => {
    const html = await trendChart([{ week: "2026-08-17", reviews: 2, findings: 1 }]);
    expect(html.split("<path").length - 1).toBe(2);
    expect(html).toContain("8/17");
  });

  test("empty input renders null — the page owns the readable empty state", async () => {
    expect(await trendChart([])).toBe("");
  });
});

describe("StackedBarChart render (stacked face)", () => {
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
    mount(
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

  test("renders role=img with the aria-label, the svg <title> mirror, and the legend row in series order", async () => {
    const html = await stackedChart(severityBuckets, severitySeries);
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

  test("stacked segments carry the series fill faces and the tooltip series names", async () => {
    const html = await stackedChart(severityBuckets, severitySeries);
    const resolved = new Set(seriesClasses(html).map((classes) => resolveDeclared(classes, "fill")));
    expect(resolved).toEqual(new Set(severitySeries.map((series) => `var(--chart-${series.slot})`)));
    expect(html).toContain('name="must-fix"');
    expect(html).toContain('name="should-fix"');
    expect(html).toContain('name="may-fix"');
    expect(html).toContain('name="nit"');
  });

  test("stackId stacking face: segments pile bottom-up in series order, heights track the values", async () => {
    const html = await stackedChart(severityBuckets, severitySeries);
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

  test("zero-count buckets stay on the axis (time continuity) without geometry", async () => {
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
    const html = await stackedChart(buckets, severitySeries);
    expect(html).toContain(">8/17</tspan>");
    expect(html).toContain(">8/18</tspan>");
    expect(html.split("<path").length - 1).toBe(4);
  });

  test("day and week buckets share one axis face; the pinned M/D label holds for both", async () => {
    const weekBuckets: DistributionBucket[] = [
      {
        bucket_start: "2026-08-17",
        granularity: "week",
        by_severity: { "must-fix": 1, "should-fix": 0, "may-fix": 0, nit: 0 },
      },
    ];
    expect(await stackedChart(weekBuckets, severitySeries)).toContain("8/17");
    expect(await stackedChart(weekBuckets, severitySeries)).not.toContain("月");
  });

  test("more than 8 buckets thin to every-other date labels; 8 or fewer keep every label", async () => {
    const days = ["08-10", "08-11", "08-12", "08-13", "08-14", "08-15", "08-16", "08-17", "08-18", "08-19"];
    const bucket = (bucket_start: string): DistributionBucket => ({
      bucket_start,
      granularity: "day",
      by_severity: { "must-fix": 1, "should-fix": 0, "may-fix": 0, nit: 0 },
    });
    const dense = await stackedChart(days.map((day) => bucket(`2026-${day}`)), severitySeries);
    expect(dense).toContain("8/10");
    expect(dense).toContain("8/18");
    expect(dense).not.toContain("8/11");
    expect(dense).not.toContain("8/19");
    const full = await stackedChart(days.slice(0, 8).map((day) => bucket(`2026-${day}`)), severitySeries);
    expect(full).toContain("8/10");
    expect(full).toContain("8/11");
    expect(full).toContain("8/13");
    expect(full).toContain("8/17");
  });

  test("a hostile series label renders as inert text on every label surface (legend + tooltip name)", async () => {
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
    const { container, cleanup: unmount } = await mountDom(
      createElement(StackedBarChart, {
        buckets: hostileBuckets,
        series: hostileSeries,
        ariaLabel: "Hostile labels",
      }),
    );
    try {
      expect(container.querySelectorAll("script, img")).toHaveLength(0);
      expect(container.textContent).toContain("<img src=x>");
      expect(container.textContent).toContain("<script>alert(1)</script>");
      const names = [...container.querySelectorAll("path")].map((path) => path.getAttribute("name"));
      expect(names).toContain("<img src=x>");
    } finally {
      await unmount();
    }
  });

  test("a hostile bucket_start renders as escaped tick text — the non-ISO fallback stays a React text node", async () => {
    const html = await stackedChart(
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

  test("the tooltip is token-styled: contentStyle/labelStyle ride the chart face", async () => {
    const html = await stackedChart(severityBuckets, severitySeries);
    expect(html).toContain("recharts-default-tooltip");
    const tooltip = html.slice(html.indexOf("recharts-default-tooltip"));
    expect(tooltip).toContain("background-color: var(--surface-card)");
    expect(tooltip).toContain("border-color: var(--border-default)");
    expect(tooltip).toContain("border-radius: 6px");
    expect(tooltip).toContain("color: var(--text-primary)");
    expect(tooltip).toContain("font-weight: 500");
  });

  test("empty buckets or empty series render null — the page owns the readable empty state", async () => {
    expect(await stackedChart([], severitySeries)).toBe("");
    expect(await stackedChart(severityBuckets, [])).toBe("");
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
