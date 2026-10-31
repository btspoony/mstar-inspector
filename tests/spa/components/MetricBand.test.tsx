/**
 * MetricBand — the r3 metric strip (compass D4): quiet keys over tabular
 * figures, separated by hairlines that are rendered separators rather than
 * borders, so the rule count is a markup fact. Four metrics therefore render
 * four rules (the header rule plus the three between them) — never five: a
 * closing edge separator would be the off-by-one this contract exists to rule
 * out.
 *
 * Static render: metrics are props, no hooks, no live browser.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MetricBand, type Metric } from "../../../src/spa/components/MetricBand";

const render = (metrics: readonly Metric[]) =>
  renderToStaticMarkup(createElement(MetricBand, { metrics }));

const separators = (html: string) => html.match(/data-slot="separator"/g) ?? [];

const four: Metric[] = [
  { key: "Apps", value: 3 },
  { key: "Enabled", value: 2 },
  { key: "Review off", value: 1 },
  { key: "24h rejected", value: 2 },
];

describe("MetricBand", () => {
  test("renders each metric's key and value, in order", () => {
    const html = render(four);
    expect(html.match(/data-slot="metric"/g)).toHaveLength(4);
    expect(html.match(/data-slot="metric-key"/g)).toHaveLength(4);
    expect(html.match(/data-slot="metric-value"/g)).toHaveLength(4);
    // Rendered in input order, key before its value in each cell.
    const cells = [...html.matchAll(/data-slot="metric-key"[^>]*>([^<]*)<\/span><span data-slot="metric-value"[^>]*>([^<]*)</g)];
    expect(cells.map((cell) => [cell[1], cell[2]])).toEqual(
      four.map((metric) => [String(metric.key), String(metric.value)]),
    );
  });

  test("four metrics render four separators, not five", () => {
    const html = render(four);
    expect(separators(html)).toHaveLength(4);
    // One header rule plus one between each adjacent pair; no closing edge.
    expect(html.match(/data-orientation="horizontal"/g)).toHaveLength(1);
    expect(html.match(/data-orientation="vertical"/g)).toHaveLength(3);
  });

  test("a single metric is one rule — nothing to divide", () => {
    const html = render([{ key: "Apps", value: 3 }]);
    expect(separators(html)).toHaveLength(1);
    expect(html).not.toContain('data-orientation="vertical"');
  });

  test("no metrics render no band", () => {
    expect(render([])).toBe("");
  });
});
