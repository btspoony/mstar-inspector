#!/usr/bin/env bun
/**
 * bump-pins.ts — move the SDK / engine / harness pins in one place.
 *
 *   bun run scripts/provider-catalog/bump-pins.ts --omp 18.23.0 --engine 4.8.0 [--harness-ref <sha>]
 *
 * The refresh workflow compares the registry's latest versions against the
 * committed pins and runs this script when either is newer. Five surfaces carry
 * the pins by hand (the image cannot import the module, and the runner's
 * manifest installs separately):
 *
 *   - `package.json` + `bun.lock`             root engine (caret) + omp (exact)
 *   - `packages/runner/package.json` + `bun.lock`  exact engine + omp the image installs
 *   - `src/contracts/sandbox-images.ts`       HARNESS_VERSION + harnessRef literals
 *   - `sandbox-image/cli-global/package.json` + `bun.lock`  the CLI pin
 *   - `sandbox-image/Dockerfile`              the clone's ref and its anchor comment
 *
 * The engine version IS the harness release: the image clones that harness tag
 * and installs its CLI at the same number, so `--engine` drives all of them. A
 * tag cannot yield a commit, so `--harness-ref` supplies the dereferenced sha;
 * without one the version literals still move and the run says the ref did not.
 *
 * INSTALL, not just relock. A lockfile-only regeneration would leave the OLD
 * package on disk while the manifests claim the new one, and the refresh would
 * then extract from — and validate — a tree it does not describe. That is the
 * Worker/image divergence this repo has already been bitten by twice, so the
 * bump runs a real `bun install` for the root and for the runner copy, then
 * checks the INSTALLED tree's version against the manifest pin (a lock row is
 * not evidence an install happened), and finally proves the committed lock is
 * self-consistent with `bun install --frozen-lockfile`. Any failure aborts the
 * bump — no fallback.
 *
 * Each lock is regenerated from the COMMITTED one, so only the pin's rows move;
 * resolving from the manifest alone would also lift the caret-ranged
 * transitives the committed lock already fixed. The runner install runs in a
 * temp copy, because a nested `packages/runner/node_modules` would shadow the
 * root resolution the repo's typecheck and tests use.
 *
 * Every rewrite is anchored on the current pin, so a surface that already moved
 * by hand fails the run instead of silently doing nothing.
 */
import { copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";

const ROOT = path.resolve(".");

/** The committed pins, read from the surfaces that declare them. */
export type Pins = { omp: string; engine: string; harness: string; harnessRef: string; bumped: string };

/** One pin rewrite: a file, the literal it carries, and the replacement. */
export type PinEdit = { file: string; from: string; to: string };

function parseArgs(argv: string[]): { omp?: string; engine?: string; harnessRef?: string } {
  const options: { omp?: string; engine?: string; harnessRef?: string } = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (value === undefined) throw new Error(`${flag} needs a value`);
    if (flag === "--omp") options.omp = value;
    else if (flag === "--engine") options.engine = value;
    else if (flag === "--harness-ref") options.harnessRef = value;
    else throw new Error(`unknown flag ${flag}`);
  }
  return options;
}

async function currentPins(dir: string = ROOT): Promise<Pins> {
  const root = JSON.parse(await readFile(path.join(dir, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  const images = await readFile(path.join(dir, "src/contracts/sandbox-images.ts"), "utf8");
  const harness = /export const HARNESS_VERSION = "([^"]+)"/.exec(images)?.[1];
  const harnessRef = /harnessRef: "([0-9a-f]{40})"/.exec(images)?.[1];
  if (harness === undefined || harnessRef === undefined) {
    throw new Error("src/contracts/sandbox-images.ts does not declare HARNESS_VERSION and harnessRef");
  }
  const dockerfile = await readFile(path.join(dir, "sandbox-image/Dockerfile"), "utf8");
  const bumped = /# mstar-harness plugin, pinned ref [0-9a-f]{40} \(tag v[^,]+, bumped (\d{4}-\d{2}-\d{2})\)/.exec(
    dockerfile,
  )?.[1];
  if (bumped === undefined) throw new Error("the Dockerfile's mstar-harness anchor comment is missing");
  return {
    omp: root.dependencies["@oh-my-pi/pi-coding-agent"]!,
    engine: root.dependencies["@mstar-harness/engine"]!,
    harness,
    harnessRef,
    bumped,
  };
}

/** The version actually present on disk for `packageName`, or null when the
 *  package is not installed. This — not a lock row — is what the extractor and
 *  the typechecker will read. */
export function installedVersion(dir: string, packageName: string): string | null {
  try {
    const manifest = JSON.parse(
      readFileSync(path.join(dir, "node_modules", ...packageName.split("/"), "package.json"), "utf8"),
    ) as { version?: unknown };
    return typeof manifest.version === "string" ? manifest.version : null;
  } catch {
    return null;
  }
}

/** One package the bumped tree must actually install. `caret` — the root
 *  manifest keeps a `^` range, so there the installed version may exceed the
 *  pin; the runner's pin is exact. */
export type Expected = { name: string; version: string; caret: boolean };

/** `[major, minor, patch]`, or null when the string is not a version. */
function versionTriple(value: string): number[] | null {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
  return match === null ? null : [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(actual: string, pinned: string): boolean {
  const a = versionTriple(actual);
  const p = versionTriple(pinned);
  if (a === null || p === null) return false;
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== p[index]) return a[index]! > p[index]!;
  }
  return true;
}

/** Run `bun install` in `dir` with each mode in turn, then prove the INSTALLED
 *  tree matches the pin. Throws — never falls back — when an install fails or
 *  the on-disk version disagrees: the whole point of the bump is that the
 *  extraction and the checks after it run against the NEW SDK. */
export function installAndVerify(dir: string, expected: Expected[], modes: string[][] = [[]]): void {
  for (const args of modes) {
    const install = Bun.spawnSync(["bun", "install", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    if (install.exitCode !== 0) {
      throw new Error(`bun install ${args.join(" ")} failed in ${dir}: ${install.stderr.toString().trim()}`);
    }
  }
  for (const { name, version, caret } of expected) {
    const actual = installedVersion(dir, name);
    const ok = actual !== null && (caret ? atLeast(actual, version) : actual === version);
    if (!ok) {
      throw new Error(
        `${name} is ${JSON.stringify(actual)} on disk in ${dir} but the pin says ${JSON.stringify(version)} — the bump did not install`,
      );
    }
    console.log(`verified ${name}@${actual} installed in ${dir} (pin ${caret ? "^" : ""}${version})`);
  }
}

/** Regenerate `dir`'s bun.lock from the committed lock + manifest beside it.
 *  `path.resolve`, not `path.join`: the runner's lock is built in an absolute
 *  temp directory, and `join` would nest it under the repo root instead. */
function regenerateLock(dir: string, root: string = ROOT): void {
  const install = Bun.spawnSync(["bun", "install", "--lockfile-only"], {
    cwd: path.resolve(root, dir),
    stdout: "pipe",
    stderr: "pipe",
  });
  if (install.exitCode !== 0) {
    throw new Error(`${path.join(dir, "bun.lock")} regeneration failed: ${install.stderr.toString()}`);
  }
}

/** The edits that move every surface from the committed pins to the requested
 *  ones. Exported for `tests/scripts/provider-catalog-refresh.test.ts`, which
 *  drives the surface list so a new pin cannot land un-updated. */
export function planEdits(
  from: Pins,
  to: { omp?: string; engine?: string; harnessRef?: string },
  date = new Date().toISOString().slice(0, 10),
): PinEdit[] {
  const edits: PinEdit[] = [];
  const engineFrom = from.engine.replace(/^\^/, "");
  if (to.omp !== undefined && to.omp !== from.omp) {
    for (const file of ["package.json", "packages/runner/package.json"]) {
      edits.push({
        file,
        from: `"@oh-my-pi/pi-coding-agent": "${from.omp}"`,
        to: `"@oh-my-pi/pi-coding-agent": "${to.omp}"`,
      });
    }
  }
  if (to.engine !== undefined && to.engine !== engineFrom) {
    edits.push({
      file: "package.json",
      from: `"@mstar-harness/engine": "^${engineFrom}"`,
      to: `"@mstar-harness/engine": "^${to.engine}"`,
    });
    edits.push({
      file: "packages/runner/package.json",
      from: `"@mstar-harness/engine": "${engineFrom}"`,
      to: `"@mstar-harness/engine": "${to.engine}"`,
    });
    edits.push({
      file: "src/contracts/sandbox-images.ts",
      from: `export const HARNESS_VERSION = "${from.harness}"`,
      to: `export const HARNESS_VERSION = "${to.engine}"`,
    });
    edits.push({
      file: "sandbox-image/cli-global/package.json",
      from: `"@mstar-harness/cli": "${from.harness}"`,
      to: `"@mstar-harness/cli": "${to.engine}"`,
    });
  }
  if (to.harnessRef !== undefined && to.harnessRef !== from.harnessRef) {
    const tag = to.engine ?? from.harness;
    edits.push({
      file: "src/contracts/sandbox-images.ts",
      from: `harnessRef: "${from.harnessRef}"`,
      to: `harnessRef: "${to.harnessRef}"`,
    });
    // The anchor comment names the ref, the tag AND the day it moved — all
    // three are pinned by tests/contracts/sandbox-images.test.ts.
    edits.push({
      file: "sandbox-image/Dockerfile",
      from: `# mstar-harness plugin, pinned ref ${from.harnessRef} (tag v${from.harness}, bumped ${from.bumped})`,
      to: `# mstar-harness plugin, pinned ref ${to.harnessRef} (tag v${tag}, bumped ${date})`,
    });
    edits.push({
      file: "sandbox-image/Dockerfile",
      from: `git -C /opt/mstar-harness fetch --depth 1 origin ${from.harnessRef}`,
      to: `git -C /opt/mstar-harness fetch --depth 1 origin ${to.harnessRef}`,
    });
  }
  return edits;
}

/** The versions ONE manifest's bumped tree must actually install, with the
 *  range shape that manifest now carries (the root keeps `^` on the engine, the
 *  runner pins exactly) — so each directory is verified against its own file. */
export function expectedInstalls(edits: PinEdit[], manifest: string): Expected[] {
  const expected: Expected[] = [];
  for (const edit of edits) {
    if (edit.file !== manifest) continue;
    const touched = /"(@[^"]+)": "([^"]+)"/.exec(edit.to);
    if (touched === null) continue;
    expected.push({
      name: touched[1]!,
      version: touched[2]!.replace(/^\^/, ""),
      caret: touched[2]!.startsWith("^"),
    });
  }
  return expected;
}

/** A throw injected between the root install and the remaining surfaces. The
 *  production path passes none; `tests/scripts/bump-pins-install.test.ts` uses it
 *  to abort a bump exactly where the workflow can abort one, which is after the
 *  real install and before the tree is consistent again. */
export type BumpHooks = { afterRootInstall?: () => void };

/** Move the pins and make the installed tree match them. Throws on any failure —
 *  the caller owns the restore, and must restore the INSTALLED tree, not just
 *  the manifests (see the workflow's `git checkout … && bun install` pair). */export async function runBump(
  root: string,
  options: { omp?: string; engine?: string; harnessRef?: string },
  hooks: BumpHooks = {},
): Promise<PinEdit[]> {
  const edits = planEdits(await currentPins(root), options);
  if (edits.length === 0) {
    console.log("pins already current — nothing to do");
    return edits;
  }

  const byFile = new Map<string, PinEdit[]>();
  for (const edit of edits) byFile.set(edit.file, [...(byFile.get(edit.file) ?? []), edit]);
  for (const [file, fileEdits] of byFile) {
    let text = await readFile(path.join(root, file), "utf8");
    for (const edit of fileEdits) {
      if (!text.includes(edit.from)) throw new Error(`${file} does not carry ${JSON.stringify(edit.from)}`);
      text = text.replace(edit.from, edit.to);
    }
    await writeFile(path.join(root, file), text, "utf8");
    console.log(`updated ${file} (${fileEdits.length} pin${fileEdits.length === 1 ? "" : "s"})`);
  }

  // Root: relock from the committed lock, install for real, then prove a clean
  // checkout would get the same tree. The install is what makes the extractor
  // read the NEW SDK; `--frozen-lockfile` is the second check.
  regenerateLock("", root);
  installAndVerify(root, expectedInstalls(edits, "package.json"), [[], ["--frozen-lockfile"]]);
  hooks.afterRootInstall?.();

  // CLI pin: its own manifest + lock (no source imports the CLI, so a lock is
  // the whole artifact).
  if (edits.some((edit) => edit.file === "sandbox-image/cli-global/package.json")) {
    regenerateLock("sandbox-image/cli-global", root);
    console.log("regenerated sandbox-image/cli-global/bun.lock");
  }

  // Runner: relock + install in a temp copy (a nested node_modules here would
  // shadow the root resolution), then copy the resulting lock back. The install
  // is real so the copy proves the lock resolves to the pinned tree.
  if (edits.some((edit) => edit.file === "packages/runner/package.json")) {
    const tmp = mkdtempSync(path.join(tmpdir(), "runner-lock-"));
    try {
      cpSync(path.join(root, "packages/runner/package.json"), path.join(tmp, "package.json"));
      // A committed lock is seeded when present so only the pin's rows move;
      // absent, `regenerateLock` resolves the whole tree instead.
      const committedLock = path.join(root, "packages/runner/bun.lock");
      if (existsSync(committedLock)) cpSync(committedLock, path.join(tmp, "bun.lock"));
      regenerateLock(tmp, root);
      installAndVerify(tmp, expectedInstalls(edits, "packages/runner/package.json"), [
        [],
        ["--frozen-lockfile"],
      ]);
      copyFileSync(path.join(tmp, "bun.lock"), path.join(root, "packages/runner/bun.lock"));
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
    console.log("regenerated packages/runner/bun.lock");
  }
  return edits;
}

if (import.meta.main) {
  await runBump(".", parseArgs(process.argv.slice(2)));
}
