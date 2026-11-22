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
    expect(measure("dark", "chart-5", "surface-inset")).toBeCloseTo(3.02, 2);
  });

  test("a muted fill fails the check — the mutated input the gate exits non-zero on", () => {
    const muted = chartFillContrast((theme) => ({
      ...resolveTheme(theme).semantic,
      "chart-5": "#1c4a80",
    }));
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
    expect(measure("light", "chart-3", "surface-page")).toBeCloseTo(3.186, 2);
    expect(measure("dark", "chart-5", "surface-page")).toBeCloseTo(3.58, 2);
  });
});
