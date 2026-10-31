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

  test("names its generator, so a hand edit is visible", () => {
    expect(html).toContain("GENERATED — do not edit.");
    expect(html).toContain("bun scripts/build-design-preview.ts");
  });
});
