/**
 * the recharts@2.15.4 static-render pin probe (AD-621
 * re-decision). recharts 3.x emits only an empty wrapper div under
 * `renderToStaticMarkup` (upstream #5997, no ETA) — this pin locks the
 * 2.15.4 face the whole plan rides on: full terminal SVG geometry renders
 * in the bun test environment (no jsdom/DOM), same source-render contract
 * as tests/spa/insights-page.test.ts.
 * It seeds the Task-2/3 pin idiom: named recharts imports, fixed
 * width/height props, `isAnimationActive={false}` on the pin path, and
 * ResponsiveContainer excluded from every render path.
 * TSX (not createElement) is deliberate: React 19 types reject recharts
 * 2.x class components through createElement's overloads (wide string
 * defaultProps), while JSX resolution accepts them — this is also the
 * exact consumption form Tasks 2-3 ship in product code.
 *
 * The one pinned class name (`recharts-surface`) is a recharts 2.15.4
 * internal: this probe guards render shape, not class names — a recharts
 * upgrade re-verifies the chart pins (tests/spa/charts.test.ts, which
 * pins the recharts-rectangle / recharts-label-list internals).
 *
 * v0.3.4 round (2026-09-16): the chart width pin — the static/SSR face
 * renders at the designed fixed 560 default (useContainerWidth never
 * measures server-side), and the measured-width wiring is pinned at the
 * hook level with a stubbed ResizeObserver (no DOM runner in this suite;
 * the repo has none by contract).
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BarChart, Bar, XAxis, YAxis } from "recharts";
import { TrendChart, type TrendPoint } from "../../src/spa/components/charts/TrendChart";
import {
  attachWidthObserver,
  DEFAULT_CHART_WIDTH,
} from "../../src/spa/components/charts/useContainerWidth";
import {
  insightsTrendPoints,
  type InsightsSummary,
  type InsightsTrendPoint,
} from "../../src/spa/pages/data";

const DATA = [
  { name: "must-fix", count: 7 },
  { name: "should-fix", count: 5 },
  { name: "nit", count: 3 },
];

const renderBar = () =>
  renderToStaticMarkup(
    <BarChart width={520} height={200} data={DATA}>
      <XAxis dataKey="name" />
      <YAxis allowDecimals={false} />
      <Bar dataKey="count" isAnimationActive={false} />
    </BarChart>,
  );

/**
 * Real series geometry = a rect whose x/y are present (any coordinate) and
 * whose height is a positive integer — a zero-height rect is the animation
 * initial-frame / empty-data face this pin exists to exclude.
 */
const geometryRects = (html: string): string[] =>
  (html.match(/<rect\b[^>]*>/g) ?? []).filter(
    (rect) => /\bx="\d+"/.test(rect) && /\by="\d+"/.test(rect) && /\bheight="[1-9]\d*"/.test(rect),
  );

describe("recharts pin probe", () => {
  test("static render emits the full-size chart surface (never the 3.x empty-wrapper face)", () => {
    const html = renderBar();
    expect(html).toContain('class="recharts-surface" width="520" height="200"');
    expect(html).toContain('viewBox="0 0 520 200"');
    // The 3.x failure shape, byte-for-byte excluded: an empty wrapper div
    // with no <svg> at all.
    expect(html).toContain("<svg");
  });

  test("bars render as real series geometry — rect with non-empty x/y/height and data-driven labels", () => {
    const html = renderBar();
    expect(geometryRects(html).length).toBeGreaterThanOrEqual(1);
    // The datum flowed the full pipeline: category labels render as axis
    // tick text, not just geometry from nowhere.
    expect(html).toContain("must-fix");
    expect(html).toContain("should-fix");
    expect(html).toContain("nit");
  });

  test("the pin path never routes through ResponsiveContainer — fixed dimensions only", () => {
    const html = renderBar();
    // Kebab-case only: recharts 3.x's empty-wrapper face carries a
    // responsive-container class; the camelCase component name can never
    // appear in markup (tautological — dropped, qc3-S-4).
    expect(html).not.toContain("responsive-container");
  });
});

describe("measured-width pin (v0.3.4 — true-size chart rendering)", () => {
  const points: TrendPoint[] = [
    { week: "2026-08-17", reviews: 1, findings: 2 },
    { week: "2026-08-24", reviews: 3, findings: 4 },
  ];

  test("the static/SSR face renders at the fixed 560 default — no viewBox upscale", () => {
    // Server render never measures (no effects run, ResizeObserver is not
    // consulted): the designed 560×166 face the geometry pins ride.
    expect(DEFAULT_CHART_WIDTH).toBe(560);
    const html = renderToStaticMarkup(
      <TrendChart
        points={points}
        seriesLabels={{ reviews: "Reviews", findings: "Findings" }}
        ariaLabel="Weekly trend"
      />,
    );
    expect(html).toContain('width="560"');
    expect(html).toContain('height="166"');
    expect(html).toContain('viewBox="0 0 560 166"');
  });

  /** Minimal ResizeObserver stub — records the observed target and calls. */
  class StubResizeObserver {
    static instances: StubResizeObserver[] = [];
    callback: ResizeObserverCallback;
    observed: Element | null = null;
    disconnects = 0;
    constructor(callback: ResizeObserverCallback) {
      this.callback = callback;
      StubResizeObserver.instances.push(this);
    }
    observe(target: Element) {
      this.observed = target;
    }
    unobserve() {}
    disconnect() {
      this.disconnects += 1;
    }
  }

  test("attachWidthObserver reports the measured container width through the stubbed ResizeObserver", () => {
    const original = globalThis.ResizeObserver;
    globalThis.ResizeObserver = StubResizeObserver as unknown as typeof ResizeObserver;
    try {
      StubResizeObserver.instances = [];
      const reported: number[] = [];
      const el = { nodeType: 1 } as unknown as HTMLElement;
      const detach = attachWidthObserver(el, (w) => reported.push(w));

      // The container is observed exactly once.
      const stub = StubResizeObserver.instances.at(-1)!;
      expect(stub.observed).toBe(el);

      // A real reading flows through, rounded to whole pixels.
      stub.callback([{ contentRect: { width: 943.6, height: 166 } } as ResizeObserverEntry], stub);
      expect(reported).toEqual([944]);
      // A zero reading (hidden/detached container) is ignored — the face holds.
      stub.callback([{ contentRect: { width: 0 } } as ResizeObserverEntry], stub);
      expect(reported).toEqual([944]);

      detach();
      expect(stub.disconnects).toBe(1);
    } finally {
      globalThis.ResizeObserver = original;
    }
  });

  test("no ResizeObserver (SSR face, old webviews) keeps the default face — wiring no-ops", () => {
    const original = globalThis.ResizeObserver;
    delete (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
    try {
      StubResizeObserver.instances = [];
      const reported: number[] = [];
      const detach = attachWidthObserver({ nodeType: 1 } as unknown as HTMLElement, (w) => reported.push(w));
      expect(typeof detach).toBe("function");
      expect(() => detach()).not.toThrow();
      expect(StubResizeObserver.instances).toHaveLength(0);
      expect(reported).toEqual([]);
    } finally {
      globalThis.ResizeObserver = original;
    }
  });
});

/**
 * Window-bucketing contract (2026-09-20) — the trend card's buckets:
 * `insightsTrendPoints` picks the source per window (day windows read the
 * zero-filled `daily_trend`; week windows zero-fill the frozen
 * `weekly_trend` over the `findings_distribution` grid) and the chart
 * statically renders those points at the designed fixed size.
 */
const trendFixture = (overrides: Partial<InsightsSummary>): InsightsSummary => ({
  window_days: 30,
  repo: "",
  reviews_total: 5,
  findings_by_severity: [],
  findings_by_category: [],
  verdict_distribution: [],
  weekly_trend: [],
  daily_trend: [],
  findings_distribution: [],
  recurring_top: [],
  ...overrides,
});

/** A 30-day window: the zero-filled day grid rides `daily_trend` (weekly_trend present but ignored). */
const DAY_WINDOW = trendFixture({
  window_days: 30,
  weekly_trend: [{ week_start: "2026-01-05", reviews: 99, findings: 99 }],
  daily_trend: [
    { day_start: "2026-09-08", reviews: 2, findings: 1 },
    { day_start: "2026-09-09", reviews: 0, findings: 0 },
    { day_start: "2026-09-10", reviews: 3, findings: 2 },
  ],
});

/** A 90-day window: raw `weekly_trend` buckets + the distribution week grid with an empty middle week. */
const WEEK_WINDOW = trendFixture({
  window_days: 90,
  weekly_trend: [
    { week_start: "2026-08-31", reviews: 4, findings: 3 },
    { week_start: "2026-09-14", reviews: 1, findings: 0 },
  ],
  findings_distribution: [
    {
      bucket_start: "2026-08-31",
      granularity: "week",
      by_severity: { "must-fix": 2, "should-fix": 1, nit: 0 },
      by_category: { DEBT: 3 },
    },
    { bucket_start: "2026-09-07", granularity: "week", by_severity: {}, by_category: {} },
    {
      bucket_start: "2026-09-14",
      granularity: "week",
      by_severity: { "must-fix": 1, "should-fix": 0, nit: 0 },
      by_category: { DEBT: 1 },
    },
  ],
});

describe("insightsTrendPoints (window-bucketing contract)", () => {
  test("day windows (clamped <= 30) map daily_trend directly — weekly_trend is ignored", () => {
    expect(insightsTrendPoints(DAY_WINDOW)).toEqual([
      { bucket_start: "2026-09-08", reviews: 2, findings: 1 },
      { bucket_start: "2026-09-09", reviews: 0, findings: 0 },
      { bucket_start: "2026-09-10", reviews: 3, findings: 2 },
    ]);
  });

  test("week windows (31–90) zero-fill weekly_trend over the findings_distribution grid", () => {
    const points = insightsTrendPoints(WEEK_WINDOW);
    // Same bucket count as the stacked charts; the empty week renders as a
    // 0/0 bucket, covered weeks overlay their counts, grid order rules.
    expect(points).toHaveLength(WEEK_WINDOW.findings_distribution.length);
    expect(points).toEqual([
      { bucket_start: "2026-08-31", reviews: 4, findings: 3 },
      { bucket_start: "2026-09-07", reviews: 0, findings: 0 },
      { bucket_start: "2026-09-14", reviews: 1, findings: 0 },
    ]);
  });

  test("the > 30 predicate mirrors the store's granularity derivation — sources never mix", () => {
    // 30 on week-shaped data → day path (daily_trend) — the weekly rows
    // and grid never leak into a day window.
    expect(insightsTrendPoints({ ...WEEK_WINDOW, window_days: 30 })).toEqual([]);
    // 31 (legal direct-URL window) on day-shaped data → week path (the
    // grid) — the daily rows never leak into a week window.
    expect(insightsTrendPoints({ ...DAY_WINDOW, window_days: 31 })).toEqual([]);
  });
});

describe("trend card static render (day and week window faces)", () => {
  // The exact consumption form AppInsightsTab ships: helper output mapped
  // onto TrendPoint (the `week` field carries the bucket start).
  const renderTrend = (points: InsightsTrendPoint[]) =>
    renderToStaticMarkup(
      <TrendChart
        points={points.map((row) => ({ week: row.bucket_start, reviews: row.reviews, findings: row.findings }))}
        seriesLabels={{ reviews: "Reviews", findings: "Findings" }}
        ariaLabel="Trend"
      />,
    );

  test("day-window face: fixed-size static chart, real geometry, no ResponsiveContainer", () => {
    const html = renderTrend(insightsTrendPoints(DAY_WINDOW));
    expect(html).toContain('width="560"');
    expect(html).toContain('height="166"');
    expect(html).toContain('viewBox="0 0 560 166"');
    expect(html).not.toContain("responsive-container");
    expect(geometryRects(html).length).toBeGreaterThanOrEqual(1);
    // The zero-findings day keeps its grid slot on the pinned M/D axis —
    // tick text even without positive-height bars.
    expect(html).toContain("9/9");
  });

  test("week-window face: the zero-filled empty week stays on the axis at fixed size", () => {
    const html = renderTrend(insightsTrendPoints(WEEK_WINDOW));
    expect(html).toContain('width="560"');
    expect(html).toContain('height="166"');
    expect(html).not.toContain("responsive-container");
    expect(geometryRects(html).length).toBeGreaterThanOrEqual(1);
    // The 0/0 empty week keeps its grid slot (time continuity) — labeled,
    // while only covered weeks contribute geometry.
    expect(html).toContain("9/7");
  });
});
