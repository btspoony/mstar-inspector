/**
 * Generator for `src/spa/styles/tokens.css` (plan 201, task 3).
 *
 * The token source under `src/design-system/tokens/` is the only hand-editable
 * half of the design system; this stylesheet is emitted from it:
 * primitives → semantics → components → the transitional names → the D15 ops
 * variant → the reduced-motion fold.
 *
 * Two sets beyond the survivors: D14a's transitional palette steps (each with
 * the plan that closes it) and `legacyTokens`, the pre-redesign names surfaces
 * in plans 202-203 still read. Both come from the source as data, so the
 * generator holds no list of its own and a step leaves the output in the same
 * commit that migrates its last consumer.
 *
 * Only declarations that differ are re-emitted for the light face; a semantic
 * built from `var(--x)` follows the theme through the primitive it names.
 *
 * Usage:
 *   bun scripts/build-tokens.ts           # write the stylesheet
 *   bun scripts/build-tokens.ts --check   # exit 1 when the file has drifted
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  OPS_SURFACE_ATTR,
  legacyTokens,
  opsSurface,
  reducedMotionDurations,
  tokenLayers,
  transitionalSteps,
  type ThemeName,
} from "../src/design-system/tokens";

const ROOT = path.resolve(import.meta.dir, "..");
const OUT_PATH = path.join(ROOT, "src/spa/styles/tokens.css");

/** `:root` is the deterministic dark default; light is the stored choice only. */
const ROOT_THEME: ThemeName = "dark";
const LIGHT_SELECTOR = `:root[data-theme="light"]`;
const OPS_SELECTOR = `:root[${OPS_SURFACE_ATTR}]`;

const declaration = (name: string, value: string, indent = "  "): string => `${indent}--${name}: ${value};`;

const transitionOwner = new Map(transitionalSteps.map((step) => [step.name as string, step.owner]));

/** Primitives in source order; a transitional step carries its closing owner. */
function primitiveBlock(theme: ThemeName): string[] {
  return Object.entries(tokenLayers(theme).primitive).flatMap(([name, value]) => {
    const owner = transitionOwner.get(name);
    if (owner === undefined) return [declaration(name, value)];
    return [
      `  /* D14a transitional — its last consumer is closed by plan ${owner};`,
      "     it leaves this set in the commit that migrates that consumer. */",
      declaration(name, value),
    ];
  });
}

function build(): string {
  const dark = tokenLayers(ROOT_THEME);
  const light = tokenLayers("light");

  const semanticNames = Object.keys(dark.semantic);
  const lightOverrides = semanticNames.filter(
    (name) => light.semantic[name] !== dark.semantic[name],
  );

  const lines: string[] = [
    "/*",
    " * GENERATED FILE — do not edit.",
    " *",
    " * Emitted by `scripts/build-tokens.ts` from `src/design-system/tokens/`.",
    " * Change the token source and run `bun scripts/build-tokens.ts`;",
    " * `bun scripts/build-tokens.ts --check` fails on any hand edit here.",
    " *",
    " * Contract:",
    ' *   - :root = themes.dark (console default; unset renders dark in every',
    " *     browser, the OS preference is not consulted)",
    ' *   - :root[data-theme="light"] = themes.light (stored manual choice, set',
    " *     pre-paint by the inline bootstrap in src/spa/index.html from",
    ' *     localStorage["mstar.dashboard.theme"])',
    ` *   - ${OPS_SELECTOR} = the D15 operator variant: the accent tone is`,
    " *     withheld whole, never a second component set",
    " *   - the reduced-motion fold at the end collapses every duration to 1ms",
    " *",
    " * The SPA layout consumes this module. Do not build components here.",
    " */",
    "",
    ":root {",
    "  color-scheme: dark;",
    "",
    `  /* primitives · ${ROOT_THEME} (raw values only) */`,
    ...primitiveBlock(ROOT_THEME),
    "",
    "  /* semantic · shared + dark */",
    ...semanticNames.map((name) => declaration(name, dark.semantic[name]!)),
    "",
    "  /* component — composed from the semantic layer */",
    ...Object.entries(dark.component).map(([name, value]) => declaration(name, value)),
    "",
  ];

  if (legacyTokens.length > 0) {
    lines.push(
      "  /* transitional names owned by later plans (202-204 migrate them;",
      "     each declaration leaves with its last consumer) */",
      ...legacyTokens.flatMap((token) => [
        `  /* closed by plan ${token.owner} */`,
        declaration(token.name, token.value),
      ]),
    );
  }

  lines.push(
    "}",
    "",
    "/* Stored manual choice — the only light face; unset stays dark. */",
    `${LIGHT_SELECTOR} {`,
    "  color-scheme: light;",
    "",
    "  /* primitives · light */",
    ...primitiveBlock("light"),
    "",
    "  /* semantic · light (only the names whose declaration differs) */",
    ...lightOverrides.map((name) => declaration(name, light.semantic[name]!)),
    "}",
    "",
    "/* D15 operator surface variant: the accent tone is withheld, not restyled. */",
    `${OPS_SELECTOR} {`,
    ...Object.entries(opsSurface).map(([name, value]) => declaration(name, value)),
    "}",
    "",
    "/* Reduced-motion fold (DESIGN.md motion.reduced-motion): every duration",
    "   consumer — transitions included — collapses to effectively instant, so",
    "   entrances render their end state and interactive transitions become",
    "   immediate. Component-level keyframes must additionally guard any",
    "   non-token property with the same media query. */",
    "@media (prefers-reduced-motion: reduce) {",
    "  :root {",
    ...Object.entries(reducedMotionDurations).map(([name, value]) =>
      declaration(name, value, "    "),
    ),
    "  }",
    "}",
    "",
  );

  return lines.join("\n");
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
    console.error("Run `bun scripts/build-tokens.ts` and commit the result.");
    process.exit(1);
  }
} else {
  writeFileSync(OUT_PATH, generated);
  console.log(`${outLabel} written from the token source`);
}
