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

const geometryRects = (html: string): string[] =>
  (html.match(/<rect\b[^>]*>/g) ?? []).filter(
    (rect) => /\bx="\d+"/.test(rect) && /\by="\d+"/.test(rect) && /\bheight="[1-9]\d*"/.test(rect),
  );

describe("recharts pin probe", () => {
  test("static render emits the full-size chart surface (never the 3.x empty-wrapper face)", () => {
    const html = renderBar();
    expect(html).toContain('class="recharts-surface" width="520" height="200"');
    expect(html).toContain('viewBox="0 0 520 200"');
    expect(html).toContain("<svg");
  });

  test("bars render as real series geometry — rect with non-empty x/y/height and data-driven labels", () => {
    const html = renderBar();
    expect(geometryRects(html).length).toBeGreaterThanOrEqual(1);
    expect(html).toContain("must-fix");
    expect(html).toContain("should-fix");
    expect(html).toContain("nit");
  });

  test("the pin path never routes through ResponsiveContainer — fixed dimensions only", () => {
    const html = renderBar();
    expect(html).not.toContain("responsive-container");
  });
});

describe("measured-width pin (v0.3.4 — true-size chart rendering)", () => {
  const points: TrendPoint[] = [
    { week: "2026-08-17", reviews: 1, findings: 2 },
    { week: "2026-08-24", reviews: 3, findings: 4 },
  ];

  test("the static/SSR face renders at the fixed 560 default — no viewBox upscale", () => {
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

      const stub = StubResizeObserver.instances.at(-1)!;
      expect(stub.observed).toBe(el);

      stub.callback([{ contentRect: { width: 943.6, height: 166 } } as ResizeObserverEntry], stub);
      expect(reported).toEqual([944]);
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

const trendFixture = (overrides: Partial<InsightsSummary>): InsightsSummary => ({
  window_days: 30,
  repo: "",
  reviews_total: 5,
  findings_by_severity: [],
  verdict_distribution: [],
  weekly_trend: [],
  daily_trend: [],
  findings_distribution: [],
  ...overrides,
});

const DAY_WINDOW = trendFixture({
  window_days: 30,
  weekly_trend: [{ week_start: "2026-01-05", reviews: 99, findings: 99 }],
  daily_trend: [
    { day_start: "2026-09-08", reviews: 2, findings: 1 },
    { day_start: "2026-09-09", reviews: 0, findings: 0 },
    { day_start: "2026-09-10", reviews: 3, findings: 2 },
  ],
});

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
    },
    { bucket_start: "2026-09-07", granularity: "week", by_severity: {} },
    {
      bucket_start: "2026-09-14",
      granularity: "week",
      by_severity: { "must-fix": 1, "should-fix": 0, nit: 0 },
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
    expect(points).toHaveLength(WEEK_WINDOW.findings_distribution.length);
    expect(points).toEqual([
      { bucket_start: "2026-08-31", reviews: 4, findings: 3 },
      { bucket_start: "2026-09-07", reviews: 0, findings: 0 },
      { bucket_start: "2026-09-14", reviews: 1, findings: 0 },
    ]);
  });

  test("the > 30 predicate mirrors the store's granularity derivation — sources never mix", () => {
    expect(insightsTrendPoints({ ...WEEK_WINDOW, window_days: 30 })).toEqual([]);
    expect(insightsTrendPoints({ ...DAY_WINDOW, window_days: 31 })).toEqual([]);
  });
});

describe("trend card static render (day and week window faces)", () => {
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
    expect(html).toContain("9/9");
  });

  test("week-window face: the zero-filled empty week stays on the axis at fixed size", () => {
    const html = renderTrend(insightsTrendPoints(WEEK_WINDOW));
    expect(html).toContain('width="560"');
    expect(html).toContain('height="166"');
    expect(html).not.toContain("responsive-container");
    expect(geometryRects(html).length).toBeGreaterThanOrEqual(1);
    expect(html).toContain("9/7");
  });
});
