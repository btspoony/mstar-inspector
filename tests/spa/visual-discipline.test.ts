import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, test } from "bun:test";

import { PALETTE_UTILITY_SOURCE } from "../helpers/tailwind-palette";

const REPO = new URL("../../", import.meta.url).pathname;

const SPA_DIR = join(REPO, "src/spa");
const PRIMITIVES_DIR = join(REPO, "src/design-system/primitives");
const GENERATED_STYLESHEET = "styles/tokens.css";
const COLOUR_SOURCE = /\.(?:tsx?|css|html)$/;

function colourSources(root: string = SPA_DIR): string[] {
  return listFiles(root)
    .filter((file) => COLOUR_SOURCE.test(file))
    .filter((file) => relative(root, file) !== GENERATED_STYLESHEET)
    .sort();
}

const SPA_TARGETS = colourSources(SPA_DIR);
const PRIMITIVE_TARGETS = colourSources(PRIMITIVES_DIR);
const TARGETS = [...SPA_TARGETS, ...PRIMITIVE_TARGETS];

const ARBITRARY_COLOUR = /\[(#[0-9a-fA-F]{3,8})/g;
const ARBITRARY_GEOMETRY = /\[(\d+px|calc\(|color-mix\()/g;
const DOCUMENTED_MEASURE = /max-w-\[(?:960|1200)px\]/g;
const HEX_OUTSIDE_FN = /#[0-9a-fA-F]{3,8}\b/g;
const FN_SPAN = /\b(?:rgba|hsl)a?\([^)]*\)/g;
const PALETTE_UTILITY = new RegExp(PALETTE_UTILITY_SOURCE, "g");

const ALLOW: string[] = [];

type GuardRule = { label: string; re: RegExp; strip?: RegExp };

const COLOUR_RULES: GuardRule[] = [
  { label: "arbitrary-value", re: ARBITRARY_COLOUR },
  { label: "colour-literal", re: HEX_OUTSIDE_FN, strip: FN_SPAN },
  { label: "palette-utility", re: PALETTE_UTILITY },
];

const PAGE_RULES: GuardRule[] = [
  { label: "arbitrary-value", re: ARBITRARY_GEOMETRY, strip: DOCUMENTED_MEASURE },
  ...COLOUR_RULES,
];

const PRIMITIVES_RULES = COLOUR_RULES;

const CLASS_LITERAL = /(?<![\w$])(["'`])((?:\\[\s\S]|(?!\1)[\s\S])*?)\1/g;
const BARE_BORDER = /^border(?:-[trblsexy])?$/;
const BORDER_SIDE = /^[trblsexy]$/;
const BORDER_WIDTH_VALUE = /^(?:\d+|px|thin|medium|thick|\[[^\]]*\])$/;
const BORDER_STYLE = /^(?:solid|dashed|dotted|double|none|hidden|collapse|separate)$/;
/**
 * Comment bodies, blanked in place so a reported line still matches the file.
 * The line comment starts at its own delimiter: consuming the character before
 * `//` blanked a closing quote in `cn("border")//note`, which broke the class
 * string and let the violation escape. `(?<!:)` keeps `https://` intact.
 */
const COMMENT = /\/\*[\s\S]*?\*\/|(?<!:)\/\/[^\n]*/g;

function stripVariants(token: string): string {
  let current = token;
  for (;;) {
    const next = current.replace(/^(?:[a-z0-9_-]+(?:\[[^\]]*\])?|\[[^\]]*\]):/i, "");
    if (next === current) return current;
    current = next;
  }
}

function isBorderColour(token: string): boolean {
  const match = /^border-(?:(?:t|r|b|l|s|e|x|y)-)?(.+)$/.exec(token);
  if (match === null) return false;
  const suffix = match[1] as string;
  return !(BORDER_SIDE.test(suffix) || BORDER_WIDTH_VALUE.test(suffix) || BORDER_STYLE.test(suffix));
}

function borderViolations(content: string, file: string): Violation[] {
  const source = content.replace(COMMENT, (comment) => comment.replace(/[^\n]/g, " "));
  const violations: Violation[] = [];
  for (const match of source.matchAll(CLASS_LITERAL)) {
    const text = match[2] as string;
    const classes = text.split(/\s+/).map(stripVariants).filter(Boolean);
    if (!classes.some((token) => BARE_BORDER.test(token))) continue;
    if (classes.some(isBorderColour)) continue;
    const line = source.slice(0, match.index).split("\n").length;
    violations.push({ file, line, rule: "border-width-without-colour", text });
  }
  return violations;
}

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

function scanContent(content: string, file: string, rules: GuardRule[] = PAGE_RULES): Violation[] {
  const violations: Violation[] = [];
  for (const { label, re, strip } of rules) {
    const source = strip === undefined ? content : content.replace(strip, "");
    re.lastIndex = 0;
    for (let m = re.exec(source); m !== null; m = re.exec(source)) {
      const line = source.slice(0, m.index).split("\n").length;
      const text = m[0];
      if (ALLOW.includes(`${file}:${line}:${text}`)) continue;
      violations.push({ file, line, rule: label, text });
    }
  }
  violations.push(...borderViolations(content, file));
  return violations;
}

describe("visual discipline guard", () => {
  test("matcher pairs: violations match, compliant token and scale forms do not", () => {
    const matched = (line: string) => scanContent(line, "fixture.tsx").map((v) => v.text);
    expect(matched(`<div className="bg-[#1a2b3c]" />`)).toEqual(["[#1a2b3c", "#1a2b3c"]);
    expect(matched(`<div className="w-[17px]" />`)).toEqual(["[17px"]);
    expect(matched(`<div className="w-[calc(100%-1rem)]" />`)).toEqual(["[calc("]);
    expect(matched(`<div className="bg-[color-mix(in_srgb,red,blue)]" />`)).toEqual(["[color-mix("]);
    expect(matched(`style={{ color: "#fff" }}`)).toEqual(["#fff"]);
    expect(matched(`<div className="text-red-500 bg-zinc-100 border-slate-700" />`)).toEqual([
      "text-red-500",
      "bg-zinc-100",
      "border-slate-700",
    ]);
    expect(matched(`<div className="hover:bg-rose-50" />`)).toEqual(["bg-rose-50"]);
    expect(
      matched(
        `<div className="shadow-red-500 inset-shadow-red-500 ring-offset-red-500 drop-shadow-red-500 text-shadow-red-500 inset-ring-red-500 scrollbar-thumb-red-500" />`,
      ),
    ).toEqual([
      "shadow-red-500",
      "inset-shadow-red-500",
      "ring-offset-red-500",
      "drop-shadow-red-500",
      "text-shadow-red-500",
      "inset-ring-red-500",
      "scrollbar-thumb-red-500",
    ]);
    expect(
      matched(`<div className="shadow-sm inset-shadow-xs ring-offset-2 drop-shadow-lg ring-2" />`),
    ).toEqual([]);
    expect(matched(`<div className="shadow-(--shadow-contact) ring-offset-(--gray-200)" />`)).toEqual([]);
    expect(matched(`<div className="p-4 gap-2 grid-cols-3 -translate-y-1" />`)).toEqual([]);
    expect(matched(`<div className="after:bottom-[-2px]" />`)).toEqual([]);
    expect(
      matched(`<div className="bg-(--gray-200) text-(--gray-700) border-(--gray-400)" />`),
    ).toEqual([]);
    expect(matched(`<div className={\`mx-auto w-full \${wide ? "max-w-[1200px]" : "max-w-[960px]"}\`} />`)).toEqual([]);
    expect(matched(`<div className="text-(--brand-700) brand-700" />`)).toEqual([]);
    expect(matched(`style={{ color: "rgba(255,255,255,0.5)", borderColor: "hsl(#223 3% 4%)" }}`)).toEqual([]);
    expect(matched(`// #abcdef in a comment is still a violation`)).toEqual(["#abcdef"]);
  });

  test("border-axis palette forms: border-t-red-500 and divide-x-red-500 matched neither matcher before I-000255; the shared source now rejects every spelling", () => {
    const matched = (line: string) => scanContent(line, "fixture.tsx").map((v) => v.text);
    expect(matched(`<div className="border-t-red-500" />`)).toEqual(["border-t-red-500"]);
    expect(matched(`<div className="border-x-slate-700" />`)).toEqual(["border-x-slate-700"]);
    expect(matched(`<div className="border-e-gray-100" />`)).toEqual(["border-e-gray-100"]);
    expect(matched(`<div className="divide-x-red-500" />`)).toEqual(["divide-x-red-500"]);
    expect(matched(`<div className="border-t-black" />`)).toEqual(["border-t-black"]);
    const noFlags = new RegExp(PALETTE_UTILITY_SOURCE);
    expect(noFlags.test("border-t-red-500")).toBe(true);
    expect(noFlags.test("divide-x-red-500")).toBe(true);
    expect(matched(`<div className="border-slate-700" />`)).toEqual(["border-slate-700"]);
    expect(matched(`<div className="border-t-(--border-subtle) divide-x-(--border-subtle)" />`)).toEqual([]);
  });

  test("bare black/white across the whole colour series: shadow-black and caret-black passed the nine-prefix clause; every series prefix is rejected now", () => {
    const matched = (line: string) => scanContent(line, "fixture.tsx").map((v) => v.text);
    expect(matched(`<div className="shadow-black" />`)).toEqual(["shadow-black"]);
    expect(matched(`<div className="caret-black" />`)).toEqual(["caret-black"]);
    expect(matched(`<div className="accent-white" />`)).toEqual(["accent-white"]);
    expect(matched(`<div className="inset-shadow-black" />`)).toEqual(["inset-shadow-black"]);
    expect(matched(`<div className="text-shadow-white" />`)).toEqual(["text-shadow-white"]);
    expect(matched(`<div className="drop-shadow-black" />`)).toEqual(["drop-shadow-black"]);
    expect(matched(`<div className="scrollbar-thumb-black" />`)).toEqual(["scrollbar-thumb-black"]);
    expect(matched(`<div className="scrollbar-track-white" />`)).toEqual(["scrollbar-track-white"]);
    expect(matched(`<div className="ring-offset-white" />`)).toEqual(["ring-offset-white"]);
    expect(matched(`<div className="divide-x-black" />`)).toEqual(["divide-x-black"]);
    expect(matched(`<div className="divide-y-white" />`)).toEqual(["divide-y-white"]);
    expect(matched(`<div className="bg-black text-white border-black" />`)).toEqual([
      "bg-black",
      "text-white",
      "border-black",
    ]);
    expect(matched(`<div className="shadow-sm inset-shadow-xs ring-offset-2" />`)).toEqual([]);
    expect(new RegExp(PALETTE_UTILITY_SOURCE).test("shadow-black")).toBe(true);
    expect(new RegExp(PALETTE_UTILITY_SOURCE).test("caret-white")).toBe(true);
  });

  test("border width without a colour: bare `border`/`border-b` slipped the page-layer net; the class-string rule now rejects them", () => {
    const rejected = (line: string) =>
      scanContent(line, "fixture.tsx")
        .filter((v) => v.rule === "border-width-without-colour")
        .map((v) => v.text);
    expect(rejected(`<div className="border" />`)).toEqual(["border"]);
    expect(rejected(`<div className="rounded-md border px-4" />`)).toEqual(["rounded-md border px-4"]);
    expect(rejected(`<div className="[&:not(:last-child)]:border-b" />`)).toEqual([
      "[&:not(:last-child)]:border-b",
    ]);
    expect(rejected(`<div className="border-t" />`)).toEqual(["border-t"]);
    expect(rejected(`<div className="border-b border-border" />`)).toEqual([]);
    expect(rejected(`<div className="border border-(--border-default)" />`)).toEqual([]);
    expect(rejected(`<div className="border-input border-sidebar-border border-transparent" />`)).toEqual([]);
    expect(
      rejected(`<div className={cn(TABLE_COLS, "border-(--border-subtle) px-4 py-3 [&:not(:last-child)]:border-b")} />`),
    ).toEqual([]);
    expect(rejected(`<div className="border-2" />`)).toEqual([]);
    expect(rejected(`// a bare \`border\` carries width only`)).toEqual([]);
    expect(rejected(`const cls = "border"//no colour named`)).toEqual(["border"]);
    expect(rejected(`const url = "https://example.test"; cn("border")`)).toEqual(["border"]);
  });

  test("the target walk covers components/** and styles/: a seeded component and fonts.css were invisible to the hand list and are caught now", () => {
    const root = mkdtempSync(join(tmpdir(), "colour-targets-"));
    try {
      mkdirSync(join(root, "components"), { recursive: true });
      mkdirSync(join(root, "styles"), { recursive: true });
      writeFileSync(join(root, "components/Seeded.tsx"), `<div className="text-red-500" />`);
      writeFileSync(join(root, "styles/fonts.css"), `a { color: #fff; }`);
      writeFileSync(join(root, "styles/tokens.css"), `:root { --seeded: #fff; }`);

      const targets = colourSources(root);
      expect(targets).toContain(join(root, "components/Seeded.tsx"));
      expect(targets).toContain(join(root, "styles/fonts.css"));
      expect(targets).not.toContain(join(root, "styles/tokens.css"));
      const found = targets.flatMap((file) => scanContent(readFileSync(file, "utf8"), relative(root, file)));
      expect(found.map((v) => v.text)).toEqual(["text-red-500", "#fff"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    expect(TARGETS.length).toBeGreaterThan(0);
    expect(TARGETS).toContain(join(SPA_DIR, "components/state/PageSkeleton.tsx"));
    expect(TARGETS).toContain(join(SPA_DIR, "styles/fonts.css"));
    expect(TARGETS).not.toContain(join(SPA_DIR, GENERATED_STYLESHEET));
  });

  test("the primitives root is walked, and a bare border seeded there is caught", () => {
    const root = mkdtempSync(join(tmpdir(), "colour-primitives-"));
    try {
      mkdirSync(join(root, "primitives"), { recursive: true });
      writeFileSync(join(root, "primitives/Seeded.tsx"), `<div className="rounded-md border bg-popover" />`);
      const targets = colourSources(root);
      expect(targets).toContain(join(root, "primitives/Seeded.tsx"));
      const found = targets.flatMap((file) => scanContent(readFileSync(file, "utf8"), relative(root, file)));
      expect(found.map((v) => [v.rule, v.text])).toEqual([
        ["border-width-without-colour", "rounded-md border bg-popover"],
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    expect(TARGETS).toContain(join(PRIMITIVES_DIR, "dialog.tsx"));
    expect(TARGETS).toContain(join(PRIMITIVES_DIR, "sheet.tsx"));
  });

  test("the documented measure exemption reaches one Layout.tsx site: the pair occurs there and nowhere else", () => {
    const hits = SPA_TARGETS.flatMap((file) =>
      Array.from(readFileSync(file, "utf8").matchAll(new RegExp(DOCUMENTED_MEASURE)), (match) =>
        `${relative(SPA_DIR, file)}:${match[0]}`,
      ),
    );
    const expected = ["Layout.tsx:max-w-[1200px]", "Layout.tsx:max-w-[960px]"];
    expect([...hits].sort()).toEqual(expected.sort());
  });

  test("the scanned source has no bare colour literals, bracket arbitrary values, palette utilities, or colourless border widths", () => {
    const violations = [
      ...SPA_TARGETS.flatMap((file) => scanContent(readFileSync(file, "utf8"), relative(REPO, file))),
      ...PRIMITIVE_TARGETS.flatMap((file) =>
        scanContent(readFileSync(file, "utf8"), relative(REPO, file), PRIMITIVES_RULES),
      ),
    ];
    const message = violations.map((v) => `${v.file}:${v.line}: [${v.rule}] ${v.text}`).join("\n");
    expect(violations, `visual discipline violations:\n${message}`).toEqual([]);
  });
});
