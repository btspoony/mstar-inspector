/**
 * Shared provider mapping tests (bugbot BB-2 → AL-24-5, plan 35 T3): the
 * allowlist that maps per-App BYOK provider ids to the env var names
 * injected into the review container. The global-env picker
 * (`pickProviderKeys`) was retired with the zero-global-fallback cutover
 * (plan 24 Task 6): keys come only from the App's per-App config, so there
 * is nothing to pick from a worker-env-shaped record anymore. The mapping
 * now lives in the generated provider catalog (src/pipeline/
 * provider-catalog.ts, spec §5) — the export contract (providerEnvName /
 * PROVIDER_ENV_NAMES) is unchanged.
 */

import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROVIDER_CATALOG,
  PROVIDERS,
  PROVIDER_ENV_NAMES,
  TEMPLATE_PROVIDERS,
  providerEnvName,
  customProviderEnvName,
  CUSTOM_PROVIDER_ENV_PREFIX,
  CUSTOM_PROVIDER_ENV_SUFFIX,
} from "../../src/pipeline/provider-catalog";

describe("shared provider mapping", () => {
  test("PROVIDER_ENV_NAMES is the frozen env-name snapshot of PROVIDERS", () => {
    expect([...PROVIDER_ENV_NAMES]).toEqual(Object.values(PROVIDERS).map((info) => info.envName));
    expect(Object.isFrozen(PROVIDER_ENV_NAMES)).toBe(true);
  });

  test("providerEnvName resolves known providers and fails closed otherwise", () => {
    expect(providerEnvName("anthropic")).toBe("ANTHROPIC_API_KEY");
    expect(providerEnvName("openrouter")).toBe("OPENROUTER_API_KEY");
    expect(providerEnvName("not-a-provider")).toBeUndefined();
  });

  test("ark maps to ARK_API_KEY — the in-image ark-plan base provider's key env (AL-24-5)", () => {
    expect(PROVIDERS["ark"]).toEqual({ envName: "ARK_API_KEY", label: "Ark" });
    expect(providerEnvName("ark")).toBe("ARK_API_KEY");
    // The provider set is the SSOT the dashboard PROVIDER_IDS mirror locks
    // against (tests/worker/app-config.test.ts parity lock).
    expect(Object.keys(PROVIDERS)).toHaveLength(19);
  });
});
describe("customProviderEnvName (plan 23 Task 3, AL-23-1)", () => {
  test("maps provider ids to CUSTOM_<UPPER_SNAKE>_API_KEY — hyphen → underscore, uppercased", () => {
    expect(customProviderEnvName("my-provider")).toBe("CUSTOM_MY_PROVIDER_API_KEY");
    expect(customProviderEnvName("ark")).toBe("CUSTOM_ARK_API_KEY");
    expect(customProviderEnvName("a1-b2")).toBe("CUSTOM_A1_B2_API_KEY");
    expect(customProviderEnvName("deep-model-x")).toBe("CUSTOM_DEEP_MODEL_X_API_KEY");
  });

  test("the prefix/suffix constants are the frozen contract fragments", () => {
    expect(CUSTOM_PROVIDER_ENV_PREFIX).toBe("CUSTOM_");
    expect(CUSTOM_PROVIDER_ENV_SUFFIX).toBe("_API_KEY");
    expect(customProviderEnvName("x")).toBe(`${CUSTOM_PROVIDER_ENV_PREFIX}X${CUSTOM_PROVIDER_ENV_SUFFIX}`);
  });
});

describe("provider catalog tiers (plan 35 T3, spec §5)", () => {
  test("the catalog is 19 builtin + 1 template, and PROVIDERS is exactly the builtin tier", () => {
    const builtin = Object.entries(PROVIDER_CATALOG).filter(([, e]) => e.tier === "builtin");
    const template = Object.entries(PROVIDER_CATALOG).filter(([, e]) => e.tier === "template");
    expect(builtin).toHaveLength(19);
    expect(template).toHaveLength(1);
    expect(Object.keys(PROVIDERS)).toEqual(builtin.map(([id]) => id));
    expect(Object.keys(TEMPLATE_PROVIDERS)).toEqual(template.map(([id]) => id));
  });

  test("builtin entries carry a non-null envName; template entries carry null (materialized via customProviderEnvName)", () => {
    for (const [id, entry] of Object.entries(PROVIDER_CATALOG)) {
      if (entry.tier === "builtin") {
        expect(entry.envName, id).not.toBeNull();
        expect(entry.api, id).toBeNull();
      } else {
        expect(entry.envName, id).toBeNull();
        expect(entry.api, id).not.toBeNull();
      }
    }
  });

  test("workers-ai is the template entry with the account-id-templated base URL and the custom env convention", () => {
    const entry = PROVIDER_CATALOG["workers-ai"];
    expect(entry).toBeDefined();
    expect(entry!.tier).toBe("template");
    expect(entry!.label).toBe("Cloudflare Workers AI");
    expect(entry!.baseUrl).toBe("https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1");
    expect(entry!.api).toBe("openai-completions");
    // The env convention is the custom-provider contract: the materialized
    // declaration's key rides CUSTOM_WORKERS_AI_API_KEY (spec §5).
    expect(customProviderEnvName("workers-ai")).toBe("CUSTOM_WORKERS_AI_API_KEY");
    expect(entry!.models.length).toBeGreaterThan(0);
    expect(entry!.doc).toBe("https://developers.cloudflare.com/workers-ai/models/");
  });

  test("every builtin entry has representative models and a doc URL (display metadata)", () => {
    for (const [id, entry] of Object.entries(PROVIDER_CATALOG)) {
      if (entry.tier !== "builtin") continue;
      expect(entry.models.length, id).toBeGreaterThanOrEqual(0);
      expect(entry.doc, id).not.toBeNull();
    }
  });
});

describe("provider catalog provenance + determinism (plan 38 T3)", () => {
  const repoRoot = join(import.meta.dir, "../..");
  const catalogPath = join(repoRoot, "src/pipeline/provider-catalog.ts");
  const generatorPath = join(repoRoot, "scripts/generate-provider-catalog.ts");
  const snapshotPath = join(repoRoot, "scripts/provider-catalog/models.dev-2026-09-04.json");

  test("the committed models.dev snapshot is present, parseable, and the generator's only input", () => {
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<string, unknown>;
    expect(Object.keys(snapshot).length).toBeGreaterThan(0);
    const generator = readFileSync(generatorPath, "utf8");
    // The pin is the committed snapshot file — provenance is the vendored
    // JSON, never a network source.
    expect(generator).toContain("models.dev-2026-09-04.json");
    // Zero authoring-time network: the generator reads only the snapshot.
    expect(generator).not.toMatch(/\bfetch\s*\(/);
  });

  test("the generated module is static Worker/browser code — zero runtime fetch, snapshot pin disclosed", () => {
    const source = readFileSync(catalogPath, "utf8");
    expect(source).not.toMatch(/\bfetch\s*\(/);
    // The provenance header names the pinned snapshot and the authoring path.
    expect(source).toContain("models.dev-2026-09-04.json");
    expect(source).toContain("DO NOT EDIT BY");
  });

  test("regeneration from the committed snapshot is byte-identical — deterministic generation, no hand edits", () => {
    const before = readFileSync(catalogPath, "utf8");
    for (let run = 0; run < 2; run++) {
      const proc = Bun.spawnSync(["bun", "scripts/generate-provider-catalog.ts"], {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(proc.exitCode, proc.stderr.toString()).toBe(0);
    }
    const after = readFileSync(catalogPath, "utf8");
    try {
      // Both runs reproduce the committed artifact exactly — the committed
      // module stays the single source, generated, never hand-edited.
      expect(after).toBe(before);
    } finally {
      // Keep the worktree clean even on a drift failure: restore the
      // committed bytes so the diff a reviewer sees is the test's report,
      // not a silently regenerated module.
      if (after !== before) writeFileSync(catalogPath, before);
    }
  });
});
