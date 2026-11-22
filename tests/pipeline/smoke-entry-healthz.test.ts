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

describe("smoke-entry smoke target configuration", () => {
  test("no hardcoded personal repository (target comes from configuration)", () => {
    expect(smokeEntry).not.toMatch(/github\.com\/(?!\$\{repo\})/);
    expect(smokeEntry).not.toMatch(/const GH_REPO = "/);
  });

  test("reads GH_REPO from the env and validates it before the shell sink", () => {
    expect(smokeEntry).toContain("GH_REPO: string;");
    expect(smokeEntry).toContain("function smokeRepo(env: SmokeEnv)");
    expect(smokeEntry).toContain("GITHUB_NAME_RE.test(owner)");
    expect(smokeEntry).toContain("GH_REPO must be owner/repo");
    expect(smokeEntry).toContain('if (url.pathname !== "/smoke" && url.pathname !== "/smoke-review")');
  });

  test("GH_PR stays the fixed seed PR (no env input)", () => {
    expect(smokeEntry).toContain('const GH_PR = "1";');
    expect(smokeEntry).not.toContain("GH_PR?:");
    expect(smokeEntry).not.toContain("env.GH_PR");
  });
});
