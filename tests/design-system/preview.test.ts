/**
 * The preview page contract.
 *
 * The page has no template beside its generator, so the only thing that can
 * fail it is its own coverage check. These assertions are the parts a check
 * run cannot state by itself:
 *
 * 1. **Every declared token is on the page, in both themes, at its resolved
 *    value.** That is what makes the page a gate rather than a brochure.
 * 2. **The gate has teeth.** Removing one entry, or printing a value the
 *    source does not hold, must fail — otherwise the check passes on a page
 *    that shows nothing, and no one finds out.
 * 3. **The grid faces the brief names are all there**: tone × strength, the
 *    control heights, the operator-surface remap.
 * 4. **Every exported component is accounted for, in both tiers** the barrel
 *    re-exports: a specimen per export, and every export either paints its own
 *    `data-slot` or is declared unpaintable (a Radix portal or a context root)
 *    with its reason — so a `patterns/` export cannot ship unexercised while
 *    only `primitives/` is enumerated.
 */
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
    // Five meanings × three strengths × two themes.
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
    // The two themes must not print the same surface colour: a page that
    // resolved both sections against one theme would still pass a name count.
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
    // Derivation lists a new token automatically, so the family is the only
    // thing that can catch a token the page has no way to show. This asserts
    // the generator covers the whole declared vocabulary, and that an
    // unclassified name is reported rather than passed as plain text.
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
    // The component section closes in three directions at once: one specimen
    // per export, in either tier; every export either paints its own slot or
    // is declared unpaintable with a reason; nothing declared outlives its
    // export.
    const coverage = previewCoverage(html);
    expect(coverage.specimens).toBe(coverage.expectedSpecimens);
    expect(coverage.expectedSpecimens).toBe(34);
    expect(coverage.painted).toBe(coverage.expectedPainted);
    expect(coverage.unpainted).toBe(coverage.expectedUnpainted);
    // The count it compares is non-zero in both directions, so a page that
    // rendered nothing could not pass as "everything is declared".
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
    // Drop ToggleGroup's own slot: the export is still in the tier barrel, so
    // the page owes either markup or a reason — and it now gives neither.
    const stripped = html.split('data-slot="toggle-group"').join('data-slot="toggle-group-removed"');
    expect(stripped).not.toBe(html);

    const coverage = previewCoverage(stripped);
    expect(coverage.ok).toBe(false);
    expect(coverage.missing).toContain(
      "dark: ToggleGroup neither paints its own slot nor is declared in UNPAINTED",
    );
  });

  test("the export loop closes over the patterns tier too", () => {
    // Same contract one tier up: FlowSection is a `patterns/` export, so a
    // ledger that enumerated `primitives/` alone would let this through.
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
