/**
 * Shared fixtures for release-script unit tests (plan 50 T2 / D11).
 *
 * The scripts take an explicit `root` so tests run against throwaway temp
 * dirs — no chdir, no touching the real checkout's `.changes/`, changelogs,
 * or package.json.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { renderVersionTs } from "../../scripts/release-surfaces";

export function makeTempRoot(): string {
  return mkdtempSync(join(tmpdir(), "mstar-release-scripts-"));
}

export function disposeTempRoot(root: string): void {
  rmSync(root, { recursive: true, force: true });
}

/** Write `content` at `root/<rel>`, creating parent directories. */
export function writeAt(root: string, rel: string, content: string): string {
  const path = join(root, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
  return path;
}

/** Write the `src/version.ts` surface (canonical template, plan 51). */
export function writeVersionTs(root: string, version: string): string {
  return writeAt(root, "src/version.ts", renderVersionTs(version));
}

/** Minimal bilingual repo layout the prepare flow operates on. */
export function setupReleaseRepo(root: string, current = "0.1.0"): void {
  writeAt(
    root,
    "package.json",
    `{
  "name": "test-repo",
  "version": "${current}",
  "private": true
}
`,
  );
  writeVersionTs(root, current);
  writeAt(root, "CHANGELOG.md", "# Changelog\n\nIntro.\n\n## [Unreleased]\n");
  writeAt(root, "CHANGELOG_CN.md", "# 更新日志\n\n简介。\n\n## [Unreleased]\n");
  writeAt(
    root,
    ".changes/unreleased/a-baseline.md",
    `---
category: Baseline
---

- EN baseline bullet.
- EN baseline second.

<!-- CN -->
- CN 基线要点。
`,
  );
  writeAt(
    root,
    ".changes/unreleased/z-fix.md",
    `---
category: Fixed
---

- EN fix bullet (no CN block).
`,
  );
}

/** Run git in `root`, failing the test setup loudly on a nonzero exit. */
export function git(root: string, ...args: string[]): void {
  const proc = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} failed (${proc.exitCode}): ${proc.stderr.toString().trim()}`);
  }
}
