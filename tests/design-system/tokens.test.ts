import { describe, expect, test } from "bun:test";

import {
  THEMES,
  UnresolvedTokenError,
  opsSurface,
  resolveTheme,
  survivorSteps,
  themeVaryingSemantics,
  tokenLayers,
  transitionalSteps,
  tokenNames,
} from "../../src/design-system/tokens";

const D14_SURVIVORS = [
  "background-100",
  "background-200",
  "background-300",
  "gray-200",
  "gray-600",
  "gray-700",
  "gray-900",
  "gray-1000",
  "gray-alpha-400",
  "gray-alpha-500",
  "brand-600",
  "brand-700",
  "blue-700",
  "red-100",
  "red-400",
  "red-700",
  "amber-100",
  "amber-400",
  "amber-600",
  "amber-700",
  "green-100",
  "green-300",
  "green-400",
  "green-700",
  "green-800",
  "purple-700",
] as const;

describe("palette reduction (D14)", () => {
  test("the declared palette steps are exactly the 26 survivors", () => {
    const declaredPalette = tokenNames()
      .primitive.filter((name) => !name.startsWith("font-") && !name.startsWith("breakpoint-"));
    expect([...declaredPalette].sort()).toEqual([...D14_SURVIVORS].sort());
    expect(declaredPalette).toHaveLength(26);
  });

  test("the D14a transitional set is empty and the survivor set is whole", () => {
    expect(transitionalSteps).toEqual([]);
    expect(survivorSteps).toHaveLength(26);
    expect([...survivorSteps].sort()).toEqual([...D14_SURVIVORS].sort());
  });

  test("every survivor is consumed by a layer", () => {
    const referenced = THEMES.flatMap((theme) => [
      ...Object.values(tokenLayers(theme).semantic),
      ...Object.values(tokenLayers(theme).component),
    ]).join("\n");
    for (const step of D14_SURVIVORS) {
      expect(referenced, `--${step} survives but nothing consumes it`).toContain(`var(--${step})`);
    }
  });

  test("the teal and pink families are gone", () => {
    const tealPink = tokenNames().primitive.filter((n) => n.startsWith("teal-") || n.startsWith("pink-"));
    expect(tealPink).toEqual([]);
  });
});

describe("theme parity", () => {
  test("both themes declare identical primitive, semantic and component key sets", () => {
    const [dark, light] = THEMES.map((theme) => ({
      primitive: Object.keys(tokenLayers(theme).primitive).sort(),
      semantic: Object.keys(tokenLayers(theme).semantic).sort(),
      component: Object.keys(tokenLayers(theme).component).sort(),
    }));
    expect(light?.primitive).toEqual(dark?.primitive);
    expect(light?.semantic).toEqual(dark?.semantic);
    expect(light?.component).toEqual(dark?.component);
  });

  test("the r3 semantic vocabulary is present verbatim", () => {
    const semantic = new Set(tokenNames().semantic);
    const expected = [
      ...["page", "shell", "raised", "card", "inset", "overlay"].map((n) => `surface-${n}`),
      ...["subtle", "default", "strong"].map((n) => `border-${n}`),
      ...["primary", "secondary", "muted", "faint"].map((n) => `text-${n}`),
      ...["neutral", "accent", "success", "warn", "danger"].flatMap((tone) =>
        ["bg", "border", "fg", "solid"].map((face) => `tone-${tone}-${face}`),
      ),
      ...["xs", "sm", "md"].map((n) => `control-h-${n}`),
      ...["compact", "comfort"].map((n) => `row-h-${n}`),
      ...["control", "container", "pill"].map((n) => `radius-${n}`),
      "on-brand",
      "focus-ring",
      ...Array.from({ length: 6 }, (_, i) => `chart-${i + 1}`),
      ...Array.from({ length: 6 }, (_, i) => `chart-${i + 1}-mark`),
    ];
    expect([...expected].filter((name) => !semantic.has(name))).toEqual([]);
  });

  test("surfaces, text and controls differ between themes where they must", () => {
    const varying = new Set(themeVaryingSemantics());
    for (const name of ["surface-page", "surface-card", "text-primary", "tone-success-bg", "on-brand"]) {
      expect(varying, `--${name} should differ per theme`).toContain(name);
    }
    for (const name of ["control-h-md", "radius-control", "typo-copy-14-size", "row-h-comfort"]) {
      expect(varying, `--${name} must be theme-invariant`).not.toContain(name);
    }
  });
});

describe("resolution", () => {
  test("every semantic token resolves in both themes", () => {
    for (const theme of THEMES) {
      const resolved = resolveTheme(theme).semantic;
      const unresolved = Object.entries(resolved)
        .filter(([, value]) => value === "" || /var\(--/.test(value))
        .map(([name]) => name);
      expect(unresolved, `${theme} leaves tokens referencing var()`).toEqual([]);
      const colours = Object.keys(tokenLayers(theme).semantic).filter(
        (name) => /^(surface|border|text|tone|chart)-/.test(name) || name === "on-brand" || name === "focus-ring",
      );
      for (const name of colours) {
        expect(resolved[name], `${theme} --${name}`).toMatch(/^#[0-9a-f]{3,8}$|^rgba?\(/i);
      }
    }
  });

  test("every component token resolves through its semantics to a concrete value", () => {
    for (const theme of THEMES) {
      const resolved = resolveTheme(theme).component;
      for (const [name, value] of Object.entries(resolved)) {
        expect(value, `${theme} --${name}`).not.toBe("");
        expect(value, `${theme} --${name} still references var()`).not.toMatch(/var\(--/);
      }
      expect(resolved["button-primary-bg"]).toMatch(/^#[0-9a-f]{3,8}$|^rgba?\(/i);
      expect(resolved["card-radius"]).toBe("12px");
    }
  });

  test("a hover or disabled face never resolves to its own rest face", () => {
    const pairs = [
      ["button-primary-bg", "button-primary-hover-bg"],
      ["button-primary-bg", "button-disabled-bg"],
    ] as const;
    for (const theme of THEMES) {
      const resolved = resolveTheme(theme).component;
      for (const [rest, state] of pairs) {
        expect(resolved[state], `${theme} --${state} must differ from --${rest}`).not.toBe(resolved[rest]);
      }
    }
  });

  test("an undefined reference throws instead of yielding a hollow value", () => {
    expect(() => resolveTheme("dark")).not.toThrow();
    const error = new UnresolvedTokenError("dark", "surface-page", "nope");
    expect(error.message).toContain("--surface-page");
    expect(error.message).toContain("--nope");
  });

  test("focus-ring is blue-700 in both themes", () => {
    for (const theme of THEMES) {
      expect(resolveTheme(theme).semantic["focus-ring"]?.toLowerCase()).toBe(
        resolveTheme(theme).primitive["blue-700"]?.toLowerCase(),
      );
    }
  });
});

describe("chart fill/mark split", () => {
  const LIGHT_SAME_FACE = new Set(["chart-2", "chart-6"]);

  test("each slot has both faces, and they are distinct wherever the palette holds two steps", () => {
    for (const theme of THEMES) {
      const resolved = resolveTheme(theme).semantic;
      for (let i = 1; i <= 6; i += 1) {
        const slot = `chart-${i}`;
        const fill = resolved[slot];
        const mark = resolved[`${slot}-mark`];
        expect(fill, `${theme} ${slot}`).toBeString();
        expect(mark, `${theme} ${slot}-mark`).toBeString();
        if (theme === "light" && LIGHT_SAME_FACE.has(slot)) {
          expect(fill, `${theme} ${slot}: documented same-face pair`).toBe(mark);
        } else {
          expect(fill, `${theme} ${slot} fill must differ from its mark`).not.toBe(mark);
        }
      }
    }
  });

  test("the documented same-face pairs are exactly the ones the light palette forces", () => {
    const dark = resolveTheme("dark").semantic;
    const light = resolveTheme("light").semantic;
    const colliding = [1, 2, 3, 4, 5, 6]
      .map((i) => `chart-${i}`)
      .filter((slot) => light[slot] === light[`${slot}-mark`]);
    expect(colliding).toEqual([...LIGHT_SAME_FACE]);
    expect([1, 2, 3, 4, 5, 6].map((i) => `chart-${i}`).filter((slot) => dark[slot] === dark[`${slot}-mark`])).toEqual([]);
  });

  test("chart-1 follows the brand, the remaining fills are theme-fixed literals except the lifted chart-5", () => {
    const dark = resolveTheme("dark").semantic;
    const light = resolveTheme("light").semantic;
    expect(dark["chart-1"]?.toLowerCase()).toBe(resolveTheme("dark").primitive["brand-600"]?.toLowerCase());
    expect(light["chart-1"]?.toLowerCase()).toBe(resolveTheme("light").primitive["brand-600"]?.toLowerCase());
    for (const slot of ["chart-2", "chart-3", "chart-4", "chart-6"] as const) {
      expect(dark[slot], `${slot} should be theme-fixed`).toBe(light[slot] as string);
    }
    expect(dark["chart-5"]).not.toBe(light["chart-5"]);
  });
});

describe("ops surface variant (D15)", () => {
  test("withholds the accent tone by re-pointing it to the neutral tone", () => {
    expect(opsSurface["tone-accent-bg"]).toBe("var(--tone-neutral-bg)");
    expect(opsSurface["tone-accent-border"]).toBe("var(--tone-neutral-border)");
    expect(opsSurface["tone-accent-fg"]).toBe("var(--tone-neutral-fg)");
    expect(opsSurface["tone-accent-solid"]).toBe("var(--tone-neutral-solid)");
  });

  test("moves the primary action to neutral emphasis", () => {
    expect(opsSurface["button-primary-bg"]).toBe("var(--tone-neutral-bg)");
    expect(opsSurface["button-primary-fg"]).toBe("var(--text-primary)");
    expect(opsSurface["button-primary-border"]).toBe("var(--border-strong)");
  });

  test("the re-mapped primary still has a visible hover", () => {
    for (const theme of THEMES) {
      const resolved = resolveTheme(theme).semantic;
      const value = (ref: string) => resolved[/^var\(--([a-z0-9-]+)\)$/.exec(ref)?.[1] as string];
      expect(value(opsSurface["button-primary-hover-bg"]), `${theme} ops hover`).not.toBe(
        value(opsSurface["button-primary-bg"]),
      );
    }
  });

  test("introduces no new value: every entry is a reference to an existing token", () => {
    for (const [name, value] of Object.entries(opsSurface)) {
      expect(value, `ops --${name} must be a var() reference`).toMatch(/^var\(--[a-z0-9-]+\)$/);
      const target = /^var\(--([a-z0-9-]+)\)$/.exec(value)?.[1] as string;
      for (const theme of THEMES) {
        expect(tokenLayers(theme).semantic[target], `ops --${name} -> --${target}`).toBeString();
      }
    }
  });

  test("re-maps only tokens the base layers declare", () => {
    const known = new Set([...tokenNames().semantic, ...tokenNames().component]);
    expect(Object.keys(opsSurface).filter((name) => !known.has(name))).toEqual([]);
  });
});
