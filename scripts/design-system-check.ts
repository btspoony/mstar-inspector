/**
 * The design-system gate: one entry point, four links of one chain. CI runs this
 * and nothing else of the chain.
 *
 *   source → stylesheet   `scripts/build-tokens.ts --check`
 *   source → fixture      `scripts/build-fixture.ts --check`
 *   fixture → DESIGN.md   `documentSync()` below
 *   source → preview      `scripts/build-design-preview.ts --check`
 *
 * Every link is checked even when an earlier one is broken, so one run reports
 * the whole picture instead of the first failure. Exit 1 when any link is.
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
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";

import type { ThemeName } from "../src/design-system/tokens";
import { THEMES } from "../src/design-system/tokens";

const ROOT = path.resolve(import.meta.dir, "..");
const FIXTURE_PATH = path.join(ROOT, "src/design-system/fixture.json");
const DESIGN_PATH = path.join(ROOT, "DESIGN.md");

/**
 * The links that are a `--check` run of a generator, in report order. The
 * document link is not one of them: it compares in-process, below.
 */
const GENERATORS = [
  { script: "scripts/build-tokens.ts", label: "source → stylesheet" },
  { script: "scripts/build-fixture.ts", label: "source → fixture" },
  { script: "scripts/build-design-preview.ts", label: "source → preview" },
] as const;

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

if (import.meta.main) {
  const brokenLinks: string[] = [];

  for (const { script, label } of GENERATORS) {
    const run = Bun.spawnSync(["bun", script, "--check"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    const output = `${run.stdout.toString()}${run.stderr.toString()}`.trim();
    console.log(`${run.exitCode === 0 ? "ok  " : "fail"}  ${label}`);
    for (const line of output.split("\n")) console.log(`        ${line}`);
    if (run.exitCode !== 0) brokenLinks.push(label);
  }

  if (!existsSync(FIXTURE_PATH)) {
    console.error(`fail  fixture → DESIGN.md: ${path.relative(ROOT, FIXTURE_PATH)} is missing; run \`bun scripts/build-fixture.ts\`.`);
    process.exit(1);
  }

  const sync = (() => {
    try {
      return documentSync(parseFixture(readFileSync(FIXTURE_PATH, "utf8")), readFrontmatter());
    } catch (error) {
      // A malformed fixture or frontmatter is a broken link too, not a crash:
      // the message names the cause and the command that regenerates the file.
      console.error(`fail  fixture → DESIGN.md: ${error instanceof Error ? error.message : String(error)}`);
      process.exit(1);
    }
  })();
  report(sync);
  if (!sync.ok) brokenLinks.push("fixture → DESIGN.md");

  if (brokenLinks.length > 0) {
    console.error(`\ndesign-system-check: ${brokenLinks.length} broken link(s): ${brokenLinks.join(", ")}`);
    process.exit(1);
  }
  console.log("\ndesign-system-check: every link is intact");
}
