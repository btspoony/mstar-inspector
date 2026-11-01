/**
 * The design-system gate: one entry point, six links of one chain. CI runs this
 * and nothing else of the chain.
 *
 *   source → stylesheet   `scripts/build-tokens.ts --check` (also emits the
 *                         SSR face's token table, checked in the same run)
 *   source → fixture      `scripts/build-fixture.ts --check`
 *   fixture → DESIGN.md   `documentSync()` below
 *   source → preview      `scripts/build-design-preview.tsx --check`
 *   consumers → source    `danglingReferences()` below — every `var(--x)` a
 *                         hand-written stylesheet or HTML shell under `src/spa`
 *                         consumes names a token
 *   fills → surfaces      `chartFillContrast()` below — every chart fill clears
 *                         WCAG 1.4.11's 3:1 on the surfaces it paints on
 *                         (`I-000254`)
 *
 * Every link is checked even when an earlier one is broken, so one run reports
 * the whole picture instead of the first failure. Exit 1 when any link is.
 *
 * The consumers link is the one the four generator links cannot make. A
 * generator compares committed output against the source it is derived from; a
 * hand-written stylesheet is derived from nothing, so retiring a token leaves
 * its `var(--x)` resolving to nothing, the Tailwind utility that reads it
 * painting an unset colour, and all four generator links green.
 *
 * `mstar design-md validate .` is deliberately **not** here: the CLI installs
 * from GitHub, so CI would gain an unpinned network dependency. It stays a
 * local second gate; this file's document link covers the drift CI can see.
 *
 * The document link reads the **frontmatter**, not the body: the frontmatter is
 * the token SSOT, and a prose mention that happens to carry a stale value is a
 * second copy, never the authority.
 *
 * Both directions are total. Forward: every fixture token is compared at the
 * slot its layer and name route to. Reverse: every frontmatter leaf under a
 * group the forward pass writes (`themes.<theme>.colors`, `typography`,
 * `spacing`, `rounded`, `motion`, `elevation`) must be backed by a fixture
 * token, apart from the two spec-required keys in `DOCUMENT_ONLY`.
 *
 * Three token classes have no frontmatter slot at all, and the report prints
 * them with their reason rather than dropping them quietly:
 *
 * - the component layer — frontmatter `components:` is variant-shaped
 *   (`backgroundColor`, `textColor`, `rounded`, …), not token-shaped, so the
 *   33 component tokens have no one-to-one key to land on;
 * - primitive invariants (font families, breakpoints) — a family is carried per
 *   typography role, which the `typo-*-family` comparison already covers, and
 *   the spec keeps breakpoints in the body;
 * - semantic geometry (control and row heights) — the spec has no size group.
 *
 * Usage:
 *   bun scripts/design-system-check.ts   # exit 1 on any broken link
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import path from "node:path";

import type { ThemeName } from "../src/design-system/tokens";
import { THEMES, resolveTheme } from "../src/design-system/tokens";

const ROOT = path.resolve(import.meta.dir, "..");
const FIXTURE_PATH = path.join(ROOT, "src/design-system/fixture.json");
const DESIGN_PATH = path.join(ROOT, "DESIGN.md");
const SPA_ROOT = path.join(ROOT, "src/spa");
/** The one stylesheet under `src/spa` the token source derives — link 1 owns it. */
const GENERATED_STYLESHEET = "src/spa/styles/tokens.css";
const CONSUMER_FILE = /\.(?:css|html)$/;

/**
 * The links that are a `--check` run of a generator, in report order. The
 * document link is not one of them: it compares in-process, below.
 */
const GENERATORS = [
  { script: "scripts/build-tokens.ts", label: "source → stylesheet + SSR tokens" },
  { script: "scripts/build-fixture.ts", label: "source → fixture" },
  { script: "scripts/build-design-preview.tsx", label: "source → preview" },
] as const;

/**
 * Every hand-written stylesheet and HTML shell under `src/spa` — the consumers
 * no generator link sees: nothing derives them, so nothing notices when a name
 * they reference stops existing.
 *
 * Derived from the tree, not listed: a list is a guard whose coverage is its
 * own contents, and the first cut of this link named two of the four consumers
 * that already existed. A new stylesheet joins the link by existing.
 * The generated stylesheet is the one exclusion — link 1 already proves it
 * equals the token source.
 */
export function stylesheetConsumers(dir: string = SPA_ROOT): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) {
      out.push(...stylesheetConsumers(full));
    } else if (CONSUMER_FILE.test(entry)) {
      const file = path.relative(ROOT, full);
      if (file !== GENERATED_STYLESHEET) out.push(file);
    }
  }
  return out.sort();
}

/**
 * A `var()` reference, whether or not it carries a fallback or spaces inside
 * the call: `var(--x)`, `var(--x, #fff)`, `var( --x )` and `var( --x , … )`
 * all name `x`. Requiring the closing paren immediately after the name lost the
 * fallback form, which is the one that hides a retired token behind a literal;
 * requiring no space after `(` lost the same reference in its spaced spelling.
 */
const REFERENCE = /var\s*\(\s*--([a-z0-9-]+)[\s,)]/g;
/**
 * A custom property the stylesheet declares itself — the bridge's own keys.
 * The declared value is captured with the name: a declaration that references
 * its own name excuses nothing (see `danglingReferences`).
 */
const DECLARATION = /(?:^|[;{\s}])(--[a-z0-9-]+)\s*:\s*([^;{}]*)/g;
/** A block comment declares nothing: a commented-out `--legacy-x:` is not a declaration. */
const COMMENT = /\/\*[\s\S]*?\*\//g;

export interface DanglingReference {
  readonly file: string;
  readonly name: string;
  readonly theme: ThemeName;
}

/**
 * Every `var(--x)` in `css` that names neither a token of `theme` nor a property
 * the file declares itself. Checked per theme rather than over the union: a name
 * one theme declares and the other does not is dangling in the other one, and
 * the union would hide exactly that.
 *
 * A declaration excuses references to its name only when it is not itself the
 * cycle: `--x: var(--x)` (the fallback and spaced spellings included) is
 * guaranteed-invalid in CSS — the paint breaks while the gate stayed green
 * (`I-000248`). Only that spelling loses its vote; a name declared genuinely
 * elsewhere in the file still excuses its references.
 *
 * Comments are stripped before either match, so a retired name quoted in prose
 * neither becomes a reference nor a self-declaration that suppresses the check.
 */
export function danglingReferences(file: string, css: string): DanglingReference[] {
  const live = css.replace(COMMENT, "");
  const local = new Set(
    [...live.matchAll(DECLARATION)]
      .filter((match) => !new RegExp(`var\\s*\\(\\s*${match[1]}(?=[\\s,)])`).test(match[2] as string))
      .map((match) => (match[1] as string).slice(2)),
  );
  const names = [...new Set([...live.matchAll(REFERENCE)].map((match) => match[1] as string))].sort();
  return THEMES.flatMap((theme) => {
    const layers = resolveTheme(theme);
    const known = new Set([
      ...Object.keys(layers.primitive),
      ...Object.keys(layers.semantic),
      ...Object.keys(layers.component),
    ]);
    return names
      .filter((name) => !known.has(name) && !local.has(name))
      .map((name) => ({ file, name, theme }));
  });
}

type Layer = Readonly<Record<string, string>>;
export type Fixture = Readonly<Record<ThemeName, Readonly<Record<string, Layer>>>>;

/** `typo-copy-14-line` → `typography.copy-14.lineHeight`. */
const TYPO_PROP: Readonly<Record<string, string>> = {
  family: "fontFamily",
  size: "fontSize",
  weight: "fontWeight",
  line: "lineHeight",
  tracking: "letterSpacing",
};

/** `radius-control` → `rounded.sm` — the AD-574 two-tier names. */
const RADIUS_KEY: Readonly<Record<string, string>> = {
  control: "sm",
  container: "md",
  pill: "full",
};

type Slot = { readonly path: string } | { readonly reason: string };

const NO_SLOT_COMPONENT = "component layer — frontmatter `components:` is variant-shaped, not token-shaped";
const NO_SLOT_INVARIANT = "font family / breakpoint — carried per typography role, or body-only per the spec";
const NO_SLOT_GEOMETRY = "control / row height — the spec has no size group";

/**
 * Frontmatter leaves the design-md spec requires that no fixture token backs.
 * They are named so the reverse sweep can stay total: any other declared leaf
 * under these groups is a name the source dropped. Printed, never silent.
 */
const DOCUMENT_ONLY: Readonly<Record<string, string>> = {
  "spacing.base": "design-md-spec §Spacing requires the base unit in frontmatter",
  "motion.reduced-motion": "the reduced-motion fold is a media-query rule, not a duration token",
};

/**
 * Where one fixture token belongs in the frontmatter, for one theme. A `reason`
 * means the document cannot express the token at all; it is reported, never
 * skipped.
 *
 * Routing is by layer and name, not by value shape: a colour whose resolved
 * value happened to be `rgb()`/`color-mix()` would fall out of a value test and
 * never be compared. Anything left in the primitive or semantic layer is a
 * colour, so an unrecognised name lands on the colour slot and is reported
 * absent — loud, not invisible.
 */
export function documentSlot(layer: string, name: string, theme: ThemeName): Slot {
  if (layer === "component") return { reason: NO_SLOT_COMPONENT };

  const typo = /^typo-(.+)-(family|size|weight|line|tracking)$/.exec(name);
  if (typo) return { path: `typography.${typo[1]}.${TYPO_PROP[typo[2] as string]}` };

  if (name.startsWith("spacing-")) return { path: `spacing.${name.slice("spacing-".length)}` };

  const radius = /^radius-(control|container|pill)$/.exec(name);
  if (radius) return { path: `rounded.${RADIUS_KEY[radius[1] as string]}` };

  if (/^(?:duration|ease)-/.test(name)) return { path: `motion.${name}` };

  if (name.startsWith("shadow-")) return { path: `elevation.${name}.${theme}` };

  if (/^(?:control|row)-h-/.test(name)) return { reason: NO_SLOT_GEOMETRY };

  if (layer === "primitive" && /^(?:font|breakpoint)-/.test(name)) return { reason: NO_SLOT_INVARIANT };

  return { path: `themes.${theme}.colors.${name}` };
}

export interface Divergence {
  readonly token: string;
  /** Frontmatter path read, or the class that has no path. */
  readonly at: string;
  /** What DESIGN.md holds — `undefined` when it holds nothing there. */
  readonly document: string | undefined;
  readonly fixture: string;
}

/** A name DESIGN.md still declares that the source no longer does. */
export interface StaleName {
  readonly at: string;
  readonly document: string;
}

export interface SyncReport {
  readonly ok: boolean;
  /** Token/path pairs compared — one count per theme for a themed value. */
  readonly compared: number;
  readonly divergences: readonly Divergence[];
  /** Document-only names under a group the forward pass writes: the reverse direction. */
  readonly stale: readonly StaleName[];
  /**
   * Two fixture tokens claiming one frontmatter path with different values:
   * either the two themes disagree on a theme-independent slot, or two names
   * route to the same slot. Neither can be represented by one document value.
   */
  readonly collisions: readonly Collision[];
  /** Names the frontmatter cannot hold, by reason. */
  readonly unexpressed: Readonly<Record<string, number>>;
}

export interface Collision {
  /** Frontmatter path both claims landed on. */
  readonly at: string;
  readonly first: string;
  readonly firstValue: string;
  readonly second: string;
  readonly secondValue: string;
}

/** One hop; absent or non-object nodes read as `undefined`, never throw. */
const hop = (node: unknown, key: string): unknown =>
  typeof node === "object" && node !== null && Object.hasOwn(node, key)
    ? Reflect.get(node, key)
    : undefined;

/** Reads `a.b.c` out of the frontmatter; `undefined` when any hop is absent. */
function at(frontmatter: Record<string, unknown>, dotted: string): unknown {
  return dotted.split(".").reduce<unknown>(hop, frontmatter);
}

/** Every leaf path under `node`, prefixed: `typography.heading-32.fontSize`. */
function leaves(node: unknown, prefix: string): string[] {
  if (typeof node !== "object" || node === null || Array.isArray(node)) return [prefix];
  return Object.entries(node).flatMap(([key, child]) => leaves(child, `${prefix}.${key}`));
}

/**
 * Compares every fixture token against the frontmatter. Values compare as text:
 * YAML keeps `1.6` and `600` numbers while the fixture holds the CSS strings the
 * source declares, and `1.6` and `"1.6"` are the same token value.
 *
 * A theme-independent token (`spacing-4`, `duration-fast`) reaches the same
 * path from both themes. The second claim is **compared**, not skipped: equal
 * values are one comparison, different values are a collision the document
 * cannot satisfy.
 *
 * Both directions are total. Forward catches a value the document has not
 * caught up with; reverse catches a name the source dropped that the document
 * still declares — over every group the forward pass writes, not colours only,
 * which is where the palette reduction leaves its debris.
 * Only `themes.<theme>.colors` is read for colours: the top-level `colors:` map
 * mirrors the dark group, so counting it would report every name twice.
 */
export function documentSync(fixture: Fixture, frontmatter: Record<string, unknown>): SyncReport {
  const divergences: Divergence[] = [];
  const stale: StaleName[] = [];
  const collisions: Collision[] = [];
  const unexpressed: Record<string, number> = {};
  const emitted = new Map<string, { token: string; value: string }>();
  const liveColors = new Map<ThemeName, Set<string>>();

  for (const theme of THEMES) {
    const layers = fixture[theme];
    if (layers === undefined) throw new Error(`fixture is missing theme "${theme}"`);
    const colors = new Set<string>();
    liveColors.set(theme, colors);

    for (const [layer, tokens] of Object.entries(layers)) {
      for (const [name, value] of Object.entries(tokens)) {
        const token = `${layer}/${name} [${theme}]`;
        const slot = documentSlot(layer, name, theme);
        if ("reason" in slot) {
          unexpressed[slot.reason] = (unexpressed[slot.reason] ?? 0) + 1;
          continue;
        }
        if (slot.path.startsWith("themes.")) colors.add(name);

        const prior = emitted.get(slot.path);
        if (prior !== undefined) {
          if (prior.value !== value) {
            collisions.push({ at: slot.path, first: prior.token, firstValue: prior.value, second: token, secondValue: value });
          }
          continue;
        }
        emitted.set(slot.path, { token, value });
        const held = at(frontmatter, slot.path);
        const candidate: Divergence = {
          token,
          at: slot.path,
          document: held === undefined ? undefined : String(held),
          fixture: value,
        };
        if (candidate.document !== candidate.fixture) divergences.push(candidate);
      }
    }
  }

  // Reverse sweep: colours per theme, then every group the forward pass writes.
  for (const theme of THEMES) {
    const declared = at(frontmatter, `themes.${theme}.colors`);
    if (typeof declared !== "object" || declared === null) continue;
    const live = liveColors.get(theme)!;
    for (const [name, value] of Object.entries(declared)) {
      if (!live.has(name)) stale.push({ at: `themes.${theme}.colors.${name}`, document: String(value) });
    }
  }
  for (const group of ["typography", "spacing", "rounded", "motion", "elevation"] as const) {
    // An absent group is the forward pass's to report: every token it would
    // hold reads as absent. Only a declared group can carry stale leaves.
    const declared = at(frontmatter, group);
    if (typeof declared !== "object" || declared === null) continue;
    for (const path of leaves(declared, group)) {
      if (emitted.has(path) || Object.hasOwn(DOCUMENT_ONLY, path)) continue;
      stale.push({ at: path, document: String(at(frontmatter, path)) });
    }
  }

  return {
    ok: divergences.length === 0 && stale.length === 0 && collisions.length === 0,
    compared: emitted.size,
    divergences,
    stale,
    collisions,
    unexpressed,
  };
}

/**
 * The failure is read by whoever has to raise `DESIGN.md` onto the fixture, so
 * a disagreement prints both values in full, while absent names are grouped by
 * the frontmatter path prefix they belong under — 94 missing keys are one
 * structural fact per group, not 94 separate investigations.
 */
function report(report: SyncReport): void {
  const absent = report.divergences.filter((d) => d.document === undefined);
  const disagreeing = report.divergences.filter((d) => d.document !== undefined);
  const problems = report.divergences.length + report.stale.length + report.collisions.length;

  console.log(
    `fixture → DESIGN.md frontmatter: ${report.ok ? "in sync" : `${problems} divergence(s)`} (${
      report.compared
    } compared: ${disagreeing.length} disagreeing, ${absent.length} absent, ${report.stale.length} stale, ${
      report.collisions.length
    } colliding)`,
  );
  // Coverage is part of the verdict: "in sync" is only as strong as the sweep
  // that produced it, so the sweep says what it read in both directions.
  const documentOnly = Object.keys(DOCUMENT_ONLY).join(", ");
  console.log(
    `  both ways over: themes.<theme>.colors, typography, spacing, rounded, motion, elevation` +
      (documentOnly === "" ? "" : ` — document-only by spec: ${documentOnly}`) +
      "; the component layer and the invariant/geometry classes above have no slot.",
  );
  if (!report.ok) {
    console.log("  DESIGN.md is the last link (source → fixture → DESIGN.md): it is raised onto the");
    console.log("  fixture, never the reverse. Until that rewrite lands this reports what the document says.");
    console.log();
  }

  for (const d of disagreeing) {
    console.log(`  ${d.token}`);
    console.log(`    at ${d.at}`);
    console.log(`    DESIGN.md: ${JSON.stringify(d.document)}`);
    console.log(`    fixture:   ${JSON.stringify(d.fixture)}`);
  }

  const byGroup = new Map<string, Divergence[]>();
  for (const d of absent) {
    const group = d.at.split(".").slice(0, 3).join(".");
    byGroup.set(group, [...(byGroup.get(group) ?? []), d]);
  }
  for (const [group, members] of byGroup) {
    console.log(`  absent from ${group} (${members.length}):`);
    for (const d of members) console.log(`    ${d.token}  fixture ${JSON.stringify(d.fixture)}`);
  }

  if (report.stale.length > 0) {
    console.log(`  declared by DESIGN.md, no longer in the source (${report.stale.length}):`);
    for (const s of report.stale) console.log(`    ${s.at}  ${JSON.stringify(s.document)}`);
  }

  if (report.collisions.length > 0) {
    console.log(`  two source tokens claim one frontmatter path (${report.collisions.length}):`);
    for (const c of report.collisions) {
      console.log(`    ${c.at}`);
      console.log(`      ${c.first}  ${JSON.stringify(c.firstValue)}`);
      console.log(`      ${c.second}  ${JSON.stringify(c.secondValue)}`);
    }
  }

  for (const [reason, count] of Object.entries(report.unexpressed)) {
    console.log(`  outside the frontmatter contract: ${count} × ${reason}`);
  }
}

/** The fixture as data. `themes` is the only key this gate reads. */
export function parseFixture(json: string): Fixture {
  const parsed: unknown = JSON.parse(json);
  const themes = hop(parsed, "themes");
  if (typeof themes !== "object" || themes === null) {
    throw new Error(`${path.relative(ROOT, FIXTURE_PATH)} has no "themes" map; run \`bun scripts/build-fixture.ts\`.`);
  }
  // Shape checked above for the one map this gate reads; the rest is the
  // generator's output, not external input.
  return themes as Fixture;
}

function readFrontmatter(): Record<string, unknown> {
  const md = readFileSync(DESIGN_PATH, "utf8");
  const fenced = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(md);
  if (fenced === null) throw new Error("DESIGN.md has no `---` fenced YAML frontmatter");
  const parsed: unknown = Bun.YAML.parse(fenced[1] as string);
  if (typeof parsed !== "object" || parsed === null) throw new Error("DESIGN.md frontmatter is not a YAML map");
  // A parsed YAML map is a record by definition; the keys are the document's.
  return parsed as Record<string, unknown>;
}

/** WCAG 1.4.11 non-text bar: a chart fill is a large graphic, not body copy. */
export const CHART_CONTRAST_MIN = 3;

/** One chart fill measured on one backdrop, both named by semantic token. */
export interface ChartPair {
  readonly theme: ThemeName;
  readonly fill: string;
  readonly backdrop: string;
}

export interface ContrastMeasurement extends ChartPair {
  readonly ratio: number;
}

const CHART_FILLS = ["chart-1", "chart-2", "chart-3", "chart-4", "chart-5", "chart-6"] as const;

/**
 * Which chart fill sits on which backdrop. The shipped charts paint on the
 * page canvas: `AppInsightsTab` renders them in bare `FlowSection`s and
 * `.chart-frame` paints no background of its own
 * (`src/spa/components/charts/charts.css`). Dark declares its two raised
 * planes as well — a chart hosted on a card or inset face must clear the same
 * bar, and dark `chart-5` measured 2.900:1 on `surface-card` and 2.696:1 on
 * `surface-inset` before it was lifted (I-000232); relying on "charts never
 * sit on a card" as the only mechanism is exactly what failed there. Light's
 * `surface-card` is the page white, so the page pairing covers both faces.
 * Light `surface-inset` (`#f3f5f8`) is not a chart backdrop today: light
 * `chart-3` measures 2.917:1 on it, and no fill is hosted there.
 */
export const CHART_PAIRS: readonly ChartPair[] = [
  ...THEMES.flatMap((theme) => CHART_FILLS.map((fill) => ({ theme, fill, backdrop: "surface-page" }))),
  ...CHART_FILLS.flatMap((fill) => [
    { theme: "dark" as const, fill, backdrop: "surface-card" },
    { theme: "dark" as const, fill, backdrop: "surface-inset" },
  ]),
];

/** WCAG 2.x relative luminance of an opaque `#rrggbb` literal, or a refusal. */
function luminance(hex: string): number {
  const match = /^#([0-9a-f]{6})$/i.exec(hex);
  if (match === null) {
    throw new Error(`${hex} is not an opaque #rrggbb colour; the contrast link measures resolved literals only`);
  }
  const digits = match[1] as string;
  const [r, g, b] = [0, 2, 4].map((offset) => {
    const channel = parseInt(digits.slice(offset, offset + 2), 16) / 255;
    return channel <= 0.03928 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** The WCAG contrast ratio of two opaque colours. */
export function contrastRatio(a: string, b: string): number {
  const [lighter, darker] = [luminance(a), luminance(b)].sort((left, right) => right - left) as [number, number];
  return (lighter + 0.05) / (darker + 0.05);
}

/**
 * Every declared chart pairing, measured on the resolved semantic values —
 * `resolveTheme`, never a copied table or a re-parse of the generated
 * stylesheet. A missing token throws: a pairing that measures nothing must
 * not read as a pass.
 */
export function chartFillContrast(
  layers: (theme: ThemeName) => Readonly<Record<string, string>>,
  pairs: readonly ChartPair[] = CHART_PAIRS,
): ContrastMeasurement[] {
  return pairs.map(({ theme, fill, backdrop }) => {
    const tokens = layers(theme);
    const fillValue = tokens[fill];
    const backdropValue = tokens[backdrop];
    if (fillValue === undefined) throw new Error(`${fill} is not a ${theme} semantic token`);
    if (backdropValue === undefined) throw new Error(`${backdrop} is not a ${theme} semantic token`);
    return { theme, fill, backdrop, ratio: contrastRatio(fillValue, backdropValue) };
  });
}

/** The measurements below the bar — the gate fails on a non-empty list. */
export function chartContrastFailures(
  measurements: readonly ContrastMeasurement[],
): ContrastMeasurement[] {
  return measurements.filter(({ ratio }) => ratio < CHART_CONTRAST_MIN);
}

if (import.meta.main) {
  const brokenLinks: string[] = [];

  for (const { script, label } of GENERATORS) {
    const run = Bun.spawnSync(["bun", script, "--check"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    const output = `${run.stdout.toString()}${run.stderr.toString()}`.trim();
    console.log(`${run.exitCode === 0 ? "ok  " : "fail"}  ${label}`);
    for (const line of output.split("\n")) console.log(`        ${line}`);
    if (run.exitCode !== 0) brokenLinks.push(label);
  }

  // A missing or malformed fixture is a broken link, never an early exit: the
  // consumer link below must still run, or this gate reports on a tree it only
  // partly checked — and a link an earlier failure can skip reads as green.
  const sync = (() => {
    try {
      if (!existsSync(FIXTURE_PATH)) {
        throw new Error(`${path.relative(ROOT, FIXTURE_PATH)} is missing; run \`bun scripts/build-fixture.ts\`.`);
      }
      return documentSync(parseFixture(readFileSync(FIXTURE_PATH, "utf8")), readFrontmatter());
    } catch (error) {
      // The message names the cause and the command that regenerates the file.
      console.error(`fail  fixture → DESIGN.md: ${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  })();
  if (sync === null) {
    brokenLinks.push("fixture → DESIGN.md");
  } else {
    report(sync);
    if (!sync.ok) brokenLinks.push("fixture → DESIGN.md");
  }

  const consumers = stylesheetConsumers();
  const dangling = consumers.flatMap((file) =>
    danglingReferences(file, readFileSync(path.join(ROOT, file), "utf8")),
  );
  // A walk that found no stylesheet proves nothing (wrong root, moved tree):
  // that is a failure, not an empty pass.
  console.log(`${consumers.length > 0 && dangling.length === 0 ? "ok  " : "fail"}  consumers → source`);
  if (consumers.length === 0) console.log(`        no stylesheet found under ${path.relative(ROOT, SPA_ROOT)}`);
  for (const { file, name, theme } of dangling) {
    console.log(`        ${file}: --${name} is not a token in the ${theme} theme`);
  }
  if (consumers.length === 0 || dangling.length > 0) brokenLinks.push("consumers → source");

  // A chart fill is a large graphic face: WCAG 1.4.11's 3:1, not 4.5:1. Every
  // pair prints its measured ratio, so a token change that erodes a margin is
  // a visible diff rather than a silent pass.
  const contrast = chartFillContrast((theme) => resolveTheme(theme).semantic);
  const below = chartContrastFailures(contrast);
  console.log(`${below.length === 0 ? "ok  " : "fail"}  chart fill contrast`);
  for (const { theme, fill, backdrop, ratio } of contrast) {
    const mark = ratio < CHART_CONTRAST_MIN ? `  BELOW ${CHART_CONTRAST_MIN}:1` : "";
    console.log(`        ${theme} ${fill} on ${backdrop}: ${ratio.toFixed(3)}:1${mark}`);
  }
  if (below.length > 0) brokenLinks.push("chart fill contrast");

  if (brokenLinks.length > 0) {
    console.error(`\ndesign-system-check: ${brokenLinks.length} broken link(s): ${brokenLinks.join(", ")}`);
    process.exit(1);
  }
  console.log("\ndesign-system-check: every link is intact");
}
