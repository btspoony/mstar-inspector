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
  test("names the token and both values when the document disagrees", () => {
    const report = documentSync(FIXTURE, designFrontmatter());

    // At this commit DESIGN.md is still v0.4 and the semantic layer has no
    // frontmatter slot yet. The rewrite that raises it lands in a later task;
    // until then this check is red on purpose, never slackened to go green.
    expect(report.ok).toBe(false);
    expect(report.divergences.length).toBeGreaterThan(0);

    for (const divergence of report.divergences) {
      expect(divergence.token).toMatch(/^(primitive|semantic|component)\/\S+ \[(dark|light)\]$/);
      expect(divergence.at).not.toBe("");
      expect(typeof divergence.fixture).toBe("string");
    }
    const disagreeing = report.divergences.filter((d) => d.document !== undefined);
    expect(disagreeing.length).toBeGreaterThan(0);
    for (const d of disagreeing) expect(d.document).not.toBe(d.fixture);

    // Both directions: the document also still declares palette steps the
    // source dropped, and a rewrite from the fixture has to remove them.
    expect(report.stale.length).toBeGreaterThan(0);
    for (const s of report.stale) {
      expect(s.at).toMatch(/^themes\.(dark|light)\.colors\.\S+$/);
      expect(typeof s.document).toBe("string");
    }
  });

  test("a frontmatter corrected onto the fixture clears exactly that entry", () => {
    // Proves the comparison is a real read of the document rather than a
    // constant: patching the path the report named makes that one divergence
    // disappear and leaves every other alone.
    const frontmatter = designFrontmatter();
    const before = documentSync(FIXTURE, frontmatter);
    const target = before.divergences.find((d) => d.at.startsWith("elevation."));
    if (target === undefined) throw new Error("expected an elevation divergence to patch");

    const [group, shadow, theme] = target.at.split(".") as [string, string, string];
    const patched = structuredClone(frontmatter);
    const entry = patched[group];
    if (typeof entry !== "object" || entry === null) throw new Error(`no ${group} group in frontmatter`);
    const pair = Reflect.get(entry, shadow);
    if (typeof pair !== "object" || pair === null) throw new Error(`no ${group}.${shadow} entry`);
    Reflect.set(pair, theme, target.fixture);

    const after = documentSync(FIXTURE, patched);
    expect(after.divergences.map((d) => d.at)).not.toContain(target.at);
    expect(after.divergences.length).toBe(before.divergences.length - 1);
  });
});
