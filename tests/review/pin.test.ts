/**
 * Pin assertions for the sandbox image harness ref and engine dep (plan 47
 * Task 1 — supersedes the plan 32 Task 1 pin).
 *
 * POLICY CHANGE (plan 47, user instruction 2026-09-06): the repo manifest
 * `@mstar-harness/engine` range is now `^3.6.2` — the only range allowed in
 * package.json. This supersedes the plan 07/32 "exact pin, no
 * `^`/`~`/`latest`" discipline for the manifest ONLY. The sandbox image side
 * stays exact: the Dockerfile fetches a pinned deref commit, and reproducibility is frozen
 * by bun.lock (packages row must resolve to exact 3.6.2) +
 * `bun install --frozen-lockfile` in the image build.
 *
 * These tests fail if the harness image ref drifts off the 3.6.2 commit, if
 * the manifest range or the lockfile resolution drifts, or if the test fixture
 * plugin root stops mirroring the pinned layout (`commands/amazing-pr-review.md`
 * + `skills/mstar-audit`).
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { PLUGIN_ROOT_FIXTURE } from "./plugin-root-fixture";
import { REVIEW_SKILL_VERSION } from "../../src/store/artifact-store";

/** Harness 3.6.2 git ref fetched into the sandbox image (plan 47 Task 1). */
const HARNESS_362_REF = "3436ddcaf03ddec693dc7059395e9ccf92e5d005";
/** Superseded pre-3.6.2 refs that must no longer appear in the Dockerfile. */
const SUPERSEDED_360_REF = "ad76f0c6600acd5040464248085ad7d22af93e9f";
const SUPERSEDED_351_REF = "bde437075aeefd4cdb4e87060c6c44149968c3b0";
const SUPERSEDED_REF = "c188934c807184f416656a80ca50adb61ccbd525";
const SUPERSEDED_350_REF = "f1b60df0b3b2e29b9a904edb4077e52cf6d7ca66";

const REPO_ROOT = join(import.meta.dir, "..", "..");
/** The runtime-specific Dockerfile location (plan 37: sandbox-image/omp/). */
const OMP_DOCKERFILE = join(REPO_ROOT, "sandbox-image", "omp", "Dockerfile");

describe("sandbox image harness pin", () => {
  const dockerfile = readFileSync(OMP_DOCKERFILE, "utf8");

  test("Dockerfile fetches the 3.6.2 harness commit", () => {
    expect(dockerfile).toContain(`fetch --depth 1 origin ${HARNESS_362_REF}`);
  });

  test("Dockerfile no longer references the superseded refs", () => {
    expect(dockerfile).not.toContain(SUPERSEDED_360_REF);
    expect(dockerfile).not.toContain(SUPERSEDED_351_REF);
    expect(dockerfile).not.toContain(SUPERSEDED_REF);
    expect(dockerfile).not.toContain(SUPERSEDED_350_REF);
  });

  test("Dockerfile comment records the tag v3.6.2 double-write", () => {
    expect(dockerfile).toContain("tag v3.6.2");
  });
});

describe("engine dependency pin", () => {
  const pkg = JSON.parse(readFileSync(join(REPO_ROOT, "package.json"), "utf8")) as {
    dependencies: Record<string, string>;
  };

  test("@mstar-harness/engine manifest declares the ^3.6.2 range (plan 47 policy change)", () => {
    expect(pkg.dependencies["@mstar-harness/engine"]).toBe("^3.6.2");
  });

  test("@mstar-harness/engine bun.lock packages row resolves to exact 3.6.2", () => {
    const lockfile = readFileSync(join(REPO_ROOT, "bun.lock"), "utf8");
    // The packages row names the RESOLVED version verbatim (exact 3.6.2, no
    // range prefix) — this is what `bun install --frozen-lockfile` in the
    // image build installs. A bad resolution (e.g. 3.6.1, or the range
    // leaking into the resolved name) fails this anchor.
    expect(lockfile).toContain('"@mstar-harness/engine": ["@mstar-harness/engine@3.6.2"');
  });

  test("@mstar-harness/engine bun.lock workspaces row mirrors the manifest range", () => {
    const lockfile = readFileSync(join(REPO_ROOT, "bun.lock"), "utf8");
    // The workspaces dependencies row (bun.lock:9) mirrors the package.json
    // range declaration; drift here would desync the workspace root from the
    // manifest.
    expect(lockfile).toContain('"@mstar-harness/engine": "^3.6.2"');
  });
});

describe("review skill version pin", () => {
  test("REVIEW_SKILL_VERSION carries the exact 3.6.2+3436ddca value", () => {
    expect(REVIEW_SKILL_VERSION).toBe("3.6.2+3436ddca");
  });

  test("REVIEW_SKILL_VERSION + suffix binds to the Dockerfile fetch sha prefix", () => {
    const dockerfile = readFileSync(OMP_DOCKERFILE, "utf8");
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
