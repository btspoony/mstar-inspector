#!/usr/bin/env bun
/**
 * check-worktree-install.ts — refuse a baseline comparison measured inside a
 * feature worktree that has no install of its own.
 *
 * Usage:
 *   bun scripts/check-worktree-install.ts [--path <dir>]   (default: cwd)
 *
 * Feature worktrees live INSIDE this repository (`./.worktrees/<name>/`), so a
 * worktree without `node_modules` still resolves modules from the parent
 * checkout: Node/Bun walk up the directory chain. A before/after comparison
 * measured there can then borrow another tree's packages — possibly stale, or
 * from another package manager — and report success. That evidence class is
 * unusable as a baseline, and nothing about it fails visibly.
 *
 * The verdict comes from the filesystem alone, never from `package.json`: only a
 * real `node_modules` directory counts as an install.
 *
 * Exit codes: 0 = the worktree has its own install, or nothing is reachable to
 * inherit; 1 = an install is inherited from a parent tree, or the worktree (or
 * a path on the way up) could not be inspected — an unreadable answer is never
 * a pass.
 *
 * Deliberately not a CI step: a CI checkout has no parent tree above the
 * workspace, so there this check can only ever report the neutral pass. Its own
 * test (`check-worktree-install.test.ts`) runs in the normal test sweep; the
 * command is documented in `AGENTS.md` § Git worktrees as the required step
 * before a comparison claim measured inside a worktree.
 */
import { realpathSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

/** What one directory's install situation is, as paths the message can print. */
export type InstallVerdict =
  | { kind: "local"; target: string; modules: string }
  | { kind: "inherited"; target: string; modules: string }
  | { kind: "none"; target: string }
  | { kind: "uninspectable"; target: string; path: string; reason: string };

/**
 * What one `node_modules` path is, as the filesystem answers: a directory,
 * absent, or unanswerable. `ENOENT`/`ENOTDIR` mean "no install at this
 * spelling" and the walk continues; every other error — a permission-restricted
 * ancestor, a symlink loop — means the question was not answered, and a
 * can't-answer must never be read as "nothing installed".
 */
type Probe =
  | { kind: "directory" }
  | { kind: "absent" }
  | { kind: "unknown"; reason: string };

function probe(path: string): Probe {
  try {
    return statSync(path).isDirectory() ? { kind: "directory" } : { kind: "absent" };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    return {
      kind: "unknown",
      reason: `${code ?? "stat failed"}: ${error instanceof Error ? error.message : String(error)}`,
    };
  }
}

export type AncestorInstall =
  | { kind: "inherited"; modules: string }
  | { kind: "none" }
  | { kind: "unknown"; path: string; reason: string };

/**
 * The nearest ancestor install reachable from `dir`, or `none` when the walk
 * reaches the filesystem root without one. `dir` itself is not asked — the
 * caller already decided it has no install. An ancestor whose `node_modules`
 * cannot be inspected is `unknown`, never `none`.
 */
export function inheritedInstall(dir: string): AncestorInstall {
  for (let current = dirname(dir); ; current = dirname(current)) {
    const modules = join(current, "node_modules");
    const answer = probe(modules);
    if (answer.kind === "directory") return { kind: "inherited", modules };
    if (answer.kind === "unknown") {
      return { kind: "unknown", path: modules, reason: answer.reason };
    }
    if (dirname(current) === current) return { kind: "none" };
  }
}

/**
 * Resolve symlinks first: module resolution walks the real path, so a worktree
 * reached through a link must be judged where it lands. Throws when `dir` does
 * not exist — the caller refuses rather than guesses.
 */
export function evaluateInstall(dir: string): InstallVerdict {
  const target = realpathSync(resolve(dir));
  const local = join(target, "node_modules");
  const localAnswer = probe(local);
  if (localAnswer.kind === "directory") return { kind: "local", target, modules: local };
  if (localAnswer.kind === "unknown") {
    return { kind: "uninspectable", target, path: local, reason: localAnswer.reason };
  }
  const ancestor = inheritedInstall(target);
  if (ancestor.kind === "none") return { kind: "none", target };
  if (ancestor.kind === "unknown") {
    return { kind: "uninspectable", target, path: ancestor.path, reason: ancestor.reason };
  }
  return { kind: "inherited", target, modules: ancestor.modules };
}

function printUsage(): void {
  console.error("usage: bun scripts/check-worktree-install.ts [--path <dir>]");
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  let path = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--path") path = argv[++i] ?? "";
    else {
      console.error(`check-worktree-install: unknown argument ${arg}`);
      printUsage();
      process.exit(1);
    }
  }
  if (path === "") path = process.cwd();

  let verdict: InstallVerdict;
  try {
    verdict = evaluateInstall(path);
  } catch (error) {
    console.error(
      `::error::worktree-install-uninspectable: could not inspect ${resolve(path)} — ${error instanceof Error ? error.message : String(error)}; treat as unverified, not a pass`,
    );
    process.exit(1);
  }

  if (verdict.kind === "local") {
    console.log(
      `worktree install: ${verdict.target} has its own node_modules (${verdict.modules}) — a comparison here resolves its own tree`,
    );
    process.exit(0);
  }

  if (verdict.kind === "none") {
    console.log(
      `worktree install: ${verdict.target} has no node_modules and no parent tree is reachable — nothing to inherit, nothing to claim`,
    );
    process.exit(0);
  }

  if (verdict.kind === "uninspectable") {
    console.error(
      `::error::worktree-install-uninspectable: could not inspect ${verdict.path} while looking for a reachable install from ${verdict.target} — ${verdict.reason}; treat as unverified, not a pass`,
    );
    process.exit(1);
  }

  console.error(
    `::error::worktree-install-inherited: ${verdict.target} has no node_modules of its own, but ${verdict.modules} is reachable from it — module resolution walks up, so anything measured here may use the parent checkout's packages.`,
  );
  console.error(
    `Repair: install in the worktree before measuring — cd ${verdict.target} && bun install — and re-run this check; it must report the local tree.`,
  );
  process.exit(1);
}
