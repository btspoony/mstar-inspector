/**
 * Plan 29 Task 1: DESIGN.md L2 dual-theme tokens ↔ src/spa/styles/tokens.css.
 * Plan 57 T1: v0.3 value rebase (AD-573) — token names frozen, values swapped
 * (Signal Cyan brand, cool neutral retune, motion/elevation tokens, two-tier
 * radius per AD-571/573/574).
 *
 * Locked contract:
 *   - version 0.3.0, defaultTheme dark; the theme mechanism is the manual
 *     data-theme override (navbar toggle) with the prefers-color-scheme
 *     fallback — plan 41 T2 rewrites the frontmatter keys together with the
 *     DESIGN.md body and pins the dated plan-29 supersede note
 *   - L1 token names kept; v0.3 retunes the light neutrals (cool cast) while
 *     background-100/blue-700/red-700/amber-700 keep their recorded light hexes
 *   - top-level colors: === themes.dark.colors
 *   - both theme palettes share the same key set
 *   - tokens.css :root maps dark values; light applies via
 *     :root[data-theme="light"] plus the prefers-color-scheme fallback on
 *     :root:not([data-theme="dark"]) (plan 41 T1 — reverses the plan-29
 *     "no data-theme attribute selector" lock)
 */
import { describe, expect, test } from "bun:test";

const DESIGN = new URL("../../DESIGN.md", import.meta.url);
const TOKENS_CSS = new URL("../../src/spa/styles/tokens.css", import.meta.url);

/** Plan 41 theme mechanism — frontmatter top level and themes: stay equal. */
const THEME_MECHANISM = "manual data-theme override (navbar toggle), prefers-color-scheme fallback";
/** Dated user authorization reversing the plan-29 "no toggle" lock. */
const SUPERSEDE_NOTE = "Supersedes the plan-29 lock (2026-09-04, user instruction, iteration 013)";

/** Light hexes that survive the v0.3 retune unchanged. */
const KEPT_LIGHT: Record<string, string> = {
  "background-100": "#ffffff",
  "blue-700": "#0066cc",
  "red-700": "#b91c1c",
  "amber-700": "#b45309",
};

/** v0.3 retuned light values (cool gray/background cast — AD-571 constraint 3). */
const V03_LIGHT: Record<string, string> = {
  "background-200": "#f3f5f8",
  "gray-900": "#2f3742",
  "gray-1000": "#0f141a",
  "gray-alpha-400": "#10192824",
  "brand-700": "#0e7490",
};

const L2_ACCENTS = ["blue", "red", "amber", "green", "teal", "purple", "pink"] as const;
const L2_ACCENT_STEPS = ["700", "800", "900", "1000"] as const;
const TYPO_FIELDS = ["fontFamily", "fontSize", "fontWeight", "lineHeight", "letterSpacing"] as const;

type DesignFrontmatter = {
  version: string;
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

async function loadFrontmatter(): Promise<DesignFrontmatter> {
  const md = await Bun.file(DESIGN).text();
  const match = md.match(/^---\n([\s\S]*?)\n---\n/);
  if (!match) throw new Error("DESIGN.md is missing YAML frontmatter");
  return Bun.YAML.parse(match[1]!) as DesignFrontmatter;
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

describe("DESIGN.md L2 dual-theme tokens", () => {
  test("frontmatter version, default theme, and L1 name continuity", async () => {
    const fm = await loadFrontmatter();
    expect(fm.version).toBe("0.3.0");
    expect(fm.defaultTheme).toBe("dark");
    // Plan 41 T2: manual data-theme override (navbar toggle) with the OS
    // fallback — top-level keys and themes: keys move together.
    expect(fm.themeMechanism).toBe(THEME_MECHANISM);
    expect(fm.themes.default).toBe("dark");
    expect(fm.themes.mechanism).toBe(THEME_MECHANISM);
    // The description states the same contract and carries the supersede note.
    expect(fm.description).toContain("navbar theme toggle");
    expect(fm.description).toContain(SUPERSEDE_NOTE);

    for (const name of Object.keys(KEPT_LIGHT)) {
      expect(fm.colors[name]).toBeDefined();
      expect(fm.themes.dark.colors[name]).toBeDefined();
      expect(fm.themes.light.colors[name]).toBe(KEPT_LIGHT[name]);
    }
    for (const [name, value] of Object.entries(V03_LIGHT)) {
      expect(fm.themes.light.colors[name]).toBe(value);
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
        expect(fm.typography[token]?.[field]).toBeDefined();
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
  test("dark :root, manual light attribute, and OS-light media fallback match DESIGN.md palettes", async () => {
    const fm = await loadFrontmatter();
    const css = await Bun.file(TOKENS_CSS).text();

    // Plan 41 T1: the data-theme cascade replaces the plan-29 "no attribute
    // selector" lock — stored light wins over the OS; the OS-light fallback
    // applies only while the stored value is not dark.
    const darkBlock = extractBlock(css, ":root {");
    const lightBlock = extractBlock(css, ':root[data-theme="light"] {');
    const mediaBlock = extractBlock(css, "@media (prefers-color-scheme: light) {");
    expect(mediaBlock).toContain(':root:not([data-theme="dark"])');

    // color-scheme stays in sync per branch.
    expect(darkBlock).toContain("color-scheme: dark");
    expect(lightBlock).toContain("color-scheme: light");
    expect(mediaBlock).toContain("color-scheme: light");

    const darkVars = cssCustomProperties(darkBlock);
    const lightVars = cssCustomProperties(lightBlock);
    const mediaVars = cssCustomProperties(mediaBlock);

    for (const [name, value] of Object.entries(fm.themes.dark.colors)) {
      expect(darkVars[name]).toBe(value);
    }
    // Both light branches carry the full light palette (kept in sync).
    for (const [name, value] of Object.entries(fm.themes.light.colors)) {
      expect(lightVars[name]).toBe(value);
      expect(mediaVars[name]).toBe(value);
    }
  });

  test("spacing, rounded, and component vars are present on :root", async () => {
    const css = await Bun.file(TOKENS_CSS).text();
    const rootVars = cssCustomProperties(extractBlock(css, ":root {"));

    expect(rootVars["spacing-base"]).toBe("4px");
    expect(rootVars["spacing-24"]).toBe("96px");
    expect(rootVars["rounded-sm"]).toBe("8px");
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

describe("DESIGN.md v0.3 design-language tokens (plan 57 T1)", () => {
  test("Signal Cyan brand namespace is additive and dual-theme (AD-571/573)", async () => {
    const fm = await loadFrontmatter();
    for (const step of ["600", "700", "800"]) {
      expect(fm.colors[`brand-${step}`]).toMatch(/^#/);
      expect(fm.themes.dark.colors[`brand-${step}`]).toMatch(/^#/);
      expect(fm.themes.light.colors[`brand-${step}`]).toMatch(/^#/);
    }
    // Locked direction: dark wears the bright cyan step, light the deep step.
    expect(fm.themes.dark.colors["brand-700"]).toBe("#22d3ee");
    expect(fm.themes.light.colors["brand-700"]).toBe("#0e7490");
  });

  test("motion, elevation, and two-tier radius frontmatter contract (AD-574)", async () => {
    const fm = await loadFrontmatter();
    expect(fm.motion).toEqual({
      "duration-fast": "120ms",
      "duration-base": "160ms",
      "duration-slow": "240ms",
      "ease-out": "cubic-bezier(0.22, 1, 0.36, 1)",
      "ease-in-out": "cubic-bezier(0.65, 0, 0.35, 1)",
      "reduced-motion":
        "prefers-reduced-motion: reduce folds every duration to 1ms — entrances render their end state, transitions become immediate",
    });
    expect(fm.elevation["shadow-card"]).toEqual({
      dark: "0 1px 2px #02061766, 0 2px 8px #02061733",
      light: "0 1px 2px #10192814, 0 2px 8px #1019280f",
    });
    expect(fm.elevation["shadow-pop"]).toEqual({
      dark: "0 4px 12px #02061780, 0 16px 40px #02061759",
      light: "0 4px 12px #1019281f, 0 16px 40px #10192829",
    });
    // Container tier sits exactly +4px above the control tier.
    expect(fm.rounded).toEqual({ sm: "8px", md: "12px", lg: "16px", full: "9999px" });
  });

  test("motion/elevation/radius land in tokens.css with the reduced-motion fold", async () => {
    const css = await Bun.file(TOKENS_CSS).text();
    const darkVars = cssCustomProperties(extractBlock(css, ":root {"));
    const lightVars = cssCustomProperties(extractBlock(css, ':root[data-theme="light"] {'));
    const mediaVars = cssCustomProperties(extractBlock(css, "@media (prefers-color-scheme: light) {"));

    // Motion is theme-independent on :root.
    expect(darkVars["duration-fast"]).toBe("120ms");
    expect(darkVars["duration-base"]).toBe("160ms");
    expect(darkVars["duration-slow"]).toBe("240ms");
    expect(darkVars["ease-out"]).toBe("cubic-bezier(0.22, 1, 0.36, 1)");
    expect(darkVars["ease-in-out"]).toBe("cubic-bezier(0.65, 0, 0.35, 1)");

    // Elevation: dark values on :root, light values on BOTH light branches.
    expect(darkVars["shadow-card"]).toBe("0 1px 2px #02061766, 0 2px 8px #02061733");
    expect(darkVars["shadow-pop"]).toBe("0 4px 12px #02061780, 0 16px 40px #02061759");
    expect(lightVars["shadow-card"]).toBe("0 1px 2px #10192814, 0 2px 8px #1019280f");
    expect(lightVars["shadow-pop"]).toBe("0 4px 12px #1019281f, 0 16px 40px #10192829");
    expect(mediaVars["shadow-card"]).toBe(lightVars["shadow-card"]);
    expect(mediaVars["shadow-pop"]).toBe(lightVars["shadow-pop"]);

    // Two-tier radius (AD-574).
    expect(darkVars["rounded-sm"]).toBe("8px");
    expect(darkVars["rounded-md"]).toBe("12px");

    // Reduced-motion fold: durations collapse to 1ms.
    const reduceVars = cssCustomProperties(extractBlock(css, "@media (prefers-reduced-motion: reduce) {"));
    expect(reduceVars["duration-fast"]).toBe("1ms");
    expect(reduceVars["duration-base"]).toBe("1ms");
    expect(reduceVars["duration-slow"]).toBe("1ms");
  });

  test("core consumer pairs hold WCAG contrast in both themes (DESIGN.md appendix A)", async () => {
    const fm = await loadFrontmatter();
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
    const dark = fm.themes.dark.colors;
    const light = fm.themes.light.colors;

    // Text pairs (≥4.5:1).
    const textPairs: [string, string, string][] = [
      ["dark body vs page", dark["gray-1000"]!, dark["background-100"]!],
      ["dark body vs card", dark["gray-1000"]!, dark["background-200"]!],
      ["dark secondary vs card", dark["gray-900"]!, dark["background-200"]!],
      ["dark brand vs page", dark["brand-700"]!, dark["background-100"]!],
      ["dark brand vs card", dark["brand-700"]!, dark["background-200"]!],
      ["light body vs page", light["gray-1000"]!, light["background-100"]!],
      ["light body vs card", light["gray-1000"]!, light["background-200"]!],
      ["light secondary vs page", light["gray-900"]!, light["background-100"]!],
      ["light brand vs page", light["brand-700"]!, light["background-100"]!],
      ["light brand vs card", light["brand-700"]!, light["background-200"]!],
    ];
    for (const [name, fg, bg] of textPairs) {
      expect(ratio(fg, bg), name).toBeGreaterThanOrEqual(4.5);
    }

    // Chart/UI non-text fills vs card face (≥3:1).
    const fillPairs: [string, string, string][] = [
      ["dark chart blue vs card", dark["blue-700"]!, dark["background-200"]!],
      ["dark chart green vs card", dark["green-700"]!, dark["background-200"]!],
      ["dark chart amber vs card", dark["amber-700"]!, dark["background-200"]!],
      ["dark chart red vs card", dark["red-700"]!, dark["background-200"]!],
      ["light chart blue vs card", light["blue-700"]!, light["background-200"]!],
      ["light chart green vs card", light["green-700"]!, light["background-200"]!],
      ["light chart amber vs card", light["amber-700"]!, light["background-200"]!],
      ["light chart red vs card", light["red-700"]!, light["background-200"]!],
    ];
    for (const [name, fg, bg] of fillPairs) {
      expect(ratio(fg, bg), name).toBeGreaterThanOrEqual(3);
    }
  });
});

describe("DESIGN.md theme contract (plan 41 T2)", () => {
  test("manual navbar-toggle override documented with the dated plan-29 supersede note", async () => {
    const md = await Bun.file(DESIGN).text();
    // The toggle contract: storage key + pre-paint application, in body prose.
    expect(md).toContain('localStorage["mstar.dashboard.theme"]');
    expect(md).toContain("documentElement.dataset.theme");
    expect(md).toContain(SUPERSEDE_NOTE);
    // Cascade description matches the plan 41 T1 tokens.css restructure.
    expect(md).toContain(':root[data-theme="light"]');
    expect(md).toContain(':root:not([data-theme="dark"])');
    // The plan-29 lock wording is gone from every theme location.
    expect(md).not.toContain("No independent theme toggle");
    expect(md).not.toContain("navbar theme button");
    expect(md).not.toContain("switcher");
    expect(md).not.toContain("Do not introduce a theme toggle");
    expect(md).not.toContain("locked, plan 29");
  });
});

describe("SSR STYLE token parity (plan 29 QC)", () => {
  function cssCustomPropertiesFromBlock(block: string): Record<string, string> {
    const out: Record<string, string> = {};
    for (const m of block.matchAll(/--([a-z0-9-]+):\s*([^;]+);/gi)) {
      out[m[1]!] = m[2]!.trim();
    }
    return out;
  }

  test("shared hex tokens in tokens.css match src/dashboard/views.ts STYLE", async () => {
    const css = await Bun.file(new URL("../../src/spa/styles/tokens.css", import.meta.url)).text();
    const views = await Bun.file(new URL("../../src/dashboard/views.ts", import.meta.url)).text();
    const styleStart = views.indexOf("const STYLE = `<style>");
    const styleEnd = views.indexOf("`;", styleStart);
    expect(styleStart).toBeGreaterThan(0);
    const style = views.slice(styleStart, styleEnd);

    const cssRoot = cssCustomPropertiesFromBlock(extractBlock(css, ":root {"));
    const cssLight = cssCustomPropertiesFromBlock(extractBlock(css, ':root[data-theme="light"] {'));
    const ssrMediaAt = style.indexOf("@media (prefers-color-scheme: light) {");
    const ssrRoot = cssCustomPropertiesFromBlock(style.slice(0, ssrMediaAt));
    const ssrLight = cssCustomPropertiesFromBlock(style.slice(ssrMediaAt));

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
    const css = await Bun.file(new URL("../../src/spa/styles/tokens.css", import.meta.url)).text();
    const views = await Bun.file(new URL("../../src/dashboard/views.ts", import.meta.url)).text();
    const styleStart = views.indexOf("const STYLE = `<style>");
    const styleEnd = views.indexOf("`;", styleStart);
    const style = views.slice(styleStart, styleEnd);

    const cssRoot = cssCustomPropertiesFromBlock(extractBlock(css, ":root {"));
    const ssrRoot = cssCustomPropertiesFromBlock(style.slice(0, style.indexOf("@media (prefers-color-scheme: light) {")));

    for (const name of ["rounded-sm", "rounded-md"]) {
      expect(ssrRoot[name], name).toBe(cssRoot[name]);
    }
  });
});

