/**
 * why: Source-contract locks for the sandbox-image registry (QC fix wave
 * 1). The registry (src/contracts/sandbox-images.ts) is the zero-import SSOT;
 * three consumers mirror it by hand across boundaries a runtime import cannot
 * cross — each lock below turns that drift into a failing gate:
 *   - qc1 F-001: the omp build definition (Dockerfile path) must exist and be
 *     referenced verbatim by BOTH wrangler configs' `containers[].images.sandbox`;
 * The registry declares build inputs only: no provider, no model, no size.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { OMP_SANDBOX_IMAGE_PINS, enabledSandboxImages, getSandboxImage } from "../../src/contracts/sandbox-images";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const OMP_IMAGE = getSandboxImage("omp")!;

describe("registry build-definition parity (qc1 F-001)", () => {
  test("the omp Dockerfile path exists and both wrangler configs reference exactly it", () => {
    // why: The registry's build definition names a real file...
    expect(existsSync(join(REPO_ROOT, OMP_IMAGE.dockerfilePath))).toBe(true);
    // why: ...and the two registry path fields are the same file (wrangler form is
    // the ./-prefixed spelling of dockerfilePath).
    expect(OMP_IMAGE.wranglerImagePath).toBe(`./${OMP_IMAGE.dockerfilePath}`);
    // why: Both wrangler configs' `containers[].images.sandbox.dockerfile` point at
    // THAT path, with the repo-root build context unchanged (the Dockerfile
    // COPYs the runner package sources from the repo root). Collecting EVERY
    // match (not just the
    // first) pins the full set: a second, unregistered image entry fails the
    // lock instead of hiding behind the first match.
    const enabledPaths = new Set(enabledSandboxImages().map((entry) => entry.wranglerImagePath));
    for (const config of ["wrangler.jsonc", "wrangler.smoke.jsonc"]) {
      const text = readFileSync(join(REPO_ROOT, config), "utf8");
      // why: Sandbox SDK 1.0 shape: the image rides the DO scheduling policy's
      // named-images map (`images.sandbox.dockerfile`, built from the repo
      // root `build_context` the Dockerfile COPYs the runner package sources
      // from). Collecting EVERY match (not just the first) pins the full set:
      // a second, unregistered image entry fails the lock instead of hiding
      // behind the first match. "dockerfile"/"build_context" are distinct
      // keys, so each regex collects exactly its own key.
      const dockerfiles = new Set([...text.matchAll(/"dockerfile":\s*"([^"]+)"/g)].map((match) => match[1]));
      expect(dockerfiles).toEqual(enabledPaths);
      const buildContexts = new Set(
        [...text.matchAll(/"build_context":\s*"([^"]+)"/g)].map((match) => match[1]),
      );
      expect(buildContexts).toEqual(new Set(["."]));
    }
  });
});

describe("Dockerfile harness clone ref mirrors the registry pin", () => {
  // why: `harnessRef` is a literal commit the Dockerfile cannot import (it clones at
  // build time), so the pair is hand-synced — and it drifted once: 4.2.3 shipped
  // with the v4.2.2 commit, making REVIEW_SKILL_VERSION name a tree no image
  // checkout contained. Both the anchor comment and the fetch line are locked
  // here so a missing anchor fails instead of passing vacuously.
  const dockerfile = readFileSync(join(REPO_ROOT, OMP_IMAGE.dockerfilePath), "utf8");
  const ANCHOR = /#\s*mstar-harness plugin, pinned ref ([0-9a-f]{40}) \(tag v([^,]+), bumped (\d{4}-\d{2}-\d{2})\)/;
  const FETCH = /git -C \/opt\/mstar-harness fetch --depth 1 origin ([0-9a-f]{40})/;

  test("the anchor comment names the pinned ref", () => {
    const match = ANCHOR.exec(dockerfile);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(OMP_SANDBOX_IMAGE_PINS.harnessRef);
  });

  test("the shallow fetch requests the same commit", () => {
    const match = FETCH.exec(dockerfile);
    expect(match).not.toBeNull();
    expect(match![1]).toBe(OMP_SANDBOX_IMAGE_PINS.harnessRef);
  });

  test("the anchor's TAG and the registry's harnessVersion name one release", () => {
    // why: The four image-facing pins describe a single harness release:
    // HARNESS_VERSION, harnessCliVersion, the clone ref, and the tag the anchor
    // comment records. A version-only bump moved the first two while leaving the
    // tag and the ref on the previous release; nothing compared them, so the
    // inconsistent pair shipped and then wedged every later ref bump (the next
    // run built its match string from the assumed tag). This is that comparison.
    const match = ANCHOR.exec(dockerfile);
    expect(match, "the anchor comment must carry its tag").not.toBeNull();
    expect(match![2]).toBe(OMP_SANDBOX_IMAGE_PINS.harnessVersion);
    expect(OMP_SANDBOX_IMAGE_PINS.harnessCliVersion).toBe(OMP_SANDBOX_IMAGE_PINS.harnessVersion);
    // why: And the record of when it moved is a real date, not a placeholder.
    expect(match![3]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});


