/**
 * Plan 104 task 5 — visual discipline guard.
 *
 * The page layer (src/spa/pages/**, src/spa/Layout.tsx, src/spa/admin/**,
 * src/spa/admin.html) must not carry raw colour literals or bracket-syntax
 * arbitrary values; all colour/sizing comes from DESIGN.md v0.4 tokens.
 *
 * Matcher contract (plan-locked, task-5 brief):
 * - Arbitrary values match by BRACKET SYNTAX ONLY:
 *     /\[(#[0-9a-fA-F]{3,8}|\d+px|calc\(|color-mix\(/
 *   so ordinary scale utilities (p-4, gap-2, grid-cols-3, -translate-y-1)
 *   can never match; `bottom-[-2px]` does not match either (`[` is followed
 *   by `-`, not a digit).
 * - Colour literals: /#[0-9a-fA-F]{3,8}\b/ outside rgba(/hsl( context.
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
  ...listFiles(PAGES_DIR).filter((f) => f.endsWith(".tsx")),
  ...listFiles(ADMIN_DIR),
];

/** Bracket-syntax arbitrary value: `[#hex]`, `[Npx]`, `[calc(`, `[color-mix(`. */
const ARBITRARY = /\[(#[0-9a-fA-F]{3,8}|\d+px|calc\(|color-mix\()/g;
/** Bare hex, excluding hex used inside rgba(/hsl( function arguments. */
const HEX_OUTSIDE_FN = /#[0-9a-fA-F]{3,8}\b/g;
/** rgba(/hsl( argument spans stripped before the hex rule runs. */
const FN_SPAN = /\b(?:rgba|hsl)a?\([^)]*\)/g;

/** Allow-list: starts empty. A hit here must be a proven false positive. */
const ALLOW: string[] = [];

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
  const push = (source: string, re: RegExp, m: RegExpExecArray) => {
    const line = source.slice(0, m.index).split("\n").length;
    const text = m[0];
    if (ALLOW.includes(`${file}:${line}:${text}`)) return;
    violations.push({ file, line, rule: re === ARBITRARY ? "arbitrary-value" : "colour-literal", text });
  };
  ARBITRARY.lastIndex = 0;
  for (let m = ARBITRARY.exec(content); m !== null; m = ARBITRARY.exec(content)) push(content, ARBITRARY, m);
  const hexSafe = content.replace(FN_SPAN, "");
  HEX_OUTSIDE_FN.lastIndex = 0;
  for (let m = HEX_OUTSIDE_FN.exec(hexSafe); m !== null; m = HEX_OUTSIDE_FN.exec(hexSafe)) push(hexSafe, HEX_OUTSIDE_FN, m);
  return violations;
}

describe("visual discipline guard (plan 104 task 5)", () => {
  test("matcher pairs: violations match, compliant scale utilities and rgba(/hsl( hex do not", () => {
    const matched = (line: string) => scanContent(line, "fixture.tsx").map((v) => v.text);
    // must match (bracket syntax)
    expect(matched(`<div className="bg-[#1a2b3c]" />`)).toEqual(["[#1a2b3c", "#1a2b3c"]); // both rules fire on one literal
    expect(matched(`<div className="w-[17px]" />`)).toEqual(["[17px"]);
    expect(matched(`<div className="w-[calc(100%-1rem)]" />`)).toEqual(["[calc("]);
    expect(matched(`<div className="bg-[color-mix(in_srgb,red,blue)]" />`)).toEqual(["[color-mix("]);
    expect(matched(`style={{ color: "#fff" }}`)).toEqual(["#fff"]);
    // must NOT match
    expect(matched(`<div className="p-4 gap-2 grid-cols-3 -translate-y-1" />`)).toEqual([]);
    expect(matched(`<div className="after:bottom-[-2px]" />`)).toEqual([]); // `[` followed by `-`, not a digit; same for CSS-var shorthand like text-(length:--typo-…)
    // must NOT match; the rgba(/hsl( stripper is load-bearing here — #223 is a valid 3-digit hex
    expect(matched(`style={{ color: "rgba(255,255,255,0.5)", borderColor: "hsl(#223 3% 4%)" }}`)).toEqual([]);
    expect(matched(`// #abcdef in a comment is still a violation`)).toEqual(["#abcdef"]); // guard: comments are not exempt
  });

  test("page layer has no bare colour literals or bracket arbitrary values", () => {
    const violations = TARGETS.flatMap((file) =>
      scanContent(readFileSync(file, "utf8"), relative(REPO, file)),
    );
    const message = violations.map((v) => `${v.file}:${v.line}: [${v.rule}] ${v.text}`).join("\n");
    expect(violations, `visual discipline violations:\n${message}`).toEqual([]);
  });
});
