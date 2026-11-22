import {
  existsSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, test } from "bun:test";

import { survivorSteps } from "../../src/design-system/tokens";
import {
  SPA_ROOT,
  consumerWalk,
  documentSync,
  danglingReferences,
  parseFixture,
  rootsWithoutConsumers,
} from "../../scripts/design-system-check";

const DESIGN = new URL("../../DESIGN.md", import.meta.url);
const TOKENS_CSS = new URL("../../src/spa/styles/tokens.css", import.meta.url);
const FIXTURE_PATH = new URL("../../src/design-system/fixture.json", import.meta.url);
const VIEWS = new URL("../../src/dashboard/views.ts", import.meta.url);

const THEME_MECHANISM = "manual data-theme override (navbar toggle); unset = dark default";
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
const PALETTE_STEP = /^(?:background-\d00|gray-\d{3,4}|gray-alpha-\d{3,4}|brand-\d00|blue-\d00|red-\d{3,4}|amber-\d{3,4}|green-\d{3,4}|teal-\d00|purple-\d{3,4}|pink-\d{3,4})$/;
const REF = /^\{([a-z]+)\.([^}]+)\}$/;

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
const resolve = (vars: Record<string, string>, name: string): string => {
  let value = vars[name]!;
  for (let hop = 0; hop < 8 && value.startsWith("var("); hop += 1) {
    value = vars[/^var\(--([a-z0-9-]+)\)$/.exec(value)?.[1] as string]!;
  }
  return value;
};

type DesignFrontmatter = {
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

const DARK_SEMANTIC = FIXTURE.dark?.semantic!;
const LIGHT_SEMANTIC = FIXTURE.light?.semantic!;
const DARK_PRIMITIVE = FIXTURE.dark?.primitive!;
const LIGHT_PRIMITIVE = FIXTURE.light?.primitive!;
const DARK_COMPONENT = FIXTURE.dark?.component!;

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


function liveColorNames(theme: (typeof THEMES)[number]): string[] {
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
      expect(Object.keys(declared).sort(), `${theme} names`).toEqual([...live].sort());
      for (const name of live) {
        expect(declared[name], `${theme} ${name}`).toBe(FIXTURE_COLORS[theme][name]);
      }
    }
    expect(fm.colors).toEqual(fm.themes.dark.colors);
  });

  test("the palette the document carries is the 26 D14 survivors", async () => {
    const fm = await loadFrontmatter();
    const expected = [...survivorSteps].sort();
    const declared = Object.keys(fm.themes.dark.colors).filter((name) => PALETTE_STEP.test(name)).sort();
    expect(declared).toEqual(expected);
  });

  test("typography, spacing, radius, motion and elevation match the fixture", async () => {
    const fm = await loadFrontmatter();
    const sem = DARK_SEMANTIC;
    const light = LIGHT_SEMANTIC;

    for (const [name, value] of Object.entries(sem)) {
      const typo = /^typo-(.+)-(family|size|weight|line|tracking)$/.exec(name);
      if (!typo) continue;
      const prop = TYPO_PROP[typo[2] as string];
      if (prop === undefined) throw new Error(`unknown typography property in ${name}`);
      const held = fm.typography[typo[1]!]?.[prop];
      expect(held, name).toBeDefined();
      expect(String(held), name).toBe(value);
    }
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
    for (const name of [
      "button-primary", "button-secondary", "button-ghost", "button-danger", "button-disabled",
      "button-sm", "button-xs", "input", "card", "group-card", "list-row", "step-dialog",
    ]) {
      expect(fm.components[name], name).toBeDefined();
    }
  });

  test("the button size faces restate the component layer's geometry", async () => {
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
    const version = String(fm.version);
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

    const darkBlock = extractBlock(css, ":root {");
    const lightBlock = extractBlock(css, ':root[data-theme="light"] {');
    expect(css).not.toContain("prefers-color-scheme");
    expect(css).not.toContain(':root:not([data-theme="dark"])');

    expect(darkBlock).toContain("color-scheme: dark");
    expect(lightBlock).toContain("color-scheme: light");

    const darkVars = cssCustomProperties(darkBlock);
    const lightVars = cssCustomProperties(lightBlock);

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

  test("semantic and component names are present on :root, and no alias scaffold survives", async () => {
    const css = await Bun.file(TOKENS_CSS).text();
    const rootVars = cssCustomProperties(extractBlock(css, ":root {"));

    expect(rootVars["spacing-24"]).toBe("96px");
    expect(rootVars["control-h-md"]).toBe("40px");
    expect(rootVars["radius-control"]).toBe("8px");
    expect(rootVars["radius-container"]).toBe("12px");
    expect(rootVars["typo-heading-24-size"]).toBe("24px");
    expect(rootVars["button-primary-bg"]).toBe("var(--tone-accent-solid)");
    expect(rootVars["button-primary-fg"]).toBe("var(--on-brand)");
    expect(rootVars["card-bg"]).toBe("var(--surface-card)");
    expect(rootVars["rounded-sm"]).toBeUndefined();
    expect(rootVars["rounded-md"]).toBeUndefined();
    expect(rootVars["button-primary-height"]).toBeUndefined();
    expect(rootVars["notice-error-fg"]).toBeUndefined();
    expect(rootVars["sidebar-active-bg"]).toBeUndefined();
  });

  test("motion and elevation land in tokens.css with the reduced-motion fold", async () => {
    const css = await Bun.file(TOKENS_CSS).text();
    const darkVars = cssCustomProperties(extractBlock(css, ":root {"));
    const lightVars = cssCustomProperties(extractBlock(css, ':root[data-theme="light"] {'));

    expect(darkVars["duration-fast"]).toBe("120ms");
    expect(darkVars["ease-in-out"]).toBe("cubic-bezier(0.65, 0, 0.35, 1)");
    expect(darkVars["shadow-pop"]).toBe("0 8px 24px #02061799, 0 2px 6px #02061766");
    expect(lightVars["shadow-pop"]).toBe("0 8px 24px #1019281f, 0 2px 6px #10192814");

    const reduceVars = cssCustomProperties(extractBlock(css, "@media (prefers-reduced-motion: reduce) {"));
    expect(reduceVars["duration-fast"]).toBe("1ms");
    expect(reduceVars["duration-base"]).toBe("1ms");
    expect(reduceVars["duration-slow"]).toBe("1ms");
  });
});

describe("Appendix A contrast dispositions (D16)", () => {
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
    for (const meaning of ["neutral", "accent", "success", "warn", "danger"]) {
      const dark = fm.themes.dark.colors;
      expect(ratio(dark["surface-page"]!, dark[`tone-${meaning}-solid`]!), `dark ${meaning} solid`).toBeGreaterThanOrEqual(4.5);
    }
    const light = fm.themes.light.colors;
    expect(ratio(light["surface-page"]!, light["tone-accent-solid"]!), "light accent solid").toBeGreaterThanOrEqual(4.5);
    expect(ratio(light["surface-page"]!, light["tone-danger-solid"]!), "light danger solid").toBeGreaterThanOrEqual(4.5);
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
        expect(ratio(c[`chart-${n}-mark`]!, c["surface-card"]!), `${theme} chart-${n}-mark`).toBeGreaterThanOrEqual(3);
      }
    }
  });
});

describe("DESIGN.md v0.3 bridge re-point + base-component restyle", () => {
  const BRIDGE = new URL("../../src/spa/styles/shadcn-theme.css", import.meta.url);
  const PRIMITIVES_DIR = fileURLToPath(new URL("../../src/design-system/primitives/", import.meta.url));
  const SUBSET = ["button", "card", "input", "table", "skeleton", "tabs", "sidebar", "select", "dropdown-menu", "dialog"];

  test("the theme entry names the design-system tier Tailwind cannot scan on its own", async () => {
    const css = await Bun.file(BRIDGE).text();
    const directives = [...css.matchAll(/@source\s+"([^"]+)"/g)].map((match) => match[1] ?? "");
    expect(directives, "@source directives in shadcn-theme.css").toHaveLength(1);
    const [directive = ""] = directives;
    const target = new URL(directive, BRIDGE);
    expect(
      fileURLToPath(target).startsWith(fileURLToPath(new URL("../../src/spa/", import.meta.url))),
      `${target} sits inside the automatic scan base, so the directive is a no-op`,
    ).toBe(false);
    for (const tier of ["primitives", "patterns"]) {
      const child = new URL(`${directive}/${tier}/index.ts`, BRIDGE);
      expect(existsSync(child), `${child}`).toBe(true);
    }
  });

  test("bridge re-point: every value is a semantic token; focus stays on the blue duty", async () => {
    const css = await Bun.file(BRIDGE).text();
    const rootVars = cssCustomProperties(extractBlock(css, ":root {"));
    expect(rootVars["primary"]).toBe("var(--button-primary-bg)");
    expect(rootVars["primary-hover"]).toBe("var(--button-primary-hover-bg)");
    expect(rootVars["primary-foreground"]).toBe("var(--button-primary-fg)");
    expect(rootVars["secondary-hover"]).toBe("var(--surface-overlay)");
    expect(rootVars["muted"]).toBe("var(--surface-inset)");
    expect(rootVars["border"]).toBe("var(--border-default)");
    expect(rootVars["destructive"]).toBe("var(--tone-danger-solid)");
    expect(rootVars["sidebar-primary"]).toBe("var(--tone-accent-solid)");
    expect(rootVars["ring"]).toBe("var(--focus-ring)");
    expect(rootVars["sidebar-ring"]).toBe("var(--focus-ring)");

    expect(css).not.toMatch(/var\(--(?:background|gray|brand|red|blue|amber|green|teal|pink|purple)-/);

    expect(rootVars["destructive-hover"]).toBe(rootVars["destructive"]);
    const guarded = extractBlock(css, "@supports (color: color-mix(in srgb, red, blue)) {");
    expect(cssCustomProperties(guarded)["destructive-hover"]).toContain("color-mix(");

    const themeVars = cssCustomProperties(extractBlock(css, "@theme inline {"));
    expect(themeVars["color-primary-hover"]).toBe("var(--primary-hover)");
    expect(themeVars["color-secondary-hover"]).toBe("var(--secondary-hover)");
    expect(themeVars["color-destructive-hover"]).toBe("var(--destructive-hover)");
    expect(themeVars["color-sidebar-accent"]).toBe("var(--sidebar-accent)");
  });

  test("every reference the hand-written stylesheets, shells and modules consume still names a token", () => {
    const walk = consumerWalk();
    const consumers = walk.files;
    expect(consumers.length).toBeGreaterThan(0);
    expect(consumers.some((file) => file.endsWith(".tsx"))).toBe(true);
    expect(walk.failures).toEqual([]);
    const root = fileURLToPath(new URL("../../", import.meta.url));
    const missing = join(root, "src/does-not-exist");
    expect(rootsWithoutConsumers(consumerWalk([missing]).roots)).toEqual(["src/does-not-exist"]);
    expect(rootsWithoutConsumers(consumerWalk([SPA_ROOT]).roots)).toEqual([]);
    expect(() => consumerWalk(["src/spa"])).toThrow(/must be absolute/);
    for (const file of consumers) {
      const css = readFileSync(new URL(`../../${file}`, import.meta.url), "utf8");
      expect(danglingReferences(file, css), file).toEqual([]);
    }
    const probe = danglingReferences(
      "probe.css",
      [
        ":root {",
        "  --local: var(--surface-page);",
        "  --family: var(--font-sans);",
        "  --hop: var(--local);",
        "  /* --retired-900: #fff; */",
        "  --fallback: var(--retired-900, #fff);",
        "}",
      ].join("\n"),
    );
    expect(probe.map(({ name, theme }) => `${theme}:${name}`)).toEqual([
      "dark:retired-900",
      "light:retired-900",
    ]);
    const htmlNames = (html: string) => [
      ...new Set(danglingReferences("probe.html", html).map(({ name }) => name)),
    ];
    expect(
      htmlNames('<!-- legacy: var(--retired-900) --><div style="color: var(--surface-page)"></div>'),
    ).toEqual([]);
    expect(htmlNames('<div style="color: var(--retired-900)"></div>')).toEqual(["retired-900"]);
    expect(
      htmlNames("<style>/* var(--retired-900) */ .a { color: var(--surface-page); }</style>"),
    ).toEqual([]);
    const moduleNames = (tsx: string) => [
      ...new Set(danglingReferences("probe.tsx", tsx).map(({ name }) => name)),
    ];
    expect(moduleNames('a = "bg-(--surface-page) rounded-(--radius-pill)"')).toEqual([]);
    expect(moduleNames('a = "text-(length:--typo-label-12-size)"')).toEqual([]);
    expect(moduleNames('a = "bg-(--retired-900)"')).toEqual(["retired-900"]);
    expect(moduleNames('a = "border-l-(--tone-${tone}-fg)"')).toEqual([]);
    expect(moduleNames('// var(--retired-900)\na = "bg-(--surface-page)"')).toEqual([
      "retired-900",
    ]);
    expect(moduleNames('const n = 1;// bg-(--retired-900)')).toEqual(["retired-900"]);
    expect(moduleNames('f()// bg-(--retired-900)')).toEqual(["retired-900"]);
    expect(
      moduleNames('const t = `${x /* bg-(--retired-900) */}`; k = "bg-(--surface-page)"'),
    ).toEqual(["retired-900"]);
    expect(moduleNames('/* --retired-900: #fff; */ a = "bg-(--retired-900)"')).toEqual([
      "retired-900",
    ]);
    expect(moduleNames('a = "bg-(--retired-900)"; // --retired-900: #fff')).toEqual([
      "retired-900",
    ]);
    expect(moduleNames('/*\n --retired-900: #fff;\n*/\na = "bg-(--retired-900)"')).toEqual([
      "retired-900",
    ]);
    expect(
      moduleNames('const u = "https://api.example.com"; const k = "bg-(--retired-900)";'),
    ).toEqual(["retired-900"]);
    expect(moduleNames('const u = " // "; const k = "bg-(--retired-900)";')).toEqual(["retired-900"]);
    expect(moduleNames("const u = ' // '; const k = 'bg-(--retired-900)';")).toEqual(["retired-900"]);
    expect(moduleNames('const t = `a // b`; const k = "bg-(--retired-900)"')).toEqual(["retired-900"]);
    expect(moduleNames('const r = /[ //]/; const k = "bg-(--retired-900)"')).toEqual(["retired-900"]);
    expect(moduleNames('if (ok) /[//]/.test(value); const k = "bg-(--retired-900)"')).toEqual([
      "retired-900",
    ]);
    expect(moduleNames('return /[//]/.test(value) ? "bg-(--retired-900)" : ""')).toEqual([
      "retired-900",
    ]);
    expect(
      moduleNames('for await (const r of rs) /[//]/.test(r); k = "bg-(--retired-900)"'),
    ).toEqual(["retired-900"]);
    expect(moduleNames('const t = `a ${x} // b`; const k = "bg-(--retired-900)"')).toEqual([
      "retired-900",
    ]);
    expect(moduleNames('<p>a // b</p><div className="bg-(--retired-900)" />')).toEqual([
      "retired-900",
    ]);
    expect(moduleNames('const view = <div className={`\n// bg-(--retired-900)\n`} />;')).toEqual([
      "retired-900",
    ]);
    expect(
      moduleNames('const open = "/*"; const k = "bg-(--retired-900)"; const close = "*/";'),
    ).toEqual(["retired-900"]);
    expect(
      moduleNames(
        'const css = `:root { --retired-900: url(https://example.test) var(--retired-900); }`;',
      ),
    ).toEqual(["retired-900"]);
  });

  test("an unreadable consumer is a reported failure, never a thrown run", () => {
    const dir = mkdtempSync(join(tmpdir(), "consumer-root-"));
    try {
      writeFileSync(join(dir, "ok.css"), ":root { color: var(--surface-page); }");
      symlinkSync(join(dir, "gone"), join(dir, "broken.css"));
      const walk = consumerWalk([dir]);
      expect(walk.files.some((file) => file.endsWith("ok.css"))).toBe(true);
      expect(walk.failures).toHaveLength(1);
      expect(walk.failures[0]).toContain("broken.css");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the walk and the stripper read an extension's case the same way (I-000352)", () => {
    const dir = mkdtempSync(join(tmpdir(), "consumer-root-"));
    try {
      const entry = join(dir, "Card.CSS");
      writeFileSync(entry, "/* var(--retired-900) */\n:root { color: var(--surface-page); }");
      const walk = consumerWalk([dir]);
      expect(walk.files).toHaveLength(1);
      const file = walk.files[0] as string;
      expect(file.endsWith("Card.CSS")).toBe(true);
      expect(danglingReferences(file, readFileSync(entry, "utf8"))).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("an unreadable root reports unreadability, never emptiness", () => {
    const dir = mkdtempSync(join(tmpdir(), "consumer-root-"));
    try {
      const file = join(dir, "not-a-directory.css");
      writeFileSync(file, ":root { color: var(--surface-page); }");
      const walk = consumerWalk([file]);
      expect(walk.files).toEqual([]);
      expect(walk.roots).toHaveLength(1);
      expect(walk.roots[0]?.consumers).toBe(0);
      expect(walk.roots[0]?.failure).toContain("unreadable");
      expect(walk.failures).toHaveLength(1);
      expect(walk.failures[0]).toContain("unreadable");
      expect(rootsWithoutConsumers(walk.roots)).toEqual([]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a declaration no longer excuses its own dangling reference (I-000248)", () => {
    const names = (css: string) =>
      danglingReferences("probe.css", css).map(({ theme, name }) => `${theme}:${name}`);
    expect(names(":root { --x: var(--x); }")).toEqual(["dark:x", "light:x"]);
    expect(names(":root { --x: var(--x, #fff); }")).toEqual(["dark:x", "light:x"]);
    expect(names(":root { --genuine: #fff; } .a { color: var(--genuine); }")).toEqual([]);
    expect(names(":root { --x: var(--x); --x: #fff; } .a { color: var(--x); }")).toEqual([]);
    expect(names(":root { --x: var( --x ); }")).toEqual(["dark:x", "light:x"]);
    expect(names(":root { --x: var( --x , #fff ); }")).toEqual(["dark:x", "light:x"]);
    expect(names(":root { --fallback: var( --retired-900 , #fff ); }")).toEqual([
      "dark:retired-900",
      "light:retired-900",
    ]);
    expect(names(":root { --genuine: #fff; } .a { color: var( --genuine ); }")).toEqual([]);
  });

  test("the primary bridge resolves to the accent pair off the ops surface", async () => {
    const bridge = cssCustomProperties(extractBlock(await Bun.file(BRIDGE).text(), ":root {"));
    const tokens = await Bun.file(TOKENS_CSS).text();
    const dark = { ...bridge, ...cssCustomProperties(extractBlock(tokens, ":root {")) };
    const light = { ...dark, ...cssCustomProperties(extractBlock(tokens, ':root[data-theme="light"] {')) };
    for (const [theme, vars] of [["dark", dark], ["light", light]] as const) {
      expect(resolve(vars, "primary"), `${theme} --primary`).toBe(resolve(vars, "tone-accent-solid"));
      expect(resolve(vars, "primary-foreground"), `${theme} --primary-foreground`).toBe(
        resolve(vars, "on-brand"),
      );
    }
  });

  test("radius bridge collapses onto the AD-574 two tiers; tokens button maps the accent tone", async () => {
    const css = await Bun.file(BRIDGE).text();
    const themeVars = cssCustomProperties(extractBlock(css, "@theme inline {"));
    expect(themeVars["radius-sm"]).toBe("var(--radius-control)");
    expect(themeVars["radius-md"]).toBe("var(--radius-container)");
    expect(themeVars["radius-lg"]).toBe("var(--radius-container)");
    expect(themeVars["radius-xl"]).toBe("var(--radius-container)");

    const tokens = await Bun.file(TOKENS_CSS).text();
    expect(cssCustomProperties(extractBlock(tokens, ":root {"))["button-primary-bg"]).toBe(
      "var(--tone-accent-solid)",
    );
  });

  test("the destructive hover is a distinct face in both themes, and keeps its label readable", async () => {
    const bridgeVars = cssCustomProperties(extractBlock(await Bun.file(BRIDGE).text(), ":root {"));
    const tokens = await Bun.file(TOKENS_CSS).text();
    const dark = cssCustomProperties(extractBlock(tokens, ":root {"));
    const light = { ...dark, ...cssCustomProperties(extractBlock(tokens, ':root[data-theme="light"] {')) };
    const destructiveVariant = /destructive:\s*\n?\s*"([^"]+)"/.exec(await Bun.file(join(PRIMITIVES_DIR, "button.tsx")).text())?.[1];
    if (destructiveVariant === undefined) throw new Error("button.tsx declares no destructive variant");
    const fillClass = /(?:^|\s)bg-([a-z][a-z0-9-]*)(?=\s|$)/.exec(destructiveVariant)?.[1];
    const labelClass = /(?:^|\s)text-([a-z][a-z0-9-]*)(?=\s|$)/.exec(destructiveVariant)?.[1];
    expect(fillClass, "destructive variant must paint a token fill").toBeDefined();
    expect(labelClass, "destructive variant must paint a token label").toBeDefined();
    expect(
      destructiveVariant,
      "no authored `dark:` split — the token cascade is the one theme mechanism; the variant would follow data-theme but still bypass the tokens",
    ).not.toContain("dark:");

    const hoverExpression =
      cssCustomProperties(
        extractBlock(await Bun.file(BRIDGE).text(), "@supports (color: color-mix(in srgb, red, blue)) {"),
      )["destructive-hover"]!;
    const weightPercent = /color-mix\(in srgb,\s*var\(--tone-danger-solid\)\s+(\d+)%,\s*var\(--text-primary\)\)/
      .exec(hoverExpression)?.[1];
    expect(weightPercent, "destructive hover must derive from the solid and the label face").toBeDefined();
    expect(bridgeVars["destructive"]).toBe("var(--tone-danger-solid)");
    expect(bridgeVars["destructive-hover"]).toBe("var(--tone-danger-solid)");

    const blend = (solid: string, label: string, weight: number): string => {
      const [s, t] = [srgb(solid), srgb(label)];
      return `#${s
        .map((c, i) => Math.round((c * weight + t[i]! * (1 - weight)) * 255).toString(16).padStart(2, "0"))
        .join("")}`;
    };

    for (const vars of [dark, light]) {
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
      expect(source, name).toContain("Locally revised shadcn/ui copy-in (v0.3 restyle;");
      expect(source, name).not.toContain("transition-all");
    }

    const button = await Bun.file(join(PRIMITIVES_DIR, "button.tsx")).text();
    expect(button).toContain("rounded-sm");
    expect(button).not.toContain("rounded-md");
    expect(button).toContain("duration-(--duration-base)");
    expect(button).toContain("ease-(--ease-in-out)");
    expect(button).not.toMatch(/--(?:background|gray|brand|blue|red|amber|green|purple|teal|pink)-/);

    const card = await Bun.file(join(PRIMITIVES_DIR, "card.tsx")).text();
    expect(card).not.toMatch(/(?:^|["\s])shadow-/);

    for (const name of ["dropdown-menu", "select", "dialog"]) {
      const source = await Bun.file(join(PRIMITIVES_DIR, `${name}.tsx`)).text();
      expect(source, name).toMatch(/shadow-\(--[a-z0-9-]+\)/);
      expect(source, name).not.toMatch(/shadow-(md|lg)\b/);
    }

    const input = await Bun.file(join(PRIMITIVES_DIR, "input.tsx")).text();
    expect(input).toContain("rounded-sm");
    for (const name of ["input", "select"]) {
      const source = await Bun.file(join(PRIMITIVES_DIR, `${name}.tsx`)).text();
      expect(source, name).not.toMatch(/hover:border-/);
    }

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
    for (const name of ["toggle", "sheet"] as const) {
      const source = await Bun.file(join(PRIMITIVES_DIR, `${name}.tsx`)).text();
      expect(source, name).toContain("Locally revised shadcn/ui copy-in (motion-token sweep");
    }
  });
});

describe("DESIGN.md self-hosted Geist Sans typeface (AD-572)", () => {
  const FONTS_CSS = new URL("../../src/spa/styles/fonts.css", import.meta.url);
  const FONT_DIR = fileURLToPath(new URL("../../src/spa/assets/fonts/", import.meta.url));
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
    const { errorPage } = await import("../../src/dashboard/views");

    for (const [name, fields] of Object.entries(fm.typography)) {
      if (name === "mono-13") continue;
      expect(fields.fontFamily, name).toBe(GEIST_STACK);
    }
    expect(fm.typography["mono-13"]!.fontFamily).toBe(MONO_STACK);

    expect(cssCustomProperties(extractBlock(css, ":root {"))["font-sans"]).toBe(GEIST_STACK);

    const html = errorPage("boom");
    const style = html.slice(html.indexOf("<style>"), html.indexOf("</style>"));
    expect(style.match(/--font-sans: ([^;]+);/)?.[1]).toBe(GEIST_STACK);
  });

  test("vendored binaries are real woff2, inside the 150KB budget, with the OFL license", () => {
    expect(readdirSync(FONT_DIR)).toContain("OFL.txt");
    expect(readdirSync(FONT_DIR).filter((f) => f.endsWith(".woff2")).sort()).toEqual(VENDORED);

    let total = 0;
    for (const file of VENDORED) {
      const path = join(FONT_DIR, file);
      expect(readFileSync(path).subarray(0, 4).toString("latin1")).toBe("wOF2");
      total += statSync(path).size;
    }
    expect(total, `${total} bytes of woff2 vs the 150KB budget`).toBeLessThanOrEqual(150_000);
  });
});

describe("DESIGN.md theme contract", () => {
  test("manual navbar-toggle override documented with the dated supersede note", async () => {
    const md = await Bun.file(DESIGN).text();
    expect(md).toContain('localStorage["mstar.dashboard.theme"]');
    expect(md).toContain("documentElement.dataset.theme");
    expect(md).toContain(SUPERSEDE_NOTE);
    expect(md).toContain(':root[data-theme="light"]');
    expect(md).not.toContain(':root:not([data-theme="dark"])');
    expect(md).not.toContain("No independent theme toggle");
    expect(md).not.toContain("navbar theme button");
    expect(md.toLowerCase()).not.toMatch(
      /no independent theme toggle|navbar theme button|do not introduce a theme toggle/,
    );
    expect(md).not.toContain("Do not introduce a theme toggle");
  });
});

describe("SSR STYLE token parity", () => {
  async function ssrStyle(): Promise<string> {
    const { errorPage } = await import("../../src/dashboard/views");
    const html = errorPage("boom");
    const start = html.indexOf("<style>");
    const end = html.indexOf("</style>");
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    return html.slice(start, end);
  }

  function ssrBlocks(style: string): { dark: Record<string, string>; light: Record<string, string> } {
    const lightAt = style.indexOf(':root[data-theme="light"] {');
    expect(lightAt).toBeGreaterThan(0);
    return {
      dark: cssCustomProperties(style.slice(0, lightAt)),
      light: cssCustomProperties(extractBlock(style.slice(lightAt), ':root[data-theme="light"] {')),
    };
  }

  test("every declared token carries the value tokens.css resolves to, in its own theme", async () => {
    const style = await ssrStyle();
    const { dark: ssrDark, light: ssrLight } = ssrBlocks(style);
    const css = await Bun.file(TOKENS_CSS).text();
    const cssRoot = cssCustomProperties(extractBlock(css, ":root {"));
    const cssLight = cssCustomProperties(extractBlock(css, ':root[data-theme="light"] {'));
    const lightCascade = { ...cssRoot, ...cssLight };

    const names = Object.keys(ssrDark).filter((name) => name !== "focus-halo");
    const painted = [...new Set([...style.matchAll(/var\(--([a-z0-9-]+)\)/g)].map((m) => m[1] as string))];
    expect(painted.filter((name) => !names.includes(name))).toEqual(["focus-halo"]);
    for (const theme of THEMES) {
      const declared = new Set(Object.values(FIXTURE[theme]).flatMap((layer) => Object.keys(layer)));
      expect(
        names.filter((name) => !declared.has(name)),
        `${theme} declares no such token`,
      ).toEqual([]);
    }
    for (const name of names) {
      const dark = ssrDark[name] as string;
      const light = ssrLight[name];
      expect(resolve(cssRoot, name), `dark --${name}`).toBe(dark);
      if (light === undefined) {
        expect(resolve(lightCascade, name), `light --${name} (not re-declared)`).toBe(dark);
      } else {
        expect(light, `light --${name}`).toBe(resolve(lightCascade, name));
      }
    }
  });

  test("every token the stylesheet paints with is one it declares", async () => {
    const style = await ssrStyle();
    const { dark, light } = ssrBlocks(style);
    const declared = new Set([...Object.keys(dark), ...Object.keys(light)]);
    const used = [...new Set([...style.matchAll(/var\(--([a-z0-9-]+)\)/g)].map((m) => m[1] as string))];
    expect(used.length, "the stylesheet references no token").toBeGreaterThan(20);
    expect(used.filter((name) => !declared.has(name))).toEqual([]);
  });

  test("both faces paint the same primary fill from the component layer", async () => {
    const { dark: ssrDark, light: ssrLight } = ssrBlocks(await ssrStyle());
    const css = await Bun.file(TOKENS_CSS).text();
    const cssRoot = cssCustomProperties(extractBlock(css, ":root {"));
    const cssLight = cssCustomProperties(extractBlock(css, ':root[data-theme="light"] {'));
    const lightCascade = { ...cssRoot, ...cssLight };

    expect(cssRoot["button-primary-bg"]).toBe("var(--tone-accent-solid)");
    expect(resolve(ssrDark, "button-primary-bg")).toBe(resolve(cssRoot, "button-primary-bg"));
    expect(resolve({ ...ssrDark, ...ssrLight }, "button-primary-bg")).toBe(
      resolve(lightCascade, "button-primary-bg"),
    );
  });
});
