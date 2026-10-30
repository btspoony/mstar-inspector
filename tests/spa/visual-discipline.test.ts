/**
 * Visual discipline guard for the page layer (2026-10).
 *
 * The page layer (src/spa/pages/**, src/spa/Layout.tsx, src/spa/admin/**,
 * src/spa/admin.html, src/spa/index.html) must not carry raw colour literals,
 * bracket-syntax arbitrary values, or default-palette Tailwind utilities; all
 * colour/sizing comes from DESIGN.md tokens.
 *
 * Matcher contract:
 * - Arbitrary values match by BRACKET SYNTAX ONLY:
 *     /\[(#[0-9a-fA-F]{3,8}|\d+px|calc\(|color-mix\(/
 *   so ordinary scale utilities (p-4, gap-2, grid-cols-3, -translate-y-1)
 *   can never match; `bottom-[-2px]` does not match either (`[` is followed
 *   by `-`, not a digit).
 * - Colour literals: /#[0-9a-fA-F]{3,8}\b/ outside rgba(/hsl( context.
 * - Palette utilities: a Tailwind colour utility whose suffix is a default
 *   palette name plus a numeric shade (`text-red-500`). The utility prefix is
 *   required, so the token forms carrying the same palette name —
 *   `bg-(--gray-200)`, `text-(--gray-700)` — and the non-palette `brand-700`
 *   never match.
 * - Allow-list starts EMPTY: every hit is a genuine violation or the
 *   matcher is wrong (fix the matcher, never pad the allow-list).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, test } from "bun:test";

const REPO = new URL("../../", import.meta.url).pathname;

const PAGES_DIR = join(REPO, "src/spa/pages");
const ADMIN_DIR = join(REPO, "src/spa/admin");
const TARGETS: string[] = [
  join(REPO, "src/spa/Layout.tsx"),
  join(REPO, "src/spa/admin.html"),
  join(REPO, "src/spa/index.html"),
  ...listFiles(PAGES_DIR).filter((f) => f.endsWith(".tsx") || f.endsWith(".ts")),
  ...listFiles(ADMIN_DIR),
];

/** Bracket-syntax arbitrary value: `[#hex]`, `[Npx]`, `[calc(`, `[color-mix(`. */
const ARBITRARY = /\[(#[0-9a-fA-F]{3,8}|\d+px|calc\(|color-mix\()/g;
/** Bare hex, excluding hex used inside rgba(/hsl( function arguments. */
const HEX_OUTSIDE_FN = /#[0-9a-fA-F]{3,8}\b/g;
/** rgba(/hsl( argument spans stripped before the hex rule runs. */
const FN_SPAN = /\b(?:rgba|hsl)a?\([^)]*\)/g;
/**
 * Default-palette Tailwind colour utility: `text-red-500`, `bg-zinc-100`,
 * `border-slate-700`. The utility prefix is part of the pattern, so a token
 * that merely carries a palette name (`bg-(--gray-200)`) cannot match.
 */
const PALETTE_UTILITY =
  /(?<![\w-])(?:bg|text|border|ring|divide|fill|stroke|outline|decoration|caret|accent|placeholder|from|via|to)-(?:slate|gray|zinc|neutral|stone|red|orange|amber|yellow|lime|green|emerald|teal|cyan|sky|blue|indigo|violet|purple|fuchsia|pink|rose)-\d{2,3}\b/g;

/** Allow-list: starts empty. A hit here must be a proven false positive. */
const ALLOW: string[] = [];

const RULES: { label: string; re: RegExp; strip?: RegExp }[] = [
  { label: "arbitrary-value", re: ARBITRARY },
  { label: "colour-literal", re: HEX_OUTSIDE_FN, strip: FN_SPAN },
  { label: "palette-utility", re: PALETTE_UTILITY },
];

function listFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...listFiles(full));
    else out.push(full);
  }
  return out;
}

type Violation = { file: string; line: number; rule: string; text: string };

function scanContent(content: string, file: string): Violation[] {
  const violations: Violation[] = [];
  for (const { label, re, strip } of RULES) {
    const source = strip === undefined ? content : content.replace(strip, "");
    re.lastIndex = 0;
    for (let m = re.exec(source); m !== null; m = re.exec(source)) {
      const line = source.slice(0, m.index).split("\n").length;
      const text = m[0];
      if (ALLOW.includes(`${file}:${line}:${text}`)) continue;
      violations.push({ file, line, rule: label, text });
    }
  }
  return violations;
}

describe("visual discipline guard", () => {
  test("matcher pairs: violations match, compliant token and scale forms do not", () => {
    const matched = (line: string) => scanContent(line, "fixture.tsx").map((v) => v.text);
    // must match (bracket syntax)
    expect(matched(`<div className="bg-[#1a2b3c]" />`)).toEqual(["[#1a2b3c", "#1a2b3c"]); // both rules fire on one literal
    expect(matched(`<div className="w-[17px]" />`)).toEqual(["[17px"]);
    expect(matched(`<div className="w-[calc(100%-1rem)]" />`)).toEqual(["[calc("]);
    expect(matched(`<div className="bg-[color-mix(in_srgb,red,blue)]" />`)).toEqual(["[color-mix("]);
    expect(matched(`style={{ color: "#fff" }}`)).toEqual(["#fff"]);
    // must match (default palette utility)
    expect(matched(`<div className="text-red-500 bg-zinc-100 border-slate-700" />`)).toEqual([
      "text-red-500",
      "bg-zinc-100",
      "border-slate-700",
    ]);
    expect(matched(`<div className="hover:bg-rose-50" />`)).toEqual(["bg-rose-50"]);
    // must NOT match
    expect(matched(`<div className="p-4 gap-2 grid-cols-3 -translate-y-1" />`)).toEqual([]);
    expect(matched(`<div className="after:bottom-[-2px]" />`)).toEqual([]); // `[` followed by `-`, not a digit; same for CSS-var shorthand like text-(length:--typo-…)
    // must NOT match; the token forms the repo actually uses
    expect(
      matched(`<div className="bg-(--gray-200) text-(--gray-700) border-(--gray-400)" />`),
    ).toEqual([]);
    expect(matched(`<div className="text-(--brand-700) brand-700" />`)).toEqual([]); // brand is not a default palette name
    // must NOT match; the rgba(/hsl( stripper is load-bearing here — #223 is a valid 3-digit hex
    expect(matched(`style={{ color: "rgba(255,255,255,0.5)", borderColor: "hsl(#223 3% 4%)" }}`)).toEqual([]);
    expect(matched(`// #abcdef in a comment is still a violation`)).toEqual(["#abcdef"]); // guard: comments are not exempt
  });

  test("page layer has no bare colour literals, bracket arbitrary values, or palette utilities", () => {
    const violations = TARGETS.flatMap((file) =>
      scanContent(readFileSync(file, "utf8"), relative(REPO, file)),
    );
    const message = violations.map((v) => `${v.file}:${v.line}: [${v.rule}] ${v.text}`).join("\n");
    expect(violations, `visual discipline violations:\n${message}`).toEqual([]);
  });
});
