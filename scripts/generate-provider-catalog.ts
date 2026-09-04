/**
 * Author-time generator for `src/contracts/provider-catalog.generated.ts`
 * (plan 42 T1; originally plan 35 T3, spec §5 — architect-locked form).
 *
 * The catalog is a compile-time static module: the Worker, the dashboard,
 * and the sandbox image only ever import the committed artifact — zero
 * runtime network, zero ai-sdk runtime dependencies. This script is the
 * ONLY authoring path; the committed module is the SSOT and regeneration is
 * an explicit, reviewable commit (spec §5 version discipline). The module
 * lands in src/contracts/ (not src/pipeline/) because the dashboard imports
 * it directly and dashboard modules must not import pipeline code (Q2 — the
 * pipeline face at src/pipeline/provider-catalog.ts re-exports the contract
 * for pipeline consumers; src/review is untouched and stays the only
 * directory the sandbox image copies).
 *
 * Inputs (both pinned):
 *   1. `scripts/provider-catalog/models.dev-2026-09-04.json` — a trimmed
 *      snapshot of the ai-sdk ecosystem directory dataset (models.dev,
 *      fetched 2026-09-04 from https://models.dev/api.json; trimmed to the
 *      fields this generator consumes: id / name / env / api / doc /
 *      model_ids). The snapshot date is the pin — regeneration against a
 *      newer snapshot is a deliberate, reviewed act. In this snapshot the
 *      `api` field carries the provider's default base URL.
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
 *
 * Breadth enumeration (plan 42, spec § Providers contract item 2): beyond
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
 * Generation-time dependencies: NONE beyond Node builtins + the vendored
 * snapshot (the "exact-pin" requirement is satisfied by the dated snapshot;
 * no npm package is installed for generation).
 */
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const SNAPSHOT_PATH = path.resolve("scripts/provider-catalog/models.dev-2026-09-04.json");
const OUT_PATH = path.resolve("src/contracts/provider-catalog.generated.ts");

type SnapshotProvider = {
  id: string;
  name: string;
  env: string[];
  api: string | null;
  doc: string | null;
  model_ids: string[];
};

/** One builtin-tier entry spec. `sourceKey` = the models.dev snapshot key
 *  carrying the ecosystem metadata (absent → no ecosystem data; all fields
 *  local). `label`/`envName` are the omp-facing SSOT (runner contract). */
type BuiltinSpec = {
  /** Selector-facing provider id (the catalog record key). */
  id: string;
  sourceKey?: string;
  label: string;
  envName: string;
  baseUrl?: string | null;
  doc?: string | null;
  modelCount?: number;
};

/** The 19 builtin ids in mapping order (the PROVIDER_ENV_NAMES /
 *  PROVIDER_IDS parity sequence — plan 24 / AL-24-5, `ark` last). */
const BUILTIN_ORDER: BuiltinSpec[] = [
  { id: "anthropic", sourceKey: "anthropic", label: "Anthropic", envName: "ANTHROPIC_API_KEY" },
  { id: "openai", sourceKey: "openai", label: "OpenAI", envName: "OPENAI_API_KEY" },
  { id: "gemini", sourceKey: "google", label: "Google Gemini", envName: "GEMINI_API_KEY" },
  { id: "copilot", sourceKey: "github-copilot", label: "GitHub Copilot", envName: "COPILOT_GITHUB_TOKEN" },
  { id: "azure-openai", sourceKey: "azure", label: "Azure OpenAI", envName: "AZURE_OPENAI_API_KEY" },
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
  // cursor: not present in the models.dev snapshot — local metadata only.
  { id: "cursor", label: "Cursor", envName: "CURSOR_ACCESS_TOKEN", baseUrl: null, doc: "https://cursor.com/docs/api/overview" },
  { id: "ai-gateway", sourceKey: "cloudflare-ai-gateway", label: "AI Gateway", envName: "AI_GATEWAY_API_KEY" },
  { id: "wafer-serverless", sourceKey: "wafer.ai", label: "Wafer Serverless", envName: "WAFER_SERVERLESS_API_KEY" },
  { id: "ark", sourceKey: "volcengine", label: "Ark", envName: "ARK_API_KEY" },
];

/** Template-tier entries (spec §5): metadata + prefill only — NOT
 *  runner-consumable as env-name entries; the save flow materializes them
 *  through the existing custom-provider machinery (app_custom_providers).
 *  `baseUrl` carries the `{account_id}` placeholder the save flow
 *  substitutes; `api` is the custom-provider protocol to materialize with;
 *  `models` is the prefill vocabulary (curated representative ids, all
 *  present in the snapshot). */
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

/** Breadth rule (b): snapshot keys deduped into a hand-curated TEMPLATES
 *  entry (snapshot key → catalog template id) instead of becoming their own
 *  breadth row. */
const TEMPLATE_DEDUPE_SNAPSHOT_KEYS: Record<string, string> = {
  "cloudflare-workers-ai": "workers-ai",
};

/**
 * Mirror of CUSTOM_PROVIDER_ID_PATTERN (src/dashboard/app-config-store.ts)
 * — a breadth id materializes into a custom-provider declaration, so it
 * must satisfy the exact store grammar. The copy is parity-locked by
 * tests/pipeline/providers.test.ts; keep the two regex literals byte-equal.
 */
const CUSTOM_PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const DEFAULT_MODEL_COUNT = 5;

/** Breadth template models prefill cap (plan 42): at most the first 20
 *  model ids per provider, deterministic snapshot order — template prefill
 *  only, bounding the settings payload. */
const TEMPLATE_MODEL_PREFILL_CAP = 20;

type BreadthAudit = {
  /** Rule (a) skips: snapshot keys consumed as a builtin sourceKey. */
  excludedSourceKeys: string[];
  /** Rule (b) skips: snapshot keys deduped into a hand-curated template. */
  dedupedKeys: string[];
  /** Rule (c) skips: remaining ids failing the custom-provider id grammar. */
  idPatternFails: string[];
  /** Snapshot keys that became breadth template rows. */
  breadthCount: number;
};

function buildCatalog(
  snapshot: Record<string, SnapshotProvider>,
): { catalog: Record<string, unknown>; audit: BreadthAudit } {
  const catalog: Record<string, unknown> = {};
  for (const spec of BUILTIN_ORDER) {
    const source = spec.sourceKey === undefined ? undefined : snapshot[spec.sourceKey];
    if (spec.sourceKey !== undefined && source === undefined) {
      throw new Error(`snapshot is missing source key ${JSON.stringify(spec.sourceKey)} — stale snapshot?`);
    }
    const models = (source?.model_ids ?? []).slice(0, spec.modelCount ?? DEFAULT_MODEL_COUNT);
    catalog[spec.id] = {
      label: spec.label,
      tier: "builtin",
      envName: spec.envName,
      baseUrl: spec.baseUrl !== undefined ? spec.baseUrl : (source?.api ?? null),
      api: null,
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
  const builtinSourceKeys = new Set(
    BUILTIN_ORDER.filter((spec) => spec.sourceKey !== undefined).map((spec) => spec.sourceKey!),
  );
  const audit: BreadthAudit = { excludedSourceKeys: [], dedupedKeys: [], idPatternFails: [], breadthCount: 0 };
  // Snapshot insertion order (JSON.parse preserves it for non-numeric keys)
  // is the deterministic breadth order — the pinned file's own sequence.
  for (const [key, source] of Object.entries(snapshot)) {
    if (builtinSourceKeys.has(key)) {
      audit.excludedSourceKeys.push(key);
      continue;
    }
    if (TEMPLATE_DEDUPE_SNAPSHOT_KEYS[key] !== undefined) {
      audit.dedupedKeys.push(key);
      continue;
    }
    if (!CUSTOM_PROVIDER_ID_PATTERN.test(key)) {
      audit.idPatternFails.push(key);
      continue;
    }
    catalog[key] = {
      label: source.name,
      tier: "template",
      envName: null,
      // The snapshot `api` field carries the default base URL — shipped
      // verbatim (may be null or non-https; the save flow's base-URL
      // override + existing https validator make such rows materializable).
      baseUrl: source.api ?? null,
      // The snapshot carries NO protocol field — the ecosystem-norm default
      // for the directory; curated templates keep their own value.
      api: "openai-completions",
      models: source.model_ids.slice(0, TEMPLATE_MODEL_PREFILL_CAP),
      doc: source.doc ?? null,
    };
    audit.breadthCount += 1;
  }
  return { catalog, audit };
}

const snapshot = JSON.parse(await readFile(SNAPSHOT_PATH, "utf8")) as Record<string, SnapshotProvider>;
const { catalog, audit } = buildCatalog(snapshot);

const catalogLiteral = JSON.stringify(catalog, null, 2);
const builtinIdsLiteral = JSON.stringify(BUILTIN_ORDER.map((spec) => spec.id), null, 2);
const wrapList = (items: string[]): string => (items.length === 0 ? "(none)" : items.join(", "));

const auditComment = ` * Breadth enumeration (deterministic, auditable — every excluded snapshot
 * key names its rule; ${Object.keys(snapshot).length} snapshot keys → ${audit.breadthCount} breadth template entries):
 *   - rule (a) excluded as a builtin sourceKey (${audit.excludedSourceKeys.length} — no duplicate
 *     vendor rows beside the builtin tier): ${wrapList(audit.excludedSourceKeys)}
 *   - rule (b) deduped into a hand-curated template (${audit.dedupedKeys.length}):
 *     ${audit.dedupedKeys.map((key) => `${key} → ${TEMPLATE_DEDUPE_SNAPSHOT_KEYS[key]}`).join(", ") || "(none)"} (the curated entry is preserved verbatim)
 *   - rule (c) skipped, failing CUSTOM_PROVIDER_ID_PATTERN (${audit.idPatternFails.length} additional
 *     after rules a/b): ${wrapList(audit.idPatternFails)}
 *   - models prefill cap: at most the first ${TEMPLATE_MODEL_PREFILL_CAP} model ids per provider
 *     (deterministic snapshot order — template prefill only)`;

const moduleSource = `/**
 * GENERATED FILE — provider catalog (plan 42 T1; originally plan 35 T3,
 * spec §5). DO NOT EDIT BY HAND — regenerate with
 * \`bun run scripts/generate-provider-catalog.ts\` and commit the result as
 * an explicit, reviewable regeneration commit.
 *
 * Source: pinned models.dev snapshot
 * \`scripts/provider-catalog/models.dev-2026-09-04.json\` (fetched 2026-09-04
 * from https://models.dev/api.json; the \`api\` field carries the base URL)
 * + the omp-facing override table in the generator (labels / env-name
 * contract / workers-ai template). Runtime is fully static: zero network,
 * zero ai-sdk runtime dependencies — the Worker, the dashboard, and the
 * sandbox image only import this module. PURE DATA + pure derivations:
 * zero imports of any kind.
 *
 * Tiers: \`builtin\` = runner-consumable env-name entries (the per-App BYOK
 * allowlist, plan 24 / AL-24-5 — consumer.ts injects ONLY these env names
 * into the review container); \`template\` = metadata + prefill only,
 * materialized through the existing custom-provider machinery
 * (app_custom_providers) at save time (spec §5). The hand-curated
 * \`workers-ai\` template carries the {account_id} base-URL placeholder the
 * save flow substitutes.
 *
${auditComment}
 */

export type ProviderTier = "builtin" | "template";

export type ProviderCatalogEntry = {
  /** Human-readable provider label (picker/table). */
  label: string;
  /** builtin = runner-consumable env-name entry; template = metadata + prefill only. */
  tier: ProviderTier;
  /** Env var name the key is injected under inside the review container
   *  (builtin tier only; null for template — materialized via
   *  customProviderEnvName). */
  envName: string | null;
  /** Default API base URL. Template entries may carry a {account_id}
   *  placeholder the save flow substitutes. */
  baseUrl: string | null;
  /** Custom-provider API protocol to materialize a template with (template
   *  tier only; null for builtin). */
  api: string | null;
  /** Representative model ids (display/prefill metadata). */
  models: readonly string[];
  /** Provider docs URL. */
  doc: string | null;
};

export type ProviderInfo = {
  /** The env var name the key is injected under inside the review container. */
  envName: string;
  /** Human-readable provider label for the picker/table. */
  label: string;
};

export const PROVIDER_CATALOG: Record<string, ProviderCatalogEntry> = ${catalogLiteral};

/** The builtin tier ids in exact mapping order (the dashboard's PROVIDER_IDS
 *  allowlist sequence — plan 24 / AL-24-5, \`ark\` last). */
export const PROVIDER_IDS_BUILTIN: readonly string[] = Object.freeze(${builtinIdsLiteral});

/** The builtin tier as the legacy env-name mapping (consumer.ts:64
 *  consumption surface — the per-App BYOK allowlist). */
export const PROVIDERS: Record<string, ProviderInfo> = Object.fromEntries(
  Object.entries(PROVIDER_CATALOG)
    .filter(([, entry]) => entry.tier === "builtin")
    .map(([id, entry]) => [id, { envName: entry.envName!, label: entry.label }]),
) as Record<string, ProviderInfo>;

/** Resolve the env var name a provider key is injected under, or undefined if unknown. */
export function providerEnvName(name: string): string | undefined {
  return PROVIDERS[name]?.envName;
}

/** Every provider key env name, in mapping order (frozen snapshot). */
export const PROVIDER_ENV_NAMES: readonly string[] = Object.freeze(
  Object.values(PROVIDERS).map((info) => info.envName),
);

/** The template tier (metadata + prefill only — not runner-consumable). */
export const TEMPLATE_PROVIDERS: Record<string, ProviderCatalogEntry> = Object.fromEntries(
  Object.entries(PROVIDER_CATALOG).filter(([, entry]) => entry.tier === "template"),
) as Record<string, ProviderCatalogEntry>;
`;

// QC wave (seat1, plan 35): the parity locks (tests/worker/app-config.test.ts)
// fail CI on drift between this contract and the dashboard mirror — the
// mirror is now a direct re-export of this module (plan 42 T1), so the lock
// guards the re-export instead of a hand-maintained copy.
await writeFile(OUT_PATH, moduleSource, "utf8");
console.log(
  `wrote ${OUT_PATH} (${moduleSource.length} bytes): ` +
    `${BUILTIN_ORDER.length} builtin + ${Object.keys(TEMPLATES).length} curated template + ${audit.breadthCount} breadth templates; ` +
    `skips: ${audit.excludedSourceKeys.length} sourceKey / ${audit.dedupedKeys.length} dedupe / ${audit.idPatternFails.length} id-pattern`,
);
