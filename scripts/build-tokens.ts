/**
 * Generator for `src/spa/styles/tokens.css` and
 * `src/dashboard/ssr-tokens.generated.ts` (plan 201, task 3).
 *
 * The token source under `src/design-system/tokens/` is the only hand-editable
 * half of the design system; both outputs are emitted from it:
 * primitives → semantics → components → the D15 ops variant → the
 * reduced-motion fold.
 *
 * Nothing beyond the survivors: D14a's transitional palette steps closed with
 * plan 204, and the pre-redesign radius aliases left in the same plan when
 * `src/spa/pages.module.css` — their last reader — moved onto the tiers. The
 * stylesheet declares only what the three layers and the ops variant hold.
 *
 * Only declarations that differ are re-emitted for the light face; a semantic
 * built from `var(--x)` follows the theme through the primitive it names.
 *
 * The second output is the SSR face's value table: the zero-build dashboard
 * pages cannot import the design system, so they inline these resolved values
 * instead of carrying a hand copy (see `buildSsrTokens`).
 *
 * Usage:
 *   bun scripts/build-tokens.ts           # write both outputs
 *   bun scripts/build-tokens.ts --check   # exit 1 when either has drifted
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";

import {
  OPS_SURFACE_ATTR,
  THEMES,
  opsSurface,
  reducedMotionDurations,
  resolveTheme,
  tokenLayers,
  transitionalSteps,
  type ThemeName,
} from "../src/design-system/tokens";

const ROOT = path.resolve(import.meta.dir, "..");
const OUT_PATH = path.join(ROOT, "src/spa/styles/tokens.css");
const SSR_OUT_PATH = path.join(ROOT, "src/dashboard/ssr-tokens.generated.ts");

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
  ];

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

/**
 * The SSR face's half of the same chain: `src/dashboard/views.ts` is a
 * zero-build HTML producer that cannot import the design system (module
 * boundary, and no DOM), so it inlines a `<style>` block. This module is that
 * block's value table — resolved per theme, exactly as the stylesheet's own
 * declarations are, so the two faces cannot drift.
 *
 * Palette steps are deliberately absent. A consumer may name the semantic and
 * component layers and the invariant font stacks; a primitive colour step is
 * never a page's vocabulary.
 */
function buildSsrTokens(): string {
  const values = Object.fromEntries(
    THEMES.map((theme) => {
      const layers = resolveTheme(theme);
      // Primitives contribute the invariants (font stacks, breakpoints) only:
      // a palette step is never a consumer's vocabulary.
      const invariants = Object.entries(layers.primitive).filter(
        ([name]) => name.startsWith("font-") || name.startsWith("breakpoint-"),
      );
      return [theme, [...invariants, ...Object.entries(layers.semantic), ...Object.entries(layers.component)]];
    }),
  ) as Record<ThemeName, [string, string][]>;

  const block = (theme: ThemeName): string[] => [
    `  ${theme}: {`,
    ...values[theme].map(([name, value]) => `    ${JSON.stringify(name)}: ${JSON.stringify(value)},`),
    "  },",
  ];

  return [
    "/**",
    " * GENERATED FILE — do not edit.",
    " *",
    " * Emitted by `scripts/build-tokens.ts` from `src/design-system/tokens/`.",
    " * Change the token source and run `bun scripts/build-tokens.ts`;",
    " * `bun scripts/build-tokens.ts --check` fails on any hand edit here.",
    " *",
    " * The zero-build SSR dashboard face (`src/dashboard/views.ts`) inlines its",
    " * own `<style>` block and cannot reach the design system at runtime, so it",
    " * reads these resolved values instead of copying them. Both themes are",
    " * materialized: the face emits the dark block and the differing half of the",
    " * light one, exactly as the stylesheet does.",
    " *",
    " * Palette steps are absent by construction — a page names the semantic and",
    " * component layers, plus the invariant font stacks.",
    " */",
    "",
    'export type SsrTheme = "dark" | "light";',
    "",
    "export const ssrTokenValues: Readonly<Record<SsrTheme, Readonly<Record<string, string>>>> = {",
    ...block("dark"),
    ...block("light"),
    "};",
    "",
  ].join("\n");
}

const OUTPUTS: readonly { path: string; content: string }[] = [
  { path: OUT_PATH, content: build() },
  { path: SSR_OUT_PATH, content: buildSsrTokens() },
];

if (process.argv.includes("--check")) {
  let drifted = false;
  for (const output of OUTPUTS) {
    const outLabel = path.relative(ROOT, output.path);
    const current = existsSync(output.path) ? readFileSync(output.path, "utf8") : null;
    if (current === output.content) {
      console.log(`${outLabel} matches the token source`);
      continue;
    }
    drifted = true;
    if (current === null) {
      console.error(`${outLabel} is missing; the generator has never run here.`);
    } else {
      const committed = current.split("\n");
      const fresh = output.content.split("\n");
      const at = fresh.findIndex((line, i) => line !== committed[i]);
      console.error(`${outLabel} has drifted from the token source (first difference at line ${at + 1}).`);
      console.error(`  file:  ${JSON.stringify(committed[at] ?? "<end of file>")}`);
      console.error(`  fresh: ${JSON.stringify(fresh[at] ?? "<end of file>")}`);
    }
  }
  if (drifted) {
    console.error("Run `bun scripts/build-tokens.ts` and commit the result.");
    process.exit(1);
  }
} else {
  for (const output of OUTPUTS) {
    writeFileSync(output.path, output.content);
    console.log(`${path.relative(ROOT, output.path)} written from the token source`);
  }
}
