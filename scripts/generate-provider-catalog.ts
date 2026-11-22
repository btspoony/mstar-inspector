/**
 * Author-time generator for `src/contracts/provider-catalog.generated.ts`
 * (spec §5 — architect-locked form).
 *
 * The catalog is a compile-time static module: the Worker, the dashboard,
 * and the sandbox image only ever import the committed artifact — zero
 * runtime network, zero ai-sdk runtime dependencies. This script is the
 * ONLY authoring path; the committed module is the SSOT and regeneration is
 * an explicit, reviewable commit (spec §5 version discipline). The module
 * lands in src/contracts/ (not src/pipeline/) because the dashboard imports
 * it directly and dashboard modules must not import pipeline code (Q2 — the
 * pipeline face at src/pipeline/provider-catalog.ts re-exports the contract
 * for pipeline consumers; the sandbox image copies only
 * packages/{shared,runner}/src).
 *
 * Inputs (three pinned):
 *   1. `scripts/provider-catalog/inputs/models.dev-<date>.json` — a trimmed snapshot
 *      of the ai-sdk ecosystem directory dataset (models.dev, fetched from
 *      https://models.dev/api.json by `scripts/provider-catalog/fetch-models-dev.ts`
 *      and trimmed to the fields this generator consumes: id / name / env /
 *      api / doc / model_ids / limits). The newest dated file is the one read
 *      (ISO names sort lexicographically; exactly one is committed), and the
 *      fetch date it carries is the pin regeneration reports. In this snapshot
 *      the `api` field carries the provider's default base URL and `limits`
 *      carries every model's `{context, output}` token sizes.
 *   2. The omp-facing override table below — the SSOT for the runner
 *      contract: the 19 builtin ids in mapping order, their labels (the
 *      existing picker labels) and their env-name injection names (omp's
 *      built-in provider discovery, WF-004 — NOT models.dev's env arrays,
 *      which differ for e.g. `zai` (ZHIPU_API_KEY) and `gemini`
 *      (GEMINI_API_KEY)). models.dev fills the ecosystem metadata (default
 *      base URL, representative model ids, docs) for every id it carries;
 *      ids it lacks (cursor) get local metadata.
 *   3. The hand-curated `workers-ai` template — preserved verbatim; the
 *      snapshot's `cloudflare-workers-ai` row is deduped into it.
 *   4. `scripts/provider-catalog/generated/omp-api-key-providers.json` — a vendored
 *      snapshot of the omp SDK's API-key LLM providers (version, extraction
 *      date and extraction rules in its own header). It supplies provider
 *      breadth the models.dev snapshot lacks; every surviving record lands
 *      as a `template` row, so the runner allowlist never changes.
 *
 * Breadth enumeration (spec § Providers contract item 2): beyond
 * the pinned tiers above, EVERY remaining snapshot key becomes a `template`
 * entry — deterministic, auditable skips only (each rule and its skip count
 * are named in the generated file's header comment):
 *   (a) snapshot keys consumed as a builtin `sourceKey` — excluded so no
 *       duplicate vendor row appears beside the builtin tier (e.g. a
 *       `google` template next to the `gemini` builtin);
 *   (b) keys deduped into a hand-curated template (`cloudflare-workers-ai`
 *       → the verbatim `workers-ai` entry);
 *   (c) ids failing CUSTOM_PROVIDER_ID_PATTERN
 *       (`/^[a-z0-9][a-z0-9-]{0,63}$/`) — a template id materializes into
 *       a custom-provider declaration, so it must satisfy the same grammar;
 *       counted separately in the header.
 *
 * Outputs (one run, two artifacts):
 *   1. `src/contracts/provider-catalog.generated.ts` — the catalog.
 *   2. `src/contracts/provider-model-limits.generated.ts` — the per-model
 *      size table (context window / max output), restricted to the provider
 *      and model ids artifact 1 lists, so an operator's blank size field can
 *      be filled from the directory instead of retyped.
 *
 * Generation-time dependencies: NONE beyond Node builtins + the two vendored
 * snapshots (the "exact-pin" requirement is satisfied by the dated snapshot;
 * no npm package is installed for generation).
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { readdir } from "node:fs/promises";
import { INPUTS_DIR, pickNewestSnapshot } from "./provider-catalog/lib/snapshot";

const OMP_SNAPSHOT_PATH = path.resolve("scripts/provider-catalog/generated/omp-api-key-providers.json");
const OUT_PATH = path.resolve("src/contracts/provider-catalog.generated.ts");
const OUT_LIMITS_PATH = path.resolve("src/contracts/provider-model-limits.generated.ts");

type SnapshotLimit = { context?: number; output?: number };

type SnapshotProvider = {
  id: string;
  name: string;
  env: string[];
  api: string | null;
  doc: string | null;
  model_ids: string[];
  limits?: Record<string, SnapshotLimit>;
};

type ModelLimit = { contextWindow: number; maxTokens: number };

type OmpSnapshot = {
  source: {
    version: string;
    extracted: string;
    overrides?: {
      provider: string;
      bucket: string;
      record: string;
      models: number;
      source: string;
      fetched: string;
    }[];
  };
  providers: {
    id: string;
    label: string;
    env: string;
    baseUrl: string | null;
    api: string;
    models: string[];
    sourceProviderId?: string;
  }[];
  ompProviderIds: string[];
  ownsSnapshotKeys?: string[];
  excluded: {
    alias: Record<string, string>;
    nonModel: string[];
    oauthOrDeviceCode: string[];
    notMaterializable: Record<string, string>;
  };
};

type BuiltinSpec = {
  id: string;
  sourceKey?: string;
  label: string;
  envName: string;
  baseUrl?: string | null;
  api?: string;
  doc?: string | null;
  modelCount?: number;
};

const BUILTIN_ORDER: BuiltinSpec[] = [
  { id: "anthropic", sourceKey: "anthropic", label: "Anthropic", envName: "ANTHROPIC_API_KEY" },
  { id: "openai", sourceKey: "openai", label: "OpenAI", envName: "OPENAI_API_KEY" },
  { id: "gemini", sourceKey: "google", label: "Google Gemini", envName: "GEMINI_API_KEY" },
  { id: "copilot", sourceKey: "github-copilot", label: "GitHub Copilot", envName: "COPILOT_GITHUB_TOKEN" },
  {
    id: "azure-openai",
    sourceKey: "azure",
    label: "Azure OpenAI",
    envName: "AZURE_OPENAI_API_KEY",
    baseUrl: "https://{resource}.openai.azure.com/openai/deployments/{deployment}",
    api: "openai-completions",
  },
  { id: "groq", sourceKey: "groq", label: "Groq", envName: "GROQ_API_KEY" },
  { id: "cerebras", sourceKey: "cerebras", label: "Cerebras", envName: "CEREBRAS_API_KEY" },
  { id: "xai", sourceKey: "xai", label: "xAI", envName: "XAI_API_KEY" },
  { id: "openrouter", sourceKey: "openrouter", label: "OpenRouter", envName: "OPENROUTER_API_KEY" },
  { id: "kilo", sourceKey: "kilo", label: "Kilo", envName: "KILO_API_KEY" },
  { id: "mistral", sourceKey: "mistral", label: "Mistral", envName: "MISTRAL_API_KEY" },
  { id: "zai", sourceKey: "zai", label: "Z.AI", envName: "ZAI_API_KEY" },
  { id: "umans", sourceKey: "umans-ai-coding-plan", label: "Umans AI Coding Plan", envName: "UMANS_AI_CODING_PLAN_API_KEY" },
  { id: "minimax", sourceKey: "minimax", label: "MiniMax", envName: "MINIMAX_API_KEY" },
  { id: "opencode", sourceKey: "opencode", label: "OpenCode", envName: "OPENCODE_API_KEY" },
  { id: "cursor", label: "Cursor", envName: "CURSOR_ACCESS_TOKEN", baseUrl: null, doc: "https://cursor.com/docs/api/overview" },
  {
    id: "ai-gateway",
    sourceKey: "cloudflare-ai-gateway",
    label: "AI Gateway",
    envName: "AI_GATEWAY_API_KEY",
    baseUrl: "https://gateway.ai.cloudflare.com/v1/{account_id}/{gateway}",
    api: "openai-completions",
  },
  { id: "wafer-serverless", sourceKey: "wafer.ai", label: "Wafer Serverless", envName: "WAFER_SERVERLESS_API_KEY" },
  { id: "ark", sourceKey: "volcengine", label: "Ark", envName: "ARK_API_KEY" },
];

const COMMON_PROVIDER_IDS: readonly string[] = ["anthropic", "openai", "gemini", "copilot", "xai"];

const builtinIds = BUILTIN_ORDER.map((spec) => spec.id);
if (
  new Set(COMMON_PROVIDER_IDS).size !== COMMON_PROVIDER_IDS.length ||
  COMMON_PROVIDER_IDS.some((id) => !builtinIds.includes(id))
) {
  throw new Error(
    `COMMON_PROVIDER_IDS must be a duplicate-free subset of the BUILTIN_ORDER ids — got ${JSON.stringify([...COMMON_PROVIDER_IDS])}`,
  );
}

const TEMPLATES: Record<string, { label: string; baseUrl: string; api: string; models: string[]; doc: string }> = {
  "workers-ai": {
    label: "Cloudflare Workers AI",
    baseUrl: "https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1",
    api: "openai-completions",
    models: [
      "@cf/meta/llama-3.3-70b-instruct-fp8-fast",
      "@cf/meta/llama-4-scout-17b-16e-instruct",
      "@cf/qwen/qwen3-30b-a3b-fp8",
      "@cf/qwen/qwen2.5-coder-32b-instruct",
      "@cf/deepseek-ai/deepseek-v4-flash-0731",
      "@cf/deepseek-ai/deepseek-r1-distill-qwen-32b",
      "@cf/google/gemma-4-26b-a4b-it",
      "@cf/mistralai/mistral-small-3.1-24b-instruct",
    ],
    doc: "https://developers.cloudflare.com/workers-ai/models/",
  },
};

const TEMPLATE_DEDUPE_SNAPSHOT_KEYS: Record<string, string> = {
  "cloudflare-workers-ai": "workers-ai",
};

const CUSTOM_PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;


type BreadthAudit = {
  excludedSourceKeys: string[];
  dedupedKeys: string[];
  idPatternFails: string[];
  breadthCount: number;
  ompAlreadyPresent: string[];
  ompAliasSkips: string[];
  ompNonModel: string[];
  ompNotMaterializable: string[];
  ompRowCount: number;
  ompOwnedKeys: string[];
};

const MATERIALIZABLE_APIS: readonly string[] = [
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "typesafe",
];

const ALLOWED_URL_PLACEHOLDERS: Record<string, true> = { account_id: true };

/** Pure catalog builder — exported so the collision guard is testable
 *  (tests/pipeline/providers.test.ts) without file I/O or spawning the
 *  writer; the authoring path below is the only caller with side effects. */
export function buildCatalog(
  snapshot: Record<string, SnapshotProvider>,
  omp?: OmpSnapshot,
): {
  catalog: Record<string, unknown>;
  audit: BreadthAudit;
  sources: Record<string, string>;
  legacy: Record<string, string>;
} {
  const catalog: Record<string, unknown> = {};
  const legacy: Record<string, string> = {};
  const sources: Record<string, string> = {};
  for (const spec of BUILTIN_ORDER) {
    const source = spec.sourceKey === undefined ? undefined : snapshot[spec.sourceKey];
    if (spec.sourceKey !== undefined && source === undefined) {
      throw new Error(`snapshot is missing source key ${JSON.stringify(spec.sourceKey)} — stale snapshot?`);
    }
    if (spec.sourceKey !== undefined) sources[spec.id] = spec.sourceKey;
    const sourceModels = source?.model_ids ?? [];
    const models = spec.modelCount === undefined ? sourceModels : sourceModels.slice(0, spec.modelCount);
    catalog[spec.id] = {
      label: spec.label,
      tier: "builtin",
      envName: spec.envName,
      baseUrl: spec.baseUrl !== undefined ? spec.baseUrl : (source?.api ?? null),
      api: spec.api ?? null,
      models,
      doc: spec.doc !== undefined ? spec.doc : (source?.doc ?? null),
    };
  }
  for (const [id, tpl] of Object.entries(TEMPLATES)) {
    catalog[id] = {
      label: tpl.label,
      tier: "template",
      envName: null,
      baseUrl: tpl.baseUrl,
      api: tpl.api,
      models: tpl.models,
      doc: tpl.doc,
    };
  }
  for (const [snapshotKey, catalogId] of Object.entries(TEMPLATE_DEDUPE_SNAPSHOT_KEYS)) {
    if (Object.hasOwn(catalog, catalogId) && !Object.hasOwn(sources, catalogId) && Object.hasOwn(snapshot, snapshotKey)) {
      sources[catalogId] = snapshotKey;
    }
  }
  const builtinSourceKeys = new Set(
    BUILTIN_ORDER.filter((spec) => spec.sourceKey !== undefined).map((spec) => spec.sourceKey!),
  );
  const audit: BreadthAudit = {
    excludedSourceKeys: [],
    dedupedKeys: [],
    idPatternFails: [],
    breadthCount: 0,
    ompAlreadyPresent: [],
    ompAliasSkips: [],
    ompNonModel: [],
    ompNotMaterializable: [],
    ompRowCount: 0,
    ompOwnedKeys: [],
  };
  for (const [key, source] of Object.entries(snapshot)) {
    if (builtinSourceKeys.has(key)) {
      audit.excludedSourceKeys.push(key);
      continue;
    }
    if (Object.hasOwn(TEMPLATE_DEDUPE_SNAPSHOT_KEYS, key)) {
      audit.dedupedKeys.push(key);
      continue;
    }
    if (omp !== undefined && (omp.ownsSnapshotKeys ?? []).includes(key)) {
      audit.ompOwnedKeys.push(key);
      continue;
    }
    if (!CUSTOM_PROVIDER_ID_PATTERN.test(key)) {
      audit.idPatternFails.push(key);
      continue;
    }
    if (Object.hasOwn(catalog, key)) {
      const shadowed = catalog[key] as { tier: string; label: string };
      throw new Error(
        `snapshot key ${JSON.stringify(key)} would overwrite the existing ${shadowed.tier} entry ${JSON.stringify(shadowed.label)} — extend the exclusion/dedupe tables in this generator or fix the snapshot`,
      );
    }
    sources[key] = key;
    catalog[key] = {
      label: source.name,
      tier: "template",
      envName: null,
      baseUrl: source.api ?? null,
      api: "openai-completions",
      models: source.model_ids,
      doc: source.doc ?? null,
    };
    audit.breadthCount += 1;
  }
  if (omp !== undefined) {
    const catalogBeforeUnion: Record<string, true> = {};
    for (const id of Object.keys(catalog)) catalogBeforeUnion[id] = true;
    for (const key of builtinSourceKeys) catalogBeforeUnion[key] = true;
    for (const key of Object.keys(TEMPLATE_DEDUPE_SNAPSHOT_KEYS)) catalogBeforeUnion[key] = true;
    const recordsByProvider: Record<string, OmpSnapshot["providers"]> = {};
    const recordIds = new Set<string>();
    for (const record of omp.providers) {
      if (recordIds.has(record.id)) {
        throw new Error(
          `vendored omp snapshot carries duplicate record id ${JSON.stringify(record.id)} — fix scripts/provider-catalog/generated/omp-api-key-providers.json`,
        );
      }
      recordIds.add(record.id);
      const providerId = record.sourceProviderId ?? record.id;
      (recordsByProvider[providerId] ??= []).push(record);
    }
    const ompProviderIdSet = new Set(omp.ompProviderIds);
    for (const providerId of Object.keys(recordsByProvider)) {
      if (!ompProviderIdSet.has(providerId)) {
        throw new Error(
          `vendored omp record ${JSON.stringify(providerId)} is absent from ompProviderIds — list it in scripts/provider-catalog/generated/omp-api-key-providers.json`,
        );
      }
    }
    for (const providerId of omp.ompProviderIds) {
      const records = recordsByProvider[providerId] ?? [];
      if (records.length === 0) {
        if (Object.hasOwn(catalogBeforeUnion, providerId)) audit.ompAlreadyPresent.push(providerId);
        else if (Object.hasOwn(omp.excluded.alias, providerId)) {
          const target = omp.excluded.alias[providerId]!;
          if (!Object.hasOwn(catalogBeforeUnion, target)) {
            throw new Error(
              `omp provider ${JSON.stringify(providerId)} aliases ${JSON.stringify(target)}, which is not a catalog row — fix scripts/provider-catalog/generated/omp-api-key-providers.json`,
            );
          }
          audit.ompAliasSkips.push(`${providerId} → ${target}`);
        } else if (omp.excluded.nonModel.includes(providerId)) audit.ompNonModel.push(providerId);
        else if (omp.excluded.oauthOrDeviceCode.includes(providerId)) {
          audit.ompNotMaterializable.push(`${providerId} (oauth/device-code login)`);
        } else if (Object.hasOwn(omp.excluded.notMaterializable, providerId)) {
          audit.ompNotMaterializable.push(
            `${providerId} (${omp.excluded.notMaterializable[providerId]})`,
          );
        } else {
          throw new Error(
            `omp provider ${JSON.stringify(providerId)} has no vendored record and no exclusion rule — classify it in scripts/provider-catalog/generated/omp-api-key-providers.json`,
          );
        }
        continue;
      }
      const decisions = records.map((record) => {
        if (Object.hasOwn(catalog, record.id)) return { record, skip: { kind: "already" as const } };
        if (record.env.trim() === "") return { record, skip: { kind: "nonModel" as const } };
        if (!CUSTOM_PROVIDER_ID_PATTERN.test(record.id)) {
          return { record, skip: { kind: "notMaterializable" as const, detail: "id grammar" } };
        }
        if (!MATERIALIZABLE_APIS.includes(record.api)) {
          return { record, skip: { kind: "notMaterializable" as const, detail: `protocol ${record.api}` } };
        }
        const placeholders = [...(record.baseUrl ?? "").matchAll(/\{([^}]+)\}/g)].map((m) => m[1]!);
        if (placeholders.some((name) => !Object.hasOwn(ALLOWED_URL_PLACEHOLDERS, name))) {
          return {
            record,
            skip: { kind: "notMaterializable" as const, detail: `url placeholder ${placeholders.join(", ")}` },
          };
        }
        return { record, skip: null };
      });
      const shipped: OmpSnapshot["providers"] = [];
      for (const { record, skip } of decisions) {
        if (skip?.kind === "already") {
          audit.ompAlreadyPresent.push(record.id);
          continue;
        }
        if (skip?.kind === "nonModel") {
          audit.ompNonModel.push(record.id);
          continue;
        }
        if (skip?.kind === "notMaterializable") {
          audit.ompNotMaterializable.push(`${record.id} (${skip.detail})`);
          continue;
        }
        shipped.push(record);
      }
      if (shipped.length === 0) continue;
      if (Object.hasOwn(catalog, providerId)) {
        for (const record of shipped) audit.ompAlreadyPresent.push(record.id);
        continue;
      }
      const defaultRecord = shipped.find((record) => record.id === providerId) ?? shipped[0]!;
      const options = shipped
        .filter((record) => record !== defaultRecord)
        .sort((a, b) => (a.api < b.api ? -1 : a.api > b.api ? 1 : 0));
      catalog[providerId] = {
        label: defaultRecord.label,
        tier: "template",
        envName: null,
        baseUrl: defaultRecord.baseUrl,
        api: defaultRecord.api,
        models: defaultRecord.models,
        doc: null,
        ...(shipped.length > 1
          ? {
              protocols: [defaultRecord, ...options].map((record) => ({
                api: record.api,
                baseUrl: record.baseUrl,
                models: record.models,
              })),
            }
          : {}),
      };
      audit.ompRowCount += 1;
      for (const record of shipped) {
        if (record.id !== providerId) legacy[record.id] = providerId;
      }
      if (Object.hasOwn(snapshot, providerId)) sources[providerId] = providerId;
    }
  }
  const legacySorted: Record<string, string> = {};
  for (const id of Object.keys(legacy).sort()) legacySorted[id] = legacy[id]!;
  return { catalog, audit, sources, legacy: legacySorted };
}

function modelLimitOf(raw: SnapshotLimit | undefined): ModelLimit | undefined {
  const context = raw?.context;
  const output = raw?.output;
  if (typeof context !== "number" || typeof output !== "number") return undefined;
  if (!Number.isInteger(context) || !Number.isInteger(output)) return undefined;
  if (context <= 0 || output <= 0) return undefined;
  return { contextWindow: context, maxTokens: output };
}

function buildModelLimits(
  catalog: Record<string, unknown>,
  sources: Record<string, string>,
  snapshot: Record<string, SnapshotProvider>,
): { limits: Record<string, Record<string, ModelLimit>>; skipped: string[] } {
  const limits: Record<string, Record<string, ModelLimit>> = {};
  const skipped: string[] = [];
  for (const [providerId, entry] of Object.entries(catalog)) {
    const sourceKey = sources[providerId];
    const source = sourceKey === undefined ? undefined : snapshot[sourceKey];
    const row: Record<string, ModelLimit> = {};
    const vocabularies = entry as { models: string[]; protocols?: { models: string[] }[] };
    const vocabulary = [
      ...vocabularies.models,
      ...(vocabularies.protocols ?? []).flatMap((option) => option.models),
    ];
    for (const modelId of vocabulary) {
      const size = modelLimitOf(source?.limits?.[modelId]);
      if (size !== undefined) row[modelId] = size;
    }
    if (Object.keys(row).length === 0) {
      if (sourceKey !== undefined) {
        throw new Error(
          `catalog provider ${JSON.stringify(providerId)} draws its models from snapshot key ${JSON.stringify(sourceKey)} but none of them carries a usable limit — fix the snapshot or the curated model vocabulary`,
        );
      }
      skipped.push(providerId);
      continue;
    }
    limits[providerId] = row;
  }
  return { limits, skipped };
}

async function main(): Promise<void> {
  const snapshotFile = pickNewestSnapshot(await readdir(INPUTS_DIR));
  const snapshotPath = path.join(INPUTS_DIR, snapshotFile.file);
  const snapshot = JSON.parse(await readFile(snapshotPath, "utf8")) as Record<string, SnapshotProvider>;
  const omp = JSON.parse(await readFile(OMP_SNAPSHOT_PATH, "utf8")) as OmpSnapshot;
  const { catalog, audit, sources, legacy } = buildCatalog(snapshot, omp);
  const { limits, skipped } = buildModelLimits(catalog, sources, snapshot);

  const catalogLiteral = JSON.stringify(catalog, null, 2);
  const legacyLiteral = JSON.stringify(legacy, null, 2);
  const limitsLiteral = JSON.stringify(limits, null, 2);
  const builtinIdsLiteral = JSON.stringify(BUILTIN_ORDER.map((spec) => spec.id), null, 2);
  const commonIdsLiteral = JSON.stringify(COMMON_PROVIDER_IDS, null, 2);
  const wrapList = (items: string[]): string => (items.length === 0 ? "(none)" : items.join(", "));
  const overrides = omp.source.overrides ?? [];
  const overrideLines =
    overrides.length === 0
      ? ""
      : `
 * MEASURED OVERRIDES (\`scripts/provider-catalog/inputs/overrides.json\`, applied over the
 * package's own vocabulary and authoritative for these buckets — a package bump
 * does not change them; re-measure and update the \`fetched\` date):
${overrides
  .map(
    (entry) =>
      ` *   - ${entry.provider} ${entry.bucket} (${entry.record}): ${entry.models} ids, measured ${entry.fetched} from ${entry.source}`,
  )
  .join("\n")}`;

  const auditComment = ` * Breadth enumeration (deterministic, auditable — every excluded snapshot
 * key names its rule; ${Object.keys(snapshot).length} snapshot keys → ${audit.breadthCount} breadth template entries):
 *   - rule (a) excluded as a builtin sourceKey (${audit.excludedSourceKeys.length} — no duplicate
 *     vendor rows beside the builtin tier): ${wrapList(audit.excludedSourceKeys)}
 *   - rule (b) deduped into a hand-curated template (${audit.dedupedKeys.length}):
 *     ${audit.dedupedKeys.map((key) => `${key} → ${TEMPLATE_DEDUPE_SNAPSHOT_KEYS[key]}`).join(", ") || "(none)"} (the curated entry is preserved verbatim)
 *   - rule (c) skipped, failing CUSTOM_PROVIDER_ID_PATTERN (${audit.idPatternFails.length} additional
 *     after rules a/b): ${wrapList(audit.idPatternFails)}
 *   - rule (d) omp-owned mixed-protocol keys (${audit.ompOwnedKeys.length}): the union's single
 *     row for that provider owns the key (its protocols carry the union vocabulary), so the
 *     single models.dev row is not emitted: ${wrapList(audit.ompOwnedKeys)}
 * omp provider union (omp ${omp.source.version}, vendored ${omp.source.extracted} — every omp
 * API-key provider id names its rule; ${omp.ompProviderIds.length} providers → ${audit.ompRowCount} template rows):
 *   - (a) already in the catalog (builtin or template) (${audit.ompAlreadyPresent.length}): ${wrapList(audit.ompAlreadyPresent)}
 *   - (b) naming alias of an existing catalog row (${audit.ompAliasSkips.length}): ${wrapList(audit.ompAliasSkips)}
 *   - (c) non-model — no API-key env, search or local-inference surface (${audit.ompNonModel.length}):
 *     ${wrapList(audit.ompNonModel)}
 *   - (d) not materializable — id grammar, protocol outside the custom-provider set, or a
 *     non-{account_id} URL placeholder (${audit.ompNotMaterializable.length}):
 *     ${wrapList(audit.ompNotMaterializable)}
 *   - union rows are \`template\` tier with a null envName; prefill is the omp seed
 *     vocabulary verbatim (empty when omp ships none)
 *   - a mixed-protocol omp provider ships ONE row under its provider id, whose
 *     \`protocols\` array carries every materializable protocol (the base record
 *     first) with its own api, base URL and vocabulary — an add-provider choice,
 *     not a per-App or per-model switch
 *   - the per-protocol record ids that row absorbed are listed in
 *     LEGACY_PROVIDER_IDS below: read-only compatibility for a declaration
 *     already stored under one of them
 *   - sizes for such a row come from the models.dev key its id names, over the
 *     union of every protocol's vocabulary; an id the directory does not carry
 *     stays unsized${overrideLines}`;

  const moduleSource = `/**
 * GENERATED FILE — provider catalog (spec §5). DO NOT EDIT BY HAND — regenerate with
 * \`bun run scripts/generate-provider-catalog.ts\` and commit the result as
 * an explicit, reviewable regeneration commit.
 *
 * Source: pinned models.dev snapshot
 * \`scripts/provider-catalog/inputs/${snapshotFile.file}\` (fetched ${snapshotFile.date}
 * from https://models.dev/api.json; the \`api\` field carries the base URL)
 * + the omp-facing override table in the generator (labels / env-name
 * contract / workers-ai template) + the vendored omp provider snapshot
 * \`scripts/provider-catalog/generated/omp-api-key-providers.json\` (omp ${omp.source.version},
 * extracted ${omp.source.extracted}). Runtime is fully static: zero network,
 * zero ai-sdk runtime dependencies — the Worker, the dashboard, and the
 * sandbox image only import this module. PURE DATA + pure derivations:
 * zero imports of any kind.
 *
 * Tiers: \`builtin\` = the per-App BYOK allowlist (AL-24-5); \`template\` =
 * metadata + prefill only, materialized through the existing custom-provider
 * machinery (bot_custom_providers) at save time (spec §5). The hand-curated
 * \`workers-ai\` template carries the {account_id} base-URL placeholder the
 * save flow substitutes.
 *
 * Credential transport: an \`envName\` is RETAINED mapping metadata, never the
 * variable the key rides. A configured pool reaches the review container as the
 * runner's STDIN credential payload (consumer.ts buildRunnerCredentials,
 * packages/shared/src/credential-payload.ts), and the in-image runner loads it
 * into the run's IN-MEMORY credential store as \`source:"login"\` api_key rows — the
 * per-run agent directory holds only the non-secret models.yml. \`envName\`
 * only marks allowlist membership (providerEnvName).
 *
 * Display grouping (AD-547): \`PROVIDER_IDS_COMMON\` is a
 * DISPLAY-ONLY regroup of the settings picker (常用 providers first, the
 * rest under the 目录模板 group). It carries ZERO runner semantics — the
 * runner BYOK allowlist remains \`PROVIDER_IDS_BUILTIN\` /
 * \`PROVIDER_ENV_NAMES\`, and no catalog entry or runner surface reads it.
 *
${auditComment}
 */

export type ProviderTier = "builtin" | "template";

/** One selectable protocol of a mixed-protocol provider. */
export type ProviderProtocolOption = {
  /** note: Custom-provider API protocol this option materializes. */
  api: string;
  /** note: The endpoint this protocol serves on — the size gate matches THIS url. */
  baseUrl: string | null;
  /** note: This protocol's own model vocabulary (prefill; clipped to 128 at save). */
  models: readonly string[];
};

export type ProviderCatalogEntry = {
  /** note: Human-readable provider label (picker/table). */
  label: string;
  /** note: builtin = allowlisted BYOK provider (pool-transported); template = metadata + prefill only. */
  tier: ProviderTier;
  /** safety: RETAINED mapping metadata — NOT the container injection variable. The key
  envName: string | null;
  /** note: Default API base URL. Template entries may carry a {account_id}
  baseUrl: string | null;
  /** note: Custom-provider API protocol to materialize a template with (template
  api: string | null;
  /** note: Representative model ids (display/prefill metadata). */
  models: readonly string[];
  /** note: Provider docs URL. */
  doc: string | null;
  /** note: Mixed-protocol providers only: every selectable protocol, the default
  protocols?: readonly ProviderProtocolOption[];
};

export type ProviderInfo = {
  /** safety: RETAINED mapping metadata — the legacy scalar name of a provider that is
  envName: string;
  /** note: Human-readable provider label for the picker/table. */
  label: string;
};

export const PROVIDER_CATALOG: Record<string, ProviderCatalogEntry> = ${catalogLiteral};

/** Per-protocol catalog ids this catalog no longer emits → the provider row
 *  that absorbed them. READ-ONLY compatibility for a declaration already
 *  stored under one of them (label, size resolution, usage probe); no write
 *  path consults it, so a save can never recreate such an id as a row. */
export const LEGACY_PROVIDER_IDS: Readonly<Record<string, string>> = Object.freeze(${legacyLiteral});

/** The builtin tier ids in exact mapping order (the dashboard's PROVIDER_IDS
 *  allowlist sequence — AL-24-5, \`ark\` last). */
export const PROVIDER_IDS_BUILTIN: readonly string[] = Object.freeze(${builtinIdsLiteral});

/** Display-only grouping of the settings picker (AD-547): the 常用
 *  tier shown first in the Add-provider picker — a frozen subset of
 *  PROVIDER_IDS_BUILTIN in exactly this order. ZERO runner semantics: the
 *  runner BYOK allowlist remains PROVIDER_IDS_BUILTIN / PROVIDER_ENV_NAMES. */
export const PROVIDER_IDS_COMMON: readonly string[] = Object.freeze(${commonIdsLiteral});

/** The builtin tier as the legacy env-name mapping (consumer.ts:64
 *  consumption surface — the per-App BYOK allowlist). */
export const PROVIDERS: Record<string, ProviderInfo> = Object.fromEntries(
  Object.entries(PROVIDER_CATALOG)
    .filter(([, entry]) => entry.tier === "builtin")
    .map(([id, entry]) => [id, { envName: entry.envName!, label: entry.label }]),
) as Record<string, ProviderInfo>;

/** Resolve a provider's RETAINED legacy env-name metadata (allowlist membership), or undefined if unknown. */
export function providerEnvName(name: string): string | undefined {
  return PROVIDERS[name]?.envName;
}

/** Every provider's retained legacy env name, in mapping order (frozen snapshot). */
export const PROVIDER_ENV_NAMES: readonly string[] = Object.freeze(
  Object.values(PROVIDERS).map((info) => info.envName),
);

/** The template tier (metadata + prefill only — not runner-consumable). */
export const TEMPLATE_PROVIDERS: Record<string, ProviderCatalogEntry> = Object.fromEntries(
  Object.entries(PROVIDER_CATALOG).filter(([, entry]) => entry.tier === "template"),
) as Record<string, ProviderCatalogEntry>;
`;

  await writeFile(OUT_PATH, moduleSource, "utf8");

  const modelCount = Object.values(limits).reduce((total, row) => total + Object.keys(row).length, 0);
  const limitsModuleSource = `/**
 * GENERATED FILE — per-model size table (context window / max output) for the
 * provider catalog. DO NOT EDIT BY HAND — regenerate with
 * \`bun run scripts/generate-provider-catalog.ts\`.
 *
 * Source: \`scripts/provider-catalog/inputs/${snapshotFile.file}\` (fetched
 * ${snapshotFile.date} from https://models.dev/api.json; each model carries
 * \`limit: { context, output }\`). Only providers and model ids that the
 * generated provider catalog lists are carried here — the table exists to fill
 * an operator's blank size fields, not to mirror the whole directory.
 *
 * Coverage: ${Object.keys(limits).length} of ${Object.keys(catalog).length} catalog providers, ${modelCount} model entries. The omitted
 * ${skipped.length} providers carry no models.dev model row at all (their
 * vocabulary comes from the vendored omp provider snapshot, or the row is
 * local-only metadata), so the table states no number for them instead of
 * inventing one:
 *   ${wrapList(skipped)}
 *
 * Static data, zero imports, zero network: the Worker, the dashboard and the
 * sandbox image only ever import this module.
 */

/** One model's sizes, in tokens. */
export type ModelLimit = { contextWindow: number; maxTokens: number };

/** The snapshot date the table was generated from (shown as the value's source). */
export const MODEL_LIMITS_SNAPSHOT = ${JSON.stringify(snapshotFile.date)};

/** provider id → model id → sizes. */
export const MODEL_LIMITS: Readonly<Record<string, Readonly<Record<string, ModelLimit>>>> = Object.freeze(${limitsLiteral});
`;
  await writeFile(OUT_LIMITS_PATH, limitsModuleSource, "utf8");
  console.log(
    `wrote ${OUT_PATH} (${moduleSource.length} bytes): ` +
      `${BUILTIN_ORDER.length} builtin + ${Object.keys(TEMPLATES).length} curated template + ${audit.breadthCount} breadth templates; ` +
      `skips: ${audit.excludedSourceKeys.length} sourceKey / ${audit.dedupedKeys.length} dedupe / ${audit.idPatternFails.length} id-pattern; ` +
      `omp union: ${audit.ompRowCount} rows / ${audit.ompAlreadyPresent.length} present / ${audit.ompAliasSkips.length} alias / ` +
      `${audit.ompNonModel.length} non-model / ${audit.ompNotMaterializable.length} not-materializable`,
  );
  console.log(
    `wrote ${OUT_LIMITS_PATH} (${limitsModuleSource.length} bytes): ` +
      `${Object.keys(limits).length}/${Object.keys(catalog).length} catalog providers, ${modelCount} model entries, ` +
      `${skipped.length} providers without a models.dev model row`,
  );
}

// why: Authoring path: the read/write tail runs only when the script is executed
// directly (`bun run scripts/generate-provider-catalog.ts`); importing the
// module (the collision guard tests) gets the pure buildCatalog with zero
// file I/O.
if (import.meta.main) {
  await main();
}
