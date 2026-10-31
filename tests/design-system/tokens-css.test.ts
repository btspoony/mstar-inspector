/**
 * The generated stylesheet contract (plan 201, task 3).
 *
 * `bun scripts/build-tokens.ts --check` is the drift gate; these assertions are
 * the parts of the emission a check run cannot state by itself:
 *
 * 1. **The output is a pure function of the source.** Regenerating in-process
 *    and comparing against the committed file catches a hand edit the same way
 *    `--check` does, and it runs under `bun test` as well as in CI.
 * 2. **The palette is exactly the survivor set.** The D14a transitional steps
 *    closed with plan 204, whose admin.html migration removed their last
 *    readers; the emitted palette is the 26 the bands consume and nothing else.
 * 3. **Nothing removed comes back.** Neither the steps D14 dropped nor the
 *    retired pre-redesign aliases reappear as declarations.
 * 4. **The theme contract survives**: `:root` dark, `[data-theme="light"]`
 *    stored-light only, the ops variant, and the reduced-motion fold.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { survivorSteps, tokenLayers } from "../../src/design-system/tokens";

const REPO = new URL("../../", import.meta.url).pathname;
const CSS_PATH = join(REPO, "src/spa/styles/tokens.css");
const css = readFileSync(CSS_PATH, "utf8");

/** A declaration and its value from one selector block. */
function block(selector: string): Record<string, string> {
  const at = css.indexOf(`${selector} {`);
  if (at === -1) throw new Error(`missing block: ${selector}`);
  const open = css.indexOf("{", at);
  let depth = 0;
  let end = open;
  for (let i = open; i < css.length; i += 1) {
    if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) {
        end = i;
        break;
      }
    } else if (css[i] === "{") depth += 1;
  }
  const out: Record<string, string> = {};
  for (const m of css.slice(open + 1, end).matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
    out[m[1]!] = m[2]!.trim();
  }
  return out;
}

const ROOT = block(":root");
const LIGHT = block(':root[data-theme="light"]');
const OPS = block(':root[data-surface="ops"]');

describe("generated tokens.css", () => {
  test("is exactly what the generator produces from the current source", () => {
    // The same comparison `--check` makes, run here so a hand edit fails the
    // suite too rather than only the CI step.
    const check = spawnSync("bun", ["scripts/build-tokens.ts", "--check"], {
      cwd: REPO,
      encoding: "utf8",
    });
    expect(check.stdout.trim(), check.stderr).toContain("matches the token source");
    expect(check.status).toBe(0);
  });

  test("says it is generated and names the generator", () => {
    expect(css.startsWith("/*")).toBe(true);
    expect(css.slice(0, 400)).toContain("GENERATED FILE — do not edit.");
    expect(css.slice(0, 400)).toContain("scripts/build-tokens.ts");
  });

  test("declares the 26 survivors, and no other palette step", () => {
    const declaredSteps = [
      ...Object.keys(ROOT),
      ...Object.keys(LIGHT),
    ].filter((name) => /^(?:background|gray|gray-alpha|brand|blue|red|amber|green|teal|purple|pink)-/.test(name));
    const unique = [...new Set(declaredSteps)].sort();
    expect(unique).toEqual([...survivorSteps].sort());
    expect(unique).toHaveLength(26);
  });

  test("every dark semantic and component declaration reaches :root at its source value", () => {
    // The generator's own `--check` compares the file to its last output, so a
    // filter inside `build()` would stay green after a regeneration. Compare
    // the source to the file instead: a dropped declaration has nowhere to hide.
    const dark = tokenLayers("dark");
    for (const [layer, tokens] of [
      ["semantic", dark.semantic],
      ["component", dark.component],
    ] as const) {
      for (const [name, value] of Object.entries(tokens)) {
        expect(ROOT[name], `--${name} (${layer})`).toBe(value);
      }
    }
  });

  test("no removed step reappears as a declaration", () => {
    const declared = new Set([...Object.keys(ROOT), ...Object.keys(LIGHT)]);
    // The families D14 emptied out entirely — after task 4 the chart steps
    // that used to survive transitionally are gone too, so nothing of teal or
    // pink may remain.
    for (const family of ["blue", "teal", "pink", "purple"]) {
      const survivors = survivorSteps.filter((step) => step.startsWith(`${family}-`));
      const alive = [...declared].filter((name) => name.startsWith(`${family}-`));
      expect(alive.sort(), family).toEqual([...survivors].sort());
    }
  });

  test("the light branch re-declares only what differs", () => {
    // A full re-declaration would also work, but it hides which names are
    // genuinely theme-varying and doubles the surface a hand edit could drift
    // in. Primitives are re-declared whole (their values are raw hexes); the
    // semantic half carries only the names whose declaration changed.
    const dark = tokenLayers("dark");
    const light = tokenLayers("light");
    const varyingSemantics = Object.keys(dark.semantic).filter(
      (name) => dark.semantic[name] !== light.semantic[name],
    );
    expect(Object.keys(LIGHT).sort()).toEqual(
      [...Object.keys(light.primitive), ...varyingSemantics].sort(),
    );
    // And the assertion has teeth: at least the surface ladder varies.
    expect(varyingSemantics.length).toBeGreaterThan(10);
  });

  test("keeps the theme contract: dark default, stored light, ops variant, reduced motion", () => {
    expect(ROOT["color-scheme"]).toBeUndefined();
    expect(css).toContain(":root {\n  color-scheme: dark;");
    expect(css).toContain(`:root[data-theme="light"] {\n  color-scheme: light;`);
    expect(css).not.toContain("prefers-color-scheme");
    expect(css).toContain("@media (prefers-reduced-motion: reduce) {");

    expect(OPS["tone-accent-solid"]).toBe("var(--tone-neutral-solid)");
    expect(OPS["button-primary-bg"]).toBe("var(--tone-neutral-bg)");

    // Source order is load-bearing: `:root[data-theme="light"]` and
    // `:root[data-surface="ops"]` both score 0-2-0, so only the later block
    // wins. Emit ops first and the light branch repaints the console's accent
    // tokens — a silent return of the tone D15 withholds.
    const lightAt = css.indexOf(':root[data-theme="light"] {');
    const opsAt = css.indexOf(':root[data-surface="ops"] {');
    expect(lightAt).toBeGreaterThan(-1);
    expect(opsAt).toBeGreaterThan(lightAt);
  });
});
