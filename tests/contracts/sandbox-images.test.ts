/**
 * Source-contract locks for the sandbox-image registry (plan 37 QC fix wave
 * 1). The registry (src/contracts/sandbox-images.ts) is the zero-import SSOT;
 * three consumers mirror it by hand across boundaries a runtime import cannot
 * cross — each lock below turns that drift into a failing gate:
 *   - qc1 F-001: the omp build definition (Dockerfile path) must exist and be
 *     referenced verbatim by BOTH wrangler configs' `containers[].image`;
 *   - qc1 F-003 / qc2 S1 / qc3 S-3: the in-image verify-synthesis.sh
 *     ARK_PLAN_HOST literal (the image COPYs only src/review, so the script
 *     cannot import the registry) must mirror the omp entry's scalars;
 *   - qc1 F-002: the in-image CapabilityHost mirror (src/review/runtime.ts)
 *     must stay mutually assignable with the registry's SandboxImageHost —
 *     enforced at TYPECHECK time by the type assertions inside the test.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import { enabledSandboxImages, getSandboxImage } from "../../src/contracts/sandbox-images";
import type { SandboxImageHost, SandboxImageHostModel } from "../../src/contracts/sandbox-images";
import type { CapabilityHost, CapabilityHostModel } from "../../src/review/runtime";

const REPO_ROOT = join(import.meta.dir, "..", "..");
const OMP_IMAGE = getSandboxImage("omp")!;

describe("registry build-definition parity (qc1 F-001)", () => {
  test("the omp Dockerfile path exists and both wrangler configs reference exactly it", () => {
    // The registry's build definition names a real file...
    expect(existsSync(join(REPO_ROOT, OMP_IMAGE.dockerfilePath))).toBe(true);
    // ...and the two registry path fields are the same file (wrangler form is
    // the ./-prefixed spelling of dockerfilePath).
    expect(OMP_IMAGE.wranglerImagePath).toBe(`./${OMP_IMAGE.dockerfilePath}`);
    // Both wrangler configs' containers[].image point at THAT path, with the
    // repo-root build context unchanged (the Dockerfile COPYs package.json +
    // src/review from the repo root). Collecting EVERY match (not just the
    // first) pins the full set: a second, unregistered containers[].image
    // entry fails the lock instead of hiding behind the first match.
    const enabledPaths = new Set(enabledSandboxImages().map((entry) => entry.wranglerImagePath));
    for (const config of ["wrangler.jsonc", "wrangler.smoke.jsonc"]) {
      const text = readFileSync(join(REPO_ROOT, config), "utf8");
      // "image": does not overlap "image_build_context": (the closing quote
      // of the key name differs), so each regex collects exactly its own key.
      const images = new Set([...text.matchAll(/"image":\s*"([^"]+)"/g)].map((match) => match[1]));
      expect(images).toEqual(enabledPaths);
      const buildContexts = new Set(
        [...text.matchAll(/"image_build_context":\s*"([^"]+)"/g)].map((match) => match[1]),
      );
      expect(buildContexts).toEqual(new Set(["."]));
    }
  });
});

describe("in-image verify-synthesis.sh ARK_PLAN_HOST literal mirrors the registry (qc1 F-003, qc2 S1, qc3 S-3)", () => {
  const script = readFileSync(join(REPO_ROOT, "sandbox-image", "verify-synthesis.sh"), "utf8");

  test("the ARK_PLAN_HOST block carries the omp registry host's scalars verbatim", () => {
    // Slice the inline literal block (from its const declaration to the next
    // const, DECL) so a stray mention elsewhere in the script cannot satisfy
    // the lock — only the mirrored declaration counts.
    const start = script.indexOf("const ARK_PLAN_HOST = {");
    const end = script.indexOf("const DECL");
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const block = script.slice(start, end);

    // Values extracted FROM the registry (not restated here): any registry
    // edit without the mirrored script edit fails this assertion.
    const host = OMP_IMAGE.hosts[0]!;
    expect(block).toContain(`id: "${host.id}"`);
    expect(block).toContain(`catalogProviderId: "${host.catalogProviderId}"`);
    expect(block).toContain(`apiKeyEnv: "${host.apiKeyEnv}"`);
    expect(block).toContain(`baseUrl: "${host.baseUrl}"`);
    expect(block).toContain(`api: "${host.api}"`);
    expect(block).toContain(`auth: "${host.auth}"`);
    for (const model of host.models) {
      expect(block).toContain(`id: "${model.id}"`);
      expect(block).toContain(`name: "${model.name}"`);
      expect(block).toContain(`reasoning: ${model.reasoning}`);
      expect(block).toContain(`input: ${JSON.stringify(model.input)}`);
      expect(block).toContain(`contextWindow: ${model.contextWindow}`);
      expect(block).toContain(`maxTokens: ${model.maxTokens}`);
    }
  });
});

describe("CapabilityHost structural-mirror type-lock (qc1 F-002)", () => {
  test("the in-image mirror stays mutually assignable with the registry types", () => {
    // The lock IS the type assertion: a field added to one type family
    // without the other fails `bun run typecheck` (tsc checks this test file)
    // before any test runs. Test-side only — src/review keeps its zero
    // outside-import module-graph boundary (tests/review/runtime-boundary).
    const hostMirror: SandboxImageHost = {} as CapabilityHost;
    const hostRegistry: CapabilityHost = {} as SandboxImageHost;
    const modelMirror: SandboxImageHostModel = {} as CapabilityHostModel;
    const modelRegistry: CapabilityHostModel = {} as SandboxImageHostModel;
    // Runtime no-op; the assertions above are the contract.
    expect(hostMirror).toBeDefined();
    expect(hostRegistry).toBeDefined();
    expect(modelMirror).toBeDefined();
    expect(modelRegistry).toBeDefined();
  });
});
