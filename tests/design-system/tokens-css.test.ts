/**
 * The generated stylesheet contract (plan 201, task 3).
 *
 * `bun scripts/build-tokens.ts --check` is the drift gate; these assertions are
 * the parts of the emission a check run cannot state by itself:
 *
 * 1. **The output is a pure function of the source.** Regenerating in-process
 *    and comparing against the committed file catches a hand edit the same way
 *    `--check` does, and it runs under `bun test` as well as in CI.
 * 2. **The transitional set is declared, with its owner.** Plans 202/203
 *    compile against those 11 steps until they migrate the last consumer;
 *    emitting survivors alone would break the build with no failing assertion
 *    until those plans run.
 * 3. **Nothing removed comes back.** The 59 steps D14 dropped must not appear
 *    as declarations, and no layer may reference a transitional step.
 * 4. **The theme contract survives**: `:root` dark, `[data-theme="light"]`
 *    stored-light only, the ops variant, and the reduced-motion fold.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

import { legacyTokens, survivorSteps, tokenLayers, transitionalSteps } from "../../src/design-system/tokens";

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

  test("declares 26 survivors and 2 transitional steps, and no other palette step", () => {
    const declaredSteps = [
      ...Object.keys(ROOT),
      ...Object.keys(LIGHT),
    ].filter((name) => /^(?:background|gray|gray-alpha|brand|blue|red|amber|green|teal|purple|pink)-/.test(name));
    const unique = [...new Set(declaredSteps)].sort();
    expect(unique).toEqual(
      [...survivorSteps, ...transitionalSteps.map((s) => s.name)].sort(),
    );
    expect(unique).toHaveLength(28);
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

  test("every transitional declaration carries the plan that closes it", () => {
    for (const step of transitionalSteps) {
      // The owner comment is the deadline: it travels with the value, so a
      // step cannot outlive its consumer unnoticed.
      expect(css, `--${step.name}`).toContain(`closed by plan ${step.owner}`);
      expect(ROOT[step.name], `--${step.name} in :root`).toMatch(/^#[0-9a-f]{3,8}$/i);
      expect(LIGHT[step.name], `--${step.name} in light`).toMatch(/^#[0-9a-f]{3,8}$/i);
    }
  });

  test("no removed step reappears as a declaration", () => {
    const declared = new Set([...Object.keys(ROOT), ...Object.keys(LIGHT)]);
    // The families D14 emptied out entirely — after task 4 the chart steps
    // that used to survive transitionally are gone too, so nothing of teal or
    // pink may remain.
    for (const family of ["blue", "teal", "pink", "purple"]) {
      const survivors = survivorSteps.filter((step) => step.startsWith(`${family}-`));
      const transitional = transitionalSteps
        .map((step) => step.name)
        .filter((step) => step.startsWith(`${family}-`));
      const alive = [...declared].filter((name) => name.startsWith(`${family}-`));
      expect(alive.sort(), family).toEqual([...survivors, ...transitional].sort());
    }
  });

  test("no layer references a transitional or legacy name", () => {
    // A reference from inside the system would make the step permanent by
    // accident; the whole point is that its consumer lives outside.
    for (const theme of ["dark", "light"] as const) {
      const layers = tokenLayers(theme);
      const referenced = [...Object.values(layers.semantic), ...Object.values(layers.component)].join("\n");
      for (const step of transitionalSteps) {
        expect(referenced, `${theme} consumes --${step.name}`).not.toContain(`var(--${step.name})`);
      }
      for (const token of legacyTokens) {
        expect(referenced, `${theme} consumes legacy --${token.name}`).not.toContain(`var(--${token.name})`);
      }
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
  });

  test("legacy names are declared as references, and only for names a later plan closes", () => {
    for (const token of legacyTokens) {
      expect(ROOT[token.name], `--${token.name}`).toBe(token.value);
      expect(css, `--${token.name} owner`).toContain(`closed by plan ${token.owner}`);
      expect(token.owner.trim()).not.toBe("");
      // A legacy value is a reference into the system or one of the plain
      // geometry values the surface already declared — never a new colour.
      expect(token.value).not.toMatch(/^#[0-9a-f]{3,8}$/i);
    }
  });
});
