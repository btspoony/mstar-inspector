import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { THEMES, resolveTheme, tokenNames } from "../../src/design-system/tokens";
import { documentSync, parseFixture } from "../../scripts/design-system-check";

const REPO = new URL("../../", import.meta.url).pathname;
const RAW = readFileSync(join(REPO, "src/design-system/fixture.json"), "utf8");
const FIXTURE = parseFixture(RAW);

function designFrontmatter(): Record<string, unknown> {
  const md = readFileSync(join(REPO, "DESIGN.md"), "utf8");
  const fenced = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(md);
  if (fenced === null) throw new Error("DESIGN.md has no `---` fenced YAML frontmatter");
  const parsed: unknown = Bun.YAML.parse(fenced[1] as string);
  if (typeof parsed !== "object" || parsed === null) throw new Error("frontmatter is not a YAML map");
  return parsed as Record<string, unknown>;
}

const LAYERS = ["primitive", "semantic", "component"] as const;

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
    expect(RAW).toContain('"$generatedBy": "bun scripts/build-fixture.ts"');
    expect(RAW).toContain('"$source": "src/design-system/tokens"');
  });

  test("carries every name the source declares, per theme and per layer", () => {
    const names = tokenNames();
    expect(Object.keys(FIXTURE).sort()).toEqual([...THEMES].sort());

    for (const theme of THEMES) {
      expect(Object.keys(FIXTURE[theme]).sort(), `${theme} layers`).toEqual([...LAYERS].sort());
      for (const layer of LAYERS) {
        expect(Object.keys(layerOf(theme, layer)).sort(), `${theme} ${layer}`).toEqual([...names[layer]].sort());
      }
    }
  });

  test("records the resolved value, not the var() reference", () => {
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
    const report = documentSync(FIXTURE, designFrontmatter());
    expect(report.ok).toBe(true);
    expect(report.divergences).toEqual([]);
    expect(report.stale).toEqual([]);
    expect(report.compared).toBeGreaterThan(0);
    expect(Object.keys(report.unexpressed)).toHaveLength(3);
    expect(Object.values(report.unexpressed).reduce((a, b) => a + b, 0)).toBe(88);
  });

  test("names the token and both values when a frontmatter value is doctored", () => {
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
    expect(report.divergences).toHaveLength(1);
  });

  test("names a palette step the source dropped that the document still declares", () => {
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
    const doctored = structuredClone(FIXTURE) as Record<string, Record<string, Record<string, string>>>;
    doctored.dark!.primitive!["spacing-4"] = "18px";

    const report = documentSync(doctored as unknown as typeof FIXTURE, designFrontmatter());
    expect(report.ok).toBe(false);
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
