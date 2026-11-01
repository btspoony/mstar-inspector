/**
 * The chart fill contrast link — WCAG 1.4.11's 3:1 bar for a chart fill.
 *
 * `I-000232` was reported once before and closed on an arithmetic error, so
 * the guard is pinned twice over: the shipped ratios are read through
 * `resolveTheme` (the same import the gate uses, never a copied table), and a
 * muted fill must produce the failure list the gate exits non-zero on.
 */
import { describe, expect, test } from "bun:test";

import { resolveTheme, type ThemeName } from "../../src/design-system/tokens";
import {
  CHART_CONTRAST_MIN,
  CHART_PAIRS,
  chartContrastFailures,
  chartFillContrast,
} from "../../scripts/design-system-check";

const shipped = chartFillContrast((theme) => resolveTheme(theme).semantic);

const measure = (theme: ThemeName, fill: string, backdrop: string): number => {
  const found = shipped.find((m) => m.theme === theme && m.fill === fill && m.backdrop === backdrop);
  if (found === undefined) throw new Error(`${theme} ${fill} on ${backdrop} is not a declared pairing`);
  return found.ratio;
};

describe("chart fill contrast", () => {
  test("every declared pairing clears 3:1 in the shipped tokens", () => {
    expect(shipped).toHaveLength(CHART_PAIRS.length);
    expect(chartContrastFailures(shipped)).toEqual([]);
  });

  test("dark chart-5 clears 3:1 on page, card and inset — the pairing I-000232 measured below the bar", () => {
    for (const backdrop of ["surface-page", "surface-card", "surface-inset"]) {
      expect(measure("dark", "chart-5", backdrop), `dark chart-5 on ${backdrop}`).toBeGreaterThanOrEqual(
        CHART_CONTRAST_MIN,
      );
    }
    // The margin the lift bought: the inset face is the tightest at 3.020:1,
    // where the shared #2563a8 measured 2.696:1.
    expect(measure("dark", "chart-5", "surface-inset")).toBeCloseTo(3.02, 2);
  });

  test("a muted fill fails the check — the mutated input the gate exits non-zero on", () => {
    const muted = chartFillContrast((theme) => ({
      ...resolveTheme(theme).semantic,
      "chart-5": "#1c4a80",
    }));
    // Same hue family, darker: below the bar on all three dark surfaces, while
    // the light page still clears it — so the failure names the pairs.
    expect(
      chartContrastFailures(muted).map(({ theme, fill, backdrop }) => `${theme}:${fill}@${backdrop}`),
    ).toEqual(["dark:chart-5@surface-page", "dark:chart-5@surface-card", "dark:chart-5@surface-inset"]);
  });

  test("a removed fill refuses to measure instead of passing on an empty list", () => {
    const withoutChart5 = (theme: ThemeName) =>
      Object.fromEntries(
        Object.entries(resolveTheme(theme).semantic).filter(([name]) => name !== "chart-5"),
      );
    expect(() => chartFillContrast(withoutChart5)).toThrow("chart-5 is not a dark semantic token");
  });

  test("the thin pairs are measured, so an eroding margin is a visible diff", () => {
    // The two thinnest declared pairs after the lift: light chart-3 (3.186:1 on
    // the page white) and dark chart-5 on the page canvas (3.580:1).
    expect(measure("light", "chart-3", "surface-page")).toBeCloseTo(3.186, 2);
    expect(measure("dark", "chart-5", "surface-page")).toBeCloseTo(3.58, 2);
  });
});
