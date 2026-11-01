/**
 * Visual discipline guard for hand-written source (2026-10).
 *
 * The scanned files must not carry raw colour literals, bracket-syntax
 * arbitrary values, default-palette Tailwind utilities, or a border width with
 * no colour in the same class string; all colour/sizing comes from DESIGN.md
 * tokens.
 *
 * The target list is DERIVED from two roots, both walked by `colourSources`,
 * never listed:
 *
 * - `src/spa/**` — every hand-written file there that can carry a class string
 *   or a colour, minus the generated stylesheet, which the gate's link 1
 *   already proves equals the token source. It used to name `pages/**`,
 *   `Layout.tsx`, `admin/**` and the shells, so `components/**` and
 *   `styles/fonts.css` — where `I-000235`'s remaining sites lived — were
 *   scanned only if some rendered surface happened to paint them.
 * - `src/design-system/primitives/**` — a primitive hands the consumer the
 *   class string it renders, so its own hairline has to be coloured on its own
 *   element. The colourless border sites `I-000260` recorded lived here, and
 *   this guard never walked the directory that held them. Primitives answer the
 *   colour vocabulary and the hairline rule; the geometry half of the
 *   arbitrary-value rule is a page-layer rule (see `ARBITRARY_GEOMETRY`).
 *
 * The rest of `src/design-system/**` stays OUT, each part for its own reason —
 * not "it is guarded elsewhere", which is what this guard used to claim:
 *
 * - `patterns/**` composes its face from `cva` variant maps, where the colour
 *   lives in a DIFFERENT class string applied to the same element
 *   (`StatusBadge`'s base `border` plus the tone variant's border token). The
 *   border rule's unit is one class string, so it cannot see across that
 *   composition and would report a defect that is not one.
 * - `tokens/**` DECLARES the literals: it is the value authority these rules
 *   compare against, so scanning it would flag the source of truth.
 * - `baseline/**` is the design specimen the port was measured from — raw
 *   values are its content, and DESIGN.md is its summary.
 * - the generated fixture (`fixture.json`) is not a colour source; it is
 *   derived from `tokens/**` and checked by the design-system gate.
 *
 * Matcher contract:
 * - Arbitrary values match by BRACKET SYNTAX ONLY:
 *     /\[(#[0-9a-fA-F]{3,8}|\d+px|calc\(|color-mix\(/
 *   so ordinary scale utilities (p-4, gap-2, grid-cols-3, -translate-y-1)
 *   can never match; `bottom-[-2px]` does not match either (`[` is followed
 *   by `-`, not a digit). The rule has two spellings with two owners: a
 *   bracket COLOUR is a violation in every scanned file, a bracket GEOMETRY
 *   value only on the page layer.
 * - Colour literals: /#[0-9a-fA-F]{3,8}\b/ outside rgba(/hsl( context.
 * - Palette utilities: a Tailwind colour utility whose suffix is a default
 *   palette name plus a numeric shade (`text-red-500`, `border-t-red-500`).
 *   The utility prefix is required, so the token forms carrying the same
 *   palette name — `bg-(--gray-200)`, `text-(--gray-700)` — and the
 *   non-palette `brand-700` never match.
 * - Border width: bare `border` / `border-{side}` with no border colour in
 *   the same class string paints only a width — preflight leaves
 *   `border-color` at `currentColor` (`I-000235`). The unit is the class
 *   string, so `border-b border-border` passes.
 * - Allow-list starts EMPTY: every hit is a genuine violation or the
 *   matcher is wrong (fix the matcher, never pad the allow-list).
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { describe, expect, test } from "bun:test";

import { PALETTE_UTILITY_SOURCE } from "../helpers/tailwind-palette";

const REPO = new URL("../../", import.meta.url).pathname;

const SPA_DIR = join(REPO, "src/spa");
/**
 * The design-system primitives — the one directory whose class strings a page
 * does not restyle. Its own root, so a site there is reachable (I-000260).
 */
const PRIMITIVES_DIR = join(REPO, "src/design-system/primitives");
/** The one stylesheet the token source derives — the gate's link 1 owns it. */
const GENERATED_STYLESHEET = "styles/tokens.css";
/** A file that can carry a class string or a colour. */
const COLOUR_SOURCE = /\.(?:tsx?|css|html)$/;

/** Every hand-written colour-carrying file under `root`, derived not listed. */
function colourSources(root: string = SPA_DIR): string[] {
  return listFiles(root)
    .filter((file) => COLOUR_SOURCE.test(file))
    .filter((file) => relative(root, file) !== GENERATED_STYLESHEET)
    .sort();
}

const SPA_TARGETS = colourSources(SPA_DIR);
const PRIMITIVE_TARGETS = colourSources(PRIMITIVES_DIR);
const TARGETS = [...SPA_TARGETS, ...PRIMITIVE_TARGETS];

/**
 * Bracket-syntax arbitrary values, in two spellings with different owners.
 *
 * - COLOUR (`bg-[#1a2b3c]`) is a violation in every scanned file: a colour
 *   comes from the token layer, never from a hand-written literal.
 * - GEOMETRY (`[17px]`, `[calc(…)`, `[color-mix(…)`) is a PAGE-layer rule: a
 *   page must not hand-roll a value the token layer or the scale should own,
 *   while a primitive legitimately owns its own shape (`max-w-[calc(100%-2rem)]`
 *   and `h-[calc(100%-1px)]` on an overlay, `ring-[3px]` on a focus halo, the
 *   rail's width arithmetic). The design system carries no token for those, so
 *   applying this half to the primitives root would demand a token for geometry
 *   that intentionally has none.
 */
const ARBITRARY_COLOUR = /\[(#[0-9a-fA-F]{3,8})/g;
const ARBITRARY_GEOMETRY = /\[(\d+px|calc\(|color-mix\()/g;
/** Bare hex, excluding hex used inside rgba(/hsl( function arguments. */
const HEX_OUTSIDE_FN = /#[0-9a-fA-F]{3,8}\b/g;
/** rgba(/hsl( argument spans stripped before the hex rule runs. */
const FN_SPAN = /\b(?:rgba|hsl)a?\([^)]*\)/g;
/**
 * Default-palette Tailwind colour utility: `text-red-500`, `bg-zinc-100`,
 * `border-slate-700`, `border-t-red-500`. The utility prefix is part of the
 * pattern, so a token that merely carries a palette name
 * (`bg-(--gray-200)`) cannot match.
 *
 * The list lives in `tests/helpers/tailwind-palette.ts`: this guard kept a
 * private copy whose prefixes drifted from the shared one (I-000255/247), so
 * a utility one consumer caught the others never saw. Compiled here with `/g`
 * because the scan walks a whole file; StatusBadge compiles it without.
 */
const PALETTE_UTILITY = new RegExp(PALETTE_UTILITY_SOURCE, "g");

/** Allow-list: starts empty. A hit here must be a proven false positive. */
const ALLOW: string[] = [];

type GuardRule = { label: string; re: RegExp; strip?: RegExp };

/** The colour vocabulary — every scanned file answers to these. */
const COLOUR_RULES: GuardRule[] = [
  { label: "arbitrary-value", re: ARBITRARY_COLOUR },
  { label: "colour-literal", re: HEX_OUTSIDE_FN, strip: FN_SPAN },
  { label: "palette-utility", re: PALETTE_UTILITY },
];

/** The page layer owns no geometry of its own either — see ARBITRARY_GEOMETRY. */
const PAGE_RULES: GuardRule[] = [{ label: "arbitrary-value", re: ARBITRARY_GEOMETRY }, ...COLOUR_RULES];

/** A primitive answers the colour vocabulary (its geometry is its own job). */
const PRIMITIVES_RULES = COLOUR_RULES;

/**
 * A quoted class string: `className="…"`, `cn("…")`, `class="…"`. The quote
 * may not follow a word character, so a prose apostrophe (`don't`) never opens
 * a literal.
 */
const CLASS_LITERAL = /(?<![\w$])(["'`])((?:\\[\s\S]|(?!\1)[\s\S])*?)\1/g;
/** `border` / `border-{side}`: width only, so preflight leaves the colour currentColor. */
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

/** Variant prefixes: `hover:`, `after:`, `md:`, `data-[x]:`, `[&:not(:last-child)]:`. */
function stripVariants(token: string): string {
  let current = token;
  for (;;) {
    const next = current.replace(/^(?:[a-z0-9_-]+(?:\[[^\]]*\])?|\[[^\]]*\]):/i, "");
    if (next === current) return current;
    current = next;
  }
}

/** A token that names a border colour rather than a width, side or style. */
function isBorderColour(token: string): boolean {
  const match = /^border-(?:(?:t|r|b|l|s|e|x|y)-)?(.+)$/.exec(token);
  if (match === null) return false;
  const suffix = match[1] as string;
  return !(BORDER_SIDE.test(suffix) || BORDER_WIDTH_VALUE.test(suffix) || BORDER_STYLE.test(suffix));
}

/**
 * A border-width utility with no colour in the same class string. `border`
 * and `border-{side}` set a width only; with no colour named, preflight leaves
 * `border-color: currentColor`, which is the shape I-000235 shipped seven of.
 * The unit is the class string, not the token: `border-b border-border`,
 * `border-(--border-default)`, `border-input`, `border-sidebar-border` and
 * `border-transparent` all name a colour and pass.
 */
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
    // must match (v4 colour-bearing shadow/ring families — each emits
    // --tw-*-color; a bare `shadow`/`ring` prefix would miss them)
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
    // must NOT match; the shadow/ring SIZE utilities carry no colour
    expect(
      matched(`<div className="shadow-sm inset-shadow-xs ring-offset-2 drop-shadow-lg ring-2" />`),
    ).toEqual([]);
    // must NOT match; token forms of the same families
    expect(matched(`<div className="shadow-(--shadow-contact) ring-offset-(--gray-200)" />`)).toEqual([]);
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

  test("border-axis palette forms: border-t-red-500 and divide-x-red-500 matched neither matcher before I-000255; the shared source now rejects every spelling", () => {
    // The previous source required the family immediately after a bare prefix,
    // so the side/span spellings below passed the source scan, the
    // rendered-attribute scan and the component class list alike.
    const matched = (line: string) => scanContent(line, "fixture.tsx").map((v) => v.text);
    expect(matched(`<div className="border-t-red-500" />`)).toEqual(["border-t-red-500"]);
    expect(matched(`<div className="border-x-slate-700" />`)).toEqual(["border-x-slate-700"]);
    expect(matched(`<div className="border-e-gray-100" />`)).toEqual(["border-e-gray-100"]);
    expect(matched(`<div className="divide-x-red-500" />`)).toEqual(["divide-x-red-500"]);
    // The bare black/white spelling takes the axis too.
    expect(matched(`<div className="border-t-black" />`)).toEqual(["border-t-black"]);
    // StatusBadge compiles the same source without flags — the axis forms are
    // caught there too, not only in this guard.
    const noFlags = new RegExp(PALETTE_UTILITY_SOURCE);
    expect(noFlags.test("border-t-red-500")).toBe(true);
    expect(noFlags.test("divide-x-red-500")).toBe(true);
    // Previously-catchable forms stay caught, and token forms stay clean.
    expect(matched(`<div className="border-slate-700" />`)).toEqual(["border-slate-700"]);
    expect(matched(`<div className="border-t-(--border-subtle) divide-x-(--border-subtle)" />`)).toEqual([]);
  });

  test("bare black/white across the whole colour series: shadow-black and caret-black passed the nine-prefix clause; every series prefix is rejected now", () => {
    // The previous black/white clause listed nine prefixes, so the rest of the
    // series — the very prefixes the family clause carries — passed every
    // guard while painting a palette step.
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
    // The side/span axis applies to black/white too: `divide-x-black` and
    // `divide-y-white` matched neither clause while painting a palette step.
    expect(matched(`<div className="divide-x-black" />`)).toEqual(["divide-x-black"]);
    expect(matched(`<div className="divide-y-white" />`)).toEqual(["divide-y-white"]);
    // The nine the clause already carried stay caught; size and shadow-scale
    // utilities do not become false positives.
    expect(matched(`<div className="bg-black text-white border-black" />`)).toEqual([
      "bg-black",
      "text-white",
      "border-black",
    ]);
    expect(matched(`<div className="shadow-sm inset-shadow-xs ring-offset-2" />`)).toEqual([]);
    // StatusBadge compiles the same source without flags.
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
    // A colour in the same class string clears the finding — the unit is the
    // string, not the individual token.
    expect(rejected(`<div className="border-b border-border" />`)).toEqual([]);
    expect(rejected(`<div className="border border-(--border-default)" />`)).toEqual([]);
    expect(rejected(`<div className="border-input border-sidebar-border border-transparent" />`)).toEqual([]);
    expect(
      rejected(`<div className={cn(TABLE_COLS, "border-(--border-subtle) px-4 py-3 [&:not(:last-child)]:border-b")} />`),
    ).toEqual([]);
    // Widths that are not the bare side spellings are out of this rule's shape.
    expect(rejected(`<div className="border-2" />`)).toEqual([]);
    // Prose quoting the word is not a class string: comments are blanked first.
    expect(rejected(`// a bare \`border\` carries width only`)).toEqual([]);
    // A no-space trailing comment must not eat the closing quote: the previous
    // stripper blanked the character before `//`, so this violation escaped.
    expect(rejected(`const cls = "border"//no colour named`)).toEqual(["border"]);
    // The `//` of a URL is not a comment opener, so its line stays intact.
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
      // The generated stylesheet is link 1's to prove, not this scan's to repeat.
      expect(targets).not.toContain(join(root, "styles/tokens.css"));
      const found = targets.flatMap((file) => scanContent(readFileSync(file, "utf8"), relative(root, file)));
      expect(found.map((v) => v.text)).toEqual(["text-red-500", "#fff"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    // The real tree: the two directories the hand list omitted are targets, and
    // the generated stylesheet is not.
    expect(TARGETS.length).toBeGreaterThan(0);
    expect(TARGETS).toContain(join(SPA_DIR, "components/state/PageSkeleton.tsx"));
    expect(TARGETS).toContain(join(SPA_DIR, "styles/fonts.css"));
    expect(TARGETS).not.toContain(join(SPA_DIR, GENERATED_STYLESHEET));
  });

  test("the primitives root is walked, and a bare border seeded there is caught", () => {
    // The guard used to describe `src/spa` as its whole surface, so the nine
    // colourless border sites I-000260 recorded under the primitives were
    // unreachable: the header claimed a rule the walk never applied there.
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

    // …and the shipped tree really is on that walk: the coverage is the tree's,
    // not the header's.
    expect(TARGETS).toContain(join(PRIMITIVES_DIR, "dialog.tsx"));
    expect(TARGETS).toContain(join(PRIMITIVES_DIR, "sheet.tsx"));
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
