/**
 * The image rebuild gate's decision seam (`scripts/check-image-inputs.ts`).
 *
 * The git invocation is the CLI's, not this test's: what must hold is the
 * VERDICT — the six declared path families fail without a marker change,
 * nothing else does, and a diff that changes the marker passes.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  evaluateImageGate,
  IMAGE_INPUT_PATTERNS,
  touchesImageInput,
  touchesRebuildMarker,
} from "./check-image-inputs";

describe("image gate", () => {
  test("a runner source change without a marker change fails", () =>
    expect(evaluateImageGate(["packages/runner/src/index.ts"], "")).toEqual({
      ok: false,
      reason: "image-input-without-marker",
    }));

  test("the same change with a rebuild marker diff passes", () =>
    expect(
      evaluateImageGate(["packages/runner/src/index.ts"], "+# rebuild: runner source change"),
    ).toEqual({ ok: true }));

  test("a docs-only change passes", () =>
    expect(evaluateImageGate(["docs/deploy.md"], "")).toEqual({ ok: true }));

  test("a sandbox-image shim change fails without the marker", () =>
    expect(evaluateImageGate(["sandbox-image/entry.sh"], "")).toEqual({
      ok: false,
      reason: "image-input-without-marker",
    }));

  test("a verify-synthesis.sh change alone fails without the marker", () =>
    expect(evaluateImageGate(["packages/runner/verify-synthesis.sh"], "")).toEqual({
      ok: false,
      reason: "image-input-without-marker",
    }));

  test("a Dockerfile change that does not touch the marker fails", () =>
    expect(evaluateImageGate(["sandbox-image/Dockerfile"], "-FROM old\n+FROM new")).toEqual({
      ok: false,
      reason: "image-input-without-marker",
    }));
});

describe("touchesImageInput", () => {
  const declared = [
    "packages/runner/src/pipeline/sandbox.ts",
    "packages/shared/src/credential-payload.ts",
    "packages/runner/package.json",
    "packages/runner/bun.lock",
    "packages/runner/verify-synthesis.sh",
    "sandbox-image/cli-global/package.json",
  ];

  test("matches each of the six declared path families", () => {
    for (const path of declared) expect(touchesImageInput([path])).toBe(true);
    expect(IMAGE_INPUT_PATTERNS).toHaveLength(6);
  });

  test("an untouched path list passes", () => {
    for (const path of [
      "docs/deploy.md",
      "src/index.ts",
      "packages/shared/bun.lock",
      "packages/runner/src-extra/index.ts",
      "packages/runner/tsconfig.json",
      "sandbox-image-notes.md",
    ]) {
      expect(touchesImageInput([path])).toBe(false);
    }
  });
});

describe("touchesRebuildMarker", () => {
  test("an added marker line counts", () =>
    expect(touchesRebuildMarker("+# rebuild: new runner source")).toBe(true));

  test("a removed marker line counts", () =>
    expect(touchesRebuildMarker("-# rebuild: stale note")).toBe(true));

  test("diff headers naming the file do not count", () =>
    expect(touchesRebuildMarker("--- a/sandbox-image/Dockerfile\n+++ b/sandbox-image/Dockerfile")).toBe(
      false,
    ));

  test("context lines and unrelated hunks do not count", () =>
    expect(touchesRebuildMarker(" # rebuild: context only\n+FROM new")).toBe(false));
});

/** A throwaway repo whose only commits are the ones this test writes. */
function tempRepo(): { dir: string; git: (...args: string[]) => string } {
  const dir = mkdtempSync(join(tmpdir(), "image-gate-"));
  const git = (...args: string[]): string => {
    const proc = Bun.spawnSync(["git", ...args], { cwd: dir, stdout: "pipe", stderr: "pipe" });
    if (proc.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${proc.stderr.toString()}`);
    return proc.stdout.toString().trim();
  };
  git("init", "-q");
  git("config", "user.name", "test");
  git("config", "user.email", "test@example.com");
  // Git's default; a global `core.quotePath=false` would otherwise hide the quoting.
  git("config", "core.quotePath", "true");
  return { dir, git };
}

function write(dir: string, path: string, content = "export const x = 1;\n"): void {
  mkdirSync(dirname(join(dir, path)), { recursive: true });
  writeFileSync(join(dir, path), content);
}

/** The gate's actual CLI, run against `dir` for `base...HEAD`. */
function runGate(dir: string, base: string, script: string): number {
  return Bun.spawnSync(["bun", script, "--base", base], {
    cwd: dir,
    stdout: "pipe",
    stderr: "pipe",
  }).exitCode!;
}

describe("image gate CLI", () => {
  const script = join(import.meta.dir, "check-image-inputs.ts");

  test("a rename out of an input family fails the gate", () => {
    const { dir, git } = tempRepo();
    try {
      write(dir, "packages/runner/src/moved.ts");
      write(dir, "docs/notes.md", "notes\n");
      git("add", "-A");
      git("commit", "-qm", "add runner source");
      const base = git("rev-parse", "HEAD");

      git("mv", "packages/runner/src/moved.ts", "docs/moved.ts");
      git("commit", "-qm", "move it out of the image inputs");

      expect(runGate(dir, base, script)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("a non-ASCII input path is matched despite Git quoting", () => {
    const { dir, git } = tempRepo();
    try {
      write(dir, "docs/notes.md", "notes\n");
      git("add", "-A");
      git("commit", "-qm", "docs only");
      const base = git("rev-parse", "HEAD");

      write(dir, "packages/runner/src/中文.ts");
      git("add", "-A");
      git("commit", "-qm", "non-ASCII runner source");

      expect(runGate(dir, base, script)).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
