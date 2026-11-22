
import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { OMP_SANDBOX_IMAGE_PINS, enabledSandboxImages, getSandboxImage } from "../../src/contracts/sandbox-images";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const OMP_IMAGE = getSandboxImage("omp")!;

describe("registry build-definition parity (qc1 F-001)", () => {
  test("the omp Dockerfile path exists and both wrangler configs reference exactly it", () => {
    expect(existsSync(join(REPO_ROOT, OMP_IMAGE.dockerfilePath))).toBe(true);
    expect(OMP_IMAGE.wranglerImagePath).toBe(`./${OMP_IMAGE.dockerfilePath}`);
    const enabledPaths = new Set(enabledSandboxImages().map((entry) => entry.wranglerImagePath));
    for (const config of ["wrangler.jsonc", "wrangler.smoke.jsonc"]) {
      const text = readFileSync(join(REPO_ROOT, config), "utf8");
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
    const match = ANCHOR.exec(dockerfile);
    expect(match, "the anchor comment must carry its tag").not.toBeNull();
    expect(match![2]).toBe(OMP_SANDBOX_IMAGE_PINS.harnessVersion);
    expect(OMP_SANDBOX_IMAGE_PINS.harnessCliVersion).toBe(OMP_SANDBOX_IMAGE_PINS.harnessVersion);
    expect(match![3]).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});


