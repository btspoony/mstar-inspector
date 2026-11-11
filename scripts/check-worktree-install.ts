#!/usr/bin/env bun
/**
 * check-worktree-install.ts — refuse a baseline comparison measured inside a
 * feature worktree whose install is not proven to be the worktree's own.
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
 * The verdict comes from the filesystem alone: never from `package.json`, never
 * from a package-manager invocation. A pass says one thing — a POPULATED
 * `node_modules` lives inside the inspected directory, and when the tree carries
 * a manager marker that manager is one the repository's lockfiles name. It does
 * not certify that every package resolves there: a package missing from the
 * local tree still falls back to an ancestor. The install stays a prerequisite
 * of the comparison, not something this check performs.
 *
 * Exit codes: 0 = a proven local install, or nothing is reachable to inherit;
 * 1 = an install is inherited from a parent tree, the local tree proves nothing
 * (a link out of the worktree, an empty tree), another manager installed it, or
 * a path on the way could not be inspected — an unreadable answer is never a
 * pass.
 *
 * Deliberately not a CI step: a CI checkout has no parent tree above the
 * workspace, so there this check can only ever report the neutral pass. Its own
 * test (`check-worktree-install.test.ts`) runs in the normal test sweep; the
 * command is documented in `AGENTS.md` § Git worktrees as the required step
 * before a comparison claim measured inside a worktree.
 */
import { readdirSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

/** What a verdict established, with the paths the message can print. */
export type InstallVerdict =
  | { kind: "local"; target: string; modules: string; manager?: string }
  | { kind: "inherited"; target: string; modules: string }
  | { kind: "none"; target: string }
  | { kind: "unproven"; target: string; modules: string; reason: string }
  | { kind: "foreign"; target: string; modules: string; installed: string; marker: string; lockfiles: string }
  | { kind: "uninspectable"; target: string; path: string; reason: string };

function reasonOf(error: unknown): string {
  const code = (error as { code?: string }).code;
  return `${code ?? "unknown error"}: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * What a path is, as the filesystem answers: a directory, a file, absent, or
 * unanswerable. `ENOENT`/`ENOTDIR` mean "nothing at this spelling" and callers
 * continue; every other error (a permission-restricted parent, a symlink loop)
 * means the question was not answered, and a can't-answer must never be read as
 * "nothing installed".
 */
type Probe =
  | { kind: "directory" }
  | { kind: "file" }
  | { kind: "absent" }
  | { kind: "unknown"; reason: string };

function probe(path: string): Probe {
  try {
    return { kind: statSync(path).isDirectory() ? "directory" : "file" };
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === "ENOENT" || code === "ENOTDIR") return { kind: "absent" };
    return { kind: "unknown", reason: reasonOf(error) };
  }
}

/**
 * Whether a `node_modules` directory holds anything that could be a package.
 * A dot entry (`.bin`, `.package-lock.json`, `.cache`) is a manager's bookkeeping,
 * not an installed package; a scoped package lives under `@scope/`, which is
 * neither hidden nor empty.
 */
type Presence =
  | { kind: "populated" }
  | { kind: "empty" }
  | { kind: "unknown"; reason: string };

function holdsPackages(modules: string): Presence {
  try {
    return readdirSync(modules).some((entry) => !entry.startsWith("."))
      ? { kind: "populated" }
      : { kind: "empty" };
  } catch (error) {
    return { kind: "unknown", reason: reasonOf(error) };
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

/** Lockfiles a repository may commit, and the manager each one names. */
const LOCKFILES: readonly (readonly [string, string])[] = [
  ["bun.lock", "bun"],
  ["bun.lockb", "bun"],
  ["package-lock.json", "npm"],
  ["yarn.lock", "yarn"],
  ["pnpm-lock.yaml", "pnpm"],
];

/**
 * What a manager leaves INSIDE `node_modules` once it has installed there — the
 * only provenance a filesystem read can see. Bun leaves no marker, so a bun tree
 * is reported as unidentified rather than guessed.
 */
const INSTALL_MARKERS: readonly (readonly [string, string])[] = [
  [".package-lock.json", "npm"],
  [".yarn-integrity", "yarn"],
  [".modules.yaml", "pnpm"],
];

/** The nearest directory at or above `dir` holding a `.git` entry. */
function repositoryRoot(dir: string): string {
  for (let current = dir; ; current = dirname(current)) {
    const git = probe(join(current, ".git"));
    if (git.kind === "directory" || git.kind === "file") return current;
    if (dirname(current) === current) return dir;
  }
}

/** The managers this directory's lockfiles name, with the file that named each. */
function lockfileManagers(dir: string): Map<string, string> {
  const found = new Map<string, string>();
  for (const [file, manager] of LOCKFILES) {
    const path = join(dir, file);
    if (!found.has(manager) && probe(path).kind === "file") found.set(manager, path);
  }
  return found;
}

/**
 * A local `node_modules` that exists: what it proves, or why it proves nothing.
 * Existence is not the guarantee — the tree must resolve inside the inspected
 * directory, hold packages, and not contradict the repository's lockfiles.
 */
function inspectLocal(target: string, modules: string): InstallVerdict {
  let real: string;
  try {
    real = realpathSync(modules);
  } catch (error) {
    return { kind: "uninspectable", target, path: modules, reason: reasonOf(error) };
  }
  const within = relative(target, real);
  if (within === "" || within.startsWith("..") || isAbsolute(within)) {
    return {
      kind: "unproven",
      target,
      modules,
      reason: `it resolves outside the worktree, to ${real}`
    };
  }
  const presence = holdsPackages(real);
  if (presence.kind === "unknown") {
    return { kind: "uninspectable", target, path: modules, reason: presence.reason };
  }
  if (presence.kind === "empty") {
    const ancestor = inheritedInstall(target);
    const also =
      ancestor.kind === "inherited" ? `, and ${ancestor.modules} is reachable from it` : "";
    return {
      kind: "unproven",
      target,
      modules,
      reason: `it holds no packages (empty, or only a manager's dot entries)${also}`
    };
  }
  const marker = INSTALL_MARKERS.find(([file]) => probe(join(real, file)).kind === "file");
  if (marker === undefined) return { kind: "local", target, modules };
  const [file, manager] = marker;
  const expected = new Map([
    ...lockfileManagers(repositoryRoot(target)),
    ...lockfileManagers(target)
  ]);
  if (expected.size > 0 && !expected.has(manager)) {
    return {
      kind: "foreign",
      target,
      modules,
      installed: manager,
      marker: join(real, file),
      lockfiles: [...expected.values()].join(", ")
    };
  }
  return { kind: "local", target, modules, manager };
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
  if (localAnswer.kind === "unknown") {
    return { kind: "uninspectable", target, path: local, reason: localAnswer.reason };
  }
  if (localAnswer.kind === "directory") return inspectLocal(target, local);
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
      `::error::worktree-install-uninspectable: could not inspect ${resolve(path)} — ${reasonOf(error)}; treat as unverified, not a pass`,
    );
    process.exit(1);
  }

  if (verdict.kind === "local") {
    const by =
      verdict.manager === undefined
        ? "manager not identified from the tree"
        : `installed by ${verdict.manager}`;
    console.log(
      `worktree install: ${verdict.target} has its own node_modules (${verdict.modules}), ${by} — a local tree inside the worktree; the check does not prove every package resolves there`,
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

  if (verdict.kind === "unproven") {
    console.error(
      `::error::worktree-install-unproven: ${verdict.target} has a node_modules (${verdict.modules}) that proves no local install — ${verdict.reason}. It cannot back a clean-base comparison.`,
    );
    console.error(
      `Repair: install in the worktree — cd ${verdict.target} && bun install — and re-run this check; it must report a local tree.`,
    );
    process.exit(1);
  }

  if (verdict.kind === "foreign") {
    console.error(
      `::error::worktree-install-foreign: ${verdict.modules} was installed by ${verdict.installed} (${verdict.marker}), but the repository's lockfiles name ${verdict.lockfiles}. The tree is not the one the lockfiles describe.`,
    );
    console.error(
      `Repair: reinstall in the worktree with the repository's manager — cd ${verdict.target} && bun install — and re-run this check.`,
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
