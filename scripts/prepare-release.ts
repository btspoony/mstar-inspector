#!/usr/bin/env bun
/**
 * prepare-release.ts — assemble changelog fragments + bump every version
 * surface (plan 50 D3).
 *
 * Usage:
 *   bun run release:prepare                    # auto patch bump (0.1.0 -> 0.1.1)
 *   bun run release:prepare -- 1.0.0           # explicit version (bare X.Y.Z, no v prefix)
 *   bun run release:prepare -- --minor         # auto minor bump
 *   bun run release:prepare -- --allow-empty   # allow an empty .changes/unreleased/
 *   bun run release:prepare -- --help
 *
 * What it does:
 *   1. Resolves the next version: explicit arg, or auto bump derived from
 *      `package.json#version` (AD-2: never from tags — this repo starts with
 *      zero tags, and tag-derived auto would be dead before the first cut).
 *   2. Reads `.changes/unreleased/*.md` fragments, grouped by `category`.
 *   3. Inserts a `## [<version>] - <date>` section into CHANGELOG.md and
 *      CHANGELOG_CN.md under `## [Unreleased]`. CN bullets come from each
 *      fragment's `<!-- CN -->` block; a fragment without one reuses its EN
 *      bullets verbatim in the Chinese changelog.
 *   4. Bumps every VERSION_SURFACES entry (shared list — see
 *      release-surfaces.ts).
 *   5. Moves consumed fragments to `.changes/archive/<version>/`.
 *
 * Fragment format: see `.changes/README.md`. Guards: the version must match
 * RELEASE_VERSION_RE and be strictly greater than the current version
 * (compareSemver); an empty unreleased/ dir requires --allow-empty; a
 * changelog already carrying a `## [<version>]` section aborts the run
 * (fail-closed rerun idempotency).
 *
 * This script only edits the working tree. Commit + PR is the caller's job
 * (the Release prep workflow commits and opens the `release vX.Y.Z` PR).
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";
import {
  CHANGELOGS,
  RELEASE_VERSION_RE,
  VERSION_SURFACES,
  bumpVersion,
  compareSemver,
  readSurfaceVersion,
  writeSurfaceVersion,
} from "./release-surfaces";

type Fragment = {
  file: string;
  category?: string;
  en: string;
  cn: string;
};

export type PrepareOptions = {
  version?: string;
  bump: "patch" | "minor";
  allowEmpty: boolean;
  /** Repo root the relative paths resolve under. Default: process.cwd(). */
  root?: string;
  /** Release date (YYYY-MM-DD) in the section header. Default: today. */
  date?: string;
};

export type PrepareResult = {
  current: string;
  version: string;
  fragments: string[];
};

const DEFAULT_CATEGORY = "Changed";

export function parseArgs(argv: string[]): {
  version?: string;
  bump: "patch" | "minor";
  allowEmpty: boolean;
  help: boolean;
} {
  const rest = argv.slice(2).filter((a) => a !== "--");
  let version: string | undefined;
  let bump: "patch" | "minor" = "patch";
  let allowEmpty = false;
  let help = false;
  for (const a of rest) {
    if (a === "--help" || a === "-h") help = true;
    else if (/^\d+\.\d+\.\d+/.test(a)) version = a;
    else if (a === "--minor") bump = "minor";
    else if (a === "--patch") bump = "patch";
    else if (a === "--allow-empty") allowEmpty = true;
    else throw new Error(`Unknown argument: ${a}`);
  }
  return { version, bump, allowEmpty, help };
}

function parseFrontmatter(text: string): { fm: Record<string, string>; body: string } {
  const fm: Record<string, string> = {};
  if (!text.startsWith("---")) return { fm, body: text };
  const end = text.indexOf("\n---", 3);
  if (end === -1) return { fm, body: text };
  const fmText = text.slice(3, end);
  const body = text.slice(end + 4).replace(/^\n/, "");
  for (const line of fmText.split("\n")) {
    const m = line.match(/^([A-Za-z0-9 _-]+):\s*(.*)$/);
    if (m) {
      // Strip a trailing inline comment (` # optional`) — the value ends at
      // the first whitespace-preceded `#` (`.changes/README.md` examples use
      // them; a `#` glued to the value without whitespace is kept).
      const key = m[1]?.trim() ?? "";
      fm[key] = (m[2] ?? "").trim().replace(/\s+#.*$/, "").trim();
    }
  }
  return { fm, body };
}

/** Parse one `.changes/unreleased/` fragment (format: `.changes/README.md`). */
export function parseFragment(file: string, text: string): Fragment {
  const { fm, body } = parseFrontmatter(text);
  const cnMarker = body.indexOf("\n<!-- CN -->");
  const strip = (s: string) => s.replace(/^\n+/, "").replace(/\n+$/, "");
  const en = cnMarker === -1 ? body : body.slice(0, cnMarker);
  const cn = cnMarker === -1 ? "" : body.slice(cnMarker + "\n<!-- CN -->".length);
  return {
    file,
    category: fm["category"]?.trim() || undefined,
    en: strip(en),
    cn: strip(cn),
  };
}

function readFragmentsDir(root: string): string {
  return join(root, ".changes", "unreleased");
}

function readFragments(root: string): Fragment[] {
  const dir = readFragmentsDir(root);
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((f) => f.endsWith(".md"))
    .sort();
  return files.map((f) => parseFragment(f, readFileSync(join(dir, f), "utf8")));
}

/**
 * Build the markdown body for one changelog's release section: fragments
 * grouped by category (default `Changed`), order preserved. The CN changelog
 * takes each fragment's CN bullets, falling back to its EN bullets when the
 * fragment has no `<!-- CN -->` block.
 */
export function buildSectionBody(lang: "en" | "cn", frags: Fragment[]): string {
  const groups: { category: string; bullets: string[] }[] = [];
  for (const f of frags) {
    const cat = f.category ?? DEFAULT_CATEGORY;
    let g = groups.find((x) => x.category === cat);
    if (!g) {
      g = { category: cat, bullets: [] };
      groups.push(g);
    }
    const body = lang === "cn" ? f.cn || f.en : f.en;
    for (const line of body.split("\n")) {
      const t = line.trimEnd();
      if (t.trim()) g.bullets.push(t);
    }
  }
  const lines: string[] = [];
  for (const g of groups) {
    lines.push(`### ${g.category}`, "", ...g.bullets, "");
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

/**
 * Insert a `## [<version>] - <date>` section into a changelog: directly under
 * `## [Unreleased]` when present, otherwise above the first existing section
 * (or at the end when the changelog has no sections yet).
 *
 * Fail-closed on reruns (QC A2): throws when the changelog already carries a
 * `## [<version>]` section — a half-applied prepare run (changelog written,
 * bump or archive not yet) must not assemble a duplicate section on retry.
 */
export function insertSection(changelog: string, version: string, date: string, body: string): string {
  const header = `## [${version}] - ${date}`;
  if (changelog.includes(`## [${version}]`)) {
    throw new Error(
      `Changelog already has a section for [${version}] — refusing to duplicate. ` +
        "If a previous prepare run was left half-applied, reset the working tree before retrying.",
    );
  }
  const section = body ? `\n${header}\n\n${body}\n\n` : `\n${header}\n\n`;
  const unreleased = changelog.indexOf("## [Unreleased]");
  if (unreleased !== -1) {
    const lineEnd = changelog.indexOf("\n", unreleased);
    if (lineEnd === -1) {
      // `## [Unreleased]` is the final line with no trailing newline — append
      // below it instead of mis-inserting at the top of the file.
      return `${changelog}\n${section}`;
    }
    const tail = changelog.slice(lineEnd + 1).replace(/^\n/, "");
    return `${changelog.slice(0, lineEnd + 1)}${section}${tail}`;
  }
  const firstSection = changelog.search(/\n## \[/);
  if (firstSection === -1) {
    return `${changelog.trimEnd()}\n\n${header}${body ? `\n\n${body}` : ""}\n`;
  }
  const head = changelog.slice(0, firstSection).trimEnd();
  const tail = changelog.slice(firstSection).replace(/^\n/, "");
  return `${head}\n\n${header}${body ? `\n\n${body}` : ""}\n\n${tail}`;
}

async function readCurrentVersion(root: string): Promise<string> {
  // Auto-bump derivation source is package.json#version specifically (AD-2) —
  // the one surface every release is cut from.
  const pkg = (await Bun.file(join(root, "package.json")).json()) as { version?: string };
  if (!pkg.version) throw new Error("package.json has no version");
  return pkg.version;
}

function archiveFragments(root: string, version: string, frags: Fragment[]): void {
  if (!frags.length) return;
  const dest = join(root, ".changes", "archive", version);
  mkdirSync(dest, { recursive: true });
  for (const f of frags) {
    renameSync(join(readFragmentsDir(root), f.file), join(dest, f.file));
  }
}

/**
 * The full prepare flow (steps 1–5 above). Returns the resolved version and
 * consumed fragments; throws on any guard failure before mutating anything.
 */
export async function prepareRelease(opts: PrepareOptions): Promise<PrepareResult> {
  const root = opts.root ?? process.cwd();
  const date = opts.date ?? new Date().toISOString().slice(0, 10);

  const current = await readCurrentVersion(root);
  const version = opts.version ?? bumpVersion(current, opts.bump);

  if (!RELEASE_VERSION_RE.test(version)) {
    throw new Error(`Invalid version "${version}". Expected X.Y.Z or X.Y.Z-<prerelease>.`);
  }
  if (compareSemver(version, current) <= 0) {
    throw new Error(`Version ${version} must be greater than current ${current}.`);
  }

  const frags = readFragments(root);
  if (!frags.length && !opts.allowEmpty) {
    throw new Error(
      "No fragments found in .changes/unreleased/ — refusing to cut an empty release. Add fragments or pass --allow-empty.",
    );
  }

  console.log(`Preparing release ${current} -> ${version}\n`);
  console.log(`Fragments: ${frags.length}`);
  for (const f of frags) console.log(`  - ${f.file}${f.category ? `  [category: ${f.category}]` : ""}`);

  for (const target of CHANGELOGS) {
    const path = join(root, target.path);
    const text = await Bun.file(path).text();
    const body = buildSectionBody(target.lang, frags);
    await Bun.write(path, insertSection(text, version, date, body));
    console.log(`changelog: ${target.path}`);
  }

  for (const surface of VERSION_SURFACES) {
    await writeSurfaceVersion(surface, root, current, version);
    console.log(`bump: ${surface.path} ${current} -> ${version}`);
  }

  archiveFragments(root, version, frags);

  console.log(`\nDone. Next: commit and open PR "release v${version}".`);
  console.log(`Validate with: bun run release:validate -- v${version}`);
  return { current, version, fragments: frags.map((f) => f.file) };
}

function printUsage(): void {
  console.log(`Usage:
  bun run release:prepare                    # auto patch bump (0.1.0 -> 0.1.1)
  bun run release:prepare -- 1.0.0           # explicit version (bare X.Y.Z, no v prefix)
  bun run release:prepare -- --minor         # auto minor bump
  bun run release:prepare -- --allow-empty   # allow an empty .changes/unreleased/`);
}

// Run only when executed directly (`bun run scripts/prepare-release.ts`) —
// importing the module (unit tests) must not start the release flow.
if (import.meta.main) {
  const args = parseArgs(process.argv);
  if (args.help) {
    printUsage();
  } else {
    prepareRelease(args).catch((err) => {
      console.error(`\nprepare-release failed: ${err instanceof Error ? err.message : err}`);
      process.exit(1);
    });
  }
}
