/**
 * Plan 29 Task 1: DESIGN.md L2 dual-theme tokens ↔ src/spa/styles/tokens.css.
 *
 * Locked contract:
 *   - version 0.2.0, defaultTheme dark, prefers-color-scheme light
 *   - L1 token names kept; original light hexes live on themes.light
 *   - top-level colors: === themes.dark.colors
 *   - both theme palettes share the same key set
 *   - tokens.css :root maps dark values; light media query maps light values
 *   - no data-theme attribute selector (no theme toggle)
 */
import { describe, expect, test } from "bun:test";

const DESIGN = new URL("../../DESIGN.md", import.meta.url);
const TOKENS_CSS = new URL("../../src/spa/styles/tokens.css", import.meta.url);

const KEPT_LIGHT: Record<string, string> = {
  "background-100": "#ffffff",
  "background-200": "#f4f4f5",
  "gray-1000": "#111111",
  "gray-900": "#3d3d3d",
  "blue-700": "#0066cc",
  "red-700": "#b91c1c",
  "amber-700": "#b45309",
};

const L2_ACCENTS = ["blue", "red", "amber", "green", "teal", "purple", "pink"] as const;
const L2_ACCENT_STEPS = ["700", "800", "900", "1000"] as const;
const TYPO_FIELDS = ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing"] as const;

type DesignFrontmatter = {
  version: string;
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
  components: Record<string, Record<string, string | number>>;
};

async function loadFrontmatter(): Promise<DesignFrontmatter> {
  const md = await Bun.file(DESIGN).text();
  const match = md.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error("DESIGN.md is missing YAML frontmatter");
  return Bun.YAML.parse(match[1]) as DesignFrontmatter;
}

function cssCustomProperties(block: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const m of block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)) {
    out[m[1]] = m[2].trim();
  }
  return out;
}

describe("DESIGN.md L2 dual-theme tokens", () => {
  test("frontmatter version, default theme, and L1 name continuity", async () => {
    const fm = await loadFrontmatter();
    expect(fm.version).toBe("0.2.0");
    expect(fm.defaultTheme).toBe("dark");
    expect(fm.themeMechanism).toBe("prefers-color-scheme");
    expect(fm.themes.default).toBe("dark");
    expect(fm.themes.mechanism).toBe("prefers-color-scheme");

    for (const name of Object.keys(KEPT_LIGHT)) {
      expect(fm.colors[name]).toBeDefined();
      expect(fm.themes.dark.colors[name]).toBeDefined();
      expect(fm.themes.light.colors[name]).toBe(KEPT_LIGHT[name]);
    }
  });

  test("colors: is the dark default and both themes share keys", async () => {
    const fm = await loadFrontmatter();
    expect(fm.colors).toEqual(fm.themes.dark.colors);
    const darkKeys = Object.keys(fm.themes.dark.colors).sort();
    const lightKeys = Object.keys(fm.themes.light.colors).sort();
    expect(darkKeys).toEqual(lightKeys);
    expect(darkKeys.length).toBeGreaterThanOrEqual(90);
  });

  test("Level 2 color / type / spacing / rounded / component inventory", async () => {
    const fm = await loadFrontmatter();
    for (const step of ["100", "200", "300"]) {
      expect(fm.colors[`background-${step}`]).toMatch(/^#/);
    }
    for (let n = 100; n <= 1000; n += 100) {
      expect(fm.colors[`gray-${n}`]).toMatch(/^#/);
    }
    for (let n = 100; n <= 600; n += 100) {
      expect(fm.colors[`gray-alpha-${n}`]).toMatch(/^#/);
    }
    for (const accent of L2_ACCENTS) {
      for (const step of L2_ACCENT_STEPS) {
        expect(fm.colors[`${accent}-${step}`]).toMatch(/^#/);
      }
    }

    const headings = Object.keys(fm.typography).filter((k) => k.startsWith("heading-"));
    expect(headings.length).toBeGreaterThanOrEqual(3);
    expect(fm.typography["label-14"]).toBeDefined();
    expect(fm.typography["button-14"]).toBeDefined();
    for (const token of ["heading-24", "heading-16", "copy-16", "copy-14", "label-14", "button-14"]) {
      for (const field of TYPO_FIELDS) {
        expect(fm.typography[token][field]).toBeDefined();
      }
    }

    expect(fm.spacing.base).toBe("4px");
    const numbered = Object.keys(fm.spacing).filter((k) => k !== "base");
    expect(numbered.length).toBeGreaterThanOrEqual(9);
    for (const k of ["sm", "md", "lg", "full"]) {
      expect(fm.rounded[k]).toBeDefined();
    }

    for (const name of ["button-primary", "button-secondary", "button-danger", "button-disabled", "button-small", "input", "card", "badge", "table", "sidebar", "notice-success", "notice-warn", "notice-error"]) {
      expect(fm.components[name]).toBeDefined();
    }
  });
});

describe("src/spa/styles/tokens.css mapping", () => {
  test("dark :root and light media query match DESIGN.md palettes", async () => {
    const fm = await loadFrontmatter();
    const css = await Bun.file(TOKENS_CSS).text();
    expect(css).not.toMatch(/\[data-theme/);

    const mediaAt = css.indexOf("@media (prefers-color-scheme: light) {");
    expect(mediaAt).toBeGreaterThan(0);
    const rootBlock = css.slice(0, mediaAt);
    const lightBlock = css.slice(mediaAt);
    expect(rootBlock).toContain("color-scheme: dark");
    expect(lightBlock).toContain("color-scheme: light");

    const rootVars = cssCustomProperties(rootBlock);
    const lightVars = cssCustomProperties(lightBlock);

    for (const [name, value] of Object.entries(fm.themes.dark.colors)) {
      expect(rootVars[name]).toBe(value);
    }
    for (const [name, value] of Object.entries(fm.themes.light.colors)) {
      expect(lightVars[name]).toBe(value);
    }
  });

  test("spacing, rounded, and component vars are present on :root", async () => {
    const css = await Bun.file(TOKENS_CSS).text();
    const mediaAt = css.indexOf("@media (prefers-color-scheme: light) {");
    const rootVars = cssCustomProperties(css.slice(0, mediaAt));

    expect(rootVars["spacing-base"]).toBe("4px");
    expect(rootVars["spacing-24"]).toBe("96px");
    expect(rootVars["rounded-sm"]).toBe("6px");
    expect(rootVars["rounded-md"]).toBe("12px");
    expect(rootVars["rounded-lg"]).toBe("16px");
    expect(rootVars["rounded-full"]).toBe("9999px");
    expect(rootVars["button-primary-bg"]).toBe("var(--blue-700)");
    expect(rootVars["button-danger-bg"]).toBe("var(--red-700)");
    expect(rootVars["input-border"]).toBe("var(--gray-400)");
    expect(rootVars["card-bg"]).toBe("var(--background-200)");
    expect(rootVars["sidebar-bg"]).toBe("var(--background-200)");
    expect(rootVars["notice-error-fg"]).toBe("var(--red-900)");
    expect(rootVars["typo-heading-24-size"]).toBe("24px");
  });
});
