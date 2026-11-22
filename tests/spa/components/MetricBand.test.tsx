import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { MetricBand, type Metric } from "../../../src/spa/components/MetricBand";
import { dangerFg, slotTags, textColourOf } from "../../helpers/token-colour";

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
    const cells = [...html.matchAll(/data-slot="metric-key"[^>]*>([^<]*)<\/span><span data-slot="metric-value"[^>]*>([^<]*)</g)];
    expect(cells.map((cell) => [cell[1], cell[2]])).toEqual(
      four.map((metric) => [String(metric.key), String(metric.value)]),
    );
  });

  test("four metrics render four separators, not five", () => {
    const html = render(four);
    expect(separators(html)).toHaveLength(4);
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
    expect(textColourOf(value, "light")).toBe(dangerFg("light"));
    const [key = ""] = slotTags(html, "metric-key");
    expect(textColourOf(key, "light")).not.toBe(dangerFg("light"));
  });

  test("a neutral entry renders the markup it always did — the field is additive", () => {
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
      expect(textColourOf(face, "light")).toBeNull();
    }
  });

  test("the band never infers badness from a figure", () => {
    for (const face of slotTags(render([{ key: "24h rejected", value: 4321 }]), "metric-value")) {
      expect(textColourOf(face, "light")).toBeNull();
    }
  });
});
