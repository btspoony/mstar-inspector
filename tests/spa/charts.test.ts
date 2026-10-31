/**
 * Chart primitives (B2/B3) — TrendChart on recharts (AD-621).
 * The hand-rolled layout math and its direct pins
 * (linearScale/niceTicks/bandScale/… — formerly charts/layout.ts) retired
 * with the module: recharts owns the geometry now. The render faces are
 * pinned through react-dom/server SSR (no DOM needed — static markup
 * output, the settings-layout idiom): role/aria faces, the dual-
 * series legend, the pinned M/D date axis (every locale — dateLabel.ts,
 * the 2026-09-16 user-feedback pin), >8-week label thinning, the
 * zero-data faces, and the token discipline (no raw hex in sources; fills
 * ride the charts.css class rules — never presentation-attribute var(),
 * knowledge ui-bugs/svg-var-presentation-attributes.md).
 *
 * D14 two faces: a series names a slot (1-6), never a colour. The bar paints
 * `--chart-{n}`; the legend swatch paints `--chart-{n}-mark`. The pins below
 * resolve an element's emitted class list through charts.css and assert the
 * declared property, so a renamed class cannot pass while a swatch that
 * resolved to the fill (the defect this split exists to prevent) fails.
 *
 * (B4): the aggregate BarChart and its describe block retired
 * with the component (the insights severity/category cards consume
 * StackedBarChart now).
 * (B8): the stacked-chart SSR pins — StackedBarChart renders the
 * same terminal stacked geometry through the idiom below (createElement in
 * this .ts file, the TrendChart face): the series-ordered HTML legend row,
 * the per-segment fill classes + tooltip series names, the stackId
 * bottom-up adjacency, the svg <title> mirror, the zero-count buckets kept
 * on the axis (time continuity, AC-C), and the day/week label face. The
 * severity/category page faces ride the InsightsPage pins in
 * insights-page.test.ts.
 * QC fix-1: the pins dropped with the BarChart retirement
 * restate on the stacked face — the charts.css token-binding pin (every slot's
 * two faces carry their token rule; the axis text faces),
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
import { CHART_SLOTS, chartClasses, type ChartSlot } from "../../src/spa/components/charts/chartSlots";

const CHARTS_CSS = readFileSync(
  join(import.meta.dir, "../../src/spa/components/charts/charts.css"),
  "utf8",
);

/**
 * The value `prop` resolves to for one element's emitted class list, read from
 * the charts.css rules — the property, not the class name. `undefined` when no
 * class in the list declares it (a fill with no rule paints recharts' default).
 */
function resolveDeclared(classList: string, prop: string): string | undefined {
  for (const cls of classList.split(/\s+/).filter(Boolean)) {
    const rule = new RegExp(`\\.${cls}\\s*\\{([^}]*)\\}`).exec(CHARTS_CSS)?.[1];
    const value = rule === undefined ? null : new RegExp(`(?:^|;)\\s*${prop}:\\s*([^;]+)`).exec(rule)?.[1];
    if (value !== null && value !== undefined) return value.trim();
  }
  return undefined;
}

/** Every legend swatch's class list, in legend order. */
const swatchClasses = (html: string): string[] =>
  [...html.matchAll(/<span class="(chart-legend-swatch[^"]*)"/g)].map((m) => m[1]!);

/** Every series path's class list (the recharts-rectangle face). */
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
    // Same svg <title> mirror pin as the BarChart face (recharts Surface
    // forwards `title` → `<title>`): dropping the prop fails here too.
    expect(html).toContain("<title>Weekly trend</title>");
    // Legend order pins the series→slot pairing: the reviews swatch precedes
    // its label, then the findings swatch and its label.
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
    // Two faces: the swatches resolve to the slots' mark token, the bars to
    // the quiet fill token — a swatch that resolved to the fill is the defect
    // this split exists to prevent.
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
    // Legend swatches are HTML spans now — every <path> is series geometry.
    expect(trendChart(weeks).split("<path").length - 1).toBe(4);
  });

  test("a non-zero bar height tracks the value scale (proportion face, F-01 class)", () => {
    // max 4 → recharts domain [0..4]; plot height = 166 - 4 - 20 = 142 →
    // the findings-4 rect spans the full plot height — a collapsed height
    // can never satisfy this.
    expect(trendChart(weeks)).toMatch(
      new RegExp(`<path [^>]*height="142"[^>]*class="recharts-rectangle ${chartClasses(3).fill}"`),
    );
  });

  test("date labels are the pinned M/D format in every locale (2026-09-16 user-feedback pin)", () => {
    // The locale prop is retired: the shared formatDateLabel (dateLabel.ts)
    // renders numeric M/D on the axis face regardless of the app locale —
    // the zh M月D日 face never renders again.
    const html = trendChart(weeks);
    expect(html).toContain("8/17");
    expect(html).not.toContain("月");
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

describe("StackedBarChart SSR (stacked face)", () => {
  const severityBuckets: DistributionBucket[] = [
    {
      bucket_start: "2026-08-17",
      granularity: "day",
      by_severity: { "must-fix": 7, "should-fix": 5, nit: 3 },
      by_category: {},
    },
  ];
  const severitySeries: StackedSeries[] = [
    { key: "must-fix", label: "must-fix", slot: 4 },
    { key: "should-fix", label: "should-fix", slot: 3 },
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

  /** The y/height of one slot's stacked segment path (recharts-rectangle face). */
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
    // Same svg <title> mirror pin as the TrendChart face (recharts Surface
    // forwards `title` → `<title>`): dropping the prop fails here too.
    expect(html).toContain("<title>Findings by severity</title>");
    // Legend order = stack order: each swatch precedes its own label (the
    // HTML legend row above the chart — the TrendChart face), and each swatch
    // resolves to its slot's mark token.
    const swatches = swatchClasses(html);
    const labels = ["must-fix", "should-fix", "nit"];
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
    // Colors ride the charts.css class rules only — never presentation
    // attributes, never raw hex (the no-raw-hex source scan below covers
    // the module). Each segment's emitted class list resolves to its slot's
    // quiet fill token; a deleted rule leaves `fill` unresolved.
    const resolved = new Set(seriesClasses(html).map((classes) => resolveDeclared(classes, "fill")));
    expect(resolved).toEqual(new Set(severitySeries.map((series) => `var(--chart-${series.slot})`)));
    // Exact counts ride the tooltip — every segment path carries its series
    // name so the hover face can name the number it holds.
    expect(html).toContain('name="must-fix"');
    expect(html).toContain('name="should-fix"');
    expect(html).toContain('name="nit"');
  });

  test("stackId stacking face: segments pile bottom-up in series order, heights track the values", () => {
    const html = stackedChart(severityBuckets, severitySeries);
    const must = segment(html, 4);
    const should = segment(html, 3);
    const nit = segment(html, 5);
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

  test("day and week buckets share one axis face; the pinned M/D label holds for both", () => {
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
    expect(stackedChart(weekBuckets, severitySeries)).not.toContain("月");
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
    // XSS pin (qc2-S-3, restated): category labels are
    // open-set wire strings (review/schema.ts) that travel MORE surfaces
    // now — the HTML legend text and the tooltip series name — plus the
    // axis tick face via a hostile bucket_start (next pin). All travel the
    // React text/attribute path: hostile markup surfaces escaped, never a
    // raw <img>/<script> element in the chart output.
    const hostileSeries: StackedSeries[] = [
      { key: "<img src=x>", label: "<img src=x>", slot: 5 },
      { key: "<script>alert(1)</script>", label: "<script>alert(1)</script>", slot: 1 },
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
    // formatDateLabel regex-accepts only ISO dates and falls back to
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
    // Property pin, not a class pin: the emitted class list is resolved
    // through charts.css and the DECLARED VALUE is asserted. A swatch that
    // resolved to the slot's fill would paint the loud bar face at 10px —
    // the exact defect the large-fill-quieter-than-small-marks split exists
    // to prevent — and fails here.
    for (const slot of CHART_SLOTS) {
      const { fill, swatch } = chartClasses(slot);
      expect(resolveDeclared(fill, "fill"), fill).toBe(`var(--chart-${slot})`);
      expect(resolveDeclared(swatch, "background-color"), swatch).toBe(`var(--chart-${slot}-mark)`);
      expect(resolveDeclared(swatch, "background-color")).not.toBe(resolveDeclared(fill, "fill"));
    }
    // The v0.3 chrome faces: tick text renders tabular figures (DESIGN.md
    // numerals rule) and the legend label carries the label-face weight.
    expect(CHARTS_CSS).toContain("font-variant-numeric: tabular-nums");
    expect(CHARTS_CSS).toContain("font-weight: 500");
  });

  test("the stylesheet answers exactly the six slots — no seventh family", () => {
    // A retired family (teal/pink's `-700` pairs) must not leave a rule
    // behind, and a slot without a rule cannot be reached from the type.
    const declared = [...CHARTS_CSS.matchAll(/\.chart-(?:fill|swatch)-[a-z0-9-]+/g)].map((m) => m[0]);
    const expected = CHART_SLOTS.flatMap((slot) => {
      const { fill, swatch } = chartClasses(slot);
      return [`.${fill}`, `.${swatch}`];
    });
    expect(declared.sort()).toEqual(expected.sort());
  });

  test("a series value outside the six slots does not typecheck", () => {
    const inRange: StackedSeries = { key: "k", label: "k", slot: 6 };
    // @ts-expect-error — 7 is outside chart-1..6: a chart cannot name a face
    // the stylesheet does not answer.
    const outOfRange: StackedSeries = { key: "k", label: "k", slot: 7 };
    // @ts-expect-error — the slot union has no zero.
    const zero: ChartSlot = 0;
    // The teeth are the two `@ts-expect-error` lines above (a value outside
    // the union is a compile error); the runtime asserts the same facts as
    // numbers, so a widened slot type shows up here too.
    expect(inRange.slot).toBe(6);
    expect([outOfRange.slot as number, zero as number]).toEqual([7, 0]);
    expect(CHART_SLOTS).toEqual([1, 2, 3, 4, 5, 6]);
  });
});
