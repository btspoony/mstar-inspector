/**
 * Pin assertions for the sandbox image harness ref and engine dep (plan 32
 * Task 1 — supersedes the plan 25 Task 1 pin; plan 07 Global Constraints:
 * no `^`/`~`/`latest` still apply).
 *
 * The sandbox image and the runner deps are pinned to exact upstream
 * versions. These tests fail if the harness image ref drifts off the 3.6.0
 * commit, if the engine dep loosens, or if the test fixture plugin root
 * stops mirroring the pinned layout (`commands/amazing-pr-review.md` +
 * `skills/mstar-audit`).
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PLUGIN_ROOT_FIXTURE } from "./plugin-root-fixture";
import { REVIEW_SKILL_VERSION } from "../../src/store/artifact-store";

/** Harness 3.6.0 git ref fetched into the sandbox image (plan 32 Task 1). */
const HARNESS_360_REF = "ad76f0c6600acd5040464248085ad7d22af93e9f";
/** Superseded pre-3.6.0 refs that must no longer appear in the Dockerfile. */
const SUPERSEDED_351_REF = "bde437075aeefd4cdb4e87060c6c44149968c3b0";
const SUPERSEDED_REF = "c188934c807184f416656a80ca50adb61ccbd525";
const SUPERSEDED_350_REF = "f1b60df0b3b2e29b9a904edb4077e52cf6d7ca66";

const REPO_ROOT = join(import.meta.dir, "..", "..");

describe("sandbox image harness pin", () => {
  const dockerfile = readFileSync(join(REPO_ROOT, "sandbox-image", "Dockerfile"), "utf8");

  test("Dockerfile fetches the 3.6.0 harness commit", () => {
    expect(dockerfile).toContain(`fetch --depth 1 origin ${HARNESS_360_REF}`);
  });

  test("Dockerfile no longer references the superseded ref", () => {
    expect(dockerfile).not.toContain(SUPERSEDED_351_REF);
    expect(dockerfile).not.toContain(SUPERSEDED_REF);
    expect(dockerfile).not.toContain(SUPERSEDED_350_REF);
  });

  test("Dockerfile comment records the tag v3.6.0 double-write", () => {
    expect(dockerfile).toContain("tag v3.6.0");
  });
});

describe("engine dependency pin", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };

  test("@mstar-harness/engine is pinned to exact 3.6.0 (no range prefix)", () => {
    expect(pkg.dependencies["@mstar-harness/engine"]).toBe("3.6.0");
  });

  test("@mstar-harness/engine bun.lock row resolves to exact 3.6.0 (no range prefix)", () => {
    const lockfile = readFileSync(join(REPO_ROOT, "bun.lock"), "utf8");
    // The packages row names the resolved version verbatim; a ^/~ range would
    // surface as "@mstar-harness/engine@^3.6.0" and fail this anchor.
    expect(lockfile).toContain('"@mstar-harness/engine": ["@mstar-harness/engine@3.6.0"');
    // The workspaces dependencies row (bun.lock:9) mirrors the package.json
    // exact-version declaration; drift here would desync the workspace root
    // from the resolved package.
    expect(lockfile).toContain('"@mstar-harness/engine": "3.6.0"');
  });
});

describe("review skill version pin", () => {
  test("REVIEW_SKILL_VERSION carries the exact 3.6.0+ad76f0c6 value", () => {
    expect(REVIEW_SKILL_VERSION).toBe("3.6.0+ad76f0c6");
  });

  test("REVIEW_SKILL_VERSION + suffix binds to the Dockerfile fetch sha prefix", () => {
    const dockerfile = readFileSync(join(REPO_ROOT, "sandbox-image", "Dockerfile"), "utf8");
    const fetchSha = dockerfile.match(/fetch --depth 1 origin ([0-9a-f]{40})/)?.[1];
    expect(fetchSha).toBeDefined();
    // The constant's "+" suffix is the short form of the Dockerfile fetch sha;
    // drift between the two anchors (image ref vs D1 attribution) fails here.
    expect(REVIEW_SKILL_VERSION.endsWith(`+${fetchSha!.slice(0, 8)}`)).toBe(true);
  });
});

describe("fixture plugin root layout", () => {
  test("fixture contains commands/amazing-pr-review.md and skills/mstar-audit", () => {
    expect(existsSync(join(PLUGIN_ROOT_FIXTURE, "commands", "amazing-pr-review.md"))).toBe(true);
    expect(existsSync(join(PLUGIN_ROOT_FIXTURE, "skills", "mstar-audit", "SKILL.md"))).toBe(true);
  });
});
