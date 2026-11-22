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
    expect(html.trimEnd().endsWith("</html>")).toBe(true);
  });

  test("names its origin, revision and date", () => {
    const header = /<!doctype html>\s*<!--([\s\S]*?)-->/.exec(readFileSync(BASELINE, "utf8"))?.[1] ?? "";
    expect(header).toContain("Origin:   the design-system prototype");
    expect(header).toContain("r3");
    expect(header).toContain("2026-10-31");
  });

  test("is tracked by git", () => {
    const proc = Bun.spawnSync(["git", "ls-files", "--error-unmatch", REL], {
      cwd: REPO,
      stdout: "pipe",
      stderr: "pipe",
    });
    expect(proc.exitCode, `git ls-files failed: ${proc.stderr.toString()}`).toBe(0);
  });
});
