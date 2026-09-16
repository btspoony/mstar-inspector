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
