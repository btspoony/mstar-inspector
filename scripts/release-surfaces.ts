/**
 * Single source of truth for version-bearing surfaces + shared version
 * semantics (plan 50 D3).
 *
 * Consumed by `scripts/prepare-release.ts` (bump writer) and
 * `scripts/validate-release-version.ts` (gate). Both tools read ONE list, so
 * a release can never validate a surface it failed to bump.
 *
 * Extension point (plan 51): `src/version.ts` joins VERSION_SURFACES with
 * `kind: "ts-const"` — add the entry plus a read/write branch in the two
 * switch statements below; prepare and validate pick the new surface up
 * without per-script changes.
 */
import { join } from "node:path";

/**
 * How a surface carries its version. `json` = a `"version": "X.Y.Z"` field in
 * a JSON manifest; plan 51 adds `ts-const` (the `APP_VERSION` constant in
 * `src/version.ts`, matched by regex).
 */
export type VersionSurfaceKind = "json";

export type VersionSurface = {
  label: string;
  path: string;
  kind: VersionSurfaceKind;
};

/** Every file that must carry the release version. */
export const VERSION_SURFACES: readonly VersionSurface[] = [
  { label: "package.json", path: "package.json", kind: "json" },
] as const;

/** Changelogs that receive a new release section (`.changes/README.md`). */
export const CHANGELOGS: readonly { path: string; lang: "en" | "cn" }[] = [
  { path: "CHANGELOG.md", lang: "en" },
  { path: "CHANGELOG_CN.md", lang: "cn" },
] as const;

/** Resolve which changelog file a language reads. */
export function changelogPathFor(lang: "en" | "cn"): string {
  const target = CHANGELOGS.find((c) => c.lang === lang);
  if (!target) throw new Error(`No changelog target for lang "${lang}"`);
  return target.path;
}

/**
 * Release version regex — `X.Y.Z` with an optional semver prerelease suffix
 * (`-alpha.1`). Anchored; no `+build` metadata support (not needed for
 * releases). Shared by prepare (version gate) and validate (tag gate).
 *
 * Prerelease identifiers follow semver 2.0.0 §9: dot-separated, each either
 * a numeric identifier without leading zeros (`0` or `[1-9]\d*`) or an
 * alphanumeric identifier containing at least one non-digit. Empty
 * identifiers (`alpha..1`), leading-zero numerics (`alpha.01`), and
 * identifiers starting with `.` (`-.alpha`) are rejected.
 */
export const RELEASE_VERSION_RE =
  /^\d+\.\d+\.\d+(?:-(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|\d*[A-Za-z-][0-9A-Za-z-]*))*)?$/;

/** True iff the version carries a prerelease suffix (contains `-`). */
export function isPrereleaseVersion(v: string): boolean {
  return v.includes("-");
}

export function compareSemver(a: string, b: string): number {
  const [coreA, preA] = splitVersion(a);
  const [coreB, preB] = splitVersion(b);
  const coreDiff = compareCore(coreA, coreB);
  if (coreDiff !== 0) return coreDiff;
  return comparePrerelease(preA, preB);
}

/**
 * Auto-bump the next version from a current version (AD-2: derived from
 * `package.json#version`, never from tags). A current version carrying a
 * prerelease suffix graduates instead of bumping: `patch`/default returns the
 * same-core stable (`3.6.0-alpha.1` -> `3.6.0`), `minor` returns the next
 * minor stable (`3.7.0`). Stable inputs bump normally.
 */
export function bumpVersion(v: string, kind: "patch" | "minor"): string {
  const parts = v.split(".").map((n) => parseInt(n, 10));
  const maj = parts[0] ?? 0;
  const min = parts[1] ?? 0;
  const pat = parts[2] ?? 0;
  if (isPrereleaseVersion(v)) {
    if (kind === "minor") return `${maj}.${min + 1}.0`;
    return `${maj}.${min}.${pat}`;
  }
  if (kind === "minor") return `${maj}.${min + 1}.0`;
  return `${maj}.${min}.${pat + 1}`;
}

/** Read a surface's current version (all paths resolve under `root`). */
export async function readSurfaceVersion(
  surface: VersionSurface,
  root: string,
): Promise<string | undefined> {
  const path = join(root, surface.path);
  switch (surface.kind) {
    case "json": {
      const json = (await Bun.file(path).json()) as { version?: string };
      return json.version;
    }
  }
}

/**
 * Rewrite a surface from `current` to `next`, preserving file formatting
 * (text-level replace, not JSON re-serialize). Throws when `current` is not
 * found so a silently-unbumped surface can never slip through.
 */
export async function writeSurfaceVersion(
  surface: VersionSurface,
  root: string,
  current: string,
  next: string,
): Promise<void> {
  const path = join(root, surface.path);
  switch (surface.kind) {
    case "json": {
      const text = await Bun.file(path).text();
      // Release versions contain only digits, dots, hyphens — escaping dots
      // is enough for a literal regex embed.
      const re = new RegExp(`("version"\\s*:\\s*")${current.replace(/\./g, "\\.")}(")`);
      if (!re.test(text)) {
        throw new Error(`${surface.path}: could not find version field "${current}"`);
      }
      await Bun.write(path, text.replace(re, `$1${next}$2`));
      return;
    }
  }
}

/** Split `X.Y.Z[-pre]` into its core and optional prerelease parts. */
function splitVersion(v: string): [string, string | undefined] {
  const dash = v.indexOf("-");
  if (dash === -1) return [v, undefined];
  return [v.slice(0, dash), v.slice(dash + 1)];
}

function compareCore(a: string, b: string): number {
  const pa = a.split(".").map((n) => parseInt(n, 10) || 0);
  const pb = b.split(".").map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < 3; i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

/**
 * Semver 2.0.0 §11 prerelease precedence: identifiers compared left-to-right,
 * numeric numerically, alphanumeric ASCII-lexicographically, numeric <
 * alphanumeric, shorter identifier list < longer with the same prefix. A
 * version without a prerelease outranks any prerelease of the same core.
 */
function comparePrerelease(a: string | undefined, b: string | undefined): number {
  if (a === undefined && b === undefined) return 0;
  if (a === undefined) return 1;
  if (b === undefined) return -1;
  const ia = a.split(".");
  const ib = b.split(".");
  const n = Math.min(ia.length, ib.length);
  for (let i = 0; i < n; i++) {
    const d = compareIdentifier(ia[i] ?? "", ib[i] ?? "");
    if (d !== 0) return d;
  }
  return ia.length - ib.length;
}

function compareIdentifier(a: string, b: string): number {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) {
    const na = BigInt(a);
    const nb = BigInt(b);
    return na < nb ? -1 : na > nb ? 1 : 0;
  }
  if (aNum) return -1; // numeric identifiers sort before alphanumeric
  if (bNum) return 1;
  return a < b ? -1 : a > b ? 1 : 0; // ASCII lexicographic
}
