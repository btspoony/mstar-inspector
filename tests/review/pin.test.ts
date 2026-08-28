/**
 * Pin assertions for plan 07 Task 1.
 *
 * The sandbox image and the runner deps are pinned to exact upstream
 * versions (plan 07 Global Constraints: no `^`/`~`/`latest`). These tests
 * fail if the harness image ref drifts off the 3.5.0 commit, if the engine
 * dep loosens, or if the test fixture plugin root stops mirroring the
 * pinned layout (`commands/amazing-pr-review.md` + `skills/mstar-audit`).
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PLUGIN_ROOT_FIXTURE } from "./plugin-root-fixture";

/** Harness 3.5.0 git ref fetched into the sandbox image (plan 07 Scope). */
const HARNESS_350_REF = "f1b60df0b3b2e29b9a904edb4077e52cf6d7ca66";
/** Superseded pre-3.5.0 ref that must no longer appear in the Dockerfile. */
const SUPERSEDED_REF = "c188934c807184f416656a80ca50adb61ccbd525";

const REPO_ROOT = join(import.meta.dir, "..", "..");

describe("sandbox image harness pin", () => {
  const dockerfile = readFileSync(join(REPO_ROOT, "sandbox-image", "Dockerfile"), "utf8");

  test("Dockerfile fetches the 3.5.0 harness commit", () => {
    expect(dockerfile).toContain(`fetch --depth 1 origin ${HARNESS_350_REF}`);
  });

  test("Dockerfile no longer references the superseded ref", () => {
    expect(dockerfile).not.toContain(SUPERSEDED_REF);
  });
});

describe("engine dependency pin", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };

  test("@mstar-harness/engine is pinned to exact 3.5.0 (no range prefix)", () => {
    expect(pkg.dependencies["@mstar-harness/engine"]).toBe("3.5.0");
  });
});

describe("fixture plugin root layout", () => {
  test("fixture contains commands/amazing-pr-review.md and skills/mstar-audit", () => {
    expect(existsSync(join(PLUGIN_ROOT_FIXTURE, "commands", "amazing-pr-review.md"))).toBe(true);
    expect(existsSync(join(PLUGIN_ROOT_FIXTURE, "skills", "mstar-audit", "SKILL.md"))).toBe(true);
  });
});
