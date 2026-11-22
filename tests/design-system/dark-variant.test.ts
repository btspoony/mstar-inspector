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
    expect(binding).toContain(':root:not([data-theme="light"])');
    expect(binding).not.toContain('[data-theme="dark"]');
  });

  test("a dark: utility fires under the attribute-unset root and data-theme=dark, never under light", () => {
    expect(compiled).toMatch(/\.dark\\:bg-red-500[^{]*\{\s*background-color:/);
    const variant = /\.dark\\:bg-red-500(:where\([^{]*\))/.exec(compiled)?.[1];
    if (variant === undefined) throw new Error("the compiled dark: rule carries no :where(...) guard");
    const guards = variant.slice(":where(".length, -1).split(", ");
    expect(guards).toEqual([':root:not([data-theme="light"])', ':root:not([data-theme="light"]) *']);

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
