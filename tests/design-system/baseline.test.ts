/**
 * The committed baseline reference (design-system rebuild, 2026-10-31).
 *
 * A baseline that lives only in gitignored `.mstar/` cannot be converged onto:
 * a clean checkout has no reference, and any comparator that reads it either
 * crashes or degrades into a pass. So the artefact's own contract is that it is
 * present, readable and tracked — the first of the three links (committed →
 * comparators point at it → CI runs them). The other two belong to tasks 6-7
 * and are not asserted here.
 *
 * The provenance header is asserted because it is the only thing that ties the
 * copy back to the revision it was approved at; without it a later diff cannot
 * tell an intentional copy from a stray edit.
 */
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const REPO = new URL("../../", import.meta.url).pathname;
const REL = "src/design-system/baseline/reference.html";
const BASELINE = join(REPO, REL);

describe("baseline reference", () => {
  test("exists as a non-empty HTML document", () => {
    expect(existsSync(BASELINE)).toBe(true);
    expect(statSync(BASELINE).isFile()).toBe(true);
    const html = readFileSync(BASELINE, "utf8");
    expect(html.length).toBeGreaterThan(0);
    // A truncated copy still "exists"; the closing tag is what says the whole
    // document survived the copy.
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
  });

  test("names its origin, revision and date", () => {
    const header = /<!doctype html>\s*<!--([\s\S]*?)-->/.exec(readFileSync(BASELINE, "utf8"))?.[1] ?? "";
    expect(header).toContain("Origin:   the design-system prototype");
    expect(header).toContain("r3");
    expect(header).toContain("2026-10-31");
  });

  test("is tracked by git", () => {
    // `--error-unmatch` makes an untracked-but-present file exit non-zero, so a
    // copy that was never staged cannot pass as committed.
    // Runs from the test process's checkout, which is the one under test.
    const proc = Bun.spawnSync(["git", "ls-files", "--error-unmatch", REL], {
      cwd: REPO,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode, `git ls-files failed: ${proc.stderr.toString()}`).toBe(0);
  });
});
