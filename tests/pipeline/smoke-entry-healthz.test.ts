/**
 * The local smoke entry's `/healthz` keeps the same shape as
 * the production worker face — `{"ok":true,"version":"vX.Y.Z"}` from the
 * generated single source (src/version.ts). The module statically imports
 * the workerd-only sandbox SDK chain, so Bun tests cannot import it; this is
 * the same source-scan pin contract as the SPA pins.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const smokeEntry = readFileSync(join(import.meta.dir, "../../src/pipeline/smoke-entry.ts"), "utf8");

describe("smoke-entry healthz face", () => {
  test("consumes the generated version constant (single source)", () => {
    expect(smokeEntry).toContain('import { APP_VERSION } from "../version";');
  });

  test("answers the same shape as the worker healthz (ok + v-prefixed version)", () => {
    expect(smokeEntry).toContain("Response.json({ ok: true, version: `v${APP_VERSION}` })");
  });
});

/**
 * The smoke target (repository + PR) is a per-run config input, not a baked
 * constant — pin that the module carries no personal default and that the
 * orchestrator supplies it through the documented `--var` path.
 */
describe("smoke-entry smoke target configuration", () => {
  test("no hardcoded personal repository (target comes from configuration)", () => {
    expect(smokeEntry).not.toContain("btspoony");
    expect(smokeEntry).not.toMatch(/const GH_REPO = "/);
  });

  test("reads the target from the env and allows the value before minting the shell sink", () => {
    expect(smokeEntry).toContain("GH_REPO: string;");
    expect(smokeEntry).toContain("function smokeTarget(env: SmokeEnv)");
    expect(smokeEntry).toContain("GITHUB_NAME_RE.test(owner)");
    expect(smokeEntry).toContain("PR_NUMBER_RE.test(pr)");
    // Both routes reject a malformed target instead of shell-interpolating it.
    expect(smokeEntry).toContain("GH_REPO must be owner/repo and GH_PR a number");
  });
});
