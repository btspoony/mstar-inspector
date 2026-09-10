/**
 * Plan 63 T1.1: the recharts@2.15.4 static-render pin probe (AD-621
 * re-decision). recharts 3.x emits only an empty wrapper div under
 * `renderToStaticMarkup` (upstream #5997, no ETA) — this pin locks the
 * 2.15.4 face the whole plan rides on: full terminal SVG geometry renders
 * in the bun test environment (no jsdom/DOM), same source-render contract
 * as tests/spa/insights-page.test.ts.
 * It seeds the Task-2/3 pin idiom: named recharts imports, fixed
 * width/height props, `isAnimationActive={false}` on the pin path, and
 * ResponsiveContainer excluded from every render path (plan 63 B1).
 * TSX (not createElement) is deliberate: React 19 types reject recharts
 * 2.x class components through createElement's overloads (wide string
 * defaultProps), while JSX resolution accepts them — this is also the
 * exact consumption form Tasks 2-3 ship in product code.
 *
 * The one pinned class name (`recharts-surface`) is a recharts 2.15.4
 * internal: this probe guards render shape, not class names — a recharts
 * upgrade re-verifies the chart pins (tests/spa/charts.test.ts, which
 * pins the recharts-rectangle / recharts-label-list internals).
 */
import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { BarChart, Bar, XAxis, YAxis } from "recharts";

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

describe("recharts pin probe (plan 63 T1.1)", () => {
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
