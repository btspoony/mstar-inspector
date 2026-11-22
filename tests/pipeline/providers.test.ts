
import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  PROVIDER_CATALOG,
  PROVIDERS,
  PROVIDER_ENV_NAMES,
  TEMPLATE_PROVIDERS,
  providerEnvName,
} from "../../src/pipeline/provider-catalog";
import {
  LEGACY_PROVIDER_IDS,
  PROVIDER_IDS_BUILTIN,
  PROVIDER_IDS_COMMON,
} from "../../src/contracts/provider-catalog.generated";
import { MODEL_LIMITS, MODEL_LIMITS_SNAPSHOT } from "../../src/contracts/provider-model-limits.generated";
import { CUSTOM_PROVIDER_API_IDS, CUSTOM_PROVIDER_ID_PATTERN } from "../../src/dashboard/app-config-store";
import { PROVIDER_VERIFY_ENDPOINTS } from "../../src/dashboard/provider-verify";
import { buildCatalog } from "../../scripts/generate-provider-catalog";

const REPO_ROOT = join(import.meta.dir, "../..");
const OMP_SNAPSHOT = JSON.parse(
  readFileSync(join(REPO_ROOT, "scripts/provider-catalog/generated/omp-api-key-providers.json"), "utf8"),
) as {
  source: { version: string; extracted: string };
  ownsSnapshotKeys?: string[];
  providers: {
    id: string;
    label: string;
    env: string;
    api: string;
    baseUrl: string | null;
    models: string[];
    sourceProviderId?: string;
  }[];
  ompProviderIds: string[];
  excluded: {
    alias: Record<string, string>;
    nonModel: string[];
    oauthOrDeviceCode: string[];
    notMaterializable: Record<string, string>;
  };
};

const OMP_ROW_IDS = [...new Set(OMP_SNAPSHOT.providers.map((record) => record.sourceProviderId ?? record.id))];

const CATALOG_DIR = join(REPO_ROOT, "scripts/provider-catalog/inputs");
const SNAPSHOT_FILES = readdirSync(CATALOG_DIR).filter((name) => /^models\.dev-\d{4}-\d{2}-\d{2}\.json$/.test(name));
const SNAPSHOT_FILE = [...SNAPSHOT_FILES].sort().at(-1)!;
const SNAPSHOT_PATH = join(CATALOG_DIR, SNAPSHOT_FILE);
const GENERATOR_SOURCE = readFileSync(join(REPO_ROOT, "scripts/generate-provider-catalog.ts"), "utf8");
const BUILTIN_SOURCE_KEYS = [...GENERATOR_SOURCE.matchAll(/sourceKey: "([^"]+)"/g)].map((m) => m[1]!);
const DEDUPED_SNAPSHOT_KEYS = ["cloudflare-workers-ai"];
const SNAPSHOT = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as Record<string, {
  name: string;
  api: string | null;
  doc: string | null;
  model_ids: string[];
}>;
const BREADTH_KEYS = Object.keys(SNAPSHOT).filter(
  (key) =>
    !BUILTIN_SOURCE_KEYS.includes(key) &&
    !DEDUPED_SNAPSHOT_KEYS.includes(key) &&
    !(OMP_SNAPSHOT.ownsSnapshotKeys ?? []).includes(key) &&
    CUSTOM_PROVIDER_ID_PATTERN.test(key),
);

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

  test("ark maps to ARK_API_KEY — the in-image ark base provider's key env (AL-24-5)", () => {
    expect(PROVIDERS["ark"]).toEqual({ envName: "ARK_API_KEY", label: "Ark" });
    expect(providerEnvName("ark")).toBe("ARK_API_KEY");
    expect(Object.keys(PROVIDERS)).toHaveLength(19);
  });
});
describe("provider catalog tiers (spec §5; breadth)", () => {
  test("the catalog is 19 builtin + the full template tier (curated + snapshot breadth + omp union)", () => {
    const builtin = Object.entries(PROVIDER_CATALOG).filter(([, e]) => e.tier === "builtin");
    const template = Object.entries(PROVIDER_CATALOG).filter(([, e]) => e.tier === "template");
    expect(builtin).toHaveLength(19);
    const unionIds = OMP_ROW_IDS;
    for (const id of unionIds) {
      expect(template.map(([entryId]) => entryId), id).toContain(id);
      expect(PROVIDER_CATALOG[id]!.tier, id).toBe("template");
    }
    expect(template).toHaveLength(1 + BREADTH_KEYS.length + unionIds.length);
    expect(Object.keys(PROVIDER_CATALOG)).toHaveLength(19 + template.length);
    expect(Object.keys(PROVIDERS)).toEqual(builtin.map(([id]) => id));
    expect(Object.keys(TEMPLATE_PROVIDERS)).toEqual(template.map(([id]) => id));
  });

  test("PROVIDER_IDS_BUILTIN is the frozen builtin sequence (the pipeline face's PROVIDERS order)", () => {
    expect([...PROVIDER_IDS_BUILTIN]).toEqual(Object.keys(PROVIDERS));
    expect(Object.isFrozen(PROVIDER_IDS_BUILTIN)).toBe(true);
  });

  test("builtin entries carry a non-null envName; template entries carry null (materialized as a custom-provider declaration)", () => {
    for (const [id, entry] of Object.entries(PROVIDER_CATALOG)) {
      if (entry.tier === "builtin") {
        expect(entry.envName, id).not.toBeNull();
        if (entry.api !== null) expect([...CUSTOM_PROVIDER_API_IDS] as string[], id).toContain(entry.api);
      } else {
        expect(entry.envName, id).toBeNull();
        expect(entry.api, id).not.toBeNull();
      }
    }
  });

  test("the console-only builtins carry the declaration prefill the settings face derives from", () => {
    for (const [id, shape] of [
      ["azure-openai", "https://{resource}.openai.azure.com/openai/deployments/{deployment}"],
      ["ai-gateway", "https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway}"],
    ] as const) {
      const entry = PROVIDER_CATALOG[id]!;
      expect(entry.tier, id).toBe("builtin");
      expect(entry.api, id).toBe("openai-completions");
      expect(entry.baseUrl, id).toBe(shape);
    }
  });

  test("a builtin catalog entry carries an `api` prefill exactly where verification is unsupported", () => {
    for (const [id, entry] of Object.entries(PROVIDER_CATALOG)) {
      if (entry.tier !== "builtin") continue;
      expect(entry.api !== null, id).toBe(PROVIDER_VERIFY_ENDPOINTS[id]?.kind === "unsupported");
    }
  });

  test("workers-ai is the template entry with the account-id-templated base URL and the custom-provider convention", () => {
    const entry = PROVIDER_CATALOG["workers-ai"];
    expect(entry).toBeDefined();
    expect(entry!.tier).toBe("template");
    expect(entry!.label).toBe("Cloudflare Workers AI");
    expect(entry!.baseUrl).toBe("https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1");
    expect(entry!.api).toBe("openai-completions");
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

describe("PROVIDER_IDS_COMMON display tier (AD-547)", () => {
  const COMMON_DISPLAY_ORDER = ["anthropic", "openai", "gemini", "copilot", "xai"];

  test("is exactly the 5 locked common ids in the frozen display order", () => {
    expect([...PROVIDER_IDS_COMMON]).toEqual(COMMON_DISPLAY_ORDER);
  });

  test("is a subset of PROVIDER_IDS_BUILTIN — the display tier only regroups builtin entries", () => {
    for (const id of PROVIDER_IDS_COMMON) {
      expect(PROVIDER_IDS_BUILTIN.includes(id), id).toBe(true);
    }
  });

  test("is a frozen array (readonly surface)", () => {
    expect(Object.isFrozen(PROVIDER_IDS_COMMON)).toBe(true);
  });

  test("carries zero runner semantics — the BYOK allowlist surfaces and entry shape are untouched", () => {
    expect(PROVIDER_IDS_BUILTIN).toHaveLength(19);
    expect(PROVIDER_ENV_NAMES).toHaveLength(19);
    for (const [id, entry] of Object.entries(PROVIDER_CATALOG)) {
      const expected =
        entry.protocols === undefined
          ? ["api", "baseUrl", "doc", "envName", "label", "models", "tier"]
          : ["api", "baseUrl", "doc", "envName", "label", "models", "protocols", "tier"];
      expect(Object.keys(entry).sort(), id).toEqual(expected);
    }
  });
});

describe("provider catalog breadth enumeration (spec § Providers contract 2)", () => {
  const repoRoot = join(import.meta.dir, "../..");
  const generatorPath = join(repoRoot, "scripts/generate-provider-catalog.ts");
  const snapshot = SNAPSHOT;
  const generatorSource = GENERATOR_SOURCE;
  const builtinSourceKeys = BUILTIN_SOURCE_KEYS;
  const dedupedSnapshotKeys = DEDUPED_SNAPSHOT_KEYS;

  test("the generator's id-pattern copy is byte-equal to the dashboard CUSTOM_PROVIDER_ID_PATTERN", () => {
    expect(generatorSource).toContain(`/${CUSTOM_PROVIDER_ID_PATTERN.source}/`);
  });

  test("every snapshot key is exactly one of: breadth template row, builtin sourceKey, dedupe, or id-grammar skip", () => {
    const templateIds = new Set(Object.keys(TEMPLATE_PROVIDERS));
    const expectedBreadth = BREADTH_KEYS;
    for (const key of [...builtinSourceKeys, ...dedupedSnapshotKeys]) {
      expect(templateIds.has(key), key).toBe(false);
    }
    for (const key of expectedBreadth) {
      expect(templateIds.has(key), key).toBe(true);
      expect(PROVIDER_CATALOG[key]!.tier, key).toBe("template");
    }
    expect(templateIds.size).toBe(BREADTH_KEYS.length + 1 + OMP_ROW_IDS.length);
  });

  test("snapshot-derived entries follow the breadth mapping (label/baseUrl/api/models/doc, full model vocabulary)", () => {
    const expectedBreadth = BREADTH_KEYS;
    for (const key of expectedBreadth) {
      const source = snapshot[key]!;
      const entry = PROVIDER_CATALOG[key]!;
      expect(entry.label, key).toBe(source.name);
      expect(entry.envName, key).toBeNull();
      expect(entry.baseUrl, key).toBe(source.api ?? null);
      expect(entry.api, key).toBe("openai-completions");
      expect(entry.models, key).toEqual(source.model_ids);
      expect(entry.doc, key).toBe(source.doc ?? null);
    }
    expect(PROVIDER_CATALOG["workers-ai"]!.models.length).toBe(8);
  });
});

describe("provider catalog provenance + determinism (post-breadth re-target)", () => {
  const repoRoot = join(import.meta.dir, "../..");
  const contractPath = join(repoRoot, "src/contracts/provider-catalog.generated.ts");
  const facePath = join(repoRoot, "src/pipeline/provider-catalog.ts");
  const generatorPath = join(repoRoot, "scripts/generate-provider-catalog.ts");
  test("the committed models.dev snapshot is present, parseable, and the generator's only input", () => {
    const snapshot = SNAPSHOT as Record<string, unknown>;
    expect(Object.keys(snapshot).length).toBeGreaterThan(0);
    const generator = readFileSync(generatorPath, "utf8");
    expect(SNAPSHOT_FILES).toHaveLength(1);
    const pinnedDate = SNAPSHOT_FILE.replace(/^models\.dev-/, "").replace(/\.json$/, "");
    expect(pinnedDate).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(generator).not.toMatch(/const SNAPSHOT_DATE =/);
    expect(generator).toContain('from "./provider-catalog/lib/snapshot"');
    expect(generator).not.toMatch(/\bfetch\s*\(/);
  });

  test("the generated contract is static pure data — zero imports, zero runtime fetch, snapshot pin disclosed", () => {
    const source = readFileSync(contractPath, "utf8");
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/^import\s/m);
    expect(source).not.toMatch(/from\s+"[.][.]?\//);
    expect(source).toContain(SNAPSHOT_FILE);
    expect(source).toContain("DO NOT EDIT BY");
  });

  test("the generated header's skip-count audit names every exclusion rule and its count", () => {
    const source = readFileSync(contractPath, "utf8");
    expect(source).toContain(`${Object.keys(SNAPSHOT).length} snapshot keys → ${BREADTH_KEYS.length} breadth template entries`);
    expect(source).toMatch(/rule \(a\) excluded as a builtin sourceKey \(18/);
    expect(source).toContain("wafer.ai");
    expect(source).toMatch(/rule \(b\) deduped into a hand-curated template \(1\)/);
    expect(source).toContain("cloudflare-workers-ai → workers-ai");
    expect(source).toMatch(/rule \(c\) skipped, failing CUSTOM_PROVIDER_ID_PATTERN \(0 additional/);
  });

  test("the pipeline face is the hand-written re-export (contract only), not generated output", () => {
    const face = readFileSync(facePath, "utf8");
    expect(face).toContain('export * from "../contracts/provider-catalog.generated"');
    expect(face).not.toContain("customProviderEnvName");
    expect(face).not.toContain("CUSTOM_PROVIDER_ENV");
    expect(face).not.toContain("GENERATED FILE");
  });

  test("regeneration from the committed snapshot is byte-identical — deterministic generation, no hand edits", () => {
    const limitsPath = join(repoRoot, "src/contracts/provider-model-limits.generated.ts");
    const before = readFileSync(contractPath, "utf8");
    const beforeLimits = readFileSync(limitsPath, "utf8");
    for (let run = 0; run < 2; run++) {
      const proc = Bun.spawnSync(["bun", "scripts/generate-provider-catalog.ts"], {
        cwd: repoRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(proc.exitCode, proc.stderr.toString()).toBe(0);
    }
    const after = readFileSync(contractPath, "utf8");
    const afterLimits = readFileSync(limitsPath, "utf8");
    try {
      expect(after).toBe(before);
      expect(afterLimits).toBe(beforeLimits);
    } finally {
      if (after !== before) writeFileSync(contractPath, before);
      if (afterLimits !== beforeLimits) writeFileSync(limitsPath, beforeLimits);
    }
  });
});

describe("generator breadth-collision guard (audit DEBT-46-05)", () => {
  const repoRoot = join(import.meta.dir, "../..");
  const snapshot = JSON.parse(readFileSync(SNAPSHOT_PATH, "utf8")) as Record<
    string,
    { id: string; name: string; env: string[]; api: string | null; doc: string | null; model_ids: string[] }
  >;
  const seeded = (key: string, name: string) => ({
    ...snapshot,
    [key]: { id: key, name, env: [], api: null, doc: null, model_ids: ["fake-model"] },
  });

  test("a snapshot key colliding with a builtin id throws naming the key, the shadowed entry, and the remediation", () => {
    expect(() => buildCatalog(seeded("gemini", "Gemini Impersonator"))).toThrow(
      'snapshot key "gemini" would overwrite the existing builtin entry "Google Gemini"',
    );
  });

  test("a snapshot key colliding with the curated workers-ai template throws the same way", () => {
    expect(() => buildCatalog(seeded("workers-ai", "Workers AI Impersonator"))).toThrow(
      'snapshot key "workers-ai" would overwrite the existing template entry "Cloudflare Workers AI"',
    );
  });

  test("a prototype-chain key (constructor) does not false-positive the guard and lands in the catalog", () => {
    const { catalog, audit } = buildCatalog(seeded("constructor", "Constructor Impersonator"), OMP_SNAPSHOT);
    const entry = catalog["constructor"] as { tier: string; label: string };
    expect(Object.hasOwn(catalog, "constructor")).toBe(true);
    expect(entry.tier).toBe("template");
    expect(entry.label).toBe("Constructor Impersonator");
    expect(audit.breadthCount).toBe(BREADTH_KEYS.length + 1);
  });

  test("the guard is unreachable with the committed snapshot (audit: no collision today)", () => {
    const { catalog, audit } = buildCatalog(snapshot);
    const snapshotOnlyBreadth = BREADTH_KEYS.length + (OMP_SNAPSHOT.ownsSnapshotKeys ?? []).length;
    expect(Object.keys(catalog)).toHaveLength(19 + 1 + snapshotOnlyBreadth);
    expect(audit.breadthCount).toBe(snapshotOnlyBreadth);
  });
});

describe("omp provider union (third generator input)", () => {
  const unionIds = OMP_ROW_IDS;
  const snapshotOnly = JSON.parse(
    readFileSync(SNAPSHOT_PATH, "utf8"),
  ) as Record<string, never>;
  const groups = new Map<string, typeof OMP_SNAPSHOT.providers>();
  for (const record of OMP_SNAPSHOT.providers) {
    const providerId = record.sourceProviderId ?? record.id;
    groups.set(providerId, [...(groups.get(providerId) ?? []), record]);
  }

  test("every provider group is exactly ONE template row under the provider id, carrying its default protocol", () => {
    for (const [providerId, records] of groups) {
      const entry = PROVIDER_CATALOG[providerId];
      expect(entry, providerId).toBeDefined();
      expect(entry!.tier, providerId).toBe("template");
      expect(entry!.envName, providerId).toBeNull();
      expect(CUSTOM_PROVIDER_ID_PATTERN.test(providerId), providerId).toBe(true);
      const defaultRecord = records.find((record) => record.id === providerId) ?? records[0]!;
      expect([...CUSTOM_PROVIDER_API_IDS] as string[], providerId).toContain(defaultRecord.api);
      expect(entry!.api, providerId).toBe(defaultRecord.api);
      expect(entry!.baseUrl, providerId).toBe(defaultRecord.baseUrl);
      expect(entry!.label, providerId).toBe(defaultRecord.label);
      expect(entry!.label.length, providerId).toBeGreaterThan(0);
      expect(entry!.models, providerId).toEqual(defaultRecord.models);
      for (const record of records) {
        if (record.id === providerId) continue;
        expect(Object.hasOwn(PROVIDER_CATALOG, record.id), record.id).toBe(false);
      }
    }
  });

  test("a label carries no protocol suffix — the protocol is a row option, not part of the name", () => {
    for (const [providerId, records] of groups) {
      const label = PROVIDER_CATALOG[providerId]!.label;
      for (const record of records) {
        expect(label, record.id).not.toContain(record.api);
      }
    }
  });

  test("protocols carry every materializable protocol, the default FIRST, the rest in api order", () => {
    let multiProtocolGroups = 0;
    for (const [providerId, records] of groups) {
      const entry = PROVIDER_CATALOG[providerId]!;
      const apis = records.map((record) => record.api);
      if (records.length === 1) {
        expect(entry.protocols, providerId).toBeUndefined();
        continue;
      }
      multiProtocolGroups += 1;
      const options = entry.protocols!;
      expect(options, providerId).toHaveLength(records.length);
      expect(entry.api, providerId).toBe(options[0]!.api);
      expect(options[0]!.baseUrl, providerId).toBe(entry.baseUrl);
      expect(options[0]!.models, providerId).toEqual(entry.models);
      expect([...options.map((option) => option.api)].sort(), providerId).toEqual([...apis].sort());
      const rest = options.slice(1).map((option) => option.api);
      expect(rest, providerId).toEqual([...rest].sort());
      for (const option of options) {
        const record = records.find((candidate) => candidate.api === option.api)!;
        expect(option.baseUrl, `${providerId}/${option.api}`).toBe(record.baseUrl);
        expect(option.models, `${providerId}/${option.api}`).toEqual(record.models);
      }
    }
    expect(multiProtocolGroups).toBeGreaterThan(0);
  });

  test("the collapsed record ids map back to the provider row that absorbed them", () => {
    const expected: Record<string, string> = {};
    for (const record of OMP_SNAPSHOT.providers) {
      const providerId = record.sourceProviderId ?? record.id;
      if (record.id === providerId) continue;
      expected[record.id] = providerId;
    }
    expect(Object.keys(expected).length).toBeGreaterThan(0);
    expect({ ...LEGACY_PROVIDER_IDS }).toEqual(expected);
    expect(Object.isFrozen(LEGACY_PROVIDER_IDS)).toBe(true);
  });

  test("an owned models.dev key is only taken over when a materializable record replaces it", () => {
    const owned = OMP_SNAPSHOT.ownsSnapshotKeys ?? [];
    expect(owned.length).toBeGreaterThan(0);
    for (const key of owned) {
      const replacement = OMP_SNAPSHOT.providers.filter(
        (record) => record.id === key || record.sourceProviderId === key,
      );
      expect(replacement.length, key).toBeGreaterThan(0);
      expect(PROVIDER_CATALOG[key], key).toBeDefined();
      expect(PROVIDER_CATALOG[key]!.tier, key).toBe("template");
    }
    expect(owned).not.toContain("google-vertex");
    expect(PROVIDER_CATALOG["google-vertex"]).toMatchObject({
      tier: "template",
      baseUrl: SNAPSHOT["google-vertex"]!.api ?? null,
      api: "openai-completions",
    });
  });

  test("the union adds no builtin row — the runner allowlist stays at 19", () => {
    expect(PROVIDER_IDS_BUILTIN).toHaveLength(19);
    for (const id of unionIds) {
      expect(PROVIDER_IDS_BUILTIN as readonly string[], id).not.toContain(id);
      expect(providerEnvName(id), id).toBeUndefined();
    }
  });

  test("the union pass skips a record whose id is already a catalog row", () => {
    const { catalog, audit } = buildCatalog(snapshotOnly, {
      source: OMP_SNAPSHOT.source,
      ompProviderIds: ["anthropic"],
      excluded: { alias: {}, nonModel: [], oauthOrDeviceCode: [], notMaterializable: {} },
      providers: [
        {
          id: "anthropic",
          label: "Impostor",
          env: "IMPOSTOR_API_KEY",
          baseUrl: null,
          api: "openai-completions",
          models: [],
        },
      ],
    });
    expect((catalog["anthropic"] as { tier: string }).tier).toBe("builtin");
    expect(audit.ompAlreadyPresent).toContain("anthropic");
    expect(audit.ompRowCount).toBe(0);
  });

  test("an alias whose target is not a catalog row throws instead of silently dropping the provider", () => {
    expect(() =>
      buildCatalog(snapshotOnly, {
        source: OMP_SNAPSHOT.source,
        ompProviderIds: ["moonshot"],
        excluded: { alias: { moonshot: "moonshot-ai-retired" }, nonModel: [], oauthOrDeviceCode: [], notMaterializable: {} },
        providers: [],
      }),
    ).toThrow(
      'omp provider "moonshot" aliases "moonshot-ai-retired", which is not a catalog row — fix scripts/provider-catalog/generated/omp-api-key-providers.json',
    );
    const { catalog, audit } = buildCatalog(snapshotOnly, {
      source: OMP_SNAPSHOT.source,
      ompProviderIds: ["moonshot"],
      excluded: { alias: { moonshot: "moonshotai" }, nonModel: [], oauthOrDeviceCode: [], notMaterializable: {} },
      providers: [],
    });
    expect(Object.hasOwn(catalog, "moonshot")).toBe(false);
    expect(audit.ompAliasSkips).toEqual(["moonshot → moonshotai"]);
  });
});

describe("per-model size table (provider-model-limits.generated)", () => {
  const repoRoot = join(import.meta.dir, "../..");
  const limitsPath = join(repoRoot, "src/contracts/provider-model-limits.generated.ts");

  test("the table is non-empty, frozen, and every entry carries two positive integer token counts", () => {
    expect(Object.isFrozen(MODEL_LIMITS)).toBe(true);
    const providerIds = Object.keys(MODEL_LIMITS);
    expect(providerIds.length).toBeGreaterThan(0);
    let entries = 0;
    for (const [providerId, row] of Object.entries(MODEL_LIMITS)) {
      expect(Object.keys(row).length, providerId).toBeGreaterThan(0);
      for (const [modelId, size] of Object.entries(row)) {
        entries += 1;
        expect(Number.isInteger(size.contextWindow), `${providerId}/${modelId} contextWindow`).toBe(true);
        expect(Number.isInteger(size.maxTokens), `${providerId}/${modelId} maxTokens`).toBe(true);
        expect(size.contextWindow, `${providerId}/${modelId}`).toBeGreaterThan(0);
        expect(size.maxTokens, `${providerId}/${modelId}`).toBeGreaterThan(0);
      }
    }
    expect(entries).toBeGreaterThan(0);
  });

  test("the snapshot constant is a date and names the committed snapshot file", () => {
    expect(MODEL_LIMITS_SNAPSHOT).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    expect(SNAPSHOT_FILE).toBe(`models.dev-${MODEL_LIMITS_SNAPSHOT}.json`);
  });

  test("every catalog provider id resolves in the table or is named in the explicit skip list", () => {
    const SKIPPED_PROVIDERS = new Set([
      "cursor",
      ...OMP_ROW_IDS.filter((id) => !Object.hasOwn(SNAPSHOT, id)),
    ]);
    const missing = Object.keys(PROVIDER_CATALOG)
      .filter((id) => !Object.hasOwn(MODEL_LIMITS, id))
      .sort();
    expect(missing).toEqual([...SKIPPED_PROVIDERS].sort());
    for (const id of Object.keys(PROVIDER_CATALOG)) {
      expect(Object.hasOwn(MODEL_LIMITS, id) || SKIPPED_PROVIDERS.has(id), id).toBe(true);
    }
    const skipHits = Object.keys(MODEL_LIMITS).filter((id) => SKIPPED_PROVIDERS.has(id));
    expect(skipHits).toEqual([]);
  });

  test("a merged provider row draws sizes from the models.dev key its id names, over every protocol's vocabulary", () => {
    const owned = OMP_SNAPSHOT.ownsSnapshotKeys ?? [];
    expect(owned.length).toBeGreaterThan(0);
    for (const key of owned) {
      const entry = PROVIDER_CATALOG[key]!;
      const row = MODEL_LIMITS[key];
      expect(row, key).toBeDefined();
      const sizes = Object.keys(row!);
      expect(sizes.length, key).toBeGreaterThan(0);
      const vocabulary = [...entry.models, ...(entry.protocols ?? []).flatMap((option) => option.models)];
      for (const modelId of sizes) expect(vocabulary, `${key}/${modelId}`).toContain(modelId);
      if (entry.protocols !== undefined) {
        const secondary = new Set(entry.protocols.slice(1).flatMap((option) => option.models));
        expect(sizes.some((modelId) => secondary.has(modelId)), key).toBe(true);
      }
    }
  });

  test("the table carries no model id its catalog entry does not list", () => {
    for (const [providerId, row] of Object.entries(MODEL_LIMITS)) {
      expect(PROVIDER_CATALOG[providerId], providerId).toBeDefined();
      const entry = PROVIDER_CATALOG[providerId]!;
      const vocabulary = [...entry.models, ...(entry.protocols ?? []).flatMap((option) => option.models)];
      for (const modelId of Object.keys(row)) {
        expect(vocabulary, `${providerId}/${modelId}`).toContain(modelId);
      }
    }
  });

  test("the generated table is static pure data naming its snapshot and authoring path", () => {
    const source = readFileSync(limitsPath, "utf8");
    expect(source).not.toMatch(/\bfetch\s*\(/);
    expect(source).not.toMatch(/^import\s/m);
    expect(source).toContain(SNAPSHOT_FILE);
    expect(source).toContain("DO NOT EDIT BY");
  });
});
