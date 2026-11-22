import { describe, expect, test } from "bun:test";

import { THEMES, resolveTheme, tokenNames } from "../../src/design-system/tokens";
import { buildPreview, previewCoverage, specimenOf } from "../../scripts/build-design-preview";

const html = buildPreview();

describe("design-system preview", () => {
  test("covers every token in every theme at its resolved value", () => {
    const coverage = previewCoverage(html);
    expect(coverage.missing).toEqual([]);
    expect(coverage.wrong).toEqual([]);
    expect(coverage.entries).toBe(coverage.expectedEntries);
    expect(coverage.expectedEntries).toBe(
      (tokenNames().primitive.length + tokenNames().semantic.length + tokenNames().component.length) *
        THEMES.length,
    );
  });

  test("covers every tone × strength, control height and operator-surface remap", () => {
    const coverage = previewCoverage(html);
    expect(coverage.tonePairs).toBe(coverage.expectedTonePairs);
    expect(coverage.controlHeights).toBe(coverage.expectedControlHeights);
    expect(coverage.remaps).toBe(coverage.expectedRemaps);
    expect(coverage.expectedTonePairs).toBe(30);
    expect(coverage.expectedControlHeights).toBe(6);
  });

  test("renders one section per theme, carrying that theme's own values", () => {
    for (const theme of THEMES) {
      const open = html.indexOf(`<!-- theme:${theme} -->`);
      const close = html.indexOf(`<!-- /theme:${theme} -->`);
      expect(open, `${theme} section`).toBeGreaterThan(-1);
      expect(close).toBeGreaterThan(open);
    }
    const page = resolveTheme("dark").semantic["surface-page"];
    const light = resolveTheme("light").semantic["surface-page"];
    expect(page).not.toBe(light);
    expect(html).toContain(`data-token="surface-page" data-value="${page}"`);
    expect(html).toContain(`data-token="surface-page" data-value="${light}"`);
  });

  test("fails when a token has no entry on the page", () => {
    const dropped = html.replace(
      /<tr data-layer="semantic" data-token="spacing-4"[^>]*>[\s\S]*?<\/tr>/,
      "",
    );
    expect(dropped).not.toBe(html);

    const coverage = previewCoverage(dropped);
    expect(coverage.ok).toBe(false);
    expect(coverage.missing).toContain("dark: no entry for semantic/spacing-4");
  });

  test("has a specimen family for every token the source declares", () => {
    const names = tokenNames();
    const unclassified = names.primitive
      .concat(names.semantic, names.component)
      .filter((name) => specimenOf(name, resolveTheme("dark").semantic[name] ?? "#000000") === undefined);
    expect(unclassified).toEqual([]);

    expect(specimenOf("opacity-overlay", "0.5")).toBeUndefined();
  });

  test("fails when a token is drawn with the wrong specimen", () => {
    const swapped = html.replace(
      'data-token="spacing-4" data-value="16px" data-specimen="spacing"',
      'data-token="spacing-4" data-value="16px" data-specimen="paint"',
    );
    expect(swapped).not.toBe(html);

    const coverage = previewCoverage(swapped);
    expect(coverage.ok).toBe(false);
    expect(coverage.missing).toContain(
      "dark semantic/spacing-4 is shown as paint, but its family is spacing",
    );
  });

  test("fails when an entry prints a value the source does not hold", () => {
    const resolved = resolveTheme("dark").semantic["spacing-4"] as string;
    const stale = html.replace(
      `data-token="spacing-4" data-value="${resolved}"`,
      'data-token="spacing-4" data-value="15px"',
    );
    expect(stale).not.toBe(html);

    const coverage = previewCoverage(stale);
    expect(coverage.ok).toBe(false);
    expect(coverage.wrong).toContainEqual({
      entry: "dark semantic/spacing-4",
      page: "15px",
      source: resolved,
    });
  });

  test("fails when a tone × strength specimen is missing", () => {
    const dropped = html.split('data-tone="warn" data-strength="solid"').join("data-tone-dropped");
    const coverage = previewCoverage(dropped);
    expect(coverage.ok).toBe(false);
    expect(coverage.missing).toContain("light: no specimen for warn × solid");
  });

  test("carries a specimen for every exported component, and accounts for the impaintable ones", () => {
    const coverage = previewCoverage(html);
    expect(coverage.specimens).toBe(coverage.expectedSpecimens);
    expect(coverage.expectedSpecimens).toBe(34);
    expect(coverage.painted).toBe(coverage.expectedPainted);
    expect(coverage.unpainted).toBe(coverage.expectedUnpainted);
    expect(coverage.expectedPainted).toBeGreaterThan(0);
    expect(coverage.expectedUnpainted).toBeGreaterThan(0);
  });

  test("fails when a primitive specimen is missing from a theme", () => {
    const dropped = html.split('data-primitive="Toggle"').join('data-primitive-dropped="Toggle"');
    expect(dropped).not.toBe(html);

    const coverage = previewCoverage(dropped);
    expect(coverage.ok).toBe(false);
    expect(coverage.missing).toContain("dark: no primitive specimen for Toggle");
  });

  test("fails when an exported component neither paints nor is declared", () => {
    const stripped = html.split('data-slot="toggle-group"').join('data-slot="toggle-group-removed"');
    expect(stripped).not.toBe(html);

    const coverage = previewCoverage(stripped);
    expect(coverage.ok).toBe(false);
    expect(coverage.missing).toContain(
      "dark: ToggleGroup neither paints its own slot nor is declared in UNPAINTED",
    );
  });

  test("the export loop closes over the patterns tier too", () => {
    const stripped = html.split('data-slot="flow-section"').join('data-slot="flow-section-removed"');
    expect(stripped).not.toBe(html);

    const coverage = previewCoverage(stripped);
    expect(coverage.ok).toBe(false);
    expect(coverage.missing).toContain(
      "dark: FlowSection neither paints its own slot nor is declared in UNPAINTED",
    );
  });

  test("names its generator, so a hand edit is visible", () => {
    expect(html).toContain("GENERATED — do not edit.");
    expect(html).toContain("bun scripts/build-design-preview.tsx");
  });
});
