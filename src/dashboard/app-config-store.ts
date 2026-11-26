/**
 * note: D1 store for per-App AI configuration: the `bot_provider_keys` BYOK key
 * POOLS (one row per (App, provider, key_id) — migration 0024) and the
 * `bot_custom_provider_keys` pools of the custom-provider declarations, plus
 * the model chains (`bot_model_chains` default + named chains and the
 * `bot_model_chain_seats` seat references, migration 0017). Spec
 * dashboard-multi-app-platform § Per-App BYOK + § Crypto envelope; migration
 * 0024 is the DDL single source for the pool tables.
 *
 * Crypto (lock L1): every key write encrypts INSIDE the store via
 * src/dashboard/secretbox.ts — plaintext keys arrive only as the method
 * argument and never come back out: the list faces are masked (at most the
 * last 4 characters plus the derived key id) and getAppConfig /
 * getCustomProvidersForConsumer exist for the ONE legitimate decrypt
 * consumer, the per-App exec-env assembly. The envelope AAD is the FULL row
 * key `app_provider_keys.key_enc:<appId>:<provider>:<keyId>` — the 0006
 * composite-PK rowKey extended by the per-key id —
 * with `app_custom_provider_keys.key_enc:<appId>:<provider>:<keyId>` the same
 * form. `keyId` is the first 16 hex characters of SHA-256(plaintext), so
 * re-submitting a key updates ITS row rather than the provider's single
 * slot. The master key (the DASHBOARD_ENCRYPTION_KEY env value) is bound at
 * factory time; a missing/malformed key surfaces as SecretboxKeyError on the
 * first encrypt/decrypt call — routes map that to 5xx fail-closed.
 *
 * Migration 0024 is FORWARD-ONLY and split in two halves by what can run
 * where: the SQL migration rebuilds both key tables and carries the pre-pool
 * rows across VERBATIM — migrations are SQL, and SQL cannot decrypt, so a
 * carried row keeps its two-segment-AAD envelope under the LEGACY_KEY_ID
 * sentinel. The store, which holds the master key, completes the promotion on
 * the first touch of that row: decrypt with the OLD AAD, derive the key id
 * from the plaintext, re-encrypt under the three-segment AAD and rewrite the
 * row in place (created_at / updated_at / verified_* preserved). Every read
 * and write promotes first, so no caller ever sees the sentinel.
 *
 * model_chain is stored VERBATIM (a model selector is configuration, not a
 * secret) and is never parsed here beyond the route's ≥1-token validation —
 * parseModelChain below mirrors packages/runner/src/runtime-omp.ts parseModelSelectors
 * because dashboard modules must not import review/pipeline code (architect
 * decision Q2, src/dashboard/index.ts header); behavioral parity is locked by
 * tests/worker/app-config.test.ts.
 *
 * Module boundary: dashboard-side leaf consumed by the dashboard routes and
 * the pipeline consumer — imports ONLY src/dashboard/secretbox.ts
 * (itself a zero-dependency leaf) and the zero-dependency src/contracts/
 * static contract data (src/contracts/sandbox-images.ts — the runtime-image
 * registry; src/contracts/provider-catalog.generated.ts — the generated
 * catalog SSOT; both NOT pipeline/review code), so the dashboard ↛
 * pipeline/worker isolation stays intact. The `db` parameter is a
 * locally-declared narrow D1 face (types only, zero imports) — a real
 * `D1Database`, the bun:sqlite test double (tests/store/helpers.ts), and the
 * store layer's `D1Like` all satisfy it structurally (same pattern as
 * apps-store.ts). Every write here is a
 * single statement EXCEPT the atomic multi-write faces (spec
 * §4.4): setModelChain's default-row clear-then-set, setModelChainSeats'
 * full-map save (the role editor, now chain references), and
 * removeModelChain's seat-reference cascade — each is ONE atomic
 * `db.batch`, added for multi-write atomicity, never for throughput.
 *
 * Model chains (spec §4.4): `bot_model_chains` (migration
 * 0017) holds one row per (App, chain name) — the default chain row keeps
 * the RESERVED name "default" (is_default = 1, at most one per App,
 * enforced by the store in one batch), named chains are user-named
 * selector chains (is_default = 0). `bot_model_chain_seats` maps each of
 * the 4 audit-seat agent names to a chain name; ABSENT row = the seat uses
 * the default chain. The role vocabulary lives here as the MODEL_ROLE_IDS
 * mirror (importing the runner side via packages/runner is forbidden by the
 * dashboard isolation — Q2), and the selector grammar is validated with the
 * parseModelChain mirror above; both copies are parity-locked by
 * tests/worker/app-config.test.ts. Chains are decrypt-free (selectors are
 * configuration, not secrets) and are consumed by the pipeline consumer as
 * the runner input `modelOverrides` field (seats referencing the default
 * chain — or with no reference row — are omitted; empty map → undefined).
 * The pre-chains tables `bot_model_config` / `bot_model_roles` are
 * write-retired / read-retired after migration 0017's backfill (rows
 * retained, code no longer references them; no DROP).
 *
 * Semantics (the settings UI + consumer call sites rely on these):
 *   - addProviderKey upserts ONE key of a pool. The row's id is derived from
 *     the plaintext, so re-submitting the same key updates in place
 *     (created_at/updated_at rewritten from ONE clock read) while a DIFFERENT
 *     key takes the next free slot; a NEW slot past MAX_KEYS_PER_PROVIDER
 *     throws ProviderKeyLimitError before any write (a conditional INSERT
 *     keeps the bound exact under concurrent saves). The upsert resets
 *     verified_at/verified_status to NULL: addProviderKey is the UNVERIFIED
 *     path, so a leftover caller must not inherit a stale verified_status
 *     (saveVerifiedKey is the verified one). A key longer than
 *     MAX_PROVIDER_KEY_LENGTH (4096) throws ProviderKeyTooLongError before
 *     any crypto or write (input bounds; the settings route re-renders 400
 *     first — the guard here is the backstop for direct callers).
 *   - saveVerifiedKey is the verified analogue: the same per-key upsert with
 *     verified_at = now plus verified_status 'ok' — or 'reachable' when the
 *     builtin's probe URL is not known to reject a bogus key (one allow-list,
 *     shared with the custom path) — plus THAT KEY's
 *     verified-model evidence row, as ONE atomic db.batch.
 *   - deleteProviderKey removes ONE slot — and, when it actually removed that
 *     row, that key's OWN evidence row (a model only the removed credential
 *     could reach must not stay selectable; evidence is keyed by the
 *     credential that produced it, so the surviving keys keep theirs). A
 *     MISSED delete (unknown key id / unconfigured provider) changes nothing
 *     at all — it is an idempotent no-op returning false. It returns whether
 *     it removed a key row, like setAppStatus.
 *   - getVerifiedModels returns the models the CURRENT pool AGREES on,
 *     recomputed per read as the intersection over the pool keys' own
 *     evidence rows; a key with no evidence row (e.g. an unverified sibling)
 *     leaves that provider's vocabulary unknown → [] and the probe face.
 *   - listProviderKeys is the settings-page face: one row per stored key —
 *     provider + derived key id + masked tail + the per-key bookkeeping,
 *     provider-ascending then pool order (created_at, key_id). The optional
 *     `provider` scopes it to one pool. A key of ≤4 characters reveals
 *     NOTHING (the mask must never render a whole key).
 *   - setModelChain(null) — or any BLANK chain (empty / whitespace-only,
 *     aligned with the route's 空 = 清除) — REMOVES the default
 *     chain row (absent = unset; AL-24-5: a chain-less App's reviews FAIL
 *     CLOSED — the consumer rejects the message with a structured failure;
 *     there is no deployment-level chain to fall back to).
 *     A chain with content upserts the 'default' row VERBATIM with
 *     is_default = 1 — the per-App is_default uniqueness is enforced in ONE
 *     atomic db.batch (clear-old-set-new, spec §4.4). Read it back with
 *     getModelChain (the settings route prefills the editor from it WITHOUT
 *     decrypting any key material).
 *   - Named chains: upsertModelChain / removeModelChain /
 *     getModelChains manage user-named selector chains (is_default = 0;
 *     the name "default" is reserved and rejected at route AND store
 *     level). removeModelChain deletes the chain AND every seat reference
 *     row pointing at it in ONE atomic batch (those seats fall back to the
 *     default chain). Seats: setModelChainSeat / setModelChainSeats /
 *     clearModelChainSeat / getModelChainSeats map a role to a chain name —
 *     blank or "default" clears the reference row (absent = default chain);
 *     getModelOverridesForConsumer resolves the runner-input map (seats
 *     referencing the default chain or with no reference row are omitted).
 *   - getAppConfig decrypts for the consumer face: provider id → that
 *     provider's DECRYPTED keys in pool order (created_at, then key_id — the
 *     order the consumer's credential-payload key arrays follow). A
 *     provider holding at least one key ALWAYS has an entry (the fail-closed
 *     read contract the pipeline relies on); an App with no config yields an
 *     EMPTY keys map and a null chain (a chain referring to a provider
 *     without a key is rejected fail-closed by the consumer's
 *     assertAppConfigComplete — zero-config is NOT a valid review state
 *     anymore), and an undecryptable row is a loud throw
 *     (tamper/misconfiguration is never swallowed).
 *   - Custom providers (migration 0012, per-key pools since 0024):
 *     upsertCustomProvider / removeCustomProvider / listCustomProviders
 *     manage per-App declarations of NON-built-in model providers (base URL
 *     + AL-23-1 api enum + model ids); the declaration holds NO key material
 *     — the key lives in `bot_custom_provider_keys` under the same per-key
 *     AAD form, written by upsertCustomProvider or
 *     addCustomProviderKey (both verify-first callers: each records the same
 *     ok/reachable state), listed by listCustomProviderKeys
 *     (masked) and decrypted only by getCustomProvidersForConsumer (the
 *     getAppConfig analogue — fail-loud on tamper). removeCustomProvider
 *     deletes the declaration AND its whole pool in one batch. A custom key
 *     write is additionally gated on the DECLARATION still existing, and the
 *     declaration write of upsertCustomProvider rides the same admission
 *     predicate as its key — so a refused key commits neither, and a
 *     declaration removal racing a write can neither orphan nor revive a
 *     credential. Declaration bounds (AL-23-1/AL-23-2) are enforced here as
 *     the backstop and by the settings route as 400.
 *   - Timestamps are SQLite datetime('now') (UTC — the reviews.reviewed_at
 *     convention). UNIQUE / FK violations throw (fail-loud): an unknown
 *     bot_id is a caller bug, never a silent no-op.
 */
import { createSecretbox } from "./secretbox";
import { readBotOwnerWorkspace } from "./apps-store";
import type { WorkspaceRole } from "./workspace-store";
import { builtinProbeCanRejectKey, customProbeCanRejectKey } from "./provider-verify";
import { PROVIDER_CATALOG, PROVIDER_IDS_BUILTIN } from "../contracts/provider-catalog.generated";
import { MAX_CUSTOM_PROVIDER_MODEL_IDS } from "../contracts/provider-models";

/**
 * The store-enforced `verified_status` vocabulary (migration 0015; no CHECK
 * constraint — producer-enforced, the 0006/0012 precedent):
 *   - `ok`        the probe PROVED the submitted key (a bogus key is answered
 *                 non-2xx there, which is what makes the 2xx meaningful)
 *   - `reachable` the probe only proved the ENDPOINT answered — the probe URL
 *                 is not known to reject a bogus key (a custom/template
 *                 declaration off the allow-list, or a builtin whose model
 *                 list is public: kilo / umans)
 *   - `failed`    a recorded failed verify
 * NULL = never verified.
 */
export type VerifiedStatus = "ok" | "reachable" | "failed";

/**
 * A row of `bot_provider_keys` — and, byte-identical in shape, of
 * `bot_custom_provider_keys` (migration 0024: both tables hold ONE row per
 * key, with the envelope and its bookkeeping belonging to the key rather
 * than to the provider).
 */
export type AppProviderKeyRow = {
  bot_id: string;
  provider: string;
  key_id: string;
  key_enc: string;
  created_at: string;
  updated_at: string | null;
  verified_at: string | null;
  verified_status: string | null;
};

/**
 * A row of `bot_model_chains` (migration 0017, spec §4.4).
 * The default chain row keeps the RESERVED name "default" (is_default = 1);
 * named chains are user-named selector chains (is_default = 0). is_default
 * uniqueness per App is store-enforced in ONE atomic db.batch (no CHECK /
 * partial unique index — app-family convention).
 */
export type AppModelChainRow = {
  bot_id: string;
  name: string;
  chain: string;
  is_default: number;
  created_at: string;
  updated_at: string;
};

/** A row of `bot_model_chain_seats` (migration 0017, spec §4.4). Absent row = the seat uses the default chain. */
export type AppModelChainSeatRow = {
  bot_id: string;
  role: string;
  chain_name: string;
};
/**
 * The custom-provider API protocol enum (AL-23-1 verdict): of the omp SDK
 * Api full set, ONLY the open protocol forms are declarable BYOK — the
 * google, bedrock, azure, and codex shapes are vendor
 * OAuth/credential-chain forms that do not fit a baseUrl+key declaration.
 * `typesafe` is omp's TypeSafe judgement wire (a plain Bearer + `{base}/v1/
 * models` discovery), so it fits the same declaration shape.
 * Declared locally, NOT imported: dashboard modules must not import
 * pipeline/review code (Q2).
 */
export const CUSTOM_PROVIDER_API_IDS = [
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
  "typesafe",
] as const;

export type CustomProviderApi = (typeof CUSTOM_PROVIDER_API_IDS)[number];

/**
 * A row of `bot_custom_providers` (migration 0012 — D1 column
 * names, snake_case). model_ids is a TEXT JSON array (AL-23-1 DDL). The API
 * key does NOT live here: migration 0024 moved it into
 * `bot_custom_provider_keys` (an AppProviderKeyRow), so the declaration is
 * decrypt-free and the key carries its own identity and bookkeeping.
 */
export type AppCustomProviderRow = {
  bot_id: string;
  provider_id: string;
  base_url: string;
  api: string;
  model_ids: string;
  models_meta: string;
  created_at: string;
  updated_at: string;
};

/**
 * One custom-provider declaration (the settings-page face and the
 * consumer input): a NON-built-in model provider bound to a base URL, one
 * of the AL-23-1 protocol forms, and the model ids it serves. The API key
 * is NEVER part of this shape — since migration 0024 it lives in
 * bot_custom_provider_keys (declaration-time input; the consumer decrypt
 * face reads it there).
 */
export type AppCustomProvider = {
  provider_id: string;
  base_url: string;
  api: CustomProviderApi;
  model_ids: string[];
  models_meta?: CustomProviderModelsMeta;
};

/**
 * What one declared model's owner stated about it. `contextWindow` and
 * `maxTokens` are what make the model a usable failover candidate; the rest
 * may stay unset and stay unset — the product never invents a capability
 * either. A stored entry may carry a subset, so an id-only declaration is
 * storable while the settings form is the surface that requires the two sizes.
 */
export type CustomProviderModelMeta = {
  contextWindow?: number;
  maxTokens?: number;
  name?: string;
  reasoning?: boolean;
  input?: string[];
};

/** The per-model overlay of ONE declaration, keyed by a declared model id. */
export type CustomProviderModelsMeta = Record<string, CustomProviderModelMeta>;
/**
 * A declaration as the settings / model faces read it: the declaration PLUS
 * whether its pool currently holds a credential. A drained pool leaves the
 * declaration (intact and re-keyable) but makes every model id it names
 * unusable — a run against it fails in assertAppConfigComplete — so both the
 * model-option composition and the chain membership layer gate on this flag
 * (listCustomProviders is the only producer). The write face stays
 * AppCustomProvider: has_keys is derived from the pool, never submitted.
 */
export type AppCustomProviderRead = AppCustomProvider & {
  has_keys: boolean;
};
/**
 * One custom-provider declaration as the consumer sees it (the
 * getAppConfig analogue for bot_custom_providers): the decrypt-free
 * declaration PLUS its DECRYPTED key pool, in pool order (created_at, then
 * key_id — the order the consumer's pool env indexes follow). The keys exist
 * ONLY on this face — the settings lists (listCustomProviders,
 * listCustomProviderKeys) stay decrypt-free.
 */
export type CustomProviderConsumerConfig = {
  provider_id: string;
  base_url: string;
  api: CustomProviderApi;
  model_ids: string[];
  models_meta?: CustomProviderModelsMeta;
  api_keys: string[];
};

type CustomProviderKeyJoinRow = {
  provider_id: string;
  base_url: string;
  api: string;
  model_ids: string;
  models_meta: string;
  key_id: string | null;
  key_enc: string | null;
  key_created_at: string | null;
  key_updated_at: string | null;
  key_verified_at: string | null;
  key_verified_status: string | null;
};

/**
 * A row of `bot_provider_models` (migration 0025): the verified-model
 * EVIDENCE ONE KEY produced, for BUILT-IN providers. `provider` is the
 * BYOK provider id the key was stored under — and `key_id` is the same
 * plaintext-derived id `bot_provider_keys` carries, so evidence is
 * attributable to exactly one credential. models_json is a TEXT JSON array of
 * verified model ids — configuration, not a secret (0006 model_chain
 * rationale). Custom providers write NO rows here (their vocabulary is the
 * declared model_ids, 0012).
 *
 * The row is EVIDENCE, not the answer: what the settings faces offer is the
 * intersection over the CURRENT pool's keys, recomputed on every read
 * (getVerifiedModels), so no write has to know what the other keys report.
 */
export type AppProviderModelsRow = {
  bot_id: string;
  provider: string;
  key_id: string;
  models_json: string;
  fetched_at: string;
};

/**
 * One provider's verified-model entry as the settings loader sees it (the
 * Interfaces face — the dropdown source for selector literal grammar
 * `provider/model`). `provider` is the selector-facing prefix of every
 * option built from this row, and `models` is the set the CURRENT pool
 * AGREES on (getVerifiedModels recomputes it on read).
 */
export type VerifiedModels = {
  provider: string;
  models: string[];
  fetched_at: string;
};

/**
 * The provider id allowlist — the builtin tier of the generated provider
 * catalog (19 builtin-tier provider ids incl. `ark`, same order).
 * Re-exported from the generated contract: the catalog SSOT
 * lives in src/contracts/provider-catalog.generated.ts — a
 * dashboard-importable pure-data module (Q2 forbids dashboard → pipeline
 * imports, so the mirror is a re-export of the CONTRACT, not a hand copy).
 */
export const PROVIDER_IDS: readonly string[] = PROVIDER_IDS_BUILTIN;

const RETIRED_PROVIDER_ALIASES: Readonly<Record<string, string>> = { "ark-plan": "ark" };

/**
 * The dashboard's catalog mirror (spec §5) —
 * the FULL generated catalog (builtin AND template tier, ~214 rows) as
 * id → { label, tier, baseUrl, api, models, doc }, re-exported from
 * src/contracts/provider-catalog.generated.ts. The generated entry shape is
 * structurally assignable to ProviderMirrorEntry (it additionally carries
 * `envName`, which the mirror type ignores). `tier: "template"` entries are
 * NOT runner-consumable env-name entries — the save flow materializes them
 * through the existing custom-provider machinery (bot_custom_providers),
 * substituting a {account_id} base-URL placeholder when the entry's base
 * URL carries one.
 */
export type ProviderMirrorEntry = {
  label: string;
  tier: "builtin" | "template";
  baseUrl: string | null;
  api: string | null;
  models: readonly string[];
  doc: string | null;
  protocols?: readonly {
    api: string;
    baseUrl: string | null;
    models: readonly string[];
  }[];
};

export const PROVIDER_META: Record<string, ProviderMirrorEntry> = PROVIDER_CATALOG;

/**
 * The per-role model vocabulary (spec § 语义锁) — EXACTLY the
 * 4 audit-seat agent names the runner dispatches: `mstar-review-seat` is the
 * quick/default seat (the agent definition installed from
 * packages/runner/src/seat-agent.md), the three deep seats are the harness roles
 * dispatched by name from runtime-omp's DEEP_SEAT_ROLES. Declared locally,
 * NOT imported: dashboard modules must not import review code (architect
 * decision Q2, src/dashboard/index.ts header). The copy is locked in sync by
 * tests/worker/app-config.test.ts against both review-side definitions (the
 * PROVIDER_IDS parity-lock pattern). UI and storage expose ONLY these 4 keys;
 * runner-side consumption of unknown names is a lazy pass-through (lock L3).
 */
export const MODEL_ROLE_IDS: readonly string[] = Object.freeze([
  "mstar-review-seat",
  "code-reviewer",
  "fullstack-dev",
  "frontend-dev",
]);

/**
 * Mirror of packages/runner/src/runtime-omp.ts `parseModelSelectors` (runtime-omp.ts:119):
 * comma-separated, trimmed, empty segments dropped; `undefined`/empty → `[]`.
 * Selectors pass through verbatim — a `:thinking`-style suffix is legal omp
 * selector syntax and is NOT rejected here; full selector validation stays
 * omp-side (plan brief). Local copy because dashboard modules must not import
 * review code (Q2); parity is locked by tests/worker/app-config.test.ts.
 */
export function parseModelChain(raw: string | undefined): string[] {
  if (!raw) return [];
  return raw
    .split(",")
    .map((selector) => selector.trim())
    .filter((selector) => selector.length > 0);
}
function parseModelIdsJson(raw: string, source: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((id) => typeof id === "string")) {
    throw new Error(`app-config-store: ${source} is not a JSON array of strings: ${JSON.stringify(raw)}`);
  }
  return parsed;
}

function normalizeModelMeta(value: unknown): unknown {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
  const normalized: Record<string, unknown> = {};
  for (const [field, fieldValue] of Object.entries(value as Record<string, unknown>)) {
    if (fieldValue === null || fieldValue === undefined) continue;
    normalized[field] = fieldValue;
  }
  return normalized;
}

const CUSTOM_PROVIDER_MODEL_META_FIELDS: readonly string[] = [
  "contextWindow",
  "maxTokens",
  "name",
  "reasoning",
  "input",
];

function customProviderModelMetaProblem(modelId: string, value: unknown): string | null {
  const named = `model ${JSON.stringify(modelId)}`;
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    return `${named} metadata is not a JSON object`;
  }
  const entry = value as Record<string, unknown>;
  for (const field of Object.keys(entry)) {
    if (!CUSTOM_PROVIDER_MODEL_META_FIELDS.includes(field)) {
      return `${named} metadata carries an unknown field ${JSON.stringify(field)}`;
    }
  }
  for (const field of CUSTOM_PROVIDER_MODEL_META_FIELDS) {
    if (entry[field] === null) return `${named} ${field} must not be null (leave it out to leave it unset)`;
  }
  for (const field of ["contextWindow", "maxTokens"]) {
    const raw = entry[field];
    if (raw === undefined) continue;
    if (typeof raw !== "number" || !Number.isInteger(raw) || raw <= 0) {
      return `${named} ${field} must be a positive integer`;
    }
  }
  if (entry.name !== undefined && typeof entry.name !== "string") {
    return `${named} name must be a string`;
  }
  if (entry.reasoning !== undefined && typeof entry.reasoning !== "boolean") {
    return `${named} reasoning must be a boolean`;
  }
  if (entry.input !== undefined) {
    if (!Array.isArray(entry.input) || !entry.input.every((modality) => typeof modality === "string")) {
      return `${named} input must be an array of strings`;
    }
  }
  return null;
}

function parseModelsMetaJson(
  raw: string,
  modelIds: readonly string[],
  source: string,
): CustomProviderModelsMeta | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`app-config-store: ${source} is not a JSON object: ${JSON.stringify(raw)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`app-config-store: ${source} is not a JSON object: ${JSON.stringify(raw)}`);
  }
  const meta: CustomProviderModelsMeta = {};
  for (const [modelId, value] of Object.entries(parsed as Record<string, unknown>)) {
    if (!modelIds.includes(modelId)) {
      throw new Error(
        `app-config-store: ${source} names model ${JSON.stringify(modelId)}, which is not in bot_custom_providers.model_ids`,
      );
    }
    if (value === null) continue;
    const normalized = normalizeModelMeta(value) as Record<string, unknown>;
    const problem = customProviderModelMetaProblem(modelId, normalized);
    if (problem !== null) throw new Error(`app-config-store: ${source}: ${problem}`);
    if (Object.keys(normalized).length > 0) meta[modelId] = normalized as CustomProviderModelMeta;
  }
  return Object.keys(meta).length === 0 ? undefined : meta;
}

/**
 * Provider-key length bound (spec dashboard-ops-and-role-models
 * § 硬化项 4): a pasted API key longer than this is rejected BEFORE any
 * encryption or D1 write, so an oversized input can never bloat the store.
 */
export const MAX_PROVIDER_KEY_LENGTH = 4096;
/**
 * Keys per (App, provider) pool: the pool rides the runner's stdin credential
 * payload as one ordered array per provider, so this bound is what keeps the
 * payload and the settings list
 * bounded. Growth-only: replacing an already-stored key never counts against
 * the cap. Enforced producer-side by the store, which refuses a new slot at
 * the cap with ProviderKeyLimitError and keeps the bound exact under
 * concurrent saves (a conditional INSERT — the custom-provider cap
 * precedent); the settings route answers 400 first.
 */
export const MAX_KEYS_PER_PROVIDER = 8;
const LEGACY_KEY_ID = "";
const keyIdEncoder = new TextEncoder();
/**
 * Custom-provider declaration bounds (AL-23-2 verdict): provider id
 * `[a-z0-9][a-z0-9-]{0,63}` (the credential-payload pool key the consumer
 * emits),
 * baseUrl https-only ≤2048, model_ids 1..MAX_CUSTOM_PROVIDER_MODEL_IDS
 * entries × ≤128 characters (AL-23-1).
 * The route answers 400 first; the store re-validates as the backstop for
 * direct callers (the ProviderKeyTooLongError pattern).
 */
export const CUSTOM_PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MAX_CUSTOM_PROVIDER_BASE_URL_LENGTH = 2048;
export const MAX_CUSTOM_PROVIDER_MODEL_ID_LENGTH = 128;
/**
 * Declarations per App bound (QC wave-1 W-2): the last AL-23-2 input
 * dimension left unbounded. Every declaration rides the container exec env
 * (decrypted key, ≤4096 chars each) and the runner input JSON, so an App
 * accumulating declarations grows both without limit. Growth-only: updating
 * an already-declared provider id never counts against the cap (the store
 * and the route both allow it at the cap — same spirit as the inclusive
 * model_ids bound).
 */
export const MAX_CUSTOM_PROVIDER_COUNT = 8;

/**
 * Cloudflare account id bound (spec §5 — the workers-ai
 * template's base URL placeholder): Cloudflare account ids are 32 hex
 * characters (the `{account_id}` slot of
 * `https://api.cloudflare.com/client/v4/accounts/{account_id}/ai/v1`).
 * The template materialization route rejects anything else before the
 * substituted base URL is verified/stored.
 */
export const CLOUDFLARE_ACCOUNT_ID_PATTERN = /^[0-9a-f]{32}$/i;

/**
 * Model selector/chain input bound (AL-23-2 verdict): the save-chain
 * `model_chain` and each save-roles role
 * selector are capped at 400 characters at the ROUTE (400 re-render, zero
 * writes); the store keeps whatever it is given verbatim — the cap is an
 * input bound, not a storage shape.
 */
export const MAX_MODEL_SELECTOR_LENGTH = 400;

/**
 * The reserved default-chain row name (spec §4.4): the default chain row
 * keeps this name; named chains must not use it (route AND store reject).
 * A seat reference of "default" (or a blank reference) means "use the
 * default chain" — the reference row is never stored for it.
 */
export const DEFAULT_CHAIN_NAME = "default";
/**
 * Named-chain name grammar (spec §4.4): the same
 * `[a-z0-9][a-z0-9-]{0,63}` identifier shape as custom-provider ids (the
 * established identifier convention in this module). The backfill's
 * `seat-<role>` names fit it. "default" is excluded by the reserved-name
 * check, not by the grammar.
 */
export const MODEL_CHAIN_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MAX_MODEL_CHAIN_NAME_LENGTH = 64;

/**
 * Chain-name error: an upsertModelChain/removeModelChain call
 * named the reserved "default" row or a name outside the
 * MODEL_CHAIN_NAME_PATTERN grammar. The settings route re-renders 400
 * first; this typed throw is the backstop for direct callers (the
 * UnknownModelRoleError convention).
 */
export class InvalidModelChainNameError extends Error {
  constructor(name: string) {
    super(
      `invalid model chain name ${JSON.stringify(name)}: 1–64 lowercase letters, digits or hyphens; "default" is reserved`,
    );
    this.name = "InvalidModelChainNameError";
  }
}

/**
 * Unknown-chain error: a setModelChainSeat/setModelChainSeats
 * call referenced a chain name with no stored row for the App. The settings
 * route re-renders 400 first; this typed throw is the backstop for direct
 * callers (the UnknownModelRoleError convention).
 */
export class UnknownModelChainError extends Error {
  constructor(name: string) {
    super(`unknown model chain ${JSON.stringify(name)}`);
    this.name = "UnknownModelChainError";
  }
}

/**
 * Declaration-shape error: an upsertCustomProvider call named
 * an id outside the `[a-z0-9][a-z0-9-]{0,63}` grammar, an id colliding with
 * a built-in (PROVIDER_IDS), a non-https or over-length base URL, an api outside the
 * AL-23-1 three-form enum, an empty / over-long / over-count model_ids list,
 * an empty key, or a NEW declaration at the MAX_CUSTOM_PROVIDER_COUNT cap
 * (QC wave-1 W-2). The settings route re-renders 400 first; this typed throw
 * is the backstop for direct callers (the UnknownModelRoleError convention).
 */
export class InvalidCustomProviderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidCustomProviderError";
  }
}

/**
 * Input-bound error: the plaintext key passed to addProviderKey /
 * addCustomProviderKey / saveVerifiedKey / upsertCustomProvider
 * exceeds MAX_PROVIDER_KEY_LENGTH. The settings route never surfaces it —
 * it validates the same bound first and re-renders 400 — so this typed throw
 * is the backstop for any caller that skips the route. Same class convention
 * as SecretboxKeyError (name set for structured logs).
 */
export class ProviderKeyTooLongError extends Error {
  constructor() {
    super(`provider API key exceeds the ${MAX_PROVIDER_KEY_LENGTH}-character limit`);
    this.name = "ProviderKeyTooLongError";
  }
}

/**
 * Pool-bound error: an addProviderKey / addCustomProviderKey /
 * saveVerifiedKey / upsertCustomProvider call would add a key to a
 * (App, provider) pool that already holds MAX_KEYS_PER_PROVIDER of them.
 * Re-submitting a stored key is an update, never growth, so it does not hit
 * this. The settings route re-renders 400 first; this typed throw is the
 * backstop for direct callers (the ProviderKeyTooLongError convention).
 */
export class ProviderKeyLimitError extends Error {
  constructor(provider: string) {
    super(`provider ${JSON.stringify(provider)} already holds the ${MAX_KEYS_PER_PROVIDER}-key limit`);
    this.name = "ProviderKeyLimitError";
  }
}

/**
 * Endpoint-lock error: an upsertCustomProvider call would rewrite a
 * declaration's base_url / api while its key pool still holds credentials
 * that were verified against the CURRENT endpoint — those retained keys would
 * then be sent to an endpoint they were never verified for. Removing the pool
 * first (or declaring the endpoint before any key exists) stays allowed. The
 * settings route answers a keyed 400 first; this typed throw is the backstop
 * for direct callers (the ProviderKeyLimitError convention).
 */
export class ProviderEndpointLockedError extends Error {
  constructor(provider: string) {
    super(
      `custom provider ${JSON.stringify(provider)} already holds keys for its current endpoint — remove them before changing its base URL or API protocol`,
    );
    this.name = "ProviderEndpointLockedError";
  }
}

/**
 * Role-vocabulary error: a setModelChainSeat/setModelChainSeats/
 * clearModelChainSeat call named a role outside MODEL_ROLE_IDS. The
 * settings route re-renders 400 first; this typed throw
 * is the backstop for direct callers. Same class convention as
 * ProviderKeyTooLongError (name set for structured logs).
 */
export class UnknownModelRoleError extends Error {
  constructor(role: string) {
    super(
      `unknown model role ${JSON.stringify(role)} (expected one of: ${MODEL_ROLE_IDS.join(", ")})`,
    );
    this.name = "UnknownModelRoleError";
  }
}

/**
 * Selector-grammar error: a role selector with content parses to
 * ZERO comma-separated selectors (e.g. only commas/whitespace — the same
 * parseModelChain mirror the save-chain route 400s against). A BLANK selector
 * is NOT an error: it clears the mapping (the setModelChain 空 = 清除
 * convention).
 */
export class InvalidModelSelectorError extends Error {
  constructor(selector: string) {
    super(
      `invalid model selector chain ${JSON.stringify(selector)}: at least one comma-separated model selector required`,
    );
    this.name = "InvalidModelSelectorError";
  }
}

function providerKeyAad(appId: string, provider: string, keyId: string): string {
  return `app_provider_keys.key_enc:${appId}:${provider}:${keyId}`;
}
function customProviderKeyAad(appId: string, provider: string, keyId: string): string {
  return `app_custom_provider_keys.key_enc:${appId}:${provider}:${keyId}`;
}
function legacyProviderKeyAad(appId: string, provider: string): string {
  return `app_provider_keys.key_enc:${appId}:${provider}`;
}
function legacyCustomProviderAad(appId: string, providerId: string): string {
  return `app_custom_providers.api_key_enc:${appId}:${providerId}`;
}
async function providerKeyId(plainKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", keyIdEncoder.encode(plainKey));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

export function isValidCustomProviderBaseUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.hostname !== "";
  } catch {
    return false;
  }
}

/**
 * The model_ids bound, stated ONCE: 1..MAX_CUSTOM_PROVIDER_MODEL_IDS entries,
 * each non-blank and ≤ MAX_CUSTOM_PROVIDER_MODEL_ID_LENGTH characters. Shared
 * by the declaration gate (assertCustomProvider) and the in-place model-list
 * update, so the two write paths can never disagree on the bound.
 */
export function assertCustomProviderModelIds(modelIds: readonly string[]): void {
  if (modelIds.length === 0) {
    throw new InvalidCustomProviderError("custom provider model_ids must not be empty");
  }
  if (modelIds.length > MAX_CUSTOM_PROVIDER_MODEL_IDS) {
    throw new InvalidCustomProviderError(
      `custom provider model_ids exceed the ${MAX_CUSTOM_PROVIDER_MODEL_IDS}-entry limit`,
    );
  }
  for (const id of modelIds) {
    if (id.trim() === "") {
      throw new InvalidCustomProviderError("custom provider model_ids must not contain empty entries");
    }
    if (id.length > MAX_CUSTOM_PROVIDER_MODEL_ID_LENGTH) {
      throw new InvalidCustomProviderError(
        `custom provider model id exceeds the ${MAX_CUSTOM_PROVIDER_MODEL_ID_LENGTH}-character limit`,
      );
    }
  }
}

/**
 * The metadata overlay's write gate, stated once: every key must be one of the
 * ids the SAME declaration carries (an overlay entry for a model the provider
 * does not serve is unreachable data), and every stated field must have the
 * shape `customProviderModelMetaProblem` accepts. The error names the offending
 * model id and field — the settings route re-renders it — and the caller writes
 * nothing. A declaration that states nothing passes: an id-only row is stored,
 * never refused (it is shown as saved-but-not-usable, not silently completed).
 */
export function assertCustomProviderModelsMeta(
  meta: CustomProviderModelsMeta | undefined,
  modelIds: readonly string[],
): void {
  if (meta === undefined) return;
  if (meta === null || typeof meta !== "object" || Array.isArray(meta)) {
    throw new InvalidCustomProviderError("custom provider models_meta must be an object keyed by model id");
  }
  for (const [modelId, value] of Object.entries(meta)) {
    if (!modelIds.includes(modelId)) {
      throw new InvalidCustomProviderError(
        `custom provider models_meta names model ${JSON.stringify(modelId)}, which is not in model_ids`,
      );
    }
    if (value === null) continue;
    const problem = customProviderModelMetaProblem(modelId, value);
    if (problem !== null) throw new InvalidCustomProviderError(`custom provider models_meta: ${problem}`);
  }
}

function assertCustomProvider(decl: AppCustomProvider, plainKey: string): void {
  if (!CUSTOM_PROVIDER_ID_PATTERN.test(decl.provider_id)) {
    throw new InvalidCustomProviderError(
      `invalid custom provider id ${JSON.stringify(decl.provider_id)} (expected [a-z0-9][a-z0-9-]{0,63})`,
    );
  }
  if (PROVIDER_IDS.includes(decl.provider_id)) {
    throw new InvalidCustomProviderError(
      `custom provider id ${JSON.stringify(decl.provider_id)} collides with a built-in provider id`,
    );
  }
  if (!isValidCustomProviderBaseUrl(decl.base_url)) {
    throw new InvalidCustomProviderError(
      `custom provider base URL must be a valid https URL with a host: ${JSON.stringify(decl.base_url)}`,
    );
  }
  if (decl.base_url.length > MAX_CUSTOM_PROVIDER_BASE_URL_LENGTH) {
    throw new InvalidCustomProviderError(
      `custom provider base URL exceeds the ${MAX_CUSTOM_PROVIDER_BASE_URL_LENGTH}-character limit`,
    );
  }
  if (!CUSTOM_PROVIDER_API_IDS.includes(decl.api)) {
    throw new InvalidCustomProviderError(
      `unknown custom provider API ${JSON.stringify(decl.api)} (expected one of: ${CUSTOM_PROVIDER_API_IDS.join(", ")})`,
    );
  }
  assertCustomProviderModelIds(decl.model_ids);
  assertCustomProviderModelsMeta(decl.models_meta, decl.model_ids);
  if (plainKey === "") {
    throw new InvalidCustomProviderError("custom provider API key is required at declaration");
  }
  if (plainKey.length > MAX_PROVIDER_KEY_LENGTH) {
    throw new ProviderKeyTooLongError();
  }
}

function assertModelRole(role: string): void {
  if (!MODEL_ROLE_IDS.includes(role)) {
    throw new UnknownModelRoleError(role);
  }
}

function assertModelChainName(name: string): void {
  if (name === DEFAULT_CHAIN_NAME) {
    throw new InvalidModelChainNameError(name);
  }
  if (!MODEL_CHAIN_NAME_PATTERN.test(name)) {
    throw new InvalidModelChainNameError(name);
  }
}

function maskTail(plainKey: string): string {
  return plainKey.length > 4 ? plainKey.slice(-4) : "";
}

/**
 * One stored key as the settings faces see it (listProviderKeys /
 * listCustomProviderKeys): the provider it belongs to, its derived key id
 * (the handle a per-key delete or re-verify call takes), the masked tail and
 * the per-key bookkeeping. The plaintext NEVER appears on this face.
 */
export type ProviderKeySummary = {
  provider: string;
  keyId: string;
  last4: string;
  updatedAt: string | null;
  verifiedAt: string | null;
  verifiedStatus: string | null;
};

/** The decrypted per-App configuration (the consumer face). */
export type AppConfig = {
  appId: string;
  keys: Record<string, string[]>;
  modelChain: string | null;
};

/** One chain as the settings face sees it (spec §4.4). */
export type AppModelChain = {
  name: string;
  chain: string;
  is_default: boolean;
  created_at: string;
  updated_at: string;
};

/**
 * One statement's result inside a D1 `batch()` (order matches input).
 * Declared locally — same shape as src/store/types.ts `D1BatchResult`.
 */
export type AppConfigBatchResult = {
  results: unknown[];
  meta: { changes: number; last_row_id: number };
};

/**
 * The D1 `batch` face alone (exported for callers): a holder of a narrower
 * D1 face that lacks batch (e.g. users.ts `DashboardD1`) intersects with
 * this — truthful for the runtime D1Database binding and the bun:sqlite
 * test double, which both implement batch.
 */
export type AppConfigBatchFace = {
  batch(statements: AppConfigStatement[]): Promise<AppConfigBatchResult[]>;
};

/**
 * Narrow D1 face, declared locally so this leaf module imports nothing
 * structural: prepare/bind/first/all/run for every single-statement write,
 * plus `batch` for the atomic multi-write faces (spec §4.4):
 * setModelChain's default-row clear-then-set, setModelChainSeats' full-map
 * save, and removeModelChain's seat-reference cascade. A real
 * `D1Database`, the bun:sqlite test double (tests/store/helpers.ts) and
 * the store layer's `D1Like` all satisfy it structurally.
 */
export type AppConfigStatement = {
  bind(...values: unknown[]): AppConfigStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run<T = Record<string, unknown>>(): Promise<{
    results: T[];
    meta: { changes: number; last_row_id: number };
  }>;
};

export type AppConfigD1 = {
  prepare(query: string): AppConfigStatement;
  batch(statements: AppConfigStatement[]): Promise<AppConfigBatchResult[]>;
};

/**
 * Create the per-App config store over one D1 handle, bound to the envelope
 * master key (the raw DASHBOARD_ENCRYPTION_KEY value — NOT validated here;
 * lazy first-use, same contract as createSecretbox).
 */
/** F12: whose bot a configuration write targets, and the authority claimed. */
export type BotWriteAuthority = {
  botId: string;
  workspaceId: string;
  role: WorkspaceRole;
};

/** F12: the store's own refusal — a mutation without authority never runs. */
export class BotWriteForbiddenError extends Error {
  constructor(botId: string) {
    super(`bot configuration write refused for ${JSON.stringify(botId)}`);
    this.name = "BotWriteForbiddenError";
  }
}

export function createAppConfigStore(db: AppConfigD1, encryptionKey: string | undefined) {
  const box = createSecretbox(encryptionKey);

  /**
   * F12: the store boundary guard every bot configuration mutation runs FIRST.
   * Ownership is `review_bots.workspace_id` (D5/D34 — no App owns a bot), and
   * the role must be owner or admin. A caller that bypasses the route — a
   * future code path, a test, a maintenance script — is refused here too.
   */
  async function requireBotWrite(authority: BotWriteAuthority | undefined): Promise<void> {
    if (authority === undefined) throw new BotWriteForbiddenError("(no authority)");
    if (authority.role !== "owner" && authority.role !== "admin") {
      throw new BotWriteForbiddenError(authority.botId);
    }
    // `review_bots` has ONE reader module (apps-store); the guard asks it
    // rather than opening a second read site.
    const owner = await readBotOwnerWorkspace(db, authority.botId);
    if (owner === null || owner !== authority.workspaceId) {
      throw new BotWriteForbiddenError(authority.botId);
    }
  }

  type KeyTable = {
    table: "bot_provider_keys" | "bot_custom_provider_keys";
    aad: (appId: string, provider: string, keyId: string) => string;
    legacyAad: (appId: string, provider: string) => string;
    owner?: { table: string; column: string };
  };
  const PROVIDER_KEY_TABLE: KeyTable = {
    table: "bot_provider_keys",
    aad: providerKeyAad,
    legacyAad: legacyProviderKeyAad,
  };
  const CUSTOM_KEY_TABLE: KeyTable = {
    table: "bot_custom_provider_keys",
    aad: customProviderKeyAad,
    legacyAad: legacyCustomProviderAad,
    owner: { table: "bot_custom_providers", column: "provider_id" },
  };

  function byAscii(left: string, right: string): number {
    if (left === right) return 0;
    return left < right ? -1 : 1;
  }

  async function promoteLegacyKeyRow(spec: KeyTable, row: AppProviderKeyRow): Promise<AppProviderKeyRow> {
    const plain = await box.decryptSecret(row.key_enc, spec.legacyAad(row.bot_id, row.provider));
    const keyId = await providerKeyId(plain);
    const keyEnc = await box.encryptSecret(plain, spec.aad(row.bot_id, row.provider, keyId));
    await db.batch([
      db
        .prepare(
          `DELETE FROM ${spec.table} WHERE bot_id = ? AND provider = ? AND key_id = ? AND EXISTS (
             SELECT 1 FROM ${spec.table} WHERE bot_id = ? AND provider = ? AND key_id = ?
           )`,
        )
        .bind(row.bot_id, row.provider, LEGACY_KEY_ID, row.bot_id, row.provider, keyId),
      db
        .prepare(`UPDATE ${spec.table} SET key_id = ?, key_enc = ? WHERE bot_id = ? AND provider = ? AND key_id = ?`)
        .bind(keyId, keyEnc, row.bot_id, row.provider, LEGACY_KEY_ID),
    ]);
    return { ...row, key_id: keyId, key_enc: keyEnc };
  }

  async function readKeyRows(spec: KeyTable, appId: string, provider?: string): Promise<AppProviderKeyRow[]> {
    const res =
      provider === undefined
        ? await db.prepare(`SELECT * FROM ${spec.table} WHERE bot_id = ?`).bind(appId).all<AppProviderKeyRow>()
        : await db
            .prepare(`SELECT * FROM ${spec.table} WHERE bot_id = ? AND provider = ?`)
            .bind(appId, provider)
            .all<AppProviderKeyRow>();
    const rows: AppProviderKeyRow[] = [];
    for (const row of res.results) {
      rows.push(row.key_id === LEGACY_KEY_ID ? await promoteLegacyKeyRow(spec, row) : row);
    }
    rows.sort(
      (left, right) =>
        byAscii(left.provider, right.provider) ||
        byAscii(left.created_at, right.created_at) ||
        byAscii(left.key_id, right.key_id),
    );
    return rows;
  }

  function poolAdmission(spec: KeyTable): string {
    return `((SELECT COUNT(*) FROM ${spec.table} WHERE bot_id = ? AND provider = ?) < ${MAX_KEYS_PER_PROVIDER}
             OR EXISTS (SELECT 1 FROM ${spec.table} WHERE bot_id = ? AND provider = ? AND key_id = ?))`;
  }

  function declarationGrowthAdmission(): string {
    return `((SELECT COUNT(*) FROM bot_custom_providers WHERE bot_id = ?) < ${MAX_CUSTOM_PROVIDER_COUNT}
             OR EXISTS (SELECT 1 FROM bot_custom_providers WHERE bot_id = ? AND provider_id = ?))`;
  }

  function keyInsertStatement(
    spec: KeyTable,
    appId: string,
    provider: string,
    keyId: string,
    keyEnc: string,
    opts: { verifiedStatus: VerifiedStatus | null; newDeclaration?: boolean; endpoint?: { base_url: string; api: string } },
  ): AppConfigStatement {
    const verifiedAt = opts.verifiedStatus === null ? "NULL" : "(SELECT ts FROM now)";
    const verifiedStatus = opts.verifiedStatus === null ? "NULL" : `'${opts.verifiedStatus}'`;
    let ownership = "";
    if (spec.owner !== undefined) {
      const declaration = `SELECT 1 FROM ${spec.owner.table} WHERE bot_id = ? AND ${spec.owner.column} = ?`;
      if (opts.endpoint === undefined) {
        ownership = opts.newDeclaration === true ? "" : ` AND EXISTS (${declaration})`;
      } else {
        ownership =
          opts.newDeclaration === true
            ? ` AND NOT EXISTS (${declaration} AND (base_url <> ? OR api <> ?))`
            : ` AND EXISTS (${declaration} AND base_url = ? AND api = ?)`;
      }
    }
    const growth = opts.newDeclaration === true ? ` AND ${declarationGrowthAdmission()}` : "";
    const bind = [appId, provider, keyId, keyEnc, appId, provider, appId, provider, keyId];
    if (spec.owner !== undefined) {
      bind.push(appId, provider);
      if (opts.endpoint !== undefined) bind.push(opts.endpoint.base_url, opts.endpoint.api);
    }
    if (opts.newDeclaration === true) bind.push(appId, appId, provider);
    return db
      .prepare(
        `WITH now AS (SELECT datetime('now') AS ts)
         INSERT INTO ${spec.table} (bot_id, provider, key_id, key_enc, created_at, updated_at, verified_at, verified_status)
         SELECT ?, ?, ?, ?, (SELECT ts FROM now), (SELECT ts FROM now), ${verifiedAt}, ${verifiedStatus}
         WHERE ${poolAdmission(spec)}${ownership}${growth}
         ON CONFLICT (bot_id, provider, key_id) DO UPDATE SET
           key_enc = excluded.key_enc,
           updated_at = excluded.updated_at,
           verified_at = excluded.verified_at,
           verified_status = excluded.verified_status`,
      )
      .bind(...bind);
  }

  async function throwKeyRefusal(
    spec: KeyTable,
    appId: string,
    provider: string,
    endpoint?: { base_url: string; api: string },
  ): Promise<never> {
    if (spec.owner !== undefined) {
      const decl = await db
        .prepare(`SELECT base_url, api FROM ${spec.owner.table} WHERE bot_id = ? AND ${spec.owner.column} = ?`)
        .bind(appId, provider)
        .first<{ base_url: string; api: string }>();
      if (decl === null) {
        throw new InvalidCustomProviderError(`custom provider ${JSON.stringify(provider)} is not declared for this app`);
      }
      if (endpoint !== undefined && (decl.base_url !== endpoint.base_url || decl.api !== endpoint.api)) {
        const count = await db
          .prepare(`SELECT COUNT(*) AS n FROM bot_custom_provider_keys WHERE bot_id = ? AND provider = ?`)
          .bind(appId, provider)
          .first<{ n: number }>();
        if ((count?.n ?? 0) >= MAX_KEYS_PER_PROVIDER) throw new ProviderKeyLimitError(provider);
        throw new ProviderEndpointLockedError(provider);
      }
    }
    throw new ProviderKeyLimitError(provider);
  }

  async function throwCustomProviderRefusal(
    appId: string,
    decl: AppCustomProvider,
    keyId: string,
    creating: boolean,
  ): Promise<never> {
    if (creating) {
      const countRow = await db
        .prepare(`SELECT COUNT(*) AS n FROM bot_custom_providers WHERE bot_id = ?`)
        .bind(appId)
        .first<{ n: number }>();
      if ((countRow?.n ?? 0) >= MAX_CUSTOM_PROVIDER_COUNT) {
        throw new InvalidCustomProviderError(`custom provider cap (${MAX_CUSTOM_PROVIDER_COUNT}) reached`);
      }
    }
    const pool = await db
      .prepare(
        `SELECT COUNT(*) AS n,
                EXISTS (SELECT 1 FROM bot_custom_provider_keys WHERE bot_id = ? AND provider = ? AND key_id = ?) AS present
           FROM bot_custom_provider_keys WHERE bot_id = ? AND provider = ?`,
      )
      .bind(appId, decl.provider_id, keyId, appId, decl.provider_id)
      .first<{ n: number; present: number }>();
    if ((pool?.n ?? 0) >= MAX_KEYS_PER_PROVIDER && (pool?.present ?? 0) === 0) {
      throw new ProviderKeyLimitError(decl.provider_id);
    }
    const stored = await db
      .prepare(`SELECT base_url, api FROM bot_custom_providers WHERE bot_id = ? AND provider_id = ?`)
      .bind(appId, decl.provider_id)
      .first<{ base_url: string; api: string }>();
    if (stored === null) {
      throw new InvalidCustomProviderError(
        creating
          ? `custom provider cap (${MAX_CUSTOM_PROVIDER_COUNT}) reached`
          : `custom provider ${JSON.stringify(decl.provider_id)} is not declared for this app`,
      );
    }
    throw new ProviderEndpointLockedError(decl.provider_id);
  }

  async function addKey(
    spec: KeyTable,
    appId: string,
    provider: string,
    plainKey: string,
    opts: { verifiedStatus: VerifiedStatus | null; models?: string[]; endpoint?: { base_url: string; api: string } },
  ): Promise<void> {
    if (plainKey.length > MAX_PROVIDER_KEY_LENGTH) {
      throw new ProviderKeyTooLongError();
    }
    await readKeyRows(spec, appId, provider);
    const keyId = await providerKeyId(plainKey);
    const keyEnc = await box.encryptSecret(plainKey, spec.aad(appId, provider, keyId));
    const keyStatement = keyInsertStatement(spec, appId, provider, keyId, keyEnc, opts);
    if (opts.models === undefined) {
      const res = await keyStatement.run();
      if (res.meta.changes === 0) await throwKeyRefusal(spec, appId, provider, opts.endpoint);
      return;
    }
    const res = await db.batch([
      keyStatement,
      db
        .prepare(
          `WITH now AS (SELECT datetime('now') AS ts)
           INSERT INTO bot_provider_models (bot_id, provider, key_id, models_json, fetched_at)
           SELECT ?, ?, ?, ?, (SELECT ts FROM now)
           WHERE EXISTS (SELECT 1 FROM ${spec.table} WHERE bot_id = ? AND provider = ? AND key_id = ?)
           ON CONFLICT (bot_id, provider, key_id) DO UPDATE SET
             models_json = excluded.models_json,
             fetched_at = excluded.fetched_at`,
        )
        .bind(
          appId,
          provider,
          keyId,
          JSON.stringify(opts.models),
          appId,
          provider,
          keyId,
        ),
    ]);
    if (res[0]!.meta.changes === 0) await throwKeyRefusal(spec, appId, provider, opts.endpoint);
  }

  async function summarizeKeyRow(spec: KeyTable, row: AppProviderKeyRow): Promise<ProviderKeySummary> {
    const plain = await box.decryptSecret(row.key_enc, spec.aad(row.bot_id, row.provider, row.key_id));
    return {
      provider: row.provider,
      keyId: row.key_id,
      last4: maskTail(plain),
      updatedAt: row.updated_at,
      verifiedAt: row.verified_at,
      verifiedStatus: row.verified_status,
    };
  }

  async function readModelChain(appId: string): Promise<string | null> {
    const row = await db
      .prepare(`SELECT chain FROM bot_model_chains WHERE bot_id = ? AND name = ?`)
      .bind(appId, DEFAULT_CHAIN_NAME)
      .first<Pick<AppModelChainRow, "chain">>();
    return row?.chain ?? null;
  }

  async function readModelChainSeats(appId: string): Promise<Record<string, string>> {
    const res = await db
      .prepare(`SELECT role, chain_name FROM bot_model_chain_seats WHERE bot_id = ? ORDER BY role ASC`)
      .bind(appId)
      .all<Pick<AppModelChainSeatRow, "role" | "chain_name">>();
    const seats: Record<string, string> = {};
    for (const row of res.results) {
      seats[row.role] = row.chain_name;
    }
    return seats;
  }

  async function readModelOverrides(appId: string): Promise<Record<string, string>> {
    const seats = await db
      .prepare(`SELECT role, chain_name FROM bot_model_chain_seats WHERE bot_id = ? ORDER BY role ASC`)
      .bind(appId)
      .all<Pick<AppModelChainSeatRow, "role" | "chain_name">>();
    if (seats.results.length === 0) return {};
    const chains = await db
      .prepare(`SELECT name, chain FROM bot_model_chains WHERE bot_id = ?`)
      .bind(appId)
      .all<Pick<AppModelChainRow, "name" | "chain">>();
    const chainByName = new Map(chains.results.map((row) => [row.name, row.chain]));
    const overrides: Record<string, string> = {};
    for (const seat of seats.results) {
      if (seat.chain_name === DEFAULT_CHAIN_NAME) continue;
      const chain = chainByName.get(seat.chain_name);
      if (chain === undefined) {
        throw new Error(
          `app-config-store: app ${appId}: seat ${seat.role} references missing chain ${JSON.stringify(seat.chain_name)}`,
        );
      }
      overrides[seat.role] = chain;
    }
    return overrides;
  }

  function deleteModelChainSeatStatement(appId: string, role: string): AppConfigStatement {
    return db.prepare(`DELETE FROM bot_model_chain_seats WHERE bot_id = ? AND role = ?`).bind(appId, role);
  }

  function upsertModelChainSeatStatement(appId: string, role: string, chainName: string): AppConfigStatement {
    return db
      .prepare(
        `INSERT INTO bot_model_chain_seats (bot_id, role, chain_name)
         VALUES (?, ?, ?)
         ON CONFLICT (bot_id, role) DO UPDATE SET
           chain_name = excluded.chain_name`,
      )
      .bind(appId, role, chainName);
  }

  async function deleteModelChainSeat(appId: string, role: string): Promise<void> {
    await deleteModelChainSeatStatement(appId, role).run();
  }

  async function upsertModelChainSeat(appId: string, role: string, chainName: string): Promise<void> {
    await upsertModelChainSeatStatement(appId, role, chainName).run();
  }

  async function assertChainExists(appId: string, chainName: string): Promise<void> {
    const row = await db
      .prepare(`SELECT name FROM bot_model_chains WHERE bot_id = ? AND name = ?`)
      .bind(appId, chainName)
      .first<{ name: string }>();
    if (!row) throw new UnknownModelChainError(chainName);
  }

  return {
    async addProviderKey(
      authority: BotWriteAuthority,
      appId: string,
      provider: string,
      plainKey: string,
    ): Promise<void> {
      await requireBotWrite(authority);
      return addKey(PROVIDER_KEY_TABLE, appId, provider, plainKey, { verifiedStatus: null });
    },

    async saveVerifiedKey(
      authority: BotWriteAuthority,
      appId: string,
      provider: string,
      plainKey: string,
      models: string[],
    ): Promise<void> {
      await requireBotWrite(authority);
      return addKey(PROVIDER_KEY_TABLE, appId, provider, plainKey, {
        verifiedStatus: builtinProbeCanRejectKey(provider) ? "ok" : "reachable",
        models,
      });
    },

    async deleteProviderKey(
      authority: BotWriteAuthority,
      appId: string,
      provider: string,
      keyId: string,
    ): Promise<boolean> {
      await requireBotWrite(authority);
      await readKeyRows(PROVIDER_KEY_TABLE, appId, provider);
      const res = await db.batch([
        db
          .prepare(`DELETE FROM bot_provider_keys WHERE bot_id = ? AND provider = ? AND key_id = ?`)
          .bind(appId, provider, keyId),
        db
          .prepare(
            `DELETE FROM bot_provider_models WHERE bot_id = ? AND provider = ? AND key_id = ? AND changes() > 0`,
          )
          .bind(appId, provider, keyId),
      ]);
      return res[0]!.meta.changes > 0;
    },

    async listProviderKeys(appId: string, provider?: string): Promise<ProviderKeySummary[]> {
      const rows = await readKeyRows(PROVIDER_KEY_TABLE, appId, provider);
      const summary: ProviderKeySummary[] = [];
      for (const row of rows) {
        summary.push(await summarizeKeyRow(PROVIDER_KEY_TABLE, row));
      }
      return summary;
    },

    async getProviderKeyPlaintext(
      appId: string,
      provider: string,
      keyId: string,
    ): Promise<{ plainKey: string; custom: boolean } | null> {
      for (const { spec, custom } of [
        { spec: PROVIDER_KEY_TABLE, custom: false },
        { spec: CUSTOM_KEY_TABLE, custom: true },
      ]) {
        const row = (await readKeyRows(spec, appId, provider)).find((candidate) => candidate.key_id === keyId);
        if (row === undefined) continue;
        return {
          plainKey: await box.decryptSecret(row.key_enc, spec.aad(row.bot_id, row.provider, row.key_id)),
          custom,
        };
      }
      return null;
    },

    async setModelChain(authority: BotWriteAuthority, appId: string, chain: string | null): Promise<void> {
      await requireBotWrite(authority);
      if (chain === null || chain.trim() === "") {
        await db
          .prepare(`DELETE FROM bot_model_chains WHERE bot_id = ? AND name = ?`)
          .bind(appId, DEFAULT_CHAIN_NAME)
          .run();
        return;
      }
      await db.batch([
        db
          .prepare(`UPDATE bot_model_chains SET is_default = 0 WHERE bot_id = ? AND is_default = 1`)
          .bind(appId),
        db
          .prepare(
            `INSERT INTO bot_model_chains (bot_id, name, chain, is_default, created_at, updated_at)
             VALUES (?, ?, ?, 1, datetime('now'), datetime('now'))
             ON CONFLICT (bot_id, name) DO UPDATE SET
               chain = excluded.chain,
               is_default = 1,
               updated_at = datetime('now')`,
          )
          .bind(appId, DEFAULT_CHAIN_NAME, chain),
      ]);
    },

    getModelChain(appId: string): Promise<string | null> {
      return readModelChain(appId);
    },

    async getAppConfig(appId: string): Promise<AppConfig> {
      const rows = await readKeyRows(PROVIDER_KEY_TABLE, appId);
      const keys: Record<string, string[]> = {};
      for (const row of rows) {
        const plain = await box.decryptSecret(row.key_enc, providerKeyAad(row.bot_id, row.provider, row.key_id));
        (keys[row.provider] ??= []).push(plain);
      }
      return { appId, keys, modelChain: await readModelChain(appId) };
    },

    async getVerifiedModels(appId: string): Promise<VerifiedModels[]> {
      const evidence = await db
        .prepare(`SELECT * FROM bot_provider_models WHERE bot_id = ? ORDER BY provider ASC, key_id ASC`)
        .bind(appId)
        .all<AppProviderModelsRow>();
      const rows = await readKeyRows(PROVIDER_KEY_TABLE, appId);
      const byProvider = new Map<string, Map<string, string[]>>();
      for (const row of evidence.results) {
        const provider = RETIRED_PROVIDER_ALIASES[row.provider] ?? row.provider;
        const perKey = byProvider.get(provider) ?? new Map<string, string[]>();
        perKey.set(row.key_id, parseModelIdsJson(row.models_json, "bot_provider_models.models_json"));
        byProvider.set(provider, perKey);
      }
      const entries: VerifiedModels[] = [];
      for (const [provider, perKey] of byProvider) {
        const poolKeyIds = new Set(
          rows.filter((row) => row.provider === provider).map((row) => row.key_id),
        );
        if (poolKeyIds.size === 0) continue;
        let models: string[] | null = null;
        for (const keyId of poolKeyIds) {
          const report = perKey.get(keyId);
          if (report === undefined) {
            models = null;
            break;
          }
          models = models === null ? report : models.filter((model) => report.includes(model));
        }
        const fetchedAt = evidence.results
          .filter((row) => (RETIRED_PROVIDER_ALIASES[row.provider] ?? row.provider) === provider)
          .reduce((latest, row) => (row.fetched_at > latest ? row.fetched_at : latest), "");
        entries.push({ provider, models: models ?? [], fetched_at: fetchedAt });
      }
      return entries;
    },

    async getModelChains(appId: string): Promise<AppModelChain[]> {
      const res = await db
        .prepare(`SELECT * FROM bot_model_chains WHERE bot_id = ? ORDER BY name ASC`)
        .bind(appId)
        .all<AppModelChainRow>();
      return res.results.map((row) => ({
        name: row.name,
        chain: row.chain,
        is_default: row.is_default !== 0,
        created_at: row.created_at,
        updated_at: row.updated_at,
      }));
    },

    async upsertModelChain(
      authority: BotWriteAuthority,
      appId: string,
      name: string,
      chain: string,
    ): Promise<void> {
      await requireBotWrite(authority);
      assertModelChainName(name);
      if (chain.trim() === "") {
        throw new InvalidModelSelectorError(chain);
      }
      await db
        .prepare(
          `INSERT INTO bot_model_chains (bot_id, name, chain, is_default, created_at, updated_at)
           VALUES (?, ?, ?, 0, datetime('now'), datetime('now'))
           ON CONFLICT (bot_id, name) DO UPDATE SET
             chain = excluded.chain,
             is_default = excluded.is_default,
             updated_at = datetime('now')`,
        )
        .bind(appId, name, chain)
        .run();
    },

    async removeModelChain(authority: BotWriteAuthority, appId: string, name: string): Promise<boolean> {
      await requireBotWrite(authority);
      assertModelChainName(name);
      const res = await db.batch([
        db.prepare(`DELETE FROM bot_model_chain_seats WHERE bot_id = ? AND chain_name = ?`).bind(appId, name),
        db.prepare(`DELETE FROM bot_model_chains WHERE bot_id = ? AND name = ?`).bind(appId, name),
      ]);
      return res[1]!.meta.changes > 0;
    },

    getModelChainSeats(appId: string): Promise<Record<string, string>> {
      return readModelChainSeats(appId);
    },

    async setModelChainSeat(
      authority: BotWriteAuthority,
      appId: string,
      role: string,
      chainName: string,
    ): Promise<void> {
      await requireBotWrite(authority);
      assertModelRole(role);
      const name = chainName.trim();
      if (name === "" || name === DEFAULT_CHAIN_NAME) {
        await deleteModelChainSeat(appId, role);
        return;
      }
      await assertChainExists(appId, name);
      await upsertModelChainSeat(appId, role, name);
    },

    async clearModelChainSeat(authority: BotWriteAuthority, appId: string, role: string): Promise<void> {
      await requireBotWrite(authority);
      assertModelRole(role);
      await deleteModelChainSeat(appId, role);
    },

    async setModelChainSeats(
      authority: BotWriteAuthority,
      appId: string,
      refs: Record<string, string>,
    ): Promise<void> {
      await requireBotWrite(authority);
      const entries = Object.entries(refs);
      for (const [role] of entries) {
        assertModelRole(role);
      }
      const referenced = entries
        .map(([, chainName]) => chainName.trim())
        .filter((name) => name !== "" && name !== DEFAULT_CHAIN_NAME);
      if (referenced.length > 0) {
        const chains = await db
          .prepare(`SELECT name FROM bot_model_chains WHERE bot_id = ?`)
          .bind(appId)
          .all<{ name: string }>();
        const known = new Set(chains.results.map((row) => row.name));
        for (const name of referenced) {
          if (!known.has(name)) throw new UnknownModelChainError(name);
        }
      }
      const statements = entries.map(([role, chainName]) => {
        const name = chainName.trim();
        return name === "" || name === DEFAULT_CHAIN_NAME
          ? deleteModelChainSeatStatement(appId, role)
          : upsertModelChainSeatStatement(appId, role, name);
      });
      if (statements.length > 0) {
        await db.batch(statements);
      }
    },

    getModelOverridesForConsumer(appId: string): Promise<Record<string, string>> {
      return readModelOverrides(appId);
    },
    async upsertCustomProvider(
      authority: BotWriteAuthority,
      appId: string,
      decl: AppCustomProvider,
      plainKey: string,
    ): Promise<void> {
      await requireBotWrite(authority);
      assertCustomProvider(decl, plainKey);
      const stored = await db
        .prepare(`SELECT provider_id, base_url, api FROM bot_custom_providers WHERE bot_id = ? AND provider_id = ?`)
        .bind(appId, decl.provider_id)
        .first<{ provider_id: string; base_url: string; api: string }>();
      const isNew = stored === null;
      const pool = await readKeyRows(CUSTOM_KEY_TABLE, appId, decl.provider_id);
      if (!isNew && pool.length > 0 && (stored.base_url !== decl.base_url || stored.api !== decl.api)) {
        throw new ProviderEndpointLockedError(decl.provider_id);
      }
      if (isNew) {
        const countRow = await db
          .prepare(
            `SELECT COUNT(*) AS n,
                    EXISTS (SELECT 1 FROM bot_custom_providers WHERE bot_id = ? AND provider_id = ?) AS present
               FROM bot_custom_providers WHERE bot_id = ?`,
          )
          .bind(appId, decl.provider_id, appId)
          .first<{ n: number; present: number }>();
        if ((countRow?.n ?? 0) >= MAX_CUSTOM_PROVIDER_COUNT && (countRow?.present ?? 0) === 0) {
          throw new InvalidCustomProviderError(`custom provider cap (${MAX_CUSTOM_PROVIDER_COUNT}) reached`);
        }
      }
      const keyId = await providerKeyId(plainKey);
      const keyEnc = await box.encryptSecret(plainKey, CUSTOM_KEY_TABLE.aad(appId, decl.provider_id, keyId));
      const admissionBinds = [appId, decl.provider_id, appId, decl.provider_id, keyId];
      const declaration = isNew
        ? db
            .prepare(
              `WITH now AS (SELECT datetime('now') AS ts)
               INSERT INTO bot_custom_providers (bot_id, provider_id, base_url, api, model_ids, models_meta, created_at, updated_at)
               SELECT ?, ?, ?, ?, ?, ?, (SELECT ts FROM now), (SELECT ts FROM now)
               WHERE ${declarationGrowthAdmission()}
                 AND ${poolAdmission(CUSTOM_KEY_TABLE)}
                 AND NOT EXISTS (SELECT 1 FROM bot_custom_providers
                                  WHERE bot_id = ? AND provider_id = ? AND (base_url <> ? OR api <> ?))
               ON CONFLICT (bot_id, provider_id) DO UPDATE SET
                 base_url = excluded.base_url,
                 api = excluded.api,
                 model_ids = excluded.model_ids,
                 models_meta = excluded.models_meta,
                 updated_at = (SELECT ts FROM now)`,
            )
            .bind(
              appId,
              decl.provider_id,
              decl.base_url,
              decl.api,
              JSON.stringify(decl.model_ids),
              JSON.stringify(decl.models_meta ?? {}),
              appId,
              appId,
              decl.provider_id,
              ...admissionBinds,
              appId,
              decl.provider_id,
              decl.base_url,
              decl.api,
            )
        : db
            .prepare(
              `WITH now AS (SELECT datetime('now') AS ts)
               UPDATE bot_custom_providers SET base_url = ?, api = ?, model_ids = ?, models_meta = ?, updated_at = (SELECT ts FROM now)
               WHERE bot_id = ? AND provider_id = ?
                 AND ${poolAdmission(CUSTOM_KEY_TABLE)}
                 AND (base_url = ? AND api = ?
                      OR NOT EXISTS (SELECT 1 FROM bot_custom_provider_keys WHERE bot_id = ? AND provider = ?))`,
            )
            .bind(
              decl.base_url,
              decl.api,
              JSON.stringify(decl.model_ids),
              JSON.stringify(decl.models_meta ?? {}),
              appId,
              decl.provider_id,
              ...admissionBinds,
              decl.base_url,
              decl.api,
              appId,
              decl.provider_id,
            );
      const key = keyInsertStatement(CUSTOM_KEY_TABLE, appId, decl.provider_id, keyId, keyEnc, {
        verifiedStatus: customProbeCanRejectKey(decl.base_url) ? "ok" : "reachable",
        newDeclaration: isNew,
        endpoint: { base_url: decl.base_url, api: decl.api },
      });
      const res = isNew ? await db.batch([key, declaration]) : await db.batch([declaration, key]);
      if (res[isNew ? 0 : 1]!.meta.changes === 0) {
        await throwCustomProviderRefusal(appId, decl, keyId, isNew);
      }
    },

    async removeCustomProvider(
      authority: BotWriteAuthority,
      appId: string,
      providerId: string,
    ): Promise<boolean> {
      await requireBotWrite(authority);
      const res = await db.batch([
        db.prepare(`DELETE FROM bot_custom_provider_keys WHERE bot_id = ? AND provider = ?`).bind(appId, providerId),
        db.prepare(`DELETE FROM bot_custom_providers WHERE bot_id = ? AND provider_id = ?`).bind(appId, providerId),
      ]);
      return res[1]!.meta.changes > 0;
    },

    async updateCustomProviderModels(
      appId: string,
      providerId: string,
      modelIds: string[],
      modelsMeta?: CustomProviderModelsMeta,
    ): Promise<void> {
      assertCustomProviderModelIds(modelIds);
      if (modelsMeta !== undefined) assertCustomProviderModelsMeta(modelsMeta, modelIds);
      const idsJson = JSON.stringify(modelIds);
      const statement =
        modelsMeta === undefined
          ? db
              .prepare(
                `UPDATE bot_custom_providers
                    SET model_ids = ?,
                        models_meta = (SELECT COALESCE(json_group_object(entry.key, entry.value), '{}')
                                         FROM json_each(bot_custom_providers.models_meta) AS entry
                                        WHERE entry.key IN (SELECT value FROM json_each(?))),
                        updated_at = datetime('now')
                  WHERE bot_id = ? AND provider_id = ?`,
              )
              .bind(idsJson, idsJson, appId, providerId)
          : db
              .prepare(
                `UPDATE bot_custom_providers SET model_ids = ?, models_meta = ?, updated_at = datetime('now')
                  WHERE bot_id = ? AND provider_id = ?`,
              )
              .bind(idsJson, JSON.stringify(modelsMeta), appId, providerId);
      const res = await statement.run();
      if (res.meta.changes === 0) {
        throw new InvalidCustomProviderError(`custom provider ${JSON.stringify(providerId)} is not declared for this app`);
      }
    },

    async getCustomProviderBaseUrl(appId: string, providerId: string): Promise<string | null> {
      const row = await db
        .prepare(`SELECT base_url FROM bot_custom_providers WHERE bot_id = ? AND provider_id = ?`)
        .bind(appId, providerId)
        .first<{ base_url: string }>();
      return row?.base_url ?? null;
    },

    async listCustomProviders(appId: string): Promise<AppCustomProviderRead[]> {
      const res = await db
        .prepare(
          `SELECT d.*,
                  EXISTS (SELECT 1 FROM bot_custom_provider_keys k
                           WHERE k.bot_id = d.bot_id AND k.provider = d.provider_id) AS has_keys
             FROM bot_custom_providers d WHERE d.bot_id = ? ORDER BY d.provider_id ASC`,
        )
        .bind(appId)
        .all<AppCustomProviderRow & { has_keys: number }>();
      return res.results.map((row) => {
        const modelIds = parseModelIdsJson(row.model_ids, "bot_custom_providers.model_ids");
        const modelsMeta = parseModelsMetaJson(row.models_meta, modelIds, "bot_custom_providers.models_meta");
        return {
          provider_id: row.provider_id,
          base_url: row.base_url,
          api: row.api as CustomProviderApi,
          model_ids: modelIds,
          ...(modelsMeta === undefined ? {} : { models_meta: modelsMeta }),
          has_keys: row.has_keys > 0,
        };
      });
    },

    async listCustomProviderKeys(appId: string, provider?: string): Promise<ProviderKeySummary[]> {
      const rows = await readKeyRows(CUSTOM_KEY_TABLE, appId, provider);
      const summary: ProviderKeySummary[] = [];
      for (const row of rows) {
        summary.push(await summarizeKeyRow(CUSTOM_KEY_TABLE, row));
      }
      return summary;
    },

    async addCustomProviderKey(
      authority: BotWriteAuthority,
      appId: string,
      providerId: string,
      plainKey: string,
      endpoint: { base_url: string; api: string },
    ): Promise<void> {
      // F12: authority FIRST — before any declaration read can leak whether a
      // provider exists on a bot this caller does not own.
      await requireBotWrite(authority);
      const declared = await db
        .prepare(`SELECT provider_id FROM bot_custom_providers WHERE bot_id = ? AND provider_id = ?`)
        .bind(appId, providerId)
        .first<{ provider_id: string }>();
      if (declared === null) {
        throw new InvalidCustomProviderError(`custom provider ${JSON.stringify(providerId)} is not declared for this app`);
      }
      await addKey(CUSTOM_KEY_TABLE, appId, providerId, plainKey, {
        verifiedStatus: customProbeCanRejectKey(endpoint.base_url) ? "ok" : "reachable",
        endpoint,
      });
    },

    async deleteCustomProviderKey(
      authority: BotWriteAuthority,
      appId: string,
      providerId: string,
      keyId: string,
    ): Promise<boolean> {
      await requireBotWrite(authority);
      await readKeyRows(CUSTOM_KEY_TABLE, appId, providerId);
      const res = await db
        .prepare(`DELETE FROM bot_custom_provider_keys WHERE bot_id = ? AND provider = ? AND key_id = ?`)
        .bind(appId, providerId, keyId)
        .run();
      return res.meta.changes > 0;
    },

    async getCustomProvidersForConsumer(appId: string): Promise<CustomProviderConsumerConfig[]> {
      const res = await db
        .prepare(
          `SELECT d.provider_id, d.base_url, d.api, d.model_ids, d.models_meta,
                  k.key_id, k.key_enc, k.created_at AS key_created_at, k.updated_at AS key_updated_at,
                  k.verified_at AS key_verified_at, k.verified_status AS key_verified_status
             FROM bot_custom_providers d
             LEFT JOIN bot_custom_provider_keys k
               ON k.bot_id = d.bot_id AND k.provider = d.provider_id
            WHERE d.bot_id = ?
            ORDER BY d.provider_id ASC`,
        )
        .bind(appId)
        .all<CustomProviderKeyJoinRow>();
      const pools = new Map<string, { decl: Omit<CustomProviderConsumerConfig, "api_keys">; keys: AppProviderKeyRow[] }>();
      for (const row of res.results) {
        let entry = pools.get(row.provider_id);
        if (entry === undefined) {
          const modelIds = parseModelIdsJson(row.model_ids, "bot_custom_providers.model_ids");
          const modelsMeta = parseModelsMetaJson(row.models_meta, modelIds, "bot_custom_providers.models_meta");
          entry = {
            decl: {
              provider_id: row.provider_id,
              base_url: row.base_url,
              api: row.api as CustomProviderApi,
              model_ids: modelIds,
              ...(modelsMeta === undefined ? {} : { models_meta: modelsMeta }),
            },
            keys: [],
          };
          pools.set(row.provider_id, entry);
        }
        if (row.key_id === null) continue;
        entry.keys.push({
          bot_id: appId,
          provider: row.provider_id,
          key_id: row.key_id,
          key_enc: row.key_enc ?? "",
          created_at: row.key_created_at ?? "",
          updated_at: row.key_updated_at,
          verified_at: row.key_verified_at,
          verified_status: row.key_verified_status,
        });
      }
      const out: CustomProviderConsumerConfig[] = [];
      for (const { decl, keys } of pools.values()) {
        keys.sort((left, right) => byAscii(left.created_at, right.created_at) || byAscii(left.key_id, right.key_id));
        const apiKeys: string[] = [];
        for (const row of keys) {
          const promoted = row.key_id === LEGACY_KEY_ID ? await promoteLegacyKeyRow(CUSTOM_KEY_TABLE, row) : row;
          apiKeys.push(
            await box.decryptSecret(promoted.key_enc, CUSTOM_KEY_TABLE.aad(appId, row.provider, promoted.key_id)),
          );
        }
        out.push({ ...decl, api_keys: apiKeys });
      }
      return out;
    },
  };
}

/** The store face (useful for route/consumer parameter types). */
export type AppConfigStore = ReturnType<typeof createAppConfigStore>;
