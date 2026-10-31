/**
 * The design-system gate: one entry point, three links of one chain.
 *
 *   source → stylesheet   `scripts/build-tokens.ts --check`
 *   source → fixture      `scripts/build-fixture.ts --check`
 *   fixture → DESIGN.md   `documentSync()` below
 *
 * Every link is checked even when an earlier one is broken, so one run reports
 * the whole picture instead of the first failure. Exit 1 when any link is.
 *
 * The document link reads the **frontmatter**, not the body: the frontmatter is
 * the token SSOT, and a prose mention that happens to carry a stale value is a
 * second copy, never the authority.
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

/** The chain's first two links, in the order the data flows. */
const GENERATORS = ["scripts/build-tokens.ts", "scripts/build-fixture.ts"] as const;

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

const COLOR = /^(?:#[0-9a-f]{3,8}|oklch\()/i;

type Slot = { readonly path: string } | { readonly reason: string };

const NO_SLOT_COMPONENT = "component layer — frontmatter `components:` is variant-shaped, not token-shaped";
const NO_SLOT_INVARIANT = "font family / breakpoint — carried per typography role, or body-only per the spec";
const NO_SLOT_GEOMETRY = "control / row height — the spec has no size group";

/**
 * Where one fixture token belongs in the frontmatter, for one theme. A `reason`
 * means the document cannot express the token at all; it is reported, never
 * skipped.
 */
export function documentSlot(layer: string, name: string, value: string, theme: ThemeName): Slot {
  if (layer === "component") return { reason: NO_SLOT_COMPONENT };

  const typo = /^typo-(.+)-(family|size|weight|line|tracking)$/.exec(name);
  if (typo) return { path: `typography.${typo[1]}.${TYPO_PROP[typo[2] as string]}` };

  if (name.startsWith("spacing-")) return { path: `spacing.${name.slice("spacing-".length)}` };

  const radius = /^radius-(control|container|pill)$/.exec(name);
  if (radius) return { path: `rounded.${RADIUS_KEY[radius[1] as string]}` };

  if (/^(?:duration|ease)-/.test(name)) return { path: `motion.${name}` };

  if (name.startsWith("shadow-")) return { path: `elevation.${name}.${theme}` };

  if (COLOR.test(value)) return { path: `themes.${theme}.colors.${name}` };

  if (/^(?:control|row)-h-/.test(name)) return { reason: NO_SLOT_GEOMETRY };
  return { reason: NO_SLOT_INVARIANT };
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
  /** Document-only names under `themes.<theme>.colors`: the reverse direction. */
  readonly stale: readonly StaleName[];
  /** Names the frontmatter cannot hold, by reason. */
  readonly unexpressed: Readonly<Record<string, number>>;
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

/**
 * Compares every fixture token against the frontmatter. Values compare as text:
 * YAML keeps `1.6` and `600` numbers while the fixture holds the CSS strings the
 * source declares, and `1.6` and `"1.6"` are the same token value.
 *
 * A theme-independent token (`spacing-4`, `duration-fast`) reaches the same
 * path from both themes, so the comparison is keyed by path and runs once.
 *
 * The colour groups are compared both ways. One way catches a value the
 * document has not caught up with; the other catches a palette step the source
 * dropped and the document still declares — which is exactly what the palette
 * reduction leaves behind, and what a rewrite from the fixture must remove.
 * Only `themes.<theme>.colors` is read: the top-level `colors:` map mirrors the
 * dark group, so counting it would report every name twice.
 */
export function documentSync(fixture: Fixture, frontmatter: Record<string, unknown>): SyncReport {
  const divergences: Divergence[] = [];
  const stale: StaleName[] = [];
  const unexpressed: Record<string, number> = {};
  const expected = new Map<string, Divergence>();

  for (const theme of THEMES) {
    const layers = fixture[theme];
    if (layers === undefined) throw new Error(`fixture is missing theme "${theme}"`);

    const liveColors = new Set<string>();
    for (const [layer, tokens] of Object.entries(layers)) {
      for (const [name, value] of Object.entries(tokens)) {
        const slot = documentSlot(layer, name, value, theme);
        if ("reason" in slot) {
          unexpressed[slot.reason] = (unexpressed[slot.reason] ?? 0) + 1;
          continue;
        }
        if (COLOR.test(value)) liveColors.add(name);
        if (expected.has(slot.path)) continue;
        const held = at(frontmatter, slot.path);
        expected.set(slot.path, {
          token: `${layer}/${name} [${theme}]`,
          at: slot.path,
          document: held === undefined ? undefined : String(held),
          fixture: value,
        });
      }
    }

    const declared = at(frontmatter, `themes.${theme}.colors`);
    if (typeof declared !== "object" || declared === null) continue;
    for (const [name, value] of Object.entries(declared)) {
      if (!liveColors.has(name)) stale.push({ at: `themes.${theme}.colors.${name}`, document: String(value) });
    }
  }

  for (const candidate of expected.values()) {
    if (candidate.document !== candidate.fixture) divergences.push(candidate);
  }

  return { ok: divergences.length === 0 && stale.length === 0, compared: expected.size, divergences, stale, unexpressed };
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

  console.log(
    `fixture → DESIGN.md frontmatter: ${
      report.ok ? "in sync" : `${report.divergences.length + report.stale.length} divergence(s)`
    } (${report.compared} compared: ${disagreeing.length} disagreeing, ${absent.length} absent, ${report.stale.length} stale)`,
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

  for (const script of GENERATORS) {
    const run = Bun.spawnSync(["bun", script, "--check"], { cwd: ROOT, stdout: "pipe", stderr: "pipe" });
    const label = script === "scripts/build-tokens.ts" ? "source → stylesheet" : "source → fixture";
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
