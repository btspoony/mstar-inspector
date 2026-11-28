import { afterAll, describe, expect, test } from "bun:test";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { installDom } from "./dom";
import type { InsightsSummary, InsightsTrendPoint } from "../../src/spa/pages/data";

// recharts 3 reads its SSR flag when the module is imported and renders an
// empty wrapper until a layout effect reports the chart size. Mount in the
// browser-facing DOM path instead: install the DOM first, then import.
const { win, cleanup } = installDom("http://localhost/");
afterAll(cleanup);

const { BarChart, Bar, XAxis, YAxis } = await import("recharts");
const { TrendChart } = await import("../../src/spa/components/charts/TrendChart");
const { attachWidthObserver, DEFAULT_CHART_WIDTH } = await import(
  "../../src/spa/components/charts/useContainerWidth"
);
const { insightsTrendPoints } = await import("../../src/spa/pages/data");

const DATA = [
  { name: "must-fix", count: 7 },
  { name: "should-fix", count: 5 },
  { name: "nit", count: 3 },
];

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

const renderBar = () =>
  mount(
    createElement(
      BarChart,
      { width: 520, height: 200, data: DATA },
      createElement(XAxis, { dataKey: "name" }),
      createElement(YAxis, { allowDecimals: false }),
      createElement(Bar, { dataKey: "count", isAnimationActive: false }),
    ),
  );

const geometryRects = (html: string): string[] =>
  (html.match(/<path\b[^>]*>/g) ?? []).filter((rect) => {
    const y = /\by="([0-9.]+)"/.exec(rect)?.[1];
    const height = /\bheight="([0-9.]+)"/.exec(rect)?.[1];
    return y !== undefined && height !== undefined && Number(height) > 0;
  });

describe("recharts chart surface (client face)", () => {
  test("renders the full-size chart surface, never the empty-wrapper face", async () => {
    const html = await renderBar();
    expect(html).toContain('class="recharts-surface" width="520" height="200"');
    expect(html).toContain('viewBox="0 0 520 200"');
    expect(html).toContain("<svg");
  });

  test("bars render as real series geometry — path with non-empty x/y/height and data-driven labels", async () => {
    const html = await renderBar();
    expect(geometryRects(html).length).toBeGreaterThanOrEqual(1);
    expect(html).toContain("must-fix");
    expect(html).toContain("should-fix");
    expect(html).toContain("nit");
  });

  test("the pin path never routes through ResponsiveContainer — fixed dimensions only", async () => {
    const html = await renderBar();
    expect(html).not.toContain("responsive-container");
  });
});

describe("measured-width pin (v0.3.4 — true-size chart rendering)", () => {
  const points: { week: string; reviews: number; findings: number }[] = [
    { week: "2026-08-17", reviews: 1, findings: 2 },
    { week: "2026-08-24", reviews: 3, findings: 4 },
  ];

  test("the default face renders at the fixed 560 width — no viewBox upscale", async () => {
    expect(DEFAULT_CHART_WIDTH).toBe(560);
    const html = await mount(
      createElement(TrendChart, {
        points,
        seriesLabels: { reviews: "Reviews", findings: "Findings" },
        ariaLabel: "Weekly trend",
      }),
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

  test("no ResizeObserver (old webviews) keeps the default face — wiring no-ops", () => {
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

describe("trend card client render (day and week window faces)", () => {
  const renderTrend = (points: InsightsTrendPoint[]) =>
    mount(
      createElement(TrendChart, {
        points: points.map((row) => ({ week: row.bucket_start, reviews: row.reviews, findings: row.findings })),
        seriesLabels: { reviews: "Reviews", findings: "Findings" },
        ariaLabel: "Trend",
      }),
    );

  test("day-window face: fixed-size chart, real geometry, no ResponsiveContainer", async () => {
    const html = await renderTrend(insightsTrendPoints(DAY_WINDOW));
    expect(html).toContain('width="560"');
    expect(html).toContain('height="166"');
    expect(html).toContain('viewBox="0 0 560 166"');
    expect(html).not.toContain("responsive-container");
    expect(geometryRects(html).length).toBeGreaterThanOrEqual(1);
    expect(html).toContain("9/9");
  });

  test("week-window face: the zero-filled empty week stays on the axis at fixed size", async () => {
    const html = await renderTrend(insightsTrendPoints(WEEK_WINDOW));
    expect(html).toContain('width="560"');
    expect(html).toContain('height="166"');
    expect(html).not.toContain("responsive-container");
    expect(geometryRects(html).length).toBeGreaterThanOrEqual(1);
    expect(html).toContain("9/7");
  });
});
