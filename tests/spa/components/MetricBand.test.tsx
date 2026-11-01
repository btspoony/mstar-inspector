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
import { DANGER_FG, slotTags, textColourOf } from "../../helpers/token-colour";

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

describe("MetricBand tone channel (compass D4)", () => {
  test("a caller-supplied danger tone paints the value face in the alert colour", () => {
    const html = render([{ key: "24h rejected", value: 2, tone: "danger" }]);
    const [value = ""] = slotTags(html, "metric-value");
    expect(textColourOf(value)).toBe(DANGER_FG);
    // The key stays the quiet label (`text-faint`); the alert belongs to the
    // figure alone.
    const [key = ""] = slotTags(html, "metric-key");
    expect(textColourOf(key)).not.toBe(DANGER_FG);
  });

  test("a neutral entry renders the markup it always did — the field is additive", () => {
    // Byte-for-byte, not a spot check: the same figures with the tone channel
    // present-but-absent must equal the pre-tone face exactly. A zero refused
    // count is a neutral entry (zero refusals is healthy, not a warning).
    const viaChannel: Metric[] = [
      { key: "Apps", value: 3 },
      { key: "Review off", value: 1 },
      { key: "24h rejected", value: 0, tone: undefined },
    ];
    const toneFree: Metric[] = [
      { key: "Apps", value: 3 },
      { key: "Review off", value: 1 },
      { key: "24h rejected", value: 0 },
    ];
    expect(render(viaChannel)).toBe(render(toneFree));
    for (const face of slotTags(render(viaChannel), "metric-value")) {
      expect(textColourOf(face)).toBeNull();
    }
  });

  test("the band never infers badness from a figure", () => {
    // Danger is the caller's statement about what a number MEANS. The band
    // cannot know that a big figure is a bad one, so it never guesses.
    for (const face of slotTags(render([{ key: "24h rejected", value: 4321 }]), "metric-value")) {
      expect(textColourOf(face)).toBeNull();
    }
  });
});
