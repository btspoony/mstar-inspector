/**
 * The worktree install check's decision seam (`scripts/check-worktree-install.ts`).
 *
 * A feature worktree lives INSIDE the repository, so a worktree without its own
 * install still resolves modules from the parent checkout: a before/after
 * comparison measured there can borrow another tree's packages and look
 * successful. The three verdicts are proved from throwaway fixture directories —
 * never this repository, never a real install.
 */
import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "check-worktree-install.ts");

/** A throwaway tree; the check only ever reads it. */
function fixture(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "worktree-install-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

function modules(dir: string): void {
  mkdirSync(join(dir, "node_modules"), { recursive: true });
}

function run(target?: string): { code: number; out: string } {
  const args = target === undefined ? [script] : [script, "--path", target];
  const proc = Bun.spawnSync(["bun", ...args], {
    cwd: tmpdir(),
    stdout: "pipe",
    stderr: "pipe",
  });
  return { code: proc.exitCode!, out: proc.stdout.toString() + proc.stderr.toString() };
}

describe("check-worktree-install", () => {
  test("a worktree with its own install passes and names the tree it found", () => {
    const { dir, cleanup } = fixture();
    try {
      const worktree = join(dir, "worktree");
      modules(worktree);
      const { code, out } = run(worktree);
      expect(code).toBe(0);
      // The check reports real paths: macOS resolves /var through /private/var.
      expect(out).toContain(join(realpathSync(worktree), "node_modules"));
    } finally {
      cleanup();
    }
  });

  test("an inherited install fails and names both paths and the install command", () => {
    const { dir, cleanup } = fixture();
    try {
      modules(dir);
      const worktree = join(dir, "worktree");
      mkdirSync(worktree);
      const { code, out } = run(worktree);
      expect(code).toBe(1);
      // Both paths: the directory inspected, and the tree it would inherit.
      expect(out).toContain(realpathSync(worktree));
      expect(out).toContain(join(realpathSync(dir), "node_modules"));
      expect(out).toContain("bun install");
    } finally {
      cleanup();
    }
  });

  test("no local install and no reachable parent tree is a neutral pass", () => {
    const { dir, cleanup } = fixture();
    try {
      const worktree = join(dir, "outer", "worktree");
      mkdirSync(worktree, { recursive: true });
      const { code, out } = run(worktree);
      expect(code).toBe(0);
      expect(out).toContain("nothing to inherit");
    } finally {
      cleanup();
    }
  });

  test("without --path it inspects the current directory", () => {
    const { dir, cleanup } = fixture();
    try {
      const worktree = join(dir, "worktree");
      modules(worktree);
      const proc = Bun.spawnSync(["bun", script], {
        cwd: worktree,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(proc.exitCode).toBe(0);
      expect(proc.stdout.toString() + proc.stderr.toString()).toContain(worktree);
    } finally {
      cleanup();
    }
  });

  test("an unreadable path refuses instead of passing", () => {
    const { code, out } = run(join(tmpdir(), "does-not-exist-worktree-install"));
    expect(code).toBe(1);
    expect(out).toContain("could not inspect");
  });
});
