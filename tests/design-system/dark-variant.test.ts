/**
 * The `dark:` binding — the app's theme, not the OS.
 *
 * Tailwind v4 resolves `dark:` from `prefers-color-scheme` unless a
 * `@custom-variant` re-binds it. The standard shadcn recipe keys on
 * `[data-theme="dark"]`, which this app never writes for a never-toggled
 * visitor: dark is the attribute's *absence*, so that recipe silently misses
 * exactly those visitors. The shipped binding keys on
 * `:root:not([data-theme="light"])`, mirroring the token cascade.
 *
 * The probe compiles the SHIPPED declaration through `@tailwindcss/node` — the
 * compiler `@tailwindcss/vite` wraps for the app build — so a change to that
 * line cannot leave this test asserting an old copy. The ban on authored
 * `dark:` utilities stays (`tests/design-system/boundary.test.ts`); this test
 * guards the mechanism that makes a `dark:` that slips past the text scan
 * follow the app theme.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";
import { compile } from "@tailwindcss/node";
import { Window } from "happy-dom";

const REPO = new URL("../../", import.meta.url).pathname;
const STYLESHEET = join(REPO, "src/spa/styles/shadcn-theme.css");

const shipped = readFileSync(STYLESHEET, "utf8");
const binding = /@custom-variant dark \([^;]*\);/.exec(shipped)?.[0];
if (binding === undefined) throw new Error("shadcn-theme.css declares no `@custom-variant dark`");

const compiled = (
  await compile(`@import "tailwindcss";\n${binding}\n`, { base: REPO, onDependency() {} })
).build(["dark:bg-red-500"]);

describe("dark: variant binding", () => {
  test("the shipped binding drops prefers-color-scheme and never keys on [data-theme=dark]", () => {
    expect(compiled).not.toContain("prefers-color-scheme");
    // The never-toggled visitor renders dark with the attribute unset; the
    // shadcn recipe would leave that visitor with no dark: rule at all.
    expect(binding).toContain(':root:not([data-theme="light"])');
    expect(binding).not.toContain('[data-theme="dark"]');
  });

  test("a dark: utility fires under the attribute-unset root and data-theme=dark, never under light", () => {
    expect(compiled).toMatch(/\.dark\\:bg-red-500[^{]*\{\s*background-color:/);
    // The guards the compiled rule actually carries: the root itself, and any
    // descendant of such a root. Extracted, never pinned as one string — a
    // Tailwind reformat of `:where` must not fail this without a behaviour
    // change.
    const variant = /\.dark\\:bg-red-500(:where\([^{]*\))/.exec(compiled)?.[1];
    if (variant === undefined) throw new Error("the compiled dark: rule carries no :where(...) guard");
    const guards = variant.slice(":where(".length, -1).split(", ");
    expect(guards).toEqual([':root:not([data-theme="light"])', ':root:not([data-theme="light"]) *']);

    // Evaluated per root: absence of the attribute is dark (the deterministic
    // default), an explicit dark matches, light never does — root and
    // descendant alike.
    for (const [theme, expected] of [
      [undefined, true],
      ["dark", true],
      ["light", false],
    ] as const) {
      const window = new Window();
      if (theme !== undefined) window.document.documentElement.setAttribute("data-theme", theme);
      const descendant = window.document.createElement("div");
      window.document.body.append(descendant);
      const label = theme ?? "attribute unset";
      expect(window.document.documentElement.matches(guards[0] as string), `${label} root`).toBe(expected);
      expect(descendant.matches(guards[1] as string), `${label} descendant`).toBe(expected);
    }
  });
});
