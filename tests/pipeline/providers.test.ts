/**
 * Shared provider mapping tests (bugbot BB-2 → AL-24-5, plan 35 T3; plan 42
 * T1 breadth): the allowlist that maps per-App BYOK provider ids to the env
 * var names injected into the review container. The global-env picker
 * (`pickProviderKeys`) was retired with the zero-global-fallback cutover
 * (plan 24 Task 6): keys come only from the App's per-App config, so there
 * is nothing to pick from a worker-env-shaped record anymore. The mapping
 * lives in the generated contract src/contracts/provider-catalog.generated.ts
 * (the SSOT since plan 42); src/pipeline/provider-catalog.ts is the
 * hand-written pipeline face re-exporting it — the export contract
 * (providerEnvName / PROVIDER_ENV_NAMES) is unchanged.
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
import { PROVIDER_IDS_BUILTIN } from "../../src/contracts/provider-catalog.generated";
import { CUSTOM_PROVIDER_ID_PATTERN } from "../../src/dashboard/app-config-store";

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

describe("provider catalog tiers (plan 35 T3, spec §5; plan 42 T1 breadth)", () => {
  test("the catalog is 19 builtin + the full template tier (workers-ai + snapshot breadth)", () => {
    const builtin = Object.entries(PROVIDER_CATALOG).filter(([, e]) => e.tier === "builtin");
    const template = Object.entries(PROVIDER_CATALOG).filter(([, e]) => e.tier === "template");
    // The 19 runner-consumable builtins are immutable (plan 42 Global
    // Constraints); the template tier is the hand-curated workers-ai entry
    // plus every breadth row from the committed snapshot (194 → 195).
    expect(builtin).toHaveLength(19);
    expect(template).toHaveLength(195);
    expect(Object.keys(PROVIDER_CATALOG)).toHaveLength(214);
    expect(Object.keys(PROVIDERS)).toEqual(builtin.map(([id]) => id));
    expect(Object.keys(TEMPLATE_PROVIDERS)).toEqual(template.map(([id]) => id));
  });

  test("PROVIDER_IDS_BUILTIN is the frozen builtin sequence (the pipeline face's PROVIDERS order)", () => {
    expect([...PROVIDER_IDS_BUILTIN]).toEqual(Object.keys(PROVIDERS));
    expect(Object.isFrozen(PROVIDER_IDS_BUILTIN)).toBe(true);
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

describe("provider catalog breadth enumeration (plan 42 T1, spec § Providers contract 2)", () => {
  const repoRoot = join(import.meta.dir, "../..");
  const generatorPath = join(repoRoot, "scripts/generate-provider-catalog.ts");
  const snapshotPath = join(repoRoot, "scripts/provider-catalog/models.dev-2026-09-04.json");
  const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as Record<string, {
    name: string;
    api: string | null;
    doc: string | null;
    model_ids: string[];
  }>;
  // The builtin sourceKeys, extracted from the generator's BUILTIN_ORDER
  // table (the SSOT — a sourceKey change must update this lock's input in
  // the same commit).
  const generatorSource = readFileSync(generatorPath, "utf8");
  const builtinSourceKeys = [...generatorSource.matchAll(/sourceKey: "([^"]+)"/g)].map((m) => m[1]!);
  // Breadth rule (b): snapshot keys deduped into a hand-curated template.
  const dedupedSnapshotKeys = ["cloudflare-workers-ai"];

  test("the generator's id-pattern copy is byte-equal to the dashboard CUSTOM_PROVIDER_ID_PATTERN", () => {
    // The generator hardcodes the store's grammar as a literal (zero
    // generation-time repo imports); drift would silently widen/narrow the
    // breadth enumeration.
    expect(generatorSource).toContain(`/${CUSTOM_PROVIDER_ID_PATTERN.source}/`);
  });

  test("every snapshot key is exactly one of: breadth template row, builtin sourceKey, dedupe, or id-grammar skip", () => {
    const templateIds = new Set(Object.keys(TEMPLATE_PROVIDERS));
    const expectedBreadth = Object.keys(snapshot).filter(
      (key) =>
        !builtinSourceKeys.includes(key) &&
        !dedupedSnapshotKeys.includes(key) &&
        CUSTOM_PROVIDER_ID_PATTERN.test(key),
    );
    // No excluded snapshot key appears as a TEMPLATE row (rule (a) prevents
    // duplicate vendor rows like a `google` template beside the `gemini`
    // builtin; plan-time verification: 18 sourceKey exclusions, 1 dedupe,
    // 0 additional grammar skips — wafer.ai fails the regex but is already a
    // sourceKey exclusion). Some sourceKeys coincide with their builtin id
    // (`anthropic` → `anthropic`) — those live in the builtin tier only.
    for (const key of [...builtinSourceKeys, ...dedupedSnapshotKeys]) {
      expect(templateIds.has(key), key).toBe(false);
    }
    for (const key of expectedBreadth) {
      expect(templateIds.has(key), key).toBe(true);
      expect(PROVIDER_CATALOG[key]!.tier, key).toBe("template");
    }
    // 194 breadth + 19 builtin + 1 curated template = 214 catalog rows.
    expect(expectedBreadth).toHaveLength(194);
    expect(templateIds.size).toBe(195);
  });

  test("snapshot-derived entries follow the breadth mapping (label/baseUrl/api/models/doc, 20-model prefill cap)", () => {
    const expectedBreadth = Object.keys(snapshot).filter(
      (key) =>
        !builtinSourceKeys.includes(key) &&
        !dedupedSnapshotKeys.includes(key) &&
        CUSTOM_PROVIDER_ID_PATTERN.test(key),
    );
    for (const key of expectedBreadth) {
      const source = snapshot[key]!;
      const entry = PROVIDER_CATALOG[key]!;
      expect(entry.label, key).toBe(source.name);
      expect(entry.envName, key).toBeNull();
      // The snapshot `api` field carries the base URL — shipped verbatim
      // (may be null or non-https; the save flow's base-URL override makes
      // such rows materializable).
      expect(entry.baseUrl, key).toBe(source.api ?? null);
      // The snapshot carries NO protocol field — the ecosystem-norm default.
      expect(entry.api, key).toBe("openai-completions");
      expect(entry.models, key).toEqual(source.model_ids.slice(0, 20));
      expect(entry.doc, key).toBe(source.doc ?? null);
    }
    // The curated workers-ai entry is NOT snapshot-derived — its 8-model
    // vocabulary is preserved verbatim (the model test above pins it).
    expect(PROVIDER_CATALOG["workers-ai"]!.models.length).toBe(8);
  });
});

describe("provider catalog provenance + determinism (plan 38 T3; plan 42 T1 re-target)", () => {
  const repoRoot = join(import.meta.dir, "../..");
  const contractPath = join(repoRoot, "src/contracts/provider-catalog.generated.ts");
  const facePath = join(repoRoot, "src/pipeline/provider-catalog.ts");
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

  test("the generated contract is static pure data — zero imports, zero runtime fetch, snapshot pin disclosed", () => {
    const source = readFileSync(contractPath, "utf8");
    expect(source).not.toMatch(/\bfetch\s*\(/);
    // PURE DATA: the dashboard imports this module (Q2 boundary), so it must
    // not import anything of any kind.
    expect(source).not.toMatch(/^import\s/m);
    expect(source).not.toMatch(/from\s+"[.][.]?\//);
    // The provenance header names the pinned snapshot and the authoring path.
    expect(source).toContain("models.dev-2026-09-04.json");
    expect(source).toContain("DO NOT EDIT BY");
  });

  test("the generated header's skip-count audit names every exclusion rule and its count", () => {
    const source = readFileSync(contractPath, "utf8");
    // 213 snapshot keys → 194 breadth rows; each rule names its skip count.
    expect(source).toContain("213 snapshot keys → 194 breadth template entries");
    expect(source).toMatch(/rule \(a\) excluded as a builtin sourceKey \(18/);
    expect(source).toContain("wafer.ai");
    expect(source).toMatch(/rule \(b\) deduped into a hand-curated template \(1\)/);
    expect(source).toContain("cloudflare-workers-ai → workers-ai");
    expect(source).toMatch(/rule \(c\) skipped, failing CUSTOM_PROVIDER_ID_PATTERN \(0 additional/);
    expect(source).toContain("first 20 model ids per provider");
  });

  test("the pipeline face is the hand-written re-export (contract + review/runtime), not generated output", () => {
    const face = readFileSync(facePath, "utf8");
    // consumer.ts imports providerEnvName / customProviderEnvName from the
    // face — both re-export chains must survive any rewiring.
    expect(face).toContain('export * from "../contracts/provider-catalog.generated"');
    expect(face).toContain('customProviderEnvName,\n} from "../review/runtime"');
    // The face is NOT part of the generated byte-identity compare (below) —
    // it must not claim to be generated.
    expect(face).not.toContain("GENERATED FILE");
  });

  test("regeneration from the committed snapshot is byte-identical — deterministic generation, no hand edits", () => {
    const before = readFileSync(contractPath, "utf8");
    for (let run = 0; run < 2; run++) {
      const proc = Bun.spawnSync(["bun", "scripts/generate-provider-catalog.ts"], {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(proc.exitCode, proc.stderr.toString()).toBe(0);
    }
    const after = readFileSync(contractPath, "utf8");
    try {
      // Both runs reproduce the committed artifact exactly — the committed
      // module stays the single source, generated, never hand-edited. (The
      // hand-written pipeline face is NOT part of this compare.)
      expect(after).toBe(before);
    } finally {
      // Keep the worktree clean even on a drift failure: restore the
      // committed bytes so the diff a reviewer sees is the test's report,
      // not a silently regenerated module.
      if (after !== before) writeFileSync(contractPath, before);
    }
  });
});
