/**
 * The token covenant, rewritten for v0.5: source → fixture → DESIGN.md.
 *
 * Locked contract:
 * - DESIGN.md's frontmatter agrees with the generated fixture — proven here
 *   against the same comparator the gate runs (`documentSync`), and by
 *   set-equality over each theme's colour map. The old hand-lists of light
 *   hexes (KEPT_LIGHT/V03_LIGHT) and L2 accent steps died with the palette
 *   they pinned; the fixture is the vocabulary now.
 * - The palette the document carries is exactly the D14 survivor set plus
 *   the D14a transitional live list, read from the token source — not a
 *   second hand-maintained list.
 * - `src/spa/styles/tokens.css` and the document agree because both equal
 *   the fixture; light applies only via `:root[data-theme="light"]` (the
 *   stored choice; the OS-light fallback branch is deleted).
 * - Every `{path}` reference in `components:` resolves (design-md-spec §6)
 *   — the CI-side twin of `mstar design-md validate .`, which stays local.
 * - Appendix A's contrast dispositions hold as documented, including the
 *   approved below-4.5 pairs.
 *
 * Version pins are structural (dotted numeric + matching `v<version>`
 * change-note in the description), never literals.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

import { survivorSteps, transitionalSteps } from "../../src/design-system/tokens";
import { documentSync, parseFixture } from "../../scripts/design-system-check";

const DESIGN = new URL("../../DESIGN.md", import.meta.url);
const TOKENS_CSS = new URL("../../src/spa/styles/tokens.css", import.meta.url);
const FIXTURE_PATH = new URL("../../src/design-system/fixture.json", import.meta.url);
const VIEWS = new URL("../../src/dashboard/views.ts", import.meta.url);

/** The DESIGN.md theme mechanism — frontmatter top level and themes: stay equal. */
const THEME_MECHANISM = "manual data-theme override (navbar toggle); unset = dark default";
/** Dated user authorization reversing the "no toggle" lock. */
const SUPERSEDE_NOTE = "Supersedes the earlier theme lock (2026-09-04, user instruction)";

const TYPO_FIELDS = ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing"] as const;
const TYPO_PROP: Readonly<Record<string, string>> = {
  family: "fontFamily",
  size: "fontSize",
  weight: "fontWeight",
  line: "lineHeight",
  tracking: "letterSpacing",
};
const COLOR = /^(?:#[0-9a-f]{3,8}|oklch\()/i;
/** A palette step declaration in the stylesheet: `background-100`, `gray-alpha-400`, `teal-700`. */
const PALETTE_STEP = /^(?:background-\d00|gray-\d{3,4}|gray-alpha-\d{3,4}|brand-\d00|blue-\d00|red-\d{3,4}|amber-\d{3,4}|green-\d{3,4}|teal-\d00|purple-\d{3,4}|pink-\d{3,4})$/;
/** The frontmatter reference grammar (design-md-spec §6): `{group.key}`, no component-to-component or spacing refs. */
const REF = /^\{([a-z]+)\.([^}]+)\}$/;

/** sRGB channels of a `#rrggbb` literal, 0–1. */
const srgb = (value: string): [number, number, number] => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(value.slice(i, i + 2), 16) / 255) as [number, number, number];
  return [r, g, b];
};
const luminance = (hex: string): number => {
  const [r, g, b] = srgb(hex).map((c) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)) as [
    number,
    number,
    number,
  ];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string): number => {
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (hi + 0.05) / (lo + 0.05);
};
/** Resolve `var(--x)` chains against one theme's declarations. */
const resolve = (vars: Record<string, string>, name: string): string => {
  let value = vars[name]!;
  for (let hop = 0; hop < 8 && value.startsWith("var("); hop += 1) {
    value = vars[/^var\(--([a-z0-9-]+)\)$/.exec(value)?.[1] as string]!;
  }
  return value;
};

type DesignFrontmatter = {
  /** YAML keeps `0.5` a number and `0.5.0` a string. */
  version: string | number;
  description: string;
  defaultTheme: string;
  themeMechanism: string;
  colors: Record<string, string>;
  themes: {
    default: string;
    mechanism: string;
    dark: { colors: Record<string, string> };
    light: { colors: Record<string, string> };
  };
  typography: Record<string, Record<string, string | number>>;
  spacing: Record<string, string>;
  rounded: Record<string, string>;
  motion: Record<string, string>;
  elevation: Record<string, Record<string, string>>;
  components: Record<string, Record<string, string | number>>;
};

const THEMES = ["dark", "light"] as const;
const FIXTURE = parseFixture(readFileSync(FIXTURE_PATH, "utf8"));

/** Non-nullable layer snapshots; a missing layer fails the first comparison. */
const DARK_SEMANTIC = FIXTURE.dark?.semantic!;
const LIGHT_SEMANTIC = FIXTURE.light?.semantic!;
const DARK_PRIMITIVE = FIXTURE.dark?.primitive!;
const LIGHT_PRIMITIVE = FIXTURE.light?.primitive!;
/** The component layer's geometry (heights, paddings) — theme-invariant. */
const DARK_COMPONENT = FIXTURE.dark?.component!;

/** Fixture colour values per theme: the two colour-bearing layers merged. */
const FIXTURE_COLORS: Record<(typeof THEMES)[number], Record<string, string>> = {
  dark: { ...DARK_PRIMITIVE, ...DARK_SEMANTIC },
  light: { ...LIGHT_PRIMITIVE, ...LIGHT_SEMANTIC },
};

async function loadFrontmatter(): Promise<DesignFrontmatter> {
  const md = await Bun.file(DESIGN).text();
  const match = md.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error("DESIGN.md is missing YAML frontmatter");
  return Bun.YAML.parse(match[1]!) as DesignFrontmatter;
}


/** The fixture's live colour names for one theme: primitive + semantic layers. */
function liveColorNames(theme: (typeof THEMES)[number]): string[] {
  // The component layer has no frontmatter slot; it never enters the map.
  const entries =
    theme === "dark"
      ? [...Object.entries(DARK_PRIMITIVE), ...Object.entries(DARK_SEMANTIC)]
      : [...Object.entries(LIGHT_PRIMITIVE), ...Object.entries(LIGHT_SEMANTIC)];
  return entries.filter(([, value]) => COLOR.test(value)).map(([name]) => name);
}

function cssCustomProperties(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
    out[m[1]!] = m[2]!.trim();
  }
  return out;
}

/**
 * Extract a balanced `{ ... }` block by its opening token (selector or
 * at-rule including the `{`). The open token must be the block form —
 * comment mentions of the selector carry no brace and are skipped by
 * the brace requirement.
 */
function extractBlock(css: string, openToken: string): string {
  const at = css.indexOf(openToken);
  if (at === -1) throw new Error(`block not found: ${openToken}`);
  const open = at + openToken.length - 1;
  let depth = 0;
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}") {
      depth -= 1;
      if (depth === 0) return css.slice(open + 1, i);
    }
  }
  throw new Error(`unbalanced block: ${openToken}`);
}

describe("source → fixture → DESIGN.md chain", () => {
  test("the committed document is in sync with the fixture (the gate's own comparator)", async () => {
    const fm = await loadFrontmatter();
    expect(documentSync(FIXTURE, fm as unknown as Record<string, unknown>).ok).toBe(true);
  });

  test("each theme's colour map equals the fixture's live names, value for value", async () => {
    const fm = await loadFrontmatter();
    for (const theme of THEMES) {
      const declared = fm.themes[theme].colors;
      const live = liveColorNames(theme);
      // Both directions: nothing dropped, nothing invented.
      expect(Object.keys(declared).sort(), `${theme} names`).toEqual([...live].sort());
      for (const name of live) {
        expect(declared[name], `${theme} ${name}`).toBe(FIXTURE_COLORS[theme][name]);
      }
    }
    // Top-level colors: mirrors the dark default so {colors.X} refs resolve
    // to the runtime default.
    expect(fm.colors).toEqual(fm.themes.dark.colors);
  });

  test("the palette the document carries is the D14 survivors plus the D14a live list", async () => {
    const fm = await loadFrontmatter();
    const expected = [...survivorSteps, ...transitionalSteps.map((step) => step.name)].sort();
    const declared = Object.keys(fm.themes.dark.colors).filter((name) => PALETTE_STEP.test(name)).sort();
    expect(declared).toEqual(expected);
  });

  test("typography, spacing, radius, motion and elevation match the fixture", async () => {
    const fm = await loadFrontmatter();
    const sem = DARK_SEMANTIC;
    const light = LIGHT_SEMANTIC;

    // Typography: every typo-* token lands on its role + property, exact value.
    for (const [name, value] of Object.entries(sem)) {
      const typo = /^typo-(.+)-(family|size|weight|line|tracking)$/.exec(name);
      if (!typo) continue;
      const prop = TYPO_PROP[typo[2] as string];
      if (prop === undefined) throw new Error(`unknown typography property in ${name}`);
      const held = fm.typography[typo[1]!]?.[prop];
      expect(held, name).toBeDefined();
      expect(String(held), name).toBe(value);
    }
    // And nothing extra: the roles are exactly the fixture's.
    const roles = new Set<string>();
    for (const name of Object.keys(sem)) {
      const role = /^typo-(.+)-(?:family|size|weight|line|tracking)$/.exec(name)?.[1];
      if (role !== undefined) roles.add(role);
    }
    expect(Object.keys(fm.typography).sort()).toEqual([...roles].sort());
    for (const entry of Object.values(fm.typography)) {
      expect(Object.keys(entry).sort()).toEqual([...TYPO_FIELDS].sort());
    }

    const spacingFixture: Record<string, string> = {};
    for (const [name, value] of Object.entries(sem)) {
      const step = /^spacing-(.+)$/.exec(name)?.[1];
      if (step !== undefined) spacingFixture[step] = value;
    }
    const { base: _base, ...numbered } = fm.spacing;
    expect(numbered).toEqual(spacingFixture);
    expect(fm.spacing.base).toBe("4px");

    expect(fm.rounded).toEqual({
      sm: sem["radius-control"]!,
      md: sem["radius-container"]!,
      full: sem["radius-pill"]!,
    });
    expect(fm.motion).toEqual({
      "duration-fast": sem["duration-fast"]!,
      "duration-base": sem["duration-base"]!,
      "duration-slow": sem["duration-slow"]!,
      "ease-out": sem["ease-out"]!,
      "ease-in-out": sem["ease-in-out"]!,
      "reduced-motion":
        "prefers-reduced-motion: reduce folds every duration to 1ms — entrances render their end state, transitions become immediate",
    });
    expect(fm.elevation).toEqual({
      "shadow-card": { dark: sem["shadow-card"]!, light: light["shadow-card"]! },
      "shadow-pop": { dark: sem["shadow-pop"]!, light: light["shadow-pop"]! },
    });
  });

  test("every {path} reference in components: resolves (design-md-spec §6)", async () => {
    const fm = await loadFrontmatter();
    const groups = { colors: fm.colors, typography: fm.typography, rounded: fm.rounded };
    for (const [name, entry] of Object.entries(fm.components)) {
      for (const value of Object.values(entry)) {
        if (typeof value !== "string") continue;
        const ref = REF.exec(value);
        if (ref === null) continue;
        const group = ref[1]!;
        const key = ref[2]!;
        expect(Object.keys(groups), `${name}: ${value}`).toContain(group);
        expect(Object.hasOwn(groups[group as keyof typeof groups], key), `${name}: ${value}`).toBe(true);
      }
    }
    // The v0.5 entry set the document owns (the component layer's faces plus
    // the pattern faces it documents). button-xs is the brief's named entry.
    for (const name of [
      "button-primary", "button-secondary", "button-ghost", "button-danger", "button-disabled",
      "button-sm", "button-xs", "input", "card", "group-card", "list-row", "step-dialog",
    ]) {
      expect(fm.components[name], name).toBeDefined();
    }
  });

  test("the button size faces restate the component layer's geometry", async () => {
    // `documentSync` reports the component layer and control heights as
    // unexpressed — `components:` is variant-shaped, and the spec has no size
    // group — so nothing else stops the document restating a face the source
    // does not have (I-000215). The size entries are compared here instead:
    // height and padding against the component layer, the label against the
    // typography step the entry names.
    const fm = await loadFrontmatter();
    for (const [size, label] of [["xs", "button-12"], ["sm", "button-14"]] as const) {
      const entry = fm.components[`button-${size}`]!;
      expect(entry.height, `button-${size} height`).toBe(DARK_COMPONENT[`button-height-${size}`]);
      expect(entry.padding, `button-${size} padding`).toBe(DARK_COMPONENT[`button-padding-${size}`]);
      expect(entry.typography, `button-${size} label`).toBe(`{typography.${label}}`);
      expect(fm.typography[label]!.fontSize, label).toBe(DARK_SEMANTIC[`typo-${label}-size`]);
    }
  });
});

describe("DESIGN.md theme and version contract", () => {
  test("dotted version, matching change-note, dark default, manual toggle", async () => {
    const fm = await loadFrontmatter();
    // YAML keeps `0.5` a number and `0.5.0` a string; both read the same.
    const version = String(fm.version);
    // The version pin is STRUCTURAL, not a literal: DESIGN.md's own version is
    // a dotted numeric version, and its description carries the matching
    // `v<version>` change-note. A bump edits the document only.
    expect(version).toMatch(/^\d+\.\d+(?:\.\d+)?$/);
    expect(fm.description).toContain(`v${version}`);
    expect(fm.defaultTheme).toBe("dark");
    expect(fm.themeMechanism).toBe(THEME_MECHANISM);
    expect(fm.themes.default).toBe("dark");
    expect(fm.themes.mechanism).toBe(THEME_MECHANISM);
    expect(fm.description).toContain("navbar theme toggle");
    expect(fm.description).toContain(SUPERSEDE_NOTE);
  });
});

describe("src/spa/styles/tokens.css ↔ fixture ↔ DESIGN.md", () => {
  test("dark :root and the stored-light branch match the fixture palettes (no OS fallback)", async () => {
    const css = await Bun.file(TOKENS_CSS).text();

    // v0.3.4 (2026-09-16): the prefers-color-scheme OS-light fallback is
    // deleted — unset renders dark in every browser; light applies only
    // via the stored-choice attribute branch.
    const darkBlock = extractBlock(css, ":root {");
    const lightBlock = extractBlock(css, ':root[data-theme="light"] {');
    expect(css).not.toContain("prefers-color-scheme");
    expect(css).not.toContain(':root:not([data-theme="dark"])');

    expect(darkBlock).toContain("color-scheme: dark");
    expect(lightBlock).toContain("color-scheme: light");

    const darkVars = cssCustomProperties(darkBlock);
    const lightVars = cssCustomProperties(lightBlock);

    // The stylesheet is generated from the same source as the fixture, and
    // the document equals the fixture — so all three sites agree through
    // the one shared truth, not by pairwise copying.
    const darkPrimitive = FIXTURE.dark.primitive;
    const lightPrimitive = FIXTURE.light.primitive;
    if (darkPrimitive === undefined || lightPrimitive === undefined) throw new Error("fixture is missing a primitive layer");
    for (const name of Object.keys(darkPrimitive).filter((n) => PALETTE_STEP.test(n))) {
      expect(darkVars[name], `--${name}`).toBe(darkPrimitive[name]);
    }
    for (const name of Object.keys(lightPrimitive).filter((n) => PALETTE_STEP.test(n))) {
      expect(lightVars[name], `--${name}`).toBe(lightPrimitive[name]);
    }
  });

  test("transitional steps are declared with the plan that closes them", async () => {
    const css = await Bun.file(TOKENS_CSS).text();
    const dark = extractBlock(css, ":root {");
    for (const step of transitionalSteps) {
      // The declaration is what later plans compile against; the owner
      // comment is the deadline, and it travels with the value.
      expect(dark, `--${step.name} must stay declared`).toContain(`  --${step.name}: #`);
      expect(dark, `--${step.name} needs its owner comment`).toMatch(
        new RegExp(`closed by plan [^\\n]+[\\s\\S]{0,200}?\\n\\s*--${step.name}: `),
      );
    }
  });

  test("semantic, component and legacy names are present on :root", async () => {
    const css = await Bun.file(TOKENS_CSS).text();
    const rootVars = cssCustomProperties(extractBlock(css, ":root {"));

    expect(rootVars["spacing-24"]).toBe("96px");
    expect(rootVars["control-h-md"]).toBe("40px");
    expect(rootVars["radius-control"]).toBe("8px");
    expect(rootVars["radius-container"]).toBe("12px");
    expect(rootVars["typo-heading-24-size"]).toBe("24px");
    // Component tokens name the semantic layer, never a palette step — this is
    // the whole point of the re-point: the palette becomes droppable.
    expect(rootVars["button-primary-bg"]).toBe("var(--tone-accent-solid)");
    expect(rootVars["button-primary-fg"]).toBe("var(--on-brand)");
    expect(rootVars["card-bg"]).toBe("var(--surface-card)");
    expect(rootVars["notice-error-fg"]).toBe("var(--tone-danger-fg)");
    expect(rootVars["sidebar-active-bg"]).toBe("var(--surface-overlay)");
  });

  test("motion and elevation land in tokens.css with the reduced-motion fold", async () => {
    const css = await Bun.file(TOKENS_CSS).text();
    const darkVars = cssCustomProperties(extractBlock(css, ":root {"));
    const lightVars = cssCustomProperties(extractBlock(css, ':root[data-theme="light"] {'));

    // Motion is theme-independent on :root; elevation carries dark on :root
    // and light on the stored-light branch.
    expect(darkVars["duration-fast"]).toBe("120ms");
    expect(darkVars["ease-in-out"]).toBe("cubic-bezier(0.65, 0, 0.35, 1)");
    expect(darkVars["shadow-pop"]).toBe("0 8px 24px #02061799, 0 2px 6px #02061766");
    expect(lightVars["shadow-pop"]).toBe("0 8px 24px #1019281f, 0 2px 6px #10192814");

    // Reduced-motion fold: durations collapse to 1ms.
    const reduceVars = cssCustomProperties(extractBlock(css, "@media (prefers-reduced-motion: reduce) {"));
    expect(reduceVars["duration-fast"]).toBe("1ms");
    expect(reduceVars["duration-base"]).toBe("1ms");
    expect(reduceVars["duration-slow"]).toBe("1ms");
  });
});

describe("Appendix A contrast dispositions (D16)", () => {
  // Ratios are computed over the document's own frontmatter (proven equal to
  // the fixture above), on the face each pair actually sits on.
  const lum = (hex: string): number => {
    const [r, g, b] = [0, 2, 4]
      .map((i) => parseInt(hex.slice(1 + i, 3 + i), 16) / 255)
      .map((c) => (c <= 0.04045 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4)));
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!;
  };
  const ratio = (a: string, b: string): number => {
    const hi = Math.max(lum(a), lum(b));
    const lo = Math.min(lum(a), lum(b));
    return (hi + 0.05) / (lo + 0.05);
  };

  test("text ladder holds the text bar; text-faint is the documented below-4.5 exception", async () => {
    const fm = await loadFrontmatter();
    for (const theme of THEMES) {
      const c = fm.themes[theme].colors;
      for (const token of ["text-primary", "text-secondary", "text-muted"]) {
        expect(ratio(c[token]!, c["surface-card"]!), `${theme} ${token}`).toBeGreaterThanOrEqual(4.5);
      }
      // Faint is below 4.5 on the card face (3.76 dark / 4.47 light) — the
      // documented "tertiary marks only, never body copy" constraint — and
      // still clears the 3:1 bar it is held to.
      expect(ratio(c["text-faint"]!, c["surface-card"]!), `${theme} text-faint on card`).toBeLessThan(4.5);
      expect(ratio(c["text-faint"]!, c["surface-card"]!), `${theme} text-faint on card`).toBeGreaterThanOrEqual(3);
    }
  });

  test("on-brand and the tone fg pairs hold the text bar in both themes", async () => {
    const fm = await loadFrontmatter();
    for (const theme of THEMES) {
      const c = fm.themes[theme].colors;
      expect(ratio(c["on-brand"]!, c["tone-accent-solid"]!), `${theme} on-brand`).toBeGreaterThanOrEqual(4.5);
      for (const meaning of ["neutral", "accent", "success", "warn", "danger"]) {
        expect(ratio(c[`tone-${meaning}-fg`]!, c[`tone-${meaning}-bg`]!), `${theme} ${meaning} fg`).toBeGreaterThanOrEqual(4.5);
      }
    }
  });

  test("tone solid pairs: dark passes; light carries the recorded below-4.5 exceptions", async () => {
    const fm = await loadFrontmatter();
    // The label on a tone solid is the page ink (the tone fg is chosen to sit
    // on the tint, not on its own solid step).
    for (const meaning of ["neutral", "accent", "success", "warn", "danger"]) {
      const dark = fm.themes.dark.colors;
      expect(ratio(dark["surface-page"]!, dark[`tone-${meaning}-solid`]!), `dark ${meaning} solid`).toBeGreaterThanOrEqual(4.5);
    }
    const light = fm.themes.light.colors;
    expect(ratio(light["surface-page"]!, light["tone-accent-solid"]!), "light accent solid").toBeGreaterThanOrEqual(4.5);
    expect(ratio(light["surface-page"]!, light["tone-danger-solid"]!), "light danger solid").toBeGreaterThanOrEqual(4.5);
    // D16's approved below-4.5 light solids: badge-scale faces, never
    // running text — held to at least the 3:1 bar.
    for (const meaning of ["neutral", "success", "warn"]) {
      const r = ratio(light["surface-page"]!, light[`tone-${meaning}-solid`]!);
      expect(r, `light ${meaning} solid`).toBeLessThan(4.5);
      expect(r, `light ${meaning} solid`).toBeGreaterThanOrEqual(3);
    }
  });

  test("every chart mark clears the non-text bar on the card face", async () => {
    const fm = await loadFrontmatter();
    for (const theme of THEMES) {
      const c = fm.themes[theme].colors;
      for (let n = 1; n <= 6; n++) {
        // Light chart-2-mark is the corrected number: 3.30 on v0.5's white
        // surface-card (D16's 3.02 measured the old background-200 card).
        expect(ratio(c[`chart-${n}-mark`]!, c["surface-card"]!), `${theme} chart-${n}-mark`).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

describe("DESIGN.md v0.3 bridge re-point + base-component restyle", () => {
  const BRIDGE = new URL("../../src/spa/styles/shadcn-theme.css", import.meta.url);
  const PRIMITIVES_DIR = fileURLToPath(new URL("../../src/design-system/primitives/", import.meta.url));
  /** A5 sensitive subset — the only primitives allowed to drift from the copy-in. */
  const SUBSET = ["button", "card", "input", "table", "skeleton", "tabs", "sidebar", "select", "dropdown-menu", "dialog"];

  test("bridge re-point: every value is a semantic token; focus stays on the blue duty", async () => {
    const css = await Bun.file(BRIDGE).text();
    const rootVars = cssCustomProperties(extractBlock(css, ":root {"));
    // The task-3 re-point: the accent arrives as `tone-accent-solid` and the
    // label as `on-brand`, so the bridge never names a palette step. Hover is
    // the component layer's approved one-step-quieter face.
    expect(rootVars["primary"]).toBe("var(--tone-accent-solid)");
    expect(rootVars["primary-hover"]).toBe("var(--button-primary-hover-bg)");
    expect(rootVars["primary-foreground"]).toBe("var(--on-brand)");
    expect(rootVars["secondary-hover"]).toBe("var(--surface-overlay)");
    expect(rootVars["muted"]).toBe("var(--surface-inset)");
    expect(rootVars["border"]).toBe("var(--border-default)");
    expect(rootVars["destructive"]).toBe("var(--tone-danger-solid)");
    expect(rootVars["sidebar-primary"]).toBe("var(--tone-accent-solid)");
    // Link/focus duty stays blue (AD-571) — including the sidebar ring
    // (QC round 1 F-003 revert); brand cyan never takes focus, and alerts
    // keep red/amber/green.
    expect(rootVars["ring"]).toBe("var(--focus-ring)");
    expect(rootVars["sidebar-ring"]).toBe("var(--focus-ring)");

    // No palette step may appear in the bridge: referencing one keeps that
    // step alive past the plan that removes it.
    expect(css).not.toMatch(/var\(--(?:background|gray|brand|red|blue|amber|green|teal|pink|purple)-/);

    // The destructive hover derives from the solid rather than naming a step
    // (the palette reduction removed the step the old hover used). An engine
    // without `color-mix` must still get a valid value, so the plain solid is
    // declared first and the derived face overrides it behind @supports.
    expect(rootVars["destructive-hover"]).toBe(rootVars["destructive"]);
    const guarded = extractBlock(css, "@supports (color: color-mix(in srgb, red, blue)) {");
    expect(cssCustomProperties(guarded)["destructive-hover"]).toContain("color-mix(");

    // Theme coupling (QC round 1 F-001): the hover steps must exist as
    // --color-* keys in `@theme inline`. Tailwind v4 CSS-first config
    // generates utilities from theme keys only, so an unmapped :root var
    // leaves hover:bg-primary-hover (and the secondary/destructive
    // equivalents) as dead classes with no compiled CSS — the class-string
    // pins below cannot catch that drift on their own.
    const themeVars = cssCustomProperties(extractBlock(css, "@theme inline {"));
    expect(themeVars["color-primary-hover"]).toBe("var(--primary-hover)");
    expect(themeVars["color-secondary-hover"]).toBe("var(--secondary-hover)");
    expect(themeVars["color-destructive-hover"]).toBe("var(--destructive-hover)");
    // (AD-622): the hover tint consumes the sidebar-accent key at
    // /40 opacity — same dead-class trap, so the mapping is pinned too.
    expect(themeVars["color-sidebar-accent"]).toBe("var(--sidebar-accent)");
  });

  test("radius bridge collapses onto the AD-574 two tiers; tokens button maps the accent tone", async () => {
    const css = await Bun.file(BRIDGE).text();
    const themeVars = cssCustomProperties(extractBlock(css, "@theme inline {"));
    expect(themeVars["radius-sm"]).toBe("var(--radius-control)");
    expect(themeVars["radius-md"]).toBe("var(--radius-container)");
    // lg/xl re-point onto the container step so copy-in card faces land
    // without hand edits.
    expect(themeVars["radius-lg"]).toBe("var(--radius-container)");
    expect(themeVars["radius-xl"]).toBe("var(--radius-container)");

    const tokens = await Bun.file(TOKENS_CSS).text();
    expect(cssCustomProperties(extractBlock(tokens, ":root {"))["button-primary-bg"]).toBe(
      "var(--tone-accent-solid)",
    );
  });

  test("the destructive hover is a distinct face in both themes, and keeps its label readable", async () => {
    // The derivation is a colour relationship, so assert the relationship:
    // mixing toward the label face must move the fill away from the resting
    // colour and keep the label above 4.5:1 on it, in both themes.
    // The label is read from the component's own class list, not assumed: the
    // chip the test measured used to be `on-brand` while the DOM painted
    // `text-white` (M1/W-103), so the face under test is the face that renders.
    const bridgeVars = cssCustomProperties(extractBlock(await Bun.file(BRIDGE).text(), ":root {"));
    const tokens = await Bun.file(TOKENS_CSS).text();
    const dark = cssCustomProperties(extractBlock(tokens, ":root {"));
    const light = { ...dark, ...cssCustomProperties(extractBlock(tokens, ':root[data-theme="light"] {')) };
    const destructiveVariant = /destructive:\s*\n?\s*"([^"]+)"/.exec(await Bun.file(join(PRIMITIVES_DIR, "button.tsx")).text())?.[1];
    if (destructiveVariant === undefined) throw new Error("button.tsx declares no destructive variant");
    // `bg-destructive` / `text-destructive-foreground` in the class list are the
    // rendered faces; a raw colour (`text-white`) has no bridge key and fails here.
    const fillClass = /(?:^|\s)bg-([a-z][a-z0-9-]*)(?=\s|$)/.exec(destructiveVariant)?.[1];
    const labelClass = /(?:^|\s)text-([a-z][a-z0-9-]*)(?=\s|$)/.exec(destructiveVariant)?.[1];
    expect(fillClass, "destructive variant must paint a token fill").toBeDefined();
    expect(labelClass, "destructive variant must paint a token label").toBeDefined();
    expect(destructiveVariant, "no `dark:` split — Tailwind's dark: is prefers-color-scheme, this app's theme is data-theme").not.toContain("dark:");

    // The derived face lives in the @supports block; the plain solid in `:root`
    // is its fallback.
    const hoverExpression =
      cssCustomProperties(
        extractBlock(await Bun.file(BRIDGE).text(), "@supports (color: color-mix(in srgb, red, blue)) {"),
      )["destructive-hover"]!;
    const weightPercent = /color-mix\(in srgb,\s*var\(--tone-danger-solid\)\s+(\d+)%,\s*var\(--text-primary\)\)/
      .exec(hoverExpression)?.[1];
    // The derivation is a colour relationship; pinning the numbers would let a
    // hand-written hex pass as "derived".
    expect(weightPercent, "destructive hover must derive from the solid and the label face").toBeDefined();
    expect(bridgeVars["destructive"]).toBe("var(--tone-danger-solid)");
    expect(bridgeVars["destructive-hover"]).toBe("var(--tone-danger-solid)");

    /** The mix the browser performs at paint time, computed. */
    const blend = (solid: string, label: string, weight: number): string => {
      const [s, t] = [srgb(solid), srgb(label)];
      return `#${s
        .map((c, i) => Math.round((c * weight + t[i]! * (1 - weight)) * 255).toString(16).padStart(2, "0"))
        .join("")}`;
    };

    for (const vars of [dark, light]) {
      // One map per theme: a bridge key points at a token, a token points at a
      // primitive, and the chain ends in the hex the browser paints.
      const chain = { ...vars, ...bridgeVars };
      expect(chain[fillClass!], `bg-${fillClass} must name a bridge key`).toBeDefined();
      expect(chain[labelClass!], `text-${labelClass} must name a bridge key`).toBeDefined();
      const solid = resolve(chain, fillClass!);
      const label = resolve(chain, labelClass!);
      expect(label, `${labelClass} must resolve to a colour`).toMatch(/^#[0-9a-f]{3,8}$/i);
      const hover = blend(solid, resolve(vars, "text-primary"), Number(weightPercent) / 100);
      expect(hover, "hover must differ from the resting fill").not.toBe(solid);
      expect(contrast(label, solid), `${labelClass} on the resting ${fillClass} face`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(label, hover), `${labelClass} on the hover face ${hover}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("the link variant keeps its label readable on the page plane", async () => {
    // The link face paints no fill, so its contrast duty is the page plane.
    // The label is read from the face's own class list and resolved to the hex
    // the browser paints: pinning the class would prove the spelling, not the
    // ratio the link duty exists for.
    const variant = /link:\s*"([^"]+)"/.exec(await Bun.file(join(PRIMITIVES_DIR, "button.tsx")).text())?.[1];
    if (variant === undefined) throw new Error("button.tsx declares no link variant");
    const labelClass =
      /(?:^|\s)text-\((--[a-z0-9-]+)\)/.exec(variant)?.[1] ??
      /(?:^|\s)text-([a-z][a-z0-9-]*)(?=\s|$)/.exec(variant)?.[1];
    expect(labelClass, "the link face must paint a token label").toBeDefined();

    const bridgeVars = cssCustomProperties(extractBlock(await Bun.file(BRIDGE).text(), ":root {"));
    const tokens = await Bun.file(TOKENS_CSS).text();
    const dark = { ...cssCustomProperties(extractBlock(tokens, ":root {")), ...bridgeVars };
    const light = { ...dark, ...cssCustomProperties(extractBlock(tokens, ':root[data-theme="light"] {')) };
    for (const vars of [dark, light]) {
      const name = labelClass!.startsWith("--") ? labelClass!.slice(2) : labelClass!;
      const label = resolve(vars, name);
      expect(label, `${labelClass} must resolve to a colour`).toMatch(/^#[0-9a-f]{3,8}$/i);
      const plane = resolve(vars, "surface-page");
      expect(contrast(label, plane), `${labelClass} on surface-page`).toBeGreaterThanOrEqual(4.5);
    }
  });

  test("restyled subset carries v0.3 form: supersede marker, control radius, elevation on the overlay faces only, token-eased transitions", async () => {
    for (const name of SUBSET) {
      const source = await Bun.file(join(PRIMITIVES_DIR, `${name}.tsx`)).text();
      // Copy-in supersede marker — a future regen must not clobber silently.
      expect(source, name).toContain("Locally revised shadcn/ui copy-in (v0.3 restyle;");
      // Hard constraint #7 (architect tighten-up): transition-all is
      // narrowed to explicit property lists across the subset.
      expect(source, name).not.toContain("transition-all");
    }

    const button = await Bun.file(join(PRIMITIVES_DIR, "button.tsx")).text();
    expect(button).toContain("rounded-sm");
    expect(button).not.toContain("rounded-md");
    // Hover and press are token fills on the button face; which bridge key
    // each names is the primitive's, not this suite's oracle.
    expect(button).toMatch(/hover:bg-[a-z0-9-]+/);
    expect(button).toMatch(/active:bg-[a-z0-9-]+/);
    expect(button).toContain("duration-(--duration-base)");
    expect(button).toContain("ease-(--ease-in-out)");
    // The link duty stays on the focus blue even though --primary is the accent
    // tone. Asserted as "names no palette step" rather than as the class that
    // carries it: the link face resolves through `focus-ring`, and re-pinning
    // that class name would rebuild the oracle this migration removes.
    expect(button).not.toMatch(/--(?:background|gray|brand|blue|red|amber|green|purple|teal|pink)-/);

    const card = await Bun.file(join(PRIMITIVES_DIR, "card.tsx")).text();
    // r3 card rule (plan 202 task 2): definition is the hairline plus the
    // surface step, so the resting card declares no box-shadow at all —
    // elevation is the overlays' (asserted below, on the overlay faces).
    expect(card).not.toMatch(/(?:^|["\s])shadow-/);

    for (const name of ["dropdown-menu", "select", "dialog"]) {
      const source = await Bun.file(join(PRIMITIVES_DIR, `${name}.tsx`)).text();
      // The overlay faces carry the elevation namespace; a raw shadow step is
      // the retired spelling.
      expect(source, name).toMatch(/shadow-\(--[a-z0-9-]+\)/);
      expect(source, name).not.toMatch(/shadow-(md|lg)\b/);
    }

    const input = await Bun.file(join(PRIMITIVES_DIR, "input.tsx")).text();
    expect(input).toContain("rounded-sm");
    // DESIGN.md "Input — States: hover holds the edge" governs every field
    // face, and the select trigger is a field (`border-input`, control
    // height, control radius), not an action: it holds its edge through
    // hover. Asserted as the absence of a hover edge on both, whichever
    // token they would have named.
    for (const name of ["input", "select"]) {
      const source = await Bun.file(join(PRIMITIVES_DIR, `${name}.tsx`)).text();
      expect(source, name).not.toMatch(/hover:border-/);
    }

    // QC round 1 F-004: raw `transition-opacity` faces ride the duration +
    // easing tokens so the prefers-reduced-motion fold reaches them too.
    const dialog = await Bun.file(join(PRIMITIVES_DIR, "dialog.tsx")).text();
    expect(dialog).toMatch(/transition-opacity[^"\n]*duration-\(--duration-[a-z0-9-]+\)[^"\n]*ease-\(--ease-[a-z0-9-]+\)/);
    const tabs = await Bun.file(join(PRIMITIVES_DIR, "tabs.tsx")).text();
    expect(tabs).toMatch(
      /after:transition-opacity after:duration-\(--duration-[a-z0-9-]+\) after:ease-\(--ease-[a-z0-9-]+\)/,
    );

    const skeleton = await Bun.file(join(PRIMITIVES_DIR, "skeleton.tsx")).text();
    expect(skeleton).toContain("motion-reduce:animate-none");
  });

  test("further locally revised copy-ins carry the supersede marker (banned-free pin)", async () => {
    // Coverage strengthening for the shadcn copy-in marker (QC S-2 follow-up,
    // 2026-09-20): toggle/sheet were revised in the motion-token sweep,
    // outside the v0.3 subset above, so their supersede markers were
    // unpinned. The pin is banned-free by construction — it asserts the
    // sanitized marker wording, never the process-id literal the deleted
    // negative assertion carried.
    for (const name of ["toggle", "sheet"] as const) {
      const source = await Bun.file(join(PRIMITIVES_DIR, `${name}.tsx`)).text();
      expect(source, name).toContain("Locally revised shadcn/ui copy-in (motion-token sweep");
    }
  });
});

describe("DESIGN.md self-hosted Geist Sans typeface (AD-572)", () => {
  const FONTS_CSS = new URL("../../src/spa/styles/fonts.css", import.meta.url);
  const FONT_DIR = fileURLToPath(new URL("../../src/spa/assets/fonts/", import.meta.url));
  /** Geist first; the system entries keep zh and fallback-glyph duty. */
  const GEIST_STACK = '"Geist Sans", ui-sans-serif, system-ui, -apple-system, Segoe UI, Roboto, sans-serif';
  const MONO_STACK = "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace";
  const VENDORED = ["geist-sans-latin-400.woff2", "geist-sans-latin-500.woff2", "geist-sans-latin-600.woff2"];

  test("@font-face registers three Geist weights with swap and a zh-excluding range", async () => {
    const css = await Bun.file(FONTS_CSS).text();
    const blocks = [...css.matchAll(/@font-face\s*\{([^}]*)\}/g)].map((m) => m[1]!);
    expect(blocks).toHaveLength(3);

    const weights: number[] = [];
    for (const block of blocks) {
      expect(block).toContain('font-family: "Geist Sans"');
      expect(block).toContain("font-display: swap");
      expect(block).toContain('format("woff2")');
      expect(block).toContain('url("../assets/fonts/geist-sans-latin-');
      weights.push(Number(block.match(/font-weight:\s*(\d+)/)?.[1]));
      // zh text must never select this face: no declared range may cover
      // CJK, kana, or fullwidth codepoints (probes: ideographic space,
      // hiragana, the first CJK ideograph, fullwidth comma). zh runs then
      // render on the system stack and pure-zh pages never download.
      const probes: [number, string][] = [
        [0x3000, "ideographic space"],
        [0x3042, "hiragana"],
        [0x4e00, "first CJK ideograph"],
        [0xff0c, "fullwidth comma"],
      ];
      for (const m of block.matchAll(/U\+([0-9A-Fa-f]{4,6})(?:-([0-9A-Fa-f]{4,6}))?/g)) {
        const lo = parseInt(m[1]!, 16);
        const hi = parseInt(m[2] ?? m[1]!, 16);
        for (const [cp, label] of probes) {
          const covered = cp >= lo && cp <= hi;
          expect(covered, `range U+${lo.toString(16)}-${hi.toString(16)} covers ${label} U+${cp.toString(16)}`).toBe(false);
        }
      }
    }
    expect(weights.sort((a, b) => a - b)).toEqual([400, 500, 600]);
  });

  test("the Geist stack is identical at all three value sites; mono stays system", async () => {
    const fm = await loadFrontmatter();
    const css = await Bun.file(TOKENS_CSS).text();
    const views = await Bun.file(VIEWS).text();

    for (const [name, fields] of Object.entries(fm.typography)) {
      if (name === "mono-13") continue;
      expect(fields.fontFamily, name).toBe(GEIST_STACK);
    }
    expect(fm.typography["mono-13"]!.fontFamily).toBe(MONO_STACK);

    expect(cssCustomProperties(extractBlock(css, ":root {"))["font-sans"]).toBe(GEIST_STACK);

    const styleStart = views.indexOf("const STYLE = `<style>");
    const style = views.slice(styleStart, views.indexOf("`;", styleStart));
    expect(style.match(/--font-sans: ([^;]+);/)?.[1]).toBe(GEIST_STACK);
  });

  test("vendored binaries are real woff2, inside the 150KB budget, with the OFL license", () => {
    expect(readdirSync(FONT_DIR)).toContain("OFL.txt");
    expect(readdirSync(FONT_DIR).filter((f) => f.endsWith(".woff2")).sort()).toEqual(VENDORED);

    let total = 0;
    for (const file of VENDORED) {
      const path = join(FONT_DIR, file);
      // woff2 magic — guards against a placeholder/error-page binary.
      expect(readFileSync(path).subarray(0, 4).toString("latin1")).toBe("wOF2");
      total += statSync(path).size;
    }
    // AD-572 budget: 150KB read decimal — the stricter of the two readings.
    expect(total, `${total} bytes of woff2 vs the 150KB budget`).toBeLessThanOrEqual(150_000);
  });
});

describe("DESIGN.md theme contract", () => {
  test("manual navbar-toggle override documented with the dated supersede note", async () => {
    const md = await Bun.file(DESIGN).text();
    // The toggle contract: storage key + pre-paint application, in body prose.
    expect(md).toContain('localStorage["mstar.dashboard.theme"]');
    expect(md).toContain("documentElement.dataset.theme");
    expect(md).toContain(SUPERSEDE_NOTE);
    // v0.3.4: the cascade is the stored-light branch only — the OS-fallback
    // selector is gone from every theme location.
    expect(md).toContain(':root[data-theme="light"]');
    expect(md).not.toContain(':root:not([data-theme="dark"])');
    // The lock wording is gone from every theme location.
    expect(md).not.toContain("No independent theme toggle");
    expect(md).not.toContain("navbar theme button");
    // Narrowed: `switcher` alone is legitimate — the
    // WorkspaceSwitcher control — so this pin names only the retired
    // theme-toggle wording (case-insensitively, so a re-capitalised
    // restatement cannot slip past the literal pins above).
    expect(md.toLowerCase()).not.toMatch(
      /no independent theme toggle|navbar theme button|do not introduce a theme toggle/,
    );
    expect(md).not.toContain("Do not introduce a theme toggle");
  });
});

describe("SSR STYLE token parity", () => {
  function cssCustomPropertiesFromBlock(block: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const m of block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/gi)) {
      out[m[1]!] = m[2]!.trim();
    }
    return out;
  }

  test("shared hex tokens in tokens.css match src/dashboard/views.ts STYLE", async () => {
    const css = await Bun.file(TOKENS_CSS).text();
    const views = await Bun.file(VIEWS).text();
    const styleStart = views.indexOf("const STYLE = `<style>");
    const styleEnd = views.indexOf("`;", styleStart);
    expect(styleStart).toBeGreaterThan(0);
    const style = views.slice(styleStart, styleEnd);

    const cssRoot = cssCustomPropertiesFromBlock(extractBlock(css, ":root {"));
    const cssLight = cssCustomPropertiesFromBlock(extractBlock(css, ':root[data-theme="light"] {'));
    // v0.3.4: the SSR STYLE has two branches — dark :root default and the
    // stored-light attribute; the OS-light media branch is deleted.
    const ssrLightAt = style.indexOf(':root[data-theme="light"] {');
    const ssrRoot = cssCustomPropertiesFromBlock(style.slice(0, ssrLightAt));
    const ssrLight = cssCustomPropertiesFromBlock(style.slice(ssrLightAt));

    for (const [name, value] of Object.entries(ssrRoot)) {
      if (/^#[0-9a-f]{3,8}$/i.test(value)) {
        expect(cssRoot[name]).toBe(value);
      }
    }
    for (const [name, value] of Object.entries(ssrLight)) {
      if (/^#[0-9a-f]{3,8}$/i.test(value)) {
        expect(cssLight[name]).toBe(value);
      }
    }
  });

  test("shared radius tokens in views.ts STYLE match tokens.css (three-site covenant)", async () => {
    const css = await Bun.file(TOKENS_CSS).text();
    const views = await Bun.file(VIEWS).text();
    const styleStart = views.indexOf("const STYLE = `<style>");
    const styleEnd = views.indexOf("`;", styleStart);
    const style = views.slice(styleStart, styleEnd);

    const cssRoot = cssCustomPropertiesFromBlock(extractBlock(css, ":root {"));
    const ssrRoot = cssCustomPropertiesFromBlock(style.slice(0, style.indexOf(':root[data-theme="light"] {')));

    // The stylesheet aliases the legacy radius names onto the semantic tiers
    // while the SSR face still writes the raw value, so compare what each
    // resolves to — `var()` chains followed, not the declaration strings.
    const resolve = (vars: Record<string, string>, name: string): string | undefined => {
      let value = vars[name];
      for (let hop = 0; hop < 8 && value !== undefined; hop += 1) {
        const ref = /^var\(--([a-z0-9-]+)\)$/.exec(value)?.[1];
        if (ref === undefined) break;
        value = vars[ref];
      }
      return value;
    };

    for (const name of ["rounded-sm", "rounded-md"]) {
      expect(resolve(cssRoot, name), `--${name}`).toBe(ssrRoot[name]);
    }
  });

  test("component var references stay synced: both faces paint the same primary fill", async () => {
    const css = await Bun.file(TOKENS_CSS).text();
    const views = await Bun.file(VIEWS).text();
    const styleStart = views.indexOf("const STYLE = `<style>");
    const style = views.slice(styleStart, views.indexOf("`;", styleStart));

    const cssRoot = cssCustomPropertiesFromBlock(extractBlock(css, ":root {"));
    const cssLight = cssCustomPropertiesFromBlock(extractBlock(css, ':root[data-theme="light"] {'));
    const ssrRoot = cssCustomPropertiesFromBlock(style.slice(0, style.indexOf(':root[data-theme="light"] {')));
    const ssrStoredLight = cssCustomPropertiesFromBlock(extractBlock(style, ':root[data-theme="light"] {'));

    // The SPA face names the accent job (`tone-accent-solid`); the SSR face,
    // which a later plan migrates, still names the step that job resolves
    // to. Both must land on the same colour, so follow the references
    // instead of pinning one spelling of them.
    const paint = (vars: Record<string, string>, name: string): string | undefined => {
      let value = vars[name];
      for (let hop = 0; hop < 8; hop += 1) {
        const ref = value === undefined ? undefined : /^var\(--([a-z0-9-]+)\)$/.exec(value)?.[1];
        if (ref === undefined) break;
        value = vars[ref];
      }
      return value;
    };

    // The light branch only re-declares what differs, so resolving a light
    // value means reading it over the dark cascade.
    const lightCascade = { ...cssRoot, ...cssLight };

    expect(cssRoot["button-primary-bg"], "tokens.css primary").toBe("var(--tone-accent-solid)");
    expect(ssrRoot["button-primary-bg"], "SSR primary").toBe("var(--brand-700)");
    expect(paint(cssRoot, "button-primary-bg"), "dark primary paint").toBe(ssrRoot["brand-700"]);
    expect(paint(lightCascade, "button-primary-bg"), "light primary paint").toBe(cssLight["brand-700"]);
    expect(ssrStoredLight["brand-700"], "SSR stored-light brand-700").toBe(cssLight["brand-700"]);
  });
});

