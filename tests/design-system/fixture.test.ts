/**
 * The generated fixture contract (plan 201, task 4).
 *
 * The load-bearing assertions, as opposed to descriptive ones:
 *
 * 1. **The fixture covers the source.** Every name `tokenNames()` declares is
 *    present in every theme under its own layer, and the fixture declares
 *    nothing extra. That is the property the fixture exists for: the
 *    document-sync gate can only compare what the fixture carries, so a token
 *    missing here is a silent pass there.
 * 2. **It is generated, and says so.** Regenerating in-process and comparing
 *    against the committed file is the same comparison `--check` makes, so a
 *    hand edit fails the suite too.
 * 3. **The document gate has teeth.** `documentSync` must report a fixture
 *    value that disagrees with the frontmatter, and must name the token and
 *    both values — the check is only useful if its failure is readable.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { THEMES, resolveTheme, tokenNames } from "../../src/design-system/tokens";
import { documentSync, parseFixture } from "../../scripts/design-system-check";

const REPO = new URL("../../", import.meta.url).pathname;
const RAW = readFileSync(join(REPO, "src/design-system/fixture.json"), "utf8");
const FIXTURE = parseFixture(RAW);

/** The frontmatter the document gate reads, parsed through the same parser. */
function designFrontmatter(): Record<string, unknown> {
  const md = readFileSync(join(REPO, "DESIGN.md"), "utf8");
  const fenced = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(md);
  if (fenced === null) throw new Error("DESIGN.md has no `---` fenced YAML frontmatter");
  const parsed: unknown = Bun.YAML.parse(fenced[1] as string);
  if (typeof parsed !== "object" || parsed === null) throw new Error("frontmatter is not a YAML map");
  return parsed as Record<string, unknown>;
}

const LAYERS = ["primitive", "semantic", "component"] as const;

/** One fixture layer; a missing layer is a failure, never an undefined compare. */
function layerOf(theme: (typeof THEMES)[number], layer: (typeof LAYERS)[number]) {
  const tokens = FIXTURE[theme][layer];
  if (tokens === undefined) throw new Error(`fixture is missing ${theme}.${layer}`);
  return tokens;
}

describe("generated fixture", () => {
  test("is exactly what the generator produces from the current source", () => {
    const check = spawnSync("bun", ["scripts/build-fixture.ts", "--check"], { cwd: REPO, encoding: "utf8" });
    expect(check.stdout.trim(), check.stderr).toContain("matches the token source");
    expect(check.status).toBe(0);
  });

  test("names its generator and its source", () => {
    // The header is the only thing distinguishing a generated file from a
    // hand-maintained one; `--check` cannot say it for the reader.
    expect(RAW).toContain('"$generatedBy": "bun scripts/build-fixture.ts"');
    expect(RAW).toContain('"$source": "src/design-system/tokens"');
  });

  test("carries every name the source declares, per theme and per layer", () => {
    const names = tokenNames();
    expect(Object.keys(FIXTURE).sort()).toEqual([...THEMES].sort());

    for (const theme of THEMES) {
      expect(Object.keys(FIXTURE[theme]).sort(), `${theme} layers`).toEqual([...LAYERS].sort());
      for (const layer of LAYERS) {
        // Both directions: nothing dropped, nothing invented.
        expect(Object.keys(layerOf(theme, layer)).sort(), `${theme} ${layer}`).toEqual([...names[layer]].sort());
      }
    }
  });

  test("records the resolved value, not the var() reference", () => {
    // The document gate compares against frontmatter values; a `var()` in the
    // fixture could never match one.
    for (const theme of THEMES) {
      for (const layer of LAYERS) {
        for (const [name, value] of Object.entries(layerOf(theme, layer))) {
          expect(value, `${theme} ${layer}/${name}`).not.toContain("var(--");
        }
      }
    }
  });

  test("equals the live resolution of the source, theme by theme", () => {
    for (const theme of THEMES) {
      const live = resolveTheme(theme);
      for (const layer of LAYERS) expect(layerOf(theme, layer), `${theme} ${layer}`).toEqual(live[layer]);
    }
  });
});

describe("document-sync check", () => {
  test("the committed DESIGN.md is in sync with the fixture (v0.5 rewrite)", () => {
    // The v0.5 rewrite raised the document onto the fixture, so the gate is
    // green on a clean tree — pinned here so a regression fails the suite,
    // not just the local check run.
    const report = documentSync(FIXTURE, designFrontmatter());
    expect(report.ok).toBe(true);
    expect(report.divergences).toEqual([]);
    expect(report.stale).toEqual([]);
    expect(report.compared).toBeGreaterThan(0);
    // The three slotless classes stay reported with their reasons, never
    // silently dropped: 12 font/breakpoint + 10 control/row height + 66
    // component-layer tokens.
    expect(Object.keys(report.unexpressed)).toHaveLength(3);
    expect(Object.values(report.unexpressed).reduce((a, b) => a + b, 0)).toBe(88);
  });

  test("names the token and both values when a frontmatter value is doctored", () => {
    // Teeth for the disagreeing direction: corrupt one committed value and
    // the report must name the token, the path, and both values.
    const frontmatter = designFrontmatter();
    const darkColors = (frontmatter.themes as Record<string, { colors: Record<string, string> }>).dark?.colors;
    if (darkColors === undefined) throw new Error("no themes.dark.colors group to doctor");
    const doctored = structuredClone(frontmatter);
    (doctored.themes as Record<string, { colors: Record<string, string> }>).dark!.colors["surface-page"] = "#000000";

    const report = documentSync(FIXTURE, doctored);
    expect(report.ok).toBe(false);
    const hit = report.divergences.find((d) => d.at === "themes.dark.colors.surface-page");
    expect(hit).toBeDefined();
    expect(hit?.document).toBe("#000000");
    expect(hit?.fixture).toBe(darkColors["surface-page"]);
    // Nothing else moved: one doctored value is exactly one divergence.
    expect(report.divergences).toHaveLength(1);
  });

  test("names a palette step the source dropped that the document still declares", () => {
    // Teeth for the stale direction — the one the D14 reduction leaves
    // behind whenever a rewrite lags the source.
    const doctored = designFrontmatter();
    const dark = (doctored.themes as Record<string, { colors: Record<string, string> }>).dark;
    if (dark === undefined) throw new Error("no themes.dark.colors group to doctor");
    dark.colors["gray-300"] = "#212630";

    const report = documentSync(FIXTURE, doctored);
    expect(report.ok).toBe(false);
    expect(report.stale.map((s) => s.at)).toContain("themes.dark.colors.gray-300");
    expect(report.stale).toHaveLength(1);
  });

  test("the reverse sweep covers every group, not colours only", () => {
    // A retired spacing step, typography role or motion value leaves the same
    // debris a retired colour does; a colours-only sweep passes it.
    const doctored = designFrontmatter();
    (doctored.spacing as Record<string, string>)["13"] = "52px";
    (doctored.typography as Record<string, Record<string, string>>)["copy-20"] = {
      fontFamily: '"Geist Sans", sans-serif',
      fontSize: "20px",
      fontWeight: "400",
      lineHeight: "1.5",
      letterSpacing: "0",
    };
    (doctored.motion as Record<string, string>)["duration-slower"] = "400ms";

    const report = documentSync(FIXTURE, doctored);
    expect(report.ok).toBe(false);
    expect(report.stale.map((s) => s.at).sort()).toEqual([
      "motion.duration-slower",
      "spacing.13",
      "typography.copy-20.fontFamily",
      "typography.copy-20.fontSize",
      "typography.copy-20.fontWeight",
      "typography.copy-20.letterSpacing",
      "typography.copy-20.lineHeight",
    ]);
  });

  test("the two themes must agree on a theme-independent slot", () => {
    // `spacing-4` reaches `spacing.4` from both themes; the second theme's
    // value used to be dropped by the dedup, so a light-only edit passed.
    const doctored = structuredClone(FIXTURE) as Record<string, Record<string, Record<string, string>>>;
    doctored.light!.semantic!["spacing-4"] = "20px";

    const report = documentSync(doctored as unknown as typeof FIXTURE, designFrontmatter());
    expect(report.ok).toBe(false);
    expect(report.collisions).toHaveLength(1);
    expect(report.collisions[0]).toMatchObject({
      at: "spacing.4",
      first: "semantic/spacing-4 [dark]",
      firstValue: "16px",
      second: "semantic/spacing-4 [light]",
      secondValue: "20px",
    });
  });

  test("two tokens claiming one frontmatter path collide instead of skipping the second", () => {
    // The comparator's own failure mode: a path collision used to `continue`,
    // so the second claimant was never read. A primitive and a semantic that
    // route to one slot cannot both be represented by one document value.
    const doctored = structuredClone(FIXTURE) as Record<string, Record<string, Record<string, string>>>;
    doctored.dark!.primitive!["spacing-4"] = "18px";

    const report = documentSync(doctored as unknown as typeof FIXTURE, designFrontmatter());
    expect(report.ok).toBe(false);
    // The primitive claim lands first and then contests the semantic token in
    // both themes — three claims, one document slot.
    expect(report.collisions.map((c) => [c.at, c.first, c.firstValue])).toEqual([
      ["spacing.4", "primitive/spacing-4 [dark]", "18px"],
      ["spacing.4", "primitive/spacing-4 [dark]", "18px"],
    ]);
    expect(report.collisions.map((c) => c.second)).toEqual([
      "semantic/spacing-4 [dark]",
      "semantic/spacing-4 [light]",
    ]);
  });

  test("a doctored elevation entry reports exactly that divergence, and restoring it clears it", () => {
    // Proves the comparison is a real read of the document rather than a
    // constant: doctoring one shadow value adds exactly one divergence, and
    // writing the fixture's value back restores the green report.
    const frontmatter = designFrontmatter();
    const doctored = structuredClone(frontmatter);
    const pair = (doctored.elevation as Record<string, Record<string, string>>)["shadow-pop"];
    if (pair === undefined) throw new Error("no elevation.shadow-pop entry to doctor");
    const before = pair.dark;
    pair.dark = `${pair.dark} 0 0 1px #000000`;

    const doctoredReport = documentSync(FIXTURE, doctored);
    expect(doctoredReport.ok).toBe(false);
    expect(doctoredReport.divergences.map((d) => d.at)).toEqual(["elevation.shadow-pop.dark"]);

    pair.dark = before!;
    expect(documentSync(FIXTURE, doctored)).toEqual(documentSync(FIXTURE, frontmatter));
    expect(documentSync(FIXTURE, doctored).ok).toBe(true);
  });
});
