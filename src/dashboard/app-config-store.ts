/**
 * D1 store for per-App AI configuration: the `app_provider_keys` BYOK key
 * POOLS (one row per (App, provider, key_id) — migration 0023) and the
 * `app_custom_provider_keys` pools of the custom-provider declarations, plus
 * the model chains (`app_model_chains` default + named chains and the
 * `app_model_chain_seats` seat references, migration 0017). Spec
 * dashboard-multi-app-platform § Per-App BYOK + § Crypto envelope; migration
 * 0023 is the DDL single source for the pool tables.
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
 * Migration 0023 is FORWARD-ONLY and split in two halves by what can run
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
 * parseModelChain below mirrors src/review/runtime-omp.ts parseModelSelectors
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
 * Model chains (spec §4.4): `app_model_chains` (migration
 * 0017) holds one row per (App, chain name) — the default chain row keeps
 * the RESERVED name "default" (is_default = 1, at most one per App,
 * enforced by the store in one batch), named chains are user-named
 * selector chains (is_default = 0). `app_model_chain_seats` maps each of
 * the 4 audit-seat agent names to a chain name; ABSENT row = the seat uses
 * the default chain. The role vocabulary lives here as the MODEL_ROLE_IDS
 * mirror (importing the runner side via src/review is forbidden by the
 * dashboard isolation — Q2), and the selector grammar is validated with the
 * parseModelChain mirror above; both copies are parity-locked by
 * tests/worker/app-config.test.ts. Chains are decrypt-free (selectors are
 * configuration, not secrets) and are consumed by the pipeline consumer as
 * the runner input `modelOverrides` field (seats referencing the default
 * chain — or with no reference row — are omitted; empty map → undefined).
 * The pre-chains tables `app_model_config` / `app_model_roles` are
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
 *     verified_at = now + verified_status = 'ok', plus the App's verified
 *     model cache row, as ONE atomic db.batch.
 *   - deleteProviderKey removes ONE slot — and the verified-model cache row
 *     when it removed the provider's LAST key (a cache row for a keyless
 *     provider would keep offering models). removeProviderKey removes the
 *     WHOLE pool of a provider plus its cache row (the provider-level
 *     delete). Both return whether they removed a key row; an unknown key id
 *     / unconfigured provider is an idempotent no-op, like setAppStatus.
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
 *     order the consumer's MSTAR_POOL_*_01.._NN env indexes follow). A
 *     provider holding at least one key ALWAYS has an entry (the fail-closed
 *     read contract the pipeline relies on); an App with no config yields an
 *     EMPTY keys map and a null chain (a chain referring to a provider
 *     without a key is rejected fail-closed by the consumer's
 *     assertAppConfigComplete — zero-config is NOT a valid review state
 *     anymore), and an undecryptable row is a loud throw
 *     (tamper/misconfiguration is never swallowed).
 *   - Custom providers (migration 0012, per-key pools since 0023):
 *     upsertCustomProvider / removeCustomProvider / listCustomProviders
 *     manage per-App declarations of NON-built-in model providers (base URL
 *     + AL-23-1 api enum + model ids); the declaration holds NO key material
 *     — the key lives in `app_custom_provider_keys` under the same per-key
 *     AAD form, written by upsertCustomProvider (verified) or
 *     addCustomProviderKey (unverified), listed by listCustomProviderKeys
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
 *     app_id is a caller bug, never a silent no-op.
 */
import { createSecretbox } from "./secretbox";
import { sandboxImageHostIds } from "../contracts/sandbox-images";
import { PROVIDER_CATALOG, PROVIDER_IDS_BUILTIN } from "../contracts/provider-catalog.generated";

/**
 * A row of `app_provider_keys` — and, byte-identical in shape, of
 * `app_custom_provider_keys` (migration 0023: both tables hold ONE row per
 * key, with the envelope and its bookkeeping belonging to the key rather
 * than to the provider).
 */
export type AppProviderKeyRow = {
  app_id: string;
  provider: string;
  /**
   * The key's identity inside the pool: the first 16 hex characters of
   * SHA-256(plaintext). "" on a row migration 0023 carried across, until the
   * store promotes it (the plaintext-derived id needs the master key).
   */
  key_id: string;
  /** secretbox envelope of the provider API key — opaque here (lock L1). */
  key_enc: string;
  created_at: string;
  /** Last write time (migration 0012); NULL for rows written before 0012. */
  updated_at: string | null;
  /** Verification time (migration 0015); NULL = never verified. */
  verified_at: string | null;
  /** Verification outcome ('ok' | 'failed', store-enforced; migration 0015); NULL = never verified. */
  verified_status: string | null;
};

/**
 * A row of `app_model_chains` (migration 0017, spec §4.4).
 * The default chain row keeps the RESERVED name "default" (is_default = 1);
 * named chains are user-named selector chains (is_default = 0). is_default
 * uniqueness per App is store-enforced in ONE atomic db.batch (no CHECK /
 * partial unique index — app-family convention).
 */
export type AppModelChainRow = {
  app_id: string;
  /** Chain name; "default" is the reserved default-row name. */
  name: string;
  /** Verbatim comma-separated selector chain — configuration, not a secret. */
  chain: string;
  /** 1 = the App's default chain (at most one per App); 0 = named chain. */
  is_default: number;
  created_at: string;
  updated_at: string;
};

/** A row of `app_model_chain_seats` (migration 0017, spec §4.4). Absent row = the seat uses the default chain. */
export type AppModelChainSeatRow = {
  app_id: string;
  /** One of the MODEL_ROLE_IDS audit-seat agent names. */
  role: string;
  /** The referenced chain name; the reserved "default" name is never stored (blank = default = absent row). */
  chain_name: string;
};
/**
 * The custom-provider API protocol enum (AL-23-1 verdict): of the omp SDK
 * Api full set, ONLY the three open protocol forms are declarable BYOK —
 * the google, bedrock, azure, and codex shapes are vendor
 * OAuth/credential-chain forms that do not fit a baseUrl+key declaration.
 * Declared locally, NOT imported: dashboard modules must not import
 * pipeline/review code (Q2).
 */
export const CUSTOM_PROVIDER_API_IDS = [
  "anthropic-messages",
  "openai-completions",
  "openai-responses",
] as const;

export type CustomProviderApi = (typeof CUSTOM_PROVIDER_API_IDS)[number];

/**
 * A row of `app_custom_providers` (migration 0012 — D1 column
 * names, snake_case). model_ids is a TEXT JSON array (AL-23-1 DDL). The API
 * key does NOT live here: migration 0023 moved it into
 * `app_custom_provider_keys` (an AppProviderKeyRow), so the declaration is
 * decrypt-free and the key carries its own identity and bookkeeping.
 */
export type AppCustomProviderRow = {
  app_id: string;
  provider_id: string;
  base_url: string;
  api: string;
  model_ids: string;
  created_at: string;
  updated_at: string;
};

/**
 * One custom-provider declaration (the settings-page face and the
 * consumer input): a NON-built-in model provider bound to a base URL, one
 * of the AL-23-1 protocol forms, and the model ids it serves. The API key
 * is NEVER part of this shape — since migration 0023 it lives in
 * app_custom_provider_keys (declaration-time input; the consumer decrypt
 * face reads it there).
 */
export type AppCustomProvider = {
  provider_id: string;
  base_url: string;
  api: CustomProviderApi;
  model_ids: string[];
};
/**
 * One custom-provider declaration as the consumer sees it (the
 * getAppConfig analogue for app_custom_providers): the decrypt-free
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
  api_keys: string[];
};

/**
 * A row of `app_provider_models` (migration 0015): the per-App
 * verified-model cache for BUILT-IN providers. `provider` is the
 * SELECTOR-FACING key (spec §6.1) — `ark` BYOK keys verify under the BYOK id
 * "ark" but their cache rows are written under "ark-plan" (the in-image base
 * provider id the chain references). models_json is a TEXT JSON array of
 * verified model ids — configuration, not a secret (0006 model_chain
 * rationale). Custom providers write NO rows here (their vocabulary is the
 * declared model_ids, 0012).
 */
export type AppProviderModelsRow = {
  app_id: string;
  provider: string;
  models_json: string;
  fetched_at: string;
};

/**
 * One verified-model cache entry as the settings loader sees it (the
 * Interfaces face — the dropdown source for selector literal grammar
 * `provider/model`). `provider` is the selector-facing prefix of every
 * option built from this row.
 */
export type VerifiedModels = {
  /** Selector-facing provider key (the row's `provider` — "ark-plan" for a verified `ark` BYOK key). */
  provider: string;
  /** Verified model ids, exactly as cached at save time ([] = probe-only verification). */
  models: string[];
  /** Cache write time (SQLite datetime('now') UTC). */
  fetched_at: string;
};

/**
 * BYOK provider id → selector-facing `app_provider_models` cache key (spec
 * §6.1): an `ark` BYOK key verifies under the BYOK vocabulary id "ark", but
 * its cached model list must be written under "ark-plan" — the capability
 * host id that is the chain's selector prefix (the App's selected sandbox
 * image declares the same id as a registry capability host,
 * src/contracts/sandbox-images.ts). Every other provider uses its own id
 * unchanged.
 */
export function modelCacheProviderKey(provider: string): string {
  return provider === "ark" ? "ark-plan" : provider;
}

/**
 * The provider id allowlist — the builtin tier of the generated provider
 * catalog (19 builtin-tier provider ids incl. `ark`, same order — AL-24-5
 * added `ark` so the in-image ark-plan base provider's
 * ARK_API_KEY rides the per-App BYOK keys map like every other provider).
 * Re-exported from the generated contract: the catalog SSOT
 * lives in src/contracts/provider-catalog.generated.ts — a
 * dashboard-importable pure-data module (Q2 forbids dashboard → pipeline
 * imports, so the mirror is a re-export of the CONTRACT, not a hand copy).
 */
export const PROVIDER_IDS: readonly string[] = PROVIDER_IDS_BUILTIN;

/**
 * The dashboard's catalog mirror (spec §5) —
 * the FULL generated catalog (builtin AND template tier, ~214 rows) as
 * id → { label, tier, baseUrl, api, models, doc }, re-exported from
 * src/contracts/provider-catalog.generated.ts. The generated entry shape is
 * structurally assignable to ProviderMirrorEntry (it additionally carries
 * `envName`, which the mirror type ignores). `tier: "template"` entries are
 * NOT runner-consumable env-name entries — the save flow materializes them
 * through the existing custom-provider machinery (app_custom_providers),
 * substituting a {account_id} base-URL placeholder when the entry's base
 * URL carries one.
 */
export type ProviderMirrorEntry = {
  /** Human-readable provider label (picker/table). */
  label: string;
  /** builtin = runner-consumable env-name entry; template = metadata + prefill only. */
  tier: "builtin" | "template";
  /** Default API base URL. Template entries may carry a {account_id} placeholder. */
  baseUrl: string | null;
  /** Custom-provider API protocol to materialize a template with (template tier only). */
  api: string | null;
  /** Representative model ids (display/prefill metadata). */
  models: readonly string[];
  /** Provider docs URL. */
  doc: string | null;
};

export const PROVIDER_META: Record<string, ProviderMirrorEntry> = PROVIDER_CATALOG;

/**
 * The per-role model vocabulary (spec § 语义锁) — EXACTLY the
 * 4 audit-seat agent names the runner dispatches: `mstar-review-seat` is the
 * quick/default seat (the agent definition installed from
 * src/review/seat-agent.md), the three deep seats are the harness roles
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
 * Mirror of src/review/runtime-omp.ts `parseModelSelectors` (runtime-omp.ts:119):
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
/**
 * Parse a stored TEXT JSON array of model ids — either column that stores
 * one (app_custom_providers.model_ids, AL-23-1 DDL, or
 * app_provider_models.models_json, migration 0015) — fail-loud on anything
 * that is not a JSON array of strings (the getAppConfig tamper convention):
 * a malformed row throws in the store, never deferring to a caller's
 * `.join` on a non-array. `source` names the exact table.column in the
 * error so a tampered row is attributable.
 */
function parseModelIdsJson(raw: string, source: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((id) => typeof id === "string")) {
    throw new Error(`app-config-store: ${source} is not a JSON array of strings: ${JSON.stringify(raw)}`);
  }
  return parsed;
}

/**
 * Provider-key length bound (spec dashboard-ops-and-role-models
 * § 硬化项 4): a pasted API key longer than this is rejected BEFORE any
 * encryption or D1 write, so an oversized input can never bloat the store.
 */
export const MAX_PROVIDER_KEY_LENGTH = 4096;
/**
 * Keys per (App, provider) pool: the pool rides the container exec env as
 * `MSTAR_POOL_<PROVIDER>_COUNT` + `_01.._NN` (one two-digit index per key),
 * so this bound is what keeps the assembled env and the settings list
 * bounded. Growth-only: replacing an already-stored key never counts against
 * the cap. Enforced producer-side by the store, which refuses a new slot at
 * the cap with ProviderKeyLimitError and keeps the bound exact under
 * concurrent saves (a conditional INSERT — the custom-provider cap
 * precedent); the settings route answers 400 first.
 */
export const MAX_KEYS_PER_PROVIDER = 8;
/**
 * The key id migration 0023 gives a row it carried across: SQL cannot derive
 * the real one (it needs the plaintext), so the row waits under this sentinel
 * until the store promotes it on first touch. A real key id is 16 hex
 * characters, so the empty string can never collide with one.
 */
const LEGACY_KEY_ID = "";
/** UTF-8 encoder for the SHA-256 key-id derivation (one per module, not per call). */
const keyIdEncoder = new TextEncoder();
/**
 * Custom-provider declaration bounds (AL-23-2 verdict): provider id `[a-z0-9][a-z0-9-]{0,63}` (the env-name mapping
 * `CUSTOM_<UPPER_SNAKE>_API_KEY` the consumer injects), baseUrl
 * https-only ≤2048, model_ids 1..32 entries × ≤128 characters (AL-23-1).
 * The route answers 400 first; the store re-validates as the backstop for
 * direct callers (the ProviderKeyTooLongError pattern).
 */
export const CUSTOM_PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MAX_CUSTOM_PROVIDER_BASE_URL_LENGTH = 2048;
export const MAX_CUSTOM_PROVIDER_MODEL_IDS = 32;
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
 * a built-in (PROVIDER_IDS) or with a capability host of the App's selected
 * sandbox image (sandboxImageHostIds — QC wave-1 W-1's successor),
 * a non-https or over-length base URL, an api outside the
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

/**
 * Per-key secretbox AAD rowKey (migration 0023): the envelope is bound to the
 * FULL primary key of the row — both composite-PK columns of 0006 PLUS the
 * per-key id — joined in DDL order. A row's ciphertext is therefore useless in
 * any other slot of the same pool.
 */
function providerKeyAad(appId: string, provider: string, keyId: string): string {
  return `app_provider_keys.key_enc:${appId}:${provider}:${keyId}`;
}
/**
 * The same form for app_custom_provider_keys: the envelope is bound to the
 * declaration's provider id and the per-key id, joined in DDL order —
 * `app_custom_provider_keys.key_enc:<app_id>:<provider>:<key_id>`. The
 * consumer decrypts with this exact string.
 */
function customProviderKeyAad(appId: string, provider: string, keyId: string): string {
  return `app_custom_provider_keys.key_enc:${appId}:${provider}:${keyId}`;
}
/**
 * The PRE-0023 (two-segment) AAD rowKeys, read-only. Kept ONLY for the
 * promotion path: a row migration 0023 carried across still holds its old
 * envelope until the store re-encrypts it. Key material is NEVER written
 * under these again.
 */
function legacyProviderKeyAad(appId: string, provider: string): string {
  return `app_provider_keys.key_enc:${appId}:${provider}`;
}
function legacyCustomProviderAad(appId: string, providerId: string): string {
  return `app_custom_providers.api_key_enc:${appId}:${providerId}`;
}
/**
 * The key's identity inside one (App, provider) pool: the first 16 hex
 * characters of SHA-256(plaintext) over the UTF-8 bytes. Deterministic, so
 * re-submitting a key updates its own row; stored as a primary-key column AND
 * inside the AAD, so no row can be re-pointed at other key material. Plain
 * SHA-256 (no salt, no KDF) is deliberate: the value is an identifier, not a
 * verifier — the ciphertext is what is secret.
 */
async function providerKeyId(plainKey: string): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", keyIdEncoder.encode(plainKey));
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("").slice(0, 16);
}

/**
 * Declaration-shape gate: every bound in the AL-23-1/AL-23-2
 * verdicts, checked BEFORE any crypto or write — an invalid declaration
 * throws InvalidCustomProviderError (or ProviderKeyTooLongError for an
 * over-length key, the addProviderKey convention) and touches zero rows.
 * `capabilityHostIds` are the selected sandbox image's registry host ids —
 * passed in by upsertCustomProvider so this gate stays pure.
 * The settings route re-renders 400 first; this is the backstop for direct
 * callers.
 */
/**
 * Strict https base-URL predicate (PR #10 review): a valid custom-provider
 * base URL must PARSE as an absolute https URL WITH a host — the old
 * prefix-only regex accepted `https://` with no host. Shared by the store
 * backstop (assertCustomProvider) and the settings route (one predicate,
 * two layers).
 */
export function isValidCustomProviderBaseUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === "https:" && u.hostname !== "";
  } catch {
    return false;
  }
}

function assertCustomProvider(decl: AppCustomProvider, plainKey: string, capabilityHostIds: readonly string[]): void {
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
  // (QC wave-1 W-1's successor): an id the App's SELECTED sandbox
  // image already declares as a capability host (omp: ark-plan) would be
  // skipped base-wins at synthesis — silently dead on every review — so it
  // is rejected exactly like a built-in collision.
  if (capabilityHostIds.includes(decl.provider_id)) {
    throw new InvalidCustomProviderError(
      `custom provider id ${JSON.stringify(decl.provider_id)} collides with a capability host of the App's sandbox image`,
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
  if (decl.model_ids.length === 0) {
    throw new InvalidCustomProviderError("custom provider model_ids must not be empty");
  }
  if (decl.model_ids.length > MAX_CUSTOM_PROVIDER_MODEL_IDS) {
    throw new InvalidCustomProviderError(
      `custom provider model_ids exceed the ${MAX_CUSTOM_PROVIDER_MODEL_IDS}-entry limit`,
    );
  }
  for (const id of decl.model_ids) {
    if (id.trim() === "") {
      throw new InvalidCustomProviderError("custom provider model_ids must not contain empty entries");
    }
    if (id.length > MAX_CUSTOM_PROVIDER_MODEL_ID_LENGTH) {
      throw new InvalidCustomProviderError(
        `custom provider model id exceeds the ${MAX_CUSTOM_PROVIDER_MODEL_ID_LENGTH}-character limit`,
      );
    }
  }
  if (plainKey === "") {
    throw new InvalidCustomProviderError("custom provider API key is required at declaration");
  }
  if (plainKey.length > MAX_PROVIDER_KEY_LENGTH) {
    throw new ProviderKeyTooLongError();
  }
}

/** Role vocabulary gate: anything outside MODEL_ROLE_IDS is a caller bug. */
function assertModelRole(role: string): void {
  if (!MODEL_ROLE_IDS.includes(role)) {
    throw new UnknownModelRoleError(role);
  }
}

/**
 * Named-chain name gate (spec §4.4): the reserved "default"
 * row name and any name outside the MODEL_CHAIN_NAME_PATTERN grammar are
 * rejected — the route answers 400 first; this is the backstop for direct
 * callers.
 */
function assertModelChainName(name: string): void {
  if (name === DEFAULT_CHAIN_NAME) {
    throw new InvalidModelChainNameError(name);
  }
  if (!MODEL_CHAIN_NAME_PATTERN.test(name)) {
    throw new InvalidModelChainNameError(name);
  }
}

/**
 * The masked tail: the LAST 4 characters of the plaintext key — or NOTHING
 * for a key of ≤4 characters, which the mask must never reveal whole.
 */
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
  /** First 16 hex characters of the key's SHA-256 — stable across re-submission. */
  keyId: string;
  /** Last 4 plaintext characters; "" when the key is too short to mask safely. */
  last4: string;
  /** Last write time (migration 0012); NULL = pre-0012 row (em dash in the view). */
  updatedAt: string | null;
  /** Verification time (migration 0015); NULL = never verified. */
  verifiedAt: string | null;
  /** 'ok' | 'failed' (store-enforced); NULL = never verified. */
  verifiedStatus: string | null;
};

/** The decrypted per-App configuration (the consumer face). */
export type AppConfig = {
  appId: string;
  /**
   * provider id → that provider's DECRYPTED keys, in pool order (created_at,
   * then key_id). Only providers holding at least one key appear — the
   * fail-closed read contract the pipeline's assertAppConfigComplete relies
   * on. The arrays are what the consumer indexes into MSTAR_POOL_*_01.._NN.
   */
  keys: Record<string, string[]>;
  /** Verbatim stored chain; null = unset (missing/empty = that App's reviews fail closed — AL-24-5). */
  modelChain: string | null;
};

/** One chain as the settings face sees it (spec §4.4). */
export type AppModelChain = {
  name: string;
  /** Verbatim comma-separated selector chain — configuration, not a secret. */
  chain: string;
  /** True for the App's default chain row (the reserved "default" name). */
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
export function createAppConfigStore(db: AppConfigD1, encryptionKey: string | undefined) {
  const box = createSecretbox(encryptionKey);

  /**
   * The two per-key tables are byte-identical (migration 0023), so every
   * read/write below is written ONCE against this spec and bound to one of
   * them; `legacyAad` builds the PRE-0023 rowKey the promotion path needs.
   */
  type KeyTable = {
    table: "app_provider_keys" | "app_custom_provider_keys";
    aad: (appId: string, provider: string, keyId: string) => string;
    legacyAad: (appId: string, provider: string) => string;
    /**
     * The DECLARATION row that owns this pool, when one exists: a custom key
     * row is only written while its declaration row is still there, so a
     * declaration removal racing the write cannot leave an orphan credential
     * behind (the ownership gate lives in the write itself). Built-in pools
     * have no declaration.
     */
    owner?: { table: string; column: string };
  };
  const PROVIDER_KEY_TABLE: KeyTable = {
    table: "app_provider_keys",
    aad: providerKeyAad,
    legacyAad: legacyProviderKeyAad,
  };
  const CUSTOM_KEY_TABLE: KeyTable = {
    table: "app_custom_provider_keys",
    aad: customProviderKeyAad,
    legacyAad: legacyCustomProviderAad,
    owner: { table: "app_custom_providers", column: "provider_id" },
  };

  /** Byte-order compare — SQLite's BINARY collation for these ASCII columns. */
  function byAscii(left: string, right: string): number {
    if (left === right) return 0;
    return left < right ? -1 : 1;
  }

  /**
   * Promote ONE row the 0023 migration could only carry across verbatim: the
   * old two-segment envelope is decrypted, the key id derived from the
   * plaintext and the row rewritten UNDER ITS OWN id with the three-segment
   * AAD — this runs where the master key lives, and only here. Timestamps and
   * verification bookkeeping belong to the key, so they are preserved. The
   * update MOVES a primary-key column, so the batch first drops the carried
   * row if the new path already stored the same key in the meantime (same
   * plaintext, same id — the newer row wins) and only then promotes.
   */
  async function promoteLegacyKeyRow(spec: KeyTable, row: AppProviderKeyRow): Promise<AppProviderKeyRow> {
    const plain = await box.decryptSecret(row.key_enc, spec.legacyAad(row.app_id, row.provider));
    const keyId = await providerKeyId(plain);
    const keyEnc = await box.encryptSecret(plain, spec.aad(row.app_id, row.provider, keyId));
    await db.batch([
      db
        .prepare(
          `DELETE FROM ${spec.table} WHERE app_id = ? AND provider = ? AND key_id = ? AND EXISTS (
             SELECT 1 FROM ${spec.table} WHERE app_id = ? AND provider = ? AND key_id = ?
           )`,
        )
        .bind(row.app_id, row.provider, LEGACY_KEY_ID, row.app_id, row.provider, keyId),
      db
        .prepare(`UPDATE ${spec.table} SET key_id = ?, key_enc = ? WHERE app_id = ? AND provider = ? AND key_id = ?`)
        .bind(keyId, keyEnc, row.app_id, row.provider, LEGACY_KEY_ID),
    ]);
    return { ...row, key_id: keyId, key_enc: keyEnc };
  }

  /**
   * The App's — or one provider's — key rows in pool order, the single read
   * path every face goes through so the 0023 promotion happens exactly once
   * per carried row and no caller ever sees the sentinel id. Order:
   * provider-ascending, then (created_at, key_id) — the order the consumer's
   * pool env indexes and the settings list follow.
   */
  async function readKeyRows(spec: KeyTable, appId: string, provider?: string): Promise<AppProviderKeyRow[]> {
    const res =
      provider === undefined
        ? await db.prepare(`SELECT * FROM ${spec.table} WHERE app_id = ?`).bind(appId).all<AppProviderKeyRow>()
        : await db
            .prepare(`SELECT * FROM ${spec.table} WHERE app_id = ? AND provider = ?`)
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

  /**
   * The admission predicate EVERY pool write shares: the statement writes a
   * row only while the pool has room OR the key is already in it. Evaluated
   * inside the statement, so two concurrent writers can never both pass a
   * read-then-write check — a zero-change result IS the refusal. The
   * declaration writes of an owned pool carry the very same predicate, so a
   * refused key write refuses (and commits) neither.
   */
  function poolAdmission(spec: KeyTable): string {
    return `((SELECT COUNT(*) FROM ${spec.table} WHERE app_id = ? AND provider = ?) < ${MAX_KEYS_PER_PROVIDER}
             OR EXISTS (SELECT 1 FROM ${spec.table} WHERE app_id = ? AND provider = ? AND key_id = ?))`;
  }

  /**
   * One pool row's conditional upsert, prepared but NOT run: the cap, the
   * identity and (for an owned pool) the declaration's existence all live in
   * its WHERE, so an insert matching ZERO rows is a refusal, never a silent
   * no-op. A conflicting row is UPDATEd in place with the caller's
   * verification state — `verified: false` resets it, because an unverified
   * write must never inherit a stale verified_status.
   */
  function keyInsertStatement(
    spec: KeyTable,
    appId: string,
    provider: string,
    keyId: string,
    keyEnc: string,
    opts: { verified: boolean },
  ): AppConfigStatement {
    const verifiedAt = opts.verified ? "(SELECT ts FROM now)" : "NULL";
    const verifiedStatus = opts.verified ? "'ok'" : "NULL";
    // A declaration-OWNED pool additionally requires its declaration row to
    // still exist, so a declaration removal racing this write matches zero
    // rows instead of stranding an orphan credential a re-declaration would
    // revive.
    const ownership =
      spec.owner === undefined
        ? ""
        : ` AND EXISTS (SELECT 1 FROM ${spec.owner.table} WHERE app_id = ? AND ${spec.owner.column} = ?)`;
    const bind = [appId, provider, keyId, keyEnc, appId, provider, appId, provider, keyId];
    if (spec.owner !== undefined) bind.push(appId, provider);
    return db
      .prepare(
        `WITH now AS (SELECT datetime('now') AS ts)
         INSERT INTO ${spec.table} (app_id, provider, key_id, key_enc, created_at, updated_at, verified_at, verified_status)
         SELECT ?, ?, ?, ?, (SELECT ts FROM now), (SELECT ts FROM now), ${verifiedAt}, ${verifiedStatus}
         WHERE ${poolAdmission(spec)}${ownership}
         ON CONFLICT (app_id, provider, key_id) DO UPDATE SET
           key_enc = excluded.key_enc,
           updated_at = excluded.updated_at,
           verified_at = excluded.verified_at,
           verified_status = excluded.verified_status`,
      )
      .bind(...bind);
  }

  /**
   * A pool write that matched ZERO rows. A NEW key at MAX_KEYS_PER_PROVIDER is
   * the common cause; for an OWNED pool the other cause is the declaration
   * vanishing between the caller's read and this write — named explicitly so
   * the removal race surfaces as a refusal instead of an orphan credential.
   */
  async function throwKeyRefusal(spec: KeyTable, appId: string, provider: string): Promise<never> {
    if (spec.owner !== undefined) {
      const decl = await db
        .prepare(`SELECT ${spec.owner.column} FROM ${spec.owner.table} WHERE app_id = ? AND ${spec.owner.column} = ?`)
        .bind(appId, provider)
        .first<Record<string, string>>();
      if (decl === null) {
        throw new InvalidCustomProviderError(`custom provider ${JSON.stringify(provider)} is not declared for this app`);
      }
    }
    throw new ProviderKeyLimitError(provider);
  }

  /**
   * Add (or re-submit) ONE key in a pool whose declaration (when it has one)
   * already exists. Pass `models` to land the verified-model cache row in the
   * SAME atomic batch (built-in providers only — custom providers store no
   * cache row); that statement is itself gated on the key row existing, so a
   * cap-refused key cannot leave a cache row behind.
   */
  async function addKey(
    spec: KeyTable,
    appId: string,
    provider: string,
    plainKey: string,
    opts: { verified: boolean; models?: string[] },
  ): Promise<void> {
    if (plainKey.length > MAX_PROVIDER_KEY_LENGTH) {
      throw new ProviderKeyTooLongError();
    }
    // Promote first: the cap must count real slots, and a re-submitted key must
    // collapse onto its promoted row instead of opening a second one.
    await readKeyRows(spec, appId, provider);
    const keyId = await providerKeyId(plainKey);
    const keyEnc = await box.encryptSecret(plainKey, spec.aad(appId, provider, keyId));
    const keyStatement = keyInsertStatement(spec, appId, provider, keyId, keyEnc, opts);
    if (opts.models === undefined) {
      const res = await keyStatement.run();
      if (res.meta.changes === 0) await throwKeyRefusal(spec, appId, provider);
      return;
    }
    const res = await db.batch([
      keyStatement,
      db
        .prepare(
          `WITH now AS (SELECT datetime('now') AS ts)
           INSERT INTO app_provider_models (app_id, provider, models_json, fetched_at)
           SELECT ?, ?, ?, (SELECT ts FROM now)
           WHERE EXISTS (SELECT 1 FROM ${spec.table} WHERE app_id = ? AND provider = ? AND key_id = ?)
           ON CONFLICT (app_id, provider) DO UPDATE SET
             models_json = excluded.models_json,
             fetched_at = excluded.fetched_at`,
        )
        .bind(appId, modelCacheProviderKey(provider), JSON.stringify(opts.models), appId, provider, keyId),
    ]);
    if (res[0]!.meta.changes === 0) await throwKeyRefusal(spec, appId, provider);
  }

  /** Mask one stored key row for a settings list face: decrypt, keep ONLY the tail. */
  async function summarizeKeyRow(spec: KeyTable, row: AppProviderKeyRow): Promise<ProviderKeySummary> {
    const plain = await box.decryptSecret(row.key_enc, spec.aad(row.app_id, row.provider, row.key_id));
    return {
      provider: row.provider,
      keyId: row.key_id,
      last4: maskTail(plain),
      updatedAt: row.updated_at,
      verifiedAt: row.verified_at,
      verifiedStatus: row.verified_status,
    };
  }

  /**
   * The App's stored sandbox image id (migration 0018) — the
   * custom-provider collision gate resolves the SELECTED image's capability
   * hosts through it. Unknown app → null (no host ids to refuse with; the
   * write itself fails the FK, the fail-loud convention).
   */
  async function readSandboxImageId(appId: string): Promise<string | null> {
    const row = await db
      .prepare(`SELECT sandbox_image_id FROM github_apps WHERE id = ?`)
      .bind(appId)
      .first<{ sandbox_image_id: string }>();
    return row?.sandbox_image_id ?? null;
  }

  /**
   * The App's default chain value (spec §4.4): the 'default' row of
   * app_model_chains, or null when no default row exists (absent = unset =
   * that App's reviews fail closed — AL-24-5).
   */
  async function readModelChain(appId: string): Promise<string | null> {
    const row = await db
      .prepare(`SELECT chain FROM app_model_chains WHERE app_id = ? AND name = ?`)
      .bind(appId, DEFAULT_CHAIN_NAME)
      .first<Pick<AppModelChainRow, "chain">>();
    return row?.chain ?? null;
  }

  /**
   * The App's seat → chain-name map, role-ascending for deterministic key
   * order; only REFERENCED roles appear (no row = the seat uses the default
   * chain — spec §4.4).
   */
  async function readModelChainSeats(appId: string): Promise<Record<string, string>> {
    const res = await db
      .prepare(`SELECT role, chain_name FROM app_model_chain_seats WHERE app_id = ? ORDER BY role ASC`)
      .bind(appId)
      .all<Pick<AppModelChainSeatRow, "role" | "chain_name">>();
    const seats: Record<string, string> = {};
    for (const row of res.results) {
      seats[row.role] = row.chain_name;
    }
    return seats;
  }

  /**
   * The App's per-role model overrides for the consumer (spec
   * §4.4): role → verbatim chain value, resolved through the seat → chain
   * mapping. Seats with NO reference row (absent = default) and seats
   * referencing the default chain are OMITTED — the runner input map only
   * carries seats whose chain differs from the App default (byte-identical
   * to the pre-chains app_model_roles semantics for migrated Apps). A seat
   * referencing a chain with no row throws (fail-loud, the getAppConfig
   * tamper convention — removeModelChain cleans references in the same
   * batch, so a dangling reference is a direct-DB tamper).
   */
  async function readModelOverrides(appId: string): Promise<Record<string, string>> {
    const seats = await db
      .prepare(`SELECT role, chain_name FROM app_model_chain_seats WHERE app_id = ? ORDER BY role ASC`)
      .bind(appId)
      .all<Pick<AppModelChainSeatRow, "role" | "chain_name">>();
    if (seats.results.length === 0) return {};
    const chains = await db
      .prepare(`SELECT name, chain FROM app_model_chains WHERE app_id = ?`)
      .bind(appId)
      .all<Pick<AppModelChainRow, "name" | "chain">>();
    const chainByName = new Map(chains.results.map((row) => [row.name, row.chain]));
    const overrides: Record<string, string> = {};
    for (const seat of seats.results) {
      if (seat.chain_name === DEFAULT_CHAIN_NAME) continue; // default-referenced seat omitted
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

  /** Prepared DELETE for one seat's reference row (run() or ride in a batch). */
  function deleteModelChainSeatStatement(appId: string, role: string): AppConfigStatement {
    return db.prepare(`DELETE FROM app_model_chain_seats WHERE app_id = ? AND role = ?`).bind(appId, role);
  }

  /** Prepared upsert of one seat's chain reference (run() or ride in a batch). */
  function upsertModelChainSeatStatement(appId: string, role: string, chainName: string): AppConfigStatement {
    return db
      .prepare(
        `INSERT INTO app_model_chain_seats (app_id, role, chain_name)
         VALUES (?, ?, ?)
         ON CONFLICT (app_id, role) DO UPDATE SET
           chain_name = excluded.chain_name`,
      )
      .bind(appId, role, chainName);
  }

  /** Delete one seat's reference row (idempotent — an unmapped seat deletes nothing). */
  async function deleteModelChainSeat(appId: string, role: string): Promise<void> {
    await deleteModelChainSeatStatement(appId, role).run();
  }

  /** Upsert one seat's chain reference (one row per (app_id, role) composite PK). */
  async function upsertModelChainSeat(appId: string, role: string, chainName: string): Promise<void> {
    await upsertModelChainSeatStatement(appId, role, chainName).run();
  }

  /** Fail-loud existence gate for a seat's chain reference (the route 400s first). */
  async function assertChainExists(appId: string, chainName: string): Promise<void> {
    const row = await db
      .prepare(`SELECT name FROM app_model_chains WHERE app_id = ? AND name = ?`)
      .bind(appId, chainName)
      .first<{ name: string }>();
    if (!row) throw new UnknownModelChainError(chainName);
  }

  return {
    /**
     * Store one provider key in the App's pool for (appId, provider):
     * encrypts INSIDE with the per-key AAD, then upserts THAT key's row. The
     * plaintext is never persisted, logged, or returned. Re-submitting the
     * same key updates its row in place: created_at is the key's entry time
     * and STAYS (so the pool order (created_at, key_id) never shifts under a
     * re-submission), updated_at moves forward from a fresh clock read (the
     * migration-0012 convention), and verified_at/verified_status reset to
     * NULL (migration 0015): verification
     * belongs to the (provider, key) pair, and this is the UNVERIFIED path, so
     * a leftover caller must not inherit a stale verified_status
     * (saveVerifiedKey is the verified one). A DIFFERENT key takes the next
     * free slot; a NEW slot past MAX_KEYS_PER_PROVIDER throws
     * ProviderKeyLimitError with zero writes, and a key longer than
     * MAX_PROVIDER_KEY_LENGTH throws ProviderKeyTooLongError before any
     * crypto or write (the route answers 400 first; these are the backstops
     * for direct callers).
     */
    addProviderKey(appId: string, provider: string, plainKey: string): Promise<void> {
      return addKey(PROVIDER_KEY_TABLE, appId, provider, plainKey, { verified: false });
    },

    /**
     * Store one provider key AFTER successful verification: the VERIFIED
     * analogue of addProviderKey — encrypts with the SAME per-key AAD,
     * upserts that key's row with the verification bookkeeping (migration
     * 0015: verified_at = now + verified_status = 'ok'), and upserts the App's
     * verified-model cache row under the SELECTOR-FACING provider key
     * (modelCacheProviderKey — an `ark` BYOK key caches under "ark-plan",
     * spec §6.1) as ONE atomic db.batch (D1 batch is transactional and the
     * cache statement only fires once the key row is there, so a verified key
     * with no cache row — or a cache row with no key — is impossible).
     * `models` may be [] (a provider that only got an auth-probe has an empty
     * cache — that is the "probe-only" signal the member validation falls
     * back to syntax-only on). Bounds/cap contract identical to
     * addProviderKey: ProviderKeyTooLongError before any crypto or write and
     * ProviderKeyLimitError for a NEW slot past MAX_KEYS_PER_PROVIDER.
     */
    saveVerifiedKey(appId: string, provider: string, plainKey: string, models: string[]): Promise<void> {
      return addKey(PROVIDER_KEY_TABLE, appId, provider, plainKey, { verified: true, models });
    },

    /**
     * Delete ONE key slot of a provider's pool — and the App's verified-model
     * cache row when it was that provider's LAST key, in ONE atomic batch (a
     * cache row for a keyless provider would keep offering models in the
     * settings dropdown; while a sibling key remains the cache stays, because
     * the cached model list belongs to the provider, not to one key). The
     * cache row lives under the SELECTOR-FACING provider key —
     * modelCacheProviderKey maps an `ark` BYOK key to its "ark-plan" cache row
     * (spec §6.1). Returns whether THIS call removed the key row (an unknown
     * key id — or any provider the allowlist could never have stored — is a
     * no-op returning false).
     */
    async deleteProviderKey(appId: string, provider: string, keyId: string): Promise<boolean> {
      // Promote the pool FIRST: a row 0023 carried across still wears the
      // sentinel id, so the derived id below matches nothing before promotion.
      await readKeyRows(PROVIDER_KEY_TABLE, appId, provider);
      const res = await db.batch([
        db
          .prepare(`DELETE FROM app_provider_keys WHERE app_id = ? AND provider = ? AND key_id = ?`)
          .bind(appId, provider, keyId),
        // The delete above already ran inside this transaction, so this
        // NOT EXISTS sees the post-delete state of the pool.
        db
          .prepare(
            `DELETE FROM app_provider_models WHERE app_id = ? AND provider = ? AND NOT EXISTS (
               SELECT 1 FROM app_provider_keys WHERE app_id = ? AND provider = ?
             )`,
          )
          .bind(appId, modelCacheProviderKey(provider), appId, provider),
      ]);
      return res[0]!.meta.changes > 0;
    },

    /**
     * Delete a provider's WHOLE pool — every key row of the (App, provider)
     * pool, plus its verified-model cache row — in ONE atomic batch (a removed
     * pool must not linger as "verified" in the settings dropdown). Returns
     * whether THIS call removed a key row (an unconfigured provider — or any
     * provider the allowlist could never have stored — is a no-op returning
     * false, mirroring removeCustomProvider's tolerance).
     */
    async removeProviderKey(appId: string, provider: string): Promise<boolean> {
      const res = await db.batch([
        db.prepare(`DELETE FROM app_provider_keys WHERE app_id = ? AND provider = ?`).bind(appId, provider),
        db
          .prepare(`DELETE FROM app_provider_models WHERE app_id = ? AND provider = ?`)
          .bind(appId, modelCacheProviderKey(provider)),
      ]);
      return res[0]!.meta.changes > 0;
    },

    /**
     * The settings-page key list: one row per stored key — the provider, the
     * derived key id (the handle a per-key delete / re-verify call takes), the
     * masked tail and the per-key bookkeeping (migration 0012; NULL for rows
     * written before 0012 — the view's em dash placeholder).
     * Provider-ascending, then pool order (created_at, key_id); `provider`
     * scopes the read to one pool. The plaintext NEVER appears in the return
     * value — and because this is the only list face, it cannot leak into
     * HTML either.
     */
    async listProviderKeys(appId: string, provider?: string): Promise<ProviderKeySummary[]> {
      const rows = await readKeyRows(PROVIDER_KEY_TABLE, appId, provider);
      const summary: ProviderKeySummary[] = [];
      for (const row of rows) {
        summary.push(await summarizeKeyRow(PROVIDER_KEY_TABLE, row));
      }
      return summary;
    },

    /**
     * Store the App's default model chain VERBATIM (the route has already
     * validated ≥1 selector), or clear it: `null` AND any blank chain
     * (empty or whitespace-only — the route's 空 = 清除 semantics)
     * REMOVE the 'default' row (absent = unset; a chain-less
     * App's reviews fail closed in the consumer with `per-App config
     * incomplete: app <id>: missing model chain` — no
     * deployment-level fallback exists). A chain with content upserts the
     * 'default' row verbatim, interior/trailing whitespace included, with
     * is_default = 1 — the per-App is_default uniqueness is enforced in ONE
     * atomic db.batch (spec §4.4 clear-old-set-new): the batch first clears
     * every is_default = 1 row for the App, then upserts the 'default' row,
     * so exactly one default row exists after every write (a rogue
     * direct-DB default row is swept).
     */
    async setModelChain(appId: string, chain: string | null): Promise<void> {
      if (chain === null || chain.trim() === "") {
        await db
          .prepare(`DELETE FROM app_model_chains WHERE app_id = ? AND name = ?`)
          .bind(appId, DEFAULT_CHAIN_NAME)
          .run();
        return;
      }
      await db.batch([
        db
          .prepare(`UPDATE app_model_chains SET is_default = 0 WHERE app_id = ? AND is_default = 1`)
          .bind(appId),
        db
          .prepare(
            `INSERT INTO app_model_chains (app_id, name, chain, is_default, created_at, updated_at)
             VALUES (?, ?, ?, 1, datetime('now'), datetime('now'))
             ON CONFLICT (app_id, name) DO UPDATE SET
               chain = excluded.chain,
               is_default = 1,
               updated_at = datetime('now')`,
          )
          .bind(appId, DEFAULT_CHAIN_NAME, chain),
      ]);
    },

    /** The stored chain verbatim, or null when unset (no row). */
    getModelChain(appId: string): Promise<string | null> {
      return readModelChain(appId);
    },

    /**
     * Decrypt the App's full configuration for the consumer (env assembly):
     * provider id → that provider's plaintext keys in pool order (created_at,
     * then key_id — the order the consumer's MSTAR_POOL_*_01.._NN env indexes
     * follow), plus the model chain. A provider holding at least one key ALWAYS
     * has an entry: that is the fail-closed read contract the pipeline relies
     * on (a chain provider with no entry must be visible as missing). No
     * config → `{ keys: {}, modelChain: null }`. An undecryptable row throws
     * (tamper/misconfiguration is never swallowed).
     */
    async getAppConfig(appId: string): Promise<AppConfig> {
      const rows = await readKeyRows(PROVIDER_KEY_TABLE, appId);
      const keys: Record<string, string[]> = {};
      for (const row of rows) {
        const plain = await box.decryptSecret(row.key_enc, providerKeyAad(row.app_id, row.provider, row.key_id));
        (keys[row.provider] ??= []).push(plain);
      }
      return { appId, keys, modelChain: await readModelChain(appId) };
    },

    /**
     * The App's verified-model cache (the Interfaces read face): every
     * app_provider_models row for the App, provider-ascending — the settings
     * loader's dropdown source (one cache row = one verified provider whose
     * options render as selector literal grammar `provider/model`; the row's
     * `provider` IS the selector prefix, "ark-plan" for a verified `ark`
     * BYOK key). models_json parses fail-loud (the getAppConfig tamper
     * convention): a malformed row throws in the store, never deferring to a
     * caller. A provider absent here has never been verified through
     * saveVerifiedKey (or its models were never cached).
     */
    async getVerifiedModels(appId: string): Promise<VerifiedModels[]> {
      const res = await db
        .prepare(`SELECT * FROM app_provider_models WHERE app_id = ? ORDER BY provider ASC`)
        .bind(appId)
        .all<AppProviderModelsRow>();
      return res.results.map((row) => ({
        provider: row.provider,
        models: parseModelIdsJson(row.models_json, "app_provider_models.models_json"),
        fetched_at: row.fetched_at,
      }));
    },

    /**
     * The App's chains (settings face): every app_model_chains
     * row, name-ascending ("default" sorts first). is_default is exposed as
     * a boolean. Decrypt-free by design — a model selector is
     * configuration, not a secret (the 0006 model_chain rationale).
     */
    async getModelChains(appId: string): Promise<AppModelChain[]> {
      const res = await db
        .prepare(`SELECT * FROM app_model_chains WHERE app_id = ? ORDER BY name ASC`)
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

    /**
     * Create or replace one NAMED chain (spec §4.4): the name
     * must pass assertModelChainName (the reserved "default" row name and
     * any name outside the MODEL_CHAIN_NAME_PATTERN grammar are rejected —
     * the route answers 400 first; this is the backstop) and the chain
     * value must be a non-blank selector chain (a blank chain throws
     * InvalidModelSelectorError — the route validates grammar/membership
     * first). Named chains are never default: the upsert writes
     * is_default = 0 on insert AND update, so a rogue direct-DB default
     * flag on a named row is swept (only setModelChain writes is_default =
     * 1, and only on the 'default' row).
     */
    async upsertModelChain(appId: string, name: string, chain: string): Promise<void> {
      assertModelChainName(name);
      if (chain.trim() === "") {
        throw new InvalidModelSelectorError(chain);
      }
      await db
        .prepare(
          `INSERT INTO app_model_chains (app_id, name, chain, is_default, created_at, updated_at)
           VALUES (?, ?, ?, 0, datetime('now'), datetime('now'))
           ON CONFLICT (app_id, name) DO UPDATE SET
             chain = excluded.chain,
             is_default = excluded.is_default,
             updated_at = datetime('now')`,
        )
        .bind(appId, name, chain)
        .run();
    },

    /**
     * Delete one NAMED chain — and every seat reference row pointing at it,
     * in ONE atomic batch (spec §4.4: a deleted chain's seats fall back to
     * the default chain). The reserved 'default' row cannot be removed here
     * (assertModelChainName rejects it — use setModelChain(null) to clear
     * the default). Returns whether THIS call removed a chain row (an
     * unknown name is an idempotent no-op returning false, mirroring
     * removeProviderKey's tolerance).
     */
    async removeModelChain(appId: string, name: string): Promise<boolean> {
      assertModelChainName(name);
      const res = await db.batch([
        db.prepare(`DELETE FROM app_model_chain_seats WHERE app_id = ? AND chain_name = ?`).bind(appId, name),
        db.prepare(`DELETE FROM app_model_chains WHERE app_id = ? AND name = ?`).bind(appId, name),
      ]);
      return res[1]!.meta.changes > 0;
    },

    /**
     * The App's seat → chain-name map (settings face): role →
     * referenced chain name, only the REFERENCED roles appear; an App with
     * no reference rows yields `{}` (= every seat uses the default chain).
     * Decrypt-free by design — a chain reference is configuration, not a
     * secret — the pipeline consumer reads the resolved map per message to
     * build the runner input `modelOverrides` field, so a dashboard seat
     * update applies to the very next review.
     */
    getModelChainSeats(appId: string): Promise<Record<string, string>> {
      return readModelChainSeats(appId);
    },

    /**
     * Map (or replace) one seat's chain reference, or clear it: a BLANK
     * chain_name — or the reserved "default" name — DELETES the reference
     * row (absent = default chain, spec §4.4). The name is canonicalized
     * (whitespace-trimmed) BEFORE the clear/assert/upsert decisions, so a
     * padded reference can never be stored — a dangling `"fast "` row
     * would fail every consumer read for the App (F-001, QC wave).
     * Validation BEFORE any write: an off-vocabulary role throws
     * UnknownModelRoleError and a content-bearing chain_name that names no
     * stored chain throws UnknownModelChainError (the route re-renders 400
     * first; these are the backstop for direct callers). An unknown app_id
     * fails the FK on insert (fail-loud, same as every write here);
     * clearing an unmapped seat is a quiet no-op.
     */
    async setModelChainSeat(appId: string, role: string, chainName: string): Promise<void> {
      assertModelRole(role);
      const name = chainName.trim();
      if (name === "" || name === DEFAULT_CHAIN_NAME) {
        await deleteModelChainSeat(appId, role);
        return;
      }
      await assertChainExists(appId, name);
      await upsertModelChainSeat(appId, role, name);
    },

    /**
     * Remove one seat's chain reference explicitly (idempotent — an
     * unmapped seat, like any role the vocabulary could never have stored,
     * is a no-op returning nothing, mirroring removeProviderKey's
     * tolerance).
     */
    async clearModelChainSeat(appId: string, role: string): Promise<void> {
      assertModelRole(role);
      await deleteModelChainSeat(appId, role);
    },

    /**
     * Bulk face for the settings single-save (the 4-row editor,
     * now chain references): validates EVERY (role, chain_name)
     * entry BEFORE any write (one bad entry → typed throw, zero rows
     * touched), then applies the whole map as ONE atomic `db.batch`.
     * Each name is canonicalized (whitespace-trimmed) once: the
     * validation set, the clear/upsert decision and the BIND all use the
     * same trimmed value, so a padded reference (`"fast "`, `" default "`)
     * either hits the real chain or clears — a dangling reference row is
     * impossible through this face (F-001, QC wave; the route trims too,
     * this is the backstop for direct callers). blank / "default" = clear
     * (absent = default chain), content = trimmed chain name reference.
     * D1 batch is transactional: a mid-save failure rolls back every
     * statement, so a partially applied seat map is impossible and the
     * route's "nothing was stored" failure notice stays truthful. An
     * empty map is a no-op (no batch is issued).
     */
    async setModelChainSeats(appId: string, refs: Record<string, string>): Promise<void> {
      const entries = Object.entries(refs);
      for (const [role] of entries) {
        assertModelRole(role);
      }
      const referenced = entries
        .map(([, chainName]) => chainName.trim())
        .filter((name) => name !== "" && name !== DEFAULT_CHAIN_NAME);
      if (referenced.length > 0) {
        const chains = await db
          .prepare(`SELECT name FROM app_model_chains WHERE app_id = ?`)
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

    /**
     * The App's per-role model overrides for the consumer (spec
     * §4.4): role → verbatim chain value, resolved through the seat →
     * chain mapping. Seats with NO reference row (absent = default) and
     * seats referencing the default chain are OMITTED — the runner input
     * map only carries seats whose chain differs from the App default
     * (byte-identical to the pre-chains app_model_roles semantics for
     * migrated Apps). An App with no overrides yields `{}` (= today's
     * chain behavior; the consumer maps an empty map to `undefined`).
     * Decrypt-free by design — a model selector is configuration, not a
     * secret — the pipeline consumer reads this per message, so a
     * dashboard seat update applies to the very next review. A seat
     * referencing a chain with no row throws (fail-loud, the getAppConfig
     * tamper convention).
     */
    getModelOverridesForConsumer(appId: string): Promise<Record<string, string>> {
      return readModelOverrides(appId);
    },
    /**
     * Store (or replace) one custom-provider declaration for the App:
     * validates the full AL-23-1/AL-23-2 shape, upserts the (app_id,
     * provider_id) DECLARATION row (base_url / api / model_ids — migration
     * 0023 moved the key material into app_custom_provider_keys), then stores
     * the submitted key in that declaration's pool as a verified slot (the
     * declaration flow verifies before saving, so it lands
     * verified_at = now / verified_status = 'ok'; a key already in the pool is
     * updated in place, a NEW one takes the next free slot up to
     * MAX_KEYS_PER_PROVIDER). model_ids is stored as a TEXT JSON array
     * (AL-23-1 DDL). An invalid declaration throws
     * InvalidCustomProviderError / ProviderKeyTooLongError before any crypto
     * or write (the route answers 400 first; this is the backstop).
     * The declaration-count bound (MAX_CUSTOM_PROVIDER_COUNT, QC wave-1 W-2)
     * is growth-only: a NEW id at the cap throws before any crypto or write;
     * re-declaring an EXISTING id (an update, not growth) always proceeds.
     * The cap is enforced ATOMICALLY (PR #10 cap-race fix): the new-id
     * insert is conditional (`WHERE count < cap`), so two concurrent saves
     * racing for the last slot cannot both land — the loser's insert matches
     * zero rows and throws the cap error. The pre-check below stays as the
     * fast 400 path (defense in depth, both layers).
     * The declaration and its key commit TOGETHER or not at all: both ride ONE
     * `db.batch` whose statements carry the SAME pool-admission predicate, so a
     * refused key (a ninth) refuses the declaration write with it, and the key
     * statement additionally requires the declaration — a declaration removal
     * racing this call matches zero rows on BOTH. The key is encrypted BEFORE
     * the batch, so a crypto failure (missing / malformed master key) leaves no
     * declaration behind either.
     * A fresh insert writes updated_at == created_at from ONE clock read (the
     * migration-0012 convention); re-declaring moves updated_at forward and
     * keeps created_at (the declaration's birth time).
     */
    async upsertCustomProvider(appId: string, decl: AppCustomProvider, plainKey: string): Promise<void> {
      // The collision vocabulary is the App's SELECTED image's
      // capability host ids (omp: ark-plan) — resolved here so the backstop
      // stays self-contained for direct callers (one read per declaration
      // write, the same posture as the cap-count SELECT below).
      const imageId = await readSandboxImageId(appId);
      assertCustomProvider(decl, plainKey, sandboxImageHostIds(imageId ?? ""));
      // Growth-only cap: only a provider id with NO row yet can push the App
      // past MAX_CUSTOM_PROVIDER_COUNT declarations (an upsert of an existing
      // id replaces the row in place — no count change). The pre-check answers
      // the common case; the conditional INSERT below is the race backstop.
      const existing = await db
        .prepare(`SELECT provider_id FROM app_custom_providers WHERE app_id = ? AND provider_id = ?`)
        .bind(appId, decl.provider_id)
        .first<{ provider_id: string }>();
      const isNew = existing === null;
      if (isNew) {
        const countRow = await db
          .prepare(`SELECT COUNT(*) AS n FROM app_custom_providers WHERE app_id = ?`)
          .bind(appId)
          .first<{ n: number }>();
        if ((countRow?.n ?? 0) >= MAX_CUSTOM_PROVIDER_COUNT) {
          throw new InvalidCustomProviderError(`custom provider cap (${MAX_CUSTOM_PROVIDER_COUNT}) reached`);
        }
      }
      // Promote the pool FIRST (the cap must count real slots, and a
      // re-submitted key must collapse onto its promoted row), then encrypt —
      // both BEFORE anything is written, so a crypto failure (a missing /
      // malformed master key) can never leave a declaration behind.
      await readKeyRows(CUSTOM_KEY_TABLE, appId, decl.provider_id);
      const keyId = await providerKeyId(plainKey);
      const keyEnc = await box.encryptSecret(plainKey, CUSTOM_KEY_TABLE.aad(appId, decl.provider_id, keyId));
      // ONE atomic batch: the declaration and its key commit together or not
      // at all. Each statement carries the SAME pool-admission predicate, so a
      // refused key write (a ninth key) refuses the declaration write with it,
      // and the key statement additionally requires the declaration — a
      // removal racing this call matches zero rows on BOTH, so neither a
      // changed declaration nor an orphan credential can survive a refusal.
      const admissionBinds = [appId, decl.provider_id, appId, decl.provider_id, keyId];
      const declaration = isNew
        ? db
            .prepare(
              `WITH now AS (SELECT datetime('now') AS ts)
               INSERT INTO app_custom_providers (app_id, provider_id, base_url, api, model_ids, created_at, updated_at)
               SELECT ?, ?, ?, ?, ?, (SELECT ts FROM now), (SELECT ts FROM now)
               WHERE (SELECT COUNT(*) FROM app_custom_providers WHERE app_id = ?) < ${MAX_CUSTOM_PROVIDER_COUNT}
                 AND ${poolAdmission(CUSTOM_KEY_TABLE)}`,
            )
            .bind(
              appId,
              decl.provider_id,
              decl.base_url,
              decl.api,
              JSON.stringify(decl.model_ids),
              appId,
              ...admissionBinds,
            )
        : db
            .prepare(
              `WITH now AS (SELECT datetime('now') AS ts)
               UPDATE app_custom_providers SET base_url = ?, api = ?, model_ids = ?, updated_at = (SELECT ts FROM now)
               WHERE app_id = ? AND provider_id = ?
                 AND ${poolAdmission(CUSTOM_KEY_TABLE)}`,
            )
            .bind(decl.base_url, decl.api, JSON.stringify(decl.model_ids), appId, decl.provider_id, ...admissionBinds);
      const res = await db.batch([
        declaration,
        keyInsertStatement(CUSTOM_KEY_TABLE, appId, decl.provider_id, keyId, keyEnc, { verified: true }),
      ]);
      if (isNew && res[0]!.meta.changes === 0) {
        throw new InvalidCustomProviderError(`custom provider cap (${MAX_CUSTOM_PROVIDER_COUNT}) reached`);
      }
      if (res[1]!.meta.changes === 0) await throwKeyRefusal(CUSTOM_KEY_TABLE, appId, decl.provider_id);
    },

    /**
     * Delete one custom-provider declaration — and EVERY key row of its pool,
     * in ONE atomic batch (a leftover key row would be unreachable data, and
     * would resurface on a re-declaration of the same id). Returns whether
     * THIS call removed a declaration row (an undeclared provider id is an
     * idempotent no-op returning false, mirroring removeProviderKey's
     * tolerance).
     */
    async removeCustomProvider(appId: string, providerId: string): Promise<boolean> {
      const res = await db.batch([
        db.prepare(`DELETE FROM app_custom_provider_keys WHERE app_id = ? AND provider = ?`).bind(appId, providerId),
        db.prepare(`DELETE FROM app_custom_providers WHERE app_id = ? AND provider_id = ?`).bind(appId, providerId),
      ]);
      return res[1]!.meta.changes > 0;
    },

    /**
     * The settings-page declaration list: every declaration for the
     * App, provider_id-ascending, as the decrypt-free AppCustomProvider
     * shape. model_ids is parsed from the stored TEXT JSON array; a malformed
     * row throws (fail-loud, the getAppConfig tamper convention). The keys of
     * each declaration are a SEPARATE masked read (listCustomProviderKeys) —
     * this face never touches key material.
     */
    async listCustomProviders(appId: string): Promise<AppCustomProvider[]> {
      const res = await db
        .prepare(`SELECT * FROM app_custom_providers WHERE app_id = ? ORDER BY provider_id ASC`)
        .bind(appId)
        .all<AppCustomProviderRow>();
      return res.results.map((row) => ({
        provider_id: row.provider_id,
        base_url: row.base_url,
        api: row.api as CustomProviderApi,
        model_ids: parseModelIdsJson(row.model_ids, "app_custom_providers.model_ids"),
      }));
    },

    /**
     * The settings-page key list of the custom-provider pools: the same
     * per-key rows listCustomProviders' built-in counterpart serves —
     * provider + derived key id + masked tail + bookkeeping, ordered by
     * provider then pool order (created_at, key_id). `provider` scopes the
     * read to one declaration's pool. Key material never appears here.
     */
    async listCustomProviderKeys(appId: string, provider?: string): Promise<ProviderKeySummary[]> {
      const rows = await readKeyRows(CUSTOM_KEY_TABLE, appId, provider);
      const summary: ProviderKeySummary[] = [];
      for (const row of rows) {
        summary.push(await summarizeKeyRow(CUSTOM_KEY_TABLE, row));
      }
      return summary;
    },

    /**
     * Add one key to a DECLARED custom provider's pool — the unverified path
     * (upsertCustomProvider is the declaration-time verified one). The
     * declaration is read first: an undeclared provider id throws
     * InvalidCustomProviderError, because a key row without its declaration is
     * unreachable data and a silent orphan is worse than a loud refusal (the
     * "an unknown app_id is a caller bug" convention). Bounds/cap contract
     * identical to addProviderKey.
     */
    async addCustomProviderKey(appId: string, providerId: string, plainKey: string): Promise<void> {
      const declared = await db
        .prepare(`SELECT provider_id FROM app_custom_providers WHERE app_id = ? AND provider_id = ?`)
        .bind(appId, providerId)
        .first<{ provider_id: string }>();
      if (declared === null) {
        throw new InvalidCustomProviderError(`custom provider ${JSON.stringify(providerId)} is not declared for this app`);
      }
      await addKey(CUSTOM_KEY_TABLE, appId, providerId, plainKey, { verified: false });
    },

    /**
     * Delete ONE key slot of a custom-provider pool. Returns whether THIS call
     * removed a row (an unknown key id — or an undeclared provider — is an
     * idempotent no-op returning false). Custom providers keep no model cache
     * row (0015), so there is nothing else to sweep.
     */
    async deleteCustomProviderKey(appId: string, providerId: string, keyId: string): Promise<boolean> {
      // Promote the pool FIRST — same 0023 sentinel reason as deleteProviderKey.
      await readKeyRows(CUSTOM_KEY_TABLE, appId, providerId);
      const res = await db
        .prepare(`DELETE FROM app_custom_provider_keys WHERE app_id = ? AND provider = ? AND key_id = ?`)
        .bind(appId, providerId, keyId)
        .run();
      return res.meta.changes > 0;
    },

    /**
     * Decrypt the App's custom-provider declarations for the consumer
     * (the models-synthesis face): the getAppConfig analogue for
     * app_custom_providers — every declaration plus its DECRYPTED key pool,
     * provider_id-ascending and each pool in (created_at, key_id) order. An
     * undecryptable row throws (tamper / misconfiguration is never swallowed,
     * the getAppConfig convention). The settings list faces
     * (listCustomProviders / listCustomProviderKeys) stay decrypt-free.
     */
    async getCustomProvidersForConsumer(appId: string): Promise<CustomProviderConsumerConfig[]> {
      const res = await db
        .prepare(`SELECT * FROM app_custom_providers WHERE app_id = ? ORDER BY provider_id ASC`)
        .bind(appId)
        .all<AppCustomProviderRow>();
      const out: CustomProviderConsumerConfig[] = [];
      for (const row of res.results) {
        const keyRows = await readKeyRows(CUSTOM_KEY_TABLE, appId, row.provider_id);
        const apiKeys: string[] = [];
        for (const keyRow of keyRows) {
          apiKeys.push(
            await box.decryptSecret(keyRow.key_enc, customProviderKeyAad(row.app_id, row.provider_id, keyRow.key_id)),
          );
        }
        out.push({
          provider_id: row.provider_id,
          base_url: row.base_url,
          api: row.api as CustomProviderApi,
          model_ids: parseModelIdsJson(row.model_ids, "app_custom_providers.model_ids"),
          api_keys: apiKeys,
        });
      }
      return out;
    },
  };
}

/** The store face (useful for route/consumer parameter types). */
export type AppConfigStore = ReturnType<typeof createAppConfigStore>;
