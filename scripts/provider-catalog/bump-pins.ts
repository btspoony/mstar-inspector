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
 *   - `package.json`                           root engine (caret) + omp (exact)
 *   - `packages/runner/package.json`          exact engine + omp the image installs
 *   - `src/contracts/sandbox-images.ts`       HARNESS_VERSION + harnessRef literals
 *   - `sandbox-image/cli-global/package.json` + `bun.lock`  the CLI pin
 *   - `sandbox-image/Dockerfile`              the clone's ref and its anchor comment
 *
 * The engine version IS the harness release: the image clones that harness tag
 * and installs its CLI at the same number, so `--engine` drives all of them. A
 * tag cannot yield a commit, so `--harness-ref` supplies the dereferenced sha;
 * without one the version literals still move and the run says the ref did not.
 *
 * Every rewrite is anchored on the current pin, so a surface that already moved
 * by hand fails the run instead of silently doing nothing.
 */
import { readFile, writeFile } from "node:fs/promises";
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

async function currentPins(): Promise<Pins> {
  const root = JSON.parse(await readFile(path.join(ROOT, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };
  const images = await readFile(path.join(ROOT, "src/contracts/sandbox-images.ts"), "utf8");
  const harness = /export const HARNESS_VERSION = "([^"]+)"/.exec(images)?.[1];
  const harnessRef = /harnessRef: "([0-9a-f]{40})"/.exec(images)?.[1];
  if (harness === undefined || harnessRef === undefined) {
    throw new Error("src/contracts/sandbox-images.ts does not declare HARNESS_VERSION and harnessRef");
  }
  const dockerfile = await readFile(path.join(ROOT, "sandbox-image/Dockerfile"), "utf8");
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

/** The edits that move every surface from the committed pins to the requested
 *  ones. Exported for `tests/scripts/provider-catalog-refresh-guards.test.ts`,
 *  which pins the surface list so a new pin cannot land un-updated. */
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

if (import.meta.main) {
  const edits = planEdits(await currentPins(), parseArgs(process.argv.slice(2)));
  if (edits.length === 0) {
    console.log("pins already current — nothing to do");
  } else {
    const byFile = new Map<string, PinEdit[]>();
    for (const edit of edits) byFile.set(edit.file, [...(byFile.get(edit.file) ?? []), edit]);
    for (const [file, fileEdits] of byFile) {
      let text = await readFile(path.join(ROOT, file), "utf8");
      for (const edit of fileEdits) {
        if (!text.includes(edit.from)) throw new Error(`${file} does not carry ${JSON.stringify(edit.from)}`);
        text = text.replace(edit.from, edit.to);
      }
      await writeFile(path.join(ROOT, file), text, "utf8");
      console.log(`updated ${file} (${fileEdits.length} pin${fileEdits.length === 1 ? "" : "s"})`);
    }
    // The CLI's own lock is a second exact pin: regenerate it in place.
    if (edits.some((edit) => edit.file === "sandbox-image/cli-global/package.json")) {
      const install = Bun.spawnSync(["bun", "install", "--lockfile-only"], {
        cwd: path.join(ROOT, "sandbox-image/cli-global"),
        stdout: "pipe",
        stderr: "pipe",
      });
      if (install.exitCode !== 0) throw new Error(`cli-global lock regeneration failed: ${install.stderr.toString()}`);
      console.log("regenerated sandbox-image/cli-global/bun.lock");
    }
  }
}
