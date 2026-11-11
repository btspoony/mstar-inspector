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
import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const script = join(import.meta.dir, "check-worktree-install.ts");

/** A throwaway tree; the check only ever reads it. */
function fixture(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), "worktree-install-"));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A populated install: a directory that holds no packages proves nothing. */
function modules(dir: string): void {
  mkdirSync(join(dir, "node_modules", "some-pkg"), { recursive: true });
}

/** A bare `node_modules` directory — the shape that used to pass as an install. */
function emptyModules(dir: string): void {
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

  test("an ancestor that cannot be inspected refuses instead of passing", () => {
    const { dir, cleanup } = fixture();
    try {
      const worktree = join(dir, "a", "worktree");
      mkdirSync(worktree, { recursive: true });
      // The path exists but stat cannot answer (ELOOP): an unreadable answer,
      // never the neutral "nothing to inherit" pass.
      symlinkSync("node_modules", join(dir, "a", "node_modules"));
      const { code, out } = run(worktree);
      expect(code).toBe(1);
      expect(out).toContain("worktree-install-uninspectable");
      expect(out).toContain(join(realpathSync(dir), "a", "node_modules"));
      expect(out).not.toContain("nothing to inherit");
    } finally {
      cleanup();
    }
  });

  test("an absent ancestor keeps the walk going", () => {
    const { dir, cleanup } = fixture();
    try {
      const worktree = join(dir, "a", "worktree");
      mkdirSync(worktree, { recursive: true });
      // A dangling link: nothing is installed there, so the walk must continue
      // to the neutral pass instead of refusing.
      symlinkSync("missing-target", join(dir, "a", "node_modules"));
      const { code, out } = run(worktree);
      expect(code).toBe(0);
      expect(out).toContain("nothing to inherit");
    } finally {
      cleanup();
    }
  });

  test("a local node_modules that resolves outside the worktree is not a pass", () => {
    const { dir, cleanup } = fixture();
    try {
      modules(dir); // the parent tree a link would borrow
      const worktree = join(dir, "worktree");
      mkdirSync(worktree, { recursive: true });
      symlinkSync(join(dir, "node_modules"), join(worktree, "node_modules"));
      const { code, out } = run(worktree);
      expect(code).toBe(1);
      expect(out).toContain("worktree-install-unproven");
      expect(out).toContain(join(realpathSync(dir), "node_modules"));
      expect(out).not.toContain("has its own node_modules");
    } finally {
      cleanup();
    }
  });

  test("an empty local node_modules does not certify an install", () => {
    const { dir, cleanup } = fixture();
    try {
      modules(dir); // a reachable ancestor tree
      const worktree = join(dir, "worktree");
      emptyModules(worktree);
      const { code, out } = run(worktree);
      expect(code).toBe(1);
      expect(out).toContain("worktree-install-unproven");
      expect(out).toContain(join(realpathSync(dir), "node_modules"));
    } finally {
      cleanup();
    }
  });

  test("an empty local node_modules with no ancestor is still not a pass", () => {
    const { dir, cleanup } = fixture();
    try {
      const worktree = join(dir, "worktree");
      emptyModules(worktree);
      const { code, out } = run(worktree);
      expect(code).toBe(1);
      expect(out).toContain("worktree-install-unproven");
      expect(out).not.toContain("nothing to inherit");
    } finally {
      cleanup();
    }
  });

  test("an install from a manager the repository does not use is reported", () => {
    const { dir, cleanup } = fixture();
    try {
      const worktree = join(dir, "worktree");
      modules(worktree);
      writeFileSync(join(worktree, "bun.lock"), "");
      writeFileSync(join(worktree, "node_modules", ".package-lock.json"), "{}\n");
      const { code, out } = run(worktree);
      expect(code).toBe(1);
      expect(out).toContain("worktree-install-foreign");
      expect(out).toContain("npm");
      expect(out).toContain("bun.lock");
    } finally {
      cleanup();
    }
  });

  test("a tree from the repository's own manager passes", () => {
    const { dir, cleanup } = fixture();
    try {
      const worktree = join(dir, "worktree");
      modules(worktree);
      writeFileSync(join(worktree, "bun.lock"), "");
      const { code, out } = run(worktree);
      expect(code).toBe(0);
      expect(out).toContain("has its own node_modules");
    } finally {
      cleanup();
    }
  });

  test("a tree carrying a foreign marker next to an allowed one is still foreign", () => {
    const { dir, cleanup } = fixture();
    try {
      const worktree = join(dir, "worktree");
      modules(worktree);
      writeFileSync(join(worktree, "package-lock.json"), "{}\n");
      // The first marker matches the repository; the second one must not be
      // shadowed by it.
      writeFileSync(join(worktree, "node_modules", ".package-lock.json"), "{}\n");
      writeFileSync(join(worktree, "node_modules", ".modules.yaml"), "\n");
      const { code, out } = run(worktree);
      expect(code).toBe(1);
      expect(out).toContain("worktree-install-foreign");
      expect(out).toContain(".modules.yaml");
      expect(out).toContain("pnpm");
    } finally {
      cleanup();
    }
  });

  test("an internal path whose first segment starts with two dots is inside", () => {
    const { dir, cleanup } = fixture();
    try {
      const worktree = join(dir, "worktree");
      mkdirSync(worktree, { recursive: true });
      modules(join(worktree, "..deps"));
      // Inside the worktree: only a segment NAME starts with two dots.
      symlinkSync(join("..deps", "node_modules"), join(worktree, "node_modules"));
      const { code, out } = run(worktree);
      expect(code).toBe(0);
      expect(out).toContain("has its own node_modules");
      expect(out).not.toContain("outside the worktree");
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
