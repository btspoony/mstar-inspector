#!/usr/bin/env bun
/**
 * validate-release-version.ts — release gate (plan 50 D4).
 *
 * Usage:
 *   bun run release:validate -- v1.0.0
 *   GITHUB_REF_NAME=v1.0.0 bun run release:validate
 *   bun run release:validate -- --help
 *
 * Checks, failing on the first category of problem found:
 *   1. Tag shape: `vX.Y.Z` or `vX.Y.Z-<prerelease>` (shared RELEASE_VERSION_RE).
 *   2. Surface alignment: every VERSION_SURFACES entry carries exactly the
 *      requested version (the same list `prepare-release.ts` bumps, so a
 *      release can never pass a surface it failed to bump).
 *   3. Tag not yet present: `git rev-parse refs/tags/v<version>` must not
 *      resolve — re-running against an already-published version is a bug,
 *      not a re-release.
 *
 * Plan 51 note: when `src/version.ts` joins VERSION_SURFACES, surface
 * alignment covers it automatically (per-kind read in release-surfaces.ts).
 */
import { join } from "node:path";
import {
  RELEASE_VERSION_RE,
  VERSION_SURFACES,
  readSurfaceVersion,
} from "./release-surfaces";

export type ValidateResult = {
  ok: boolean;
  /** Every diagnostic line in check order — OK/MISSING/MISMATCH prefixes. */
  lines: string[];
};

/** Strip the leading `v` — validate takes the v-prefixed tag form. */
export function tagToVersion(tag: string): string {
  return tag.startsWith("v") ? tag.slice(1) : tag;
}

/**
 * Tag-existence check via `git rev-parse` (the same check the Release prep
 * workflow runs as an early-fail shell step). `--verify` + the `refs/tags/`
 * namespace pins it to tags; exit 0 = exists, 1 = absent, anything else
 * (e.g. not a git repo) is surfaced as a hard error.
 */
export function tagExists(version: string, root: string): boolean {
  const proc = Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", `refs/tags/v${version}`], {
    cwd: root,
    stdout: "pipe",
    stderr: "pipe",
  });
  if (proc.exitCode === 0) return true;
  if (proc.exitCode === 1) return false;
  throw new Error(`git rev-parse failed (${proc.exitCode}): ${proc.stderr.toString().trim()}`);
}

/**
 * The full gate. `root` is the repo the git command runs in and the base the
 * surface paths resolve under (default caller: process.cwd()).
 */
export async function validateReleaseVersion(tag: string, root: string): Promise<ValidateResult> {
  const lines: string[] = [];
  const version = tagToVersion(tag);

  if (!RELEASE_VERSION_RE.test(version)) {
    return {
      ok: false,
      lines: [`Invalid release tag "${tag}". Expected format: vX.Y.Z or vX.Y.Z-<prerelease>`],
    };
  }

  for (const surface of VERSION_SURFACES) {
    const file = Bun.file(join(root, surface.path));
    if (!(await file.exists())) {
      lines.push(`MISSING ${surface.path}`);
      continue;
    }
    const v = await readSurfaceVersion(surface, root);
    if (v !== version) {
      lines.push(
        `MISMATCH ${surface.label} (${surface.path}): tag v${version}, file has ${v ?? "<missing>"}`,
      );
    } else {
      lines.push(`OK ${surface.label}: ${v}`);
    }
  }

  if (tagExists(version, root)) {
    lines.push(`TAGEXISTS v${version} already exists — refusing to validate a published version`);
  } else {
    lines.push(`OK tag: v${version} does not exist yet`);
  }

  return { ok: lines.every((l) => l.startsWith("OK")), lines };
}

/** CLI entry: first positional arg wins over $GITHUB_REF_NAME (workflow ref context). */
export function resolveTag(args: string[], env: Record<string, string | undefined>): string | undefined {
  return args[0] ?? env["GITHUB_REF_NAME"];
}

function printUsage(): void {
  console.log(`Usage:
  bun run release:validate -- v1.0.0
  GITHUB_REF_NAME=v1.0.0 bun run release:validate`);
}

// Run only when executed directly — importing the module (unit tests) must
// not run the gate against the real checkout.
if (import.meta.main) {
  const rest = process.argv.slice(2).filter((a) => a !== "--");
  if (rest.includes("--help") || rest.includes("-h")) {
    printUsage();
  } else {
    const tag = resolveTag(rest, process.env);
    if (!tag) {
      console.error("Usage: bun run scripts/validate-release-version.ts <tag>");
      console.error("       GITHUB_REF_NAME=v1.0.2 bun run scripts/validate-release-version.ts");
      process.exit(1);
    }
    validateReleaseVersion(tag, process.cwd())
      .then((result) => {
        for (const line of result.lines) {
          if (line.startsWith("OK")) console.log(line);
          else console.error(line);
        }
        if (!result.ok) {
          console.error(`\nRelease tag ${tag} failed validation.`);
          process.exit(1);
        }
        console.log(`\nRelease tag ${tag} validated: all surfaces aligned, tag free.`);
      })
      .catch((err) => {
        console.error(`\nvalidate-release-version failed: ${err instanceof Error ? err.message : err}`);
        process.exit(1);
      });
  }
}
