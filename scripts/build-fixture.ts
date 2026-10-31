/**
 * Generator for `src/design-system/fixture.json`.
 *
 * The fixture is the machine-readable copy of the token source: every name the
 * source declares, per theme and per layer, with each value fully resolved.
 * Resolved, not declared, because the one consumer that compares values —
 * `documentSync` in `scripts/design-system-check.ts` — holds them against
 * `DESIGN.md` frontmatter, which stores values, not `var()` chains.
 *
 * The names come from `tokenNames()`, the values from `resolveTheme()`, so the
 * fixture cannot drift from the source by omission: a token added there is in
 * the next generation, and step 2 of `scripts/design-system-check.ts` fails
 * until it is committed.
 *
 * When a name leaves the source it leaves the fixture in the same
 * generation: the palette's D14a transitional set closed with plan 204, and the
 * pre-redesign alias list retired with the page stylesheet that read it.
 *
 * Usage:
 *   bun scripts/build-fixture.ts           # write the fixture
 *   bun scripts/build-fixture.ts --check   # exit 1 when the file has drifted
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import { THEMES, resolveTheme } from "../src/design-system/tokens";

const ROOT = path.resolve(import.meta.dir, "..");
const OUT_PATH = path.join(ROOT, "src/design-system/fixture.json");

function build(): string {
  const themes = Object.fromEntries(THEMES.map((theme) => [theme, resolveTheme(theme)]));
  return `${JSON.stringify(
    {
      $generatedBy: "bun scripts/build-fixture.ts",
      $source: "src/design-system/tokens",
      themes,
    },
    null,
    2,
  )}\n`;
}

const generated = build();
const outLabel = path.relative(ROOT, OUT_PATH);

if (process.argv.includes("--check")) {
  const current = existsSync(OUT_PATH) ? readFileSync(OUT_PATH, "utf8") : null;
  if (current === generated) {
    console.log(`${outLabel} matches the token source`);
  } else {
    if (current === null) {
      console.error(`${outLabel} is missing; the generator has never run here.`);
    } else {
      const committed = current.split("\n");
      const fresh = generated.split("\n");
      const at = fresh.findIndex((line, i) => line !== committed[i]);
      console.error(`${outLabel} has drifted from the token source (first difference at line ${at + 1}).`);
      console.error(`  file:  ${JSON.stringify(committed[at] ?? "<end of file>")}`);
      console.error(`  fresh: ${JSON.stringify(fresh[at] ?? "<end of file>")}`);
    }
    console.error("Run `bun scripts/build-fixture.ts` and commit the result.");
    process.exit(1);
  }
} else {
  writeFileSync(OUT_PATH, generated);
  console.log(`${outLabel} written from the token source`);
}
