/**
 * D1 store for per-App AI configuration (plan 14 B2 Task 1): the
 * `app_provider_keys` BYOK keys + the model chains (plan 35 T2: the
 * `app_model_chains` default + named chains and the `app_model_chain_seats`
 * seat references, migration 0017). Spec dashboard-multi-app-platform
 * § Per-App BYOK + § Crypto envelope; migration 0006 is the DDL single
 * source for the key tables.
 *
 * Crypto (lock L1): setProviderKey encrypts INSIDE the store via
 * src/dashboard/secretbox.ts — plaintext keys arrive only as the method
 * argument and never come back out: listProviderKeys is masked (at most the
 * last 4 characters) and getAppConfig exists for the ONE legitimate decrypt
 * consumer, the plan-14 Task 3 per-App exec-env assembly. The envelope AAD is
 * the composite row key `app_provider_keys.key_enc:<appId>:<provider>`
 * (composite-PK rowKey, lock L1). The master key (the DASHBOARD_ENCRYPTION_KEY
 * env value) is bound at factory time; a missing/malformed key surfaces as
 * SecretboxKeyError on the first encrypt/decrypt call — routes map that to
 * 5xx fail-closed.
 *
 * model_chain is stored VERBATIM (a model selector is configuration, not a
 * secret) and is never parsed here beyond the route's ≥1-token validation —
 * parseModelChain below mirrors src/review/runtime-omp.ts parseModelSelectors
 * because dashboard modules must not import review/pipeline code (architect
 * decision Q2, src/dashboard/index.ts header); behavioral parity is locked by
 * tests/worker/app-config.test.ts.
 *
 * Module boundary: dashboard-side leaf consumed by the dashboard routes and
 * (Task 3) the pipeline consumer — imports ONLY src/dashboard/secretbox.ts
 * (itself a zero-dependency leaf), so the dashboard ↛ pipeline/worker
 * isolation stays intact. The `db` parameter is a locally-declared narrow D1
 * face (types only, zero imports) — a real `D1Database`, the bun:sqlite test
 * double (tests/store/helpers.ts), and the store layer's `D1Like` all satisfy
 * it structurally (same pattern as apps-store.ts). Every write here is a
 * single statement EXCEPT the atomic multi-write faces (plan 35 T2, spec
 * §4.4): setModelChain's default-row clear-then-set, setModelChainSeats'
 * full-map save (the plan-17 role editor, now chain references), and
 * removeModelChain's seat-reference cascade — each is ONE atomic
 * `db.batch`, added for multi-write atomicity, never for throughput.
 *
 * Model chains (plan 35 T2, spec §4.4): `app_model_chains` (migration
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
 * Semantics (the Task 2 UI + Task 3 consumer call sites rely on these):
 *   - setProviderKey upserts: re-setting a provider replaces the ciphertext
 *     (one row per (app_id, provider) — the composite PK). A key longer than
 *     MAX_PROVIDER_KEY_LENGTH (4096) throws ProviderKeyTooLongError before
 *     any crypto or write (plan 15 input bounds; the settings route re-renders
 *     400 first — the guard here is the backstop for direct callers).
 *   - removeProviderKey returns whether a row was deleted (an unconfigured
 *     provider is an idempotent no-op, like setAppStatus).
 *   - listProviderKeys is the settings-page face: provider + masked tail +
 *     last-update time (migration 0012; NULL → the view's em dash),
 *     provider-ascending; a key of ≤4 characters reveals NOTHING (the mask
 *     must never render a whole key).
 *   - setModelChain(null) — or any BLANK chain (empty / whitespace-only,
 *     plan 15: aligned with the route's 空 = 清除) — REMOVES the default
 *     chain row (absent = unset; AL-24-5: a chain-less App's reviews FAIL
 *     CLOSED — the consumer rejects the message with a structured failure
 *     (plan 24 Task 6); there is no deployment-level chain to fall back to).
 *     A chain with content upserts the 'default' row VERBATIM with
 *     is_default = 1 — the per-App is_default uniqueness is enforced in ONE
 *     atomic db.batch (clear-old-set-new, spec §4.4). Read it back with
 *     getModelChain (the settings route prefills the editor from it WITHOUT
 *     decrypting any key material).
 *   - Named chains (plan 35 T2): upsertModelChain / removeModelChain /
 *     getModelChains manage user-named selector chains (is_default = 0;
 *     the name "default" is reserved and rejected at route AND store
 *     level). removeModelChain deletes the chain AND every seat reference
 *     row pointing at it in ONE atomic batch (those seats fall back to the
 *     default chain). Seats: setModelChainSeat / setModelChainSeats /
 *     clearModelChainSeat / getModelChainSeats map a role to a chain name —
 *     blank or "default" clears the reference row (absent = default chain);
 *     getModelOverridesForConsumer resolves the runner-input map (seats
 *     referencing the default chain or with no reference row are omitted).
 *   - getAppConfig decrypts for the consumer face: an App with no config
 *     yields an EMPTY keys map and a null chain (a chain referring to a
 *     provider without a key is rejected fail-closed by the consumer's
 *     assertAppConfigComplete — plan 24 Task 6; zero-config is NOT a valid
 *     review state anymore), and an undecryptable row is a loud throw
 *     (tamper/misconfiguration is never swallowed).
 *   - Custom providers (plan 23 T2, migration 0012): upsertCustomProvider /
 *     removeCustomProvider / listCustomProviders manage per-App declarations
 *     of NON-built-in model providers (base URL + AL-23-1 api enum + model
 *     ids). The key is encrypted INSIDE the store with the composite-PK AAD
 *     `app_custom_providers.api_key_enc:<app_id>:<provider_id>` (0006 L1
 *     precedent) and never appears in the list face; the Task 3 consumer
 *     decrypts it with the same AAD via getCustomProvidersForConsumer (the
 *     getAppConfig analogue — fail-loud on tamper). Declaration bounds
 *     (AL-23-1/AL-23-2) are enforced here as the backstop and by the
 *     settings route as 400.
 *   - Timestamps are SQLite datetime('now') (UTC — the reviews.reviewed_at
 *     convention). UNIQUE / FK violations throw (fail-loud): an unknown
 *     app_id is a caller bug, never a silent no-op.
 */
import { createSecretbox } from "./secretbox";

/** A row of `app_provider_keys` (D1 column names, snake_case; migration 0006). */
export type AppProviderKeyRow = {
  app_id: string;
  provider: string;
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
 * A row of `app_model_chains` (migration 0017, plan 35 T2, spec §4.4).
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

/** A row of `app_model_chain_seats` (migration 0017, plan 35 T2, spec §4.4). Absent row = the seat uses the default chain. */
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
 * A row of `app_custom_providers` (migration 0012, plan 23 T2 — D1 column
 * names, snake_case). model_ids is a TEXT JSON array (AL-23-1 DDL);
 * api_key_enc is a secretbox envelope (lock L1, composite-PK AAD).
 */
export type AppCustomProviderRow = {
  app_id: string;
  provider_id: string;
  base_url: string;
  api: string;
  model_ids: string;
  api_key_enc: string;
  created_at: string;
  updated_at: string;
  /** Verification time (migration 0015); NULL = never verified. */
  verified_at: string | null;
  /** Verification outcome ('ok' | 'failed', store-enforced; migration 0015); NULL = never verified. */
  verified_status: string | null;
};

/**
 * One custom-provider declaration (the settings-page face and the Task 3
 * consumer input): a NON-built-in model provider bound to a base URL, one
 * of the AL-23-1 protocol forms, and the model ids it serves. The API key
 * is NEVER part of this shape — it exists only as the encrypted
 * api_key_enc column (declaration-time input, decrypt consumer face in
 * plan 23 Task 3).
 */
export type AppCustomProvider = {
  provider_id: string;
  base_url: string;
  api: CustomProviderApi;
  model_ids: string[];
};
/**
 * One custom-provider declaration as the Task 3 consumer sees it (the
 * getAppConfig analogue for app_custom_providers): the decrypt-free
 * declaration PLUS the decrypted API key. The key exists ONLY on this
 * face — the settings list (listCustomProviders) stays decrypt-free.
 */
export type CustomProviderConsumerConfig = {
  provider_id: string;
  base_url: string;
  api: CustomProviderApi;
  model_ids: string[];
  api_key: string;
};

/**
 * A row of `app_provider_models` (migration 0015, plan 31 T2): the per-App
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
 * One verified-model cache entry as the settings loader sees it (plan 31
 * Interfaces — the dropdown source for selector literal grammar
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
 * its cached model list must be written under "ark-plan" — the in-image base
 * provider id that is the chain's selector prefix (IN_IMAGE_BASE_PROVIDER_IDS
 * holds the same ids). Every other provider uses its own id unchanged.
 */
export function modelCacheProviderKey(provider: string): string {
  return provider === "ark" ? "ark-plan" : provider;
}

/**
 * The provider id allowlist — the keys of the `PROVIDERS` mapping in
 * src/pipeline/providers.ts (19 provider ids incl. `ark`, same order — plan
 * 24 Task 6 / AL-24-5 added `ark` so the in-image ark-plan base provider's
 * ARK_API_KEY rides the per-App BYOK keys map like every other provider).
 * Declared locally, NOT imported: dashboard modules must not import pipeline
 * code (architect decision Q2, src/dashboard/index.ts header). The copy is
 * locked in sync by tests/worker/app-config.test.ts (id-sequence equality
 * against the pipeline mapping — the coverage-lock pattern).
 */
export const PROVIDER_IDS: readonly string[] = Object.freeze([
  "anthropic",
  "openai",
  "gemini",
  "copilot",
  "azure-openai",
  "groq",
  "cerebras",
  "xai",
  "openrouter",
  "kilo",
  "mistral",
  "zai",
  "umans",
  "minimax",
  "opencode",
  "cursor",
  "ai-gateway",
  "wafer-serverless",
  "ark",
]);

/**
 * The in-image base provider ids (plan 23 QC wave-1 W-1) — provider ids the
 * review runner's base models.yml ALREADY declares:
 * `sandbox-image/omp-models.yml`, installed in the image as
 * /opt/omp-agent/models.yml (src/review/models-synthesis.ts
 * BASE_MODELS_YAML_PATH) and preserved verbatim by the Task 3 merge. In the
 * image today that is exactly `ark-plan` (the M0 ark provider, keyed by
 * ARK_API_KEY). A custom declaration colliding with one of these ids would be
 * silently dead on EVERY review (the base-wins merge skips it while the
 * consumer still injects its key under the CUSTOM_<ID>_API_KEY env name), so
 * it is rejected here like the PROVIDER_IDS built-ins above. Declared
 * locally, NOT imported: dashboard modules must not import review code
 * (architect decision Q2, src/dashboard/index.ts header) — the literal
 * mirrors the review contract module src/review/runtime.ts (next to
 * customProviderEnvName) and the base file itself, and is parity-locked by
 * tests/worker/app-config.test.ts against sandbox-image/omp-models.yml (the
 * PROVIDER_IDS lock pattern).
 */
export const IN_IMAGE_BASE_PROVIDER_IDS: readonly string[] = Object.freeze(["ark-plan"]);

/**
 * The per-role model vocabulary (plan 17 B6, spec § B6 语义锁) — EXACTLY the
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
 * Provider-key length bound (plan 15 Task 1, spec dashboard-ops-and-role-models
 * § 硬化项 4): a pasted API key longer than this is rejected BEFORE any
 * encryption or D1 write, so an oversized input can never bloat the store.
 */
export const MAX_PROVIDER_KEY_LENGTH = 4096;
/**
 * Custom-provider declaration bounds (AL-23-2 verdict, plan 23 Global
 * Constraints): provider id `[a-z0-9][a-z0-9-]{0,63}` (the env-name mapping
 * `CUSTOM_<UPPER_SNAKE>_API_KEY` the Task 3 consumer injects), baseUrl
 * https-only ≤2048, model_ids 1..32 entries × ≤128 characters (AL-23-1).
 * The route answers 400 first; the store re-validates as the backstop for
 * direct callers (the ProviderKeyTooLongError pattern).
 */
export const CUSTOM_PROVIDER_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MAX_CUSTOM_PROVIDER_BASE_URL_LENGTH = 2048;
export const MAX_CUSTOM_PROVIDER_MODEL_IDS = 32;
export const MAX_CUSTOM_PROVIDER_MODEL_ID_LENGTH = 128;
/**
 * Declarations per App bound (plan 23 QC wave-1 W-2): the last AL-23-2 input
 * dimension left unbounded. Every declaration rides the container exec env
 * (decrypted key, ≤4096 chars each) and the runner input JSON, so an App
 * accumulating declarations grows both without limit. Growth-only: updating
 * an already-declared provider id never counts against the cap (the store
 * and the route both allow it at the cap — same spirit as the inclusive
 * model_ids bound).
 */
export const MAX_CUSTOM_PROVIDER_COUNT = 8;

/**
 * Model selector/chain input bound (AL-23-2 verdict, plan 23 Global
 * Constraints): the save-chain `model_chain` and each save-roles role
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
 * Named-chain name grammar (plan 35 T2, spec §4.4): the same
 * `[a-z0-9][a-z0-9-]{0,63}` identifier shape as custom-provider ids (the
 * established identifier convention in this module). The backfill's
 * `seat-<role>` names fit it. "default" is excluded by the reserved-name
 * check, not by the grammar.
 */
export const MODEL_CHAIN_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;
export const MAX_MODEL_CHAIN_NAME_LENGTH = 64;

/**
 * Chain-name error (plan 35 T2): an upsertModelChain/removeModelChain call
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
 * Unknown-chain error (plan 35 T2): a setModelChainSeat/setModelChainSeats
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
 * Declaration-shape error (plan 23 T2): an upsertCustomProvider call named
 * an id outside the `[a-z0-9][a-z0-9-]{0,63}` grammar, an id colliding with
 * a built-in (PROVIDER_IDS) or in-image base provider (IN_IMAGE_BASE_PROVIDER_IDS,
 * QC wave-1 W-1), a non-https or over-length base URL, an api outside the
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
 * Input-bound error (plan 15): the plaintext key passed to setProviderKey
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
 * Role-vocabulary error (plan 17): a setModelChainSeat/setModelChainSeats/
 * clearModelChainSeat call named a role outside MODEL_ROLE_IDS. The
 * settings route re-renders 400 first (plan 17 Task 3); this typed throw
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
 * Selector-grammar error (plan 17): a role selector with content parses to
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
 * Composite-PK secretbox AAD rowKey (lock L1): the envelope is bound to BOTH
 * primary-key columns of app_provider_keys, joined in DDL order.
 */
function providerKeyAad(appId: string, provider: string): string {
  return `app_provider_keys.key_enc:${appId}:${provider}`;
}
/**
 * Composite-PK secretbox AAD rowKey for app_custom_providers (lock L1, 0006
 * precedent): the envelope is bound to BOTH primary-key columns, joined in
 * DDL order — `app_custom_providers.api_key_enc:<app_id>:<provider_id>`.
 * The Task 3 consumer decrypts with this exact string.
 */
function customProviderAad(appId: string, providerId: string): string {
  return `app_custom_providers.api_key_enc:${appId}:${providerId}`;
}

/**
 * Declaration-shape gate (plan 23 T2): every bound in the AL-23-1/AL-23-2
 * verdicts, checked BEFORE any crypto or write — an invalid declaration
 * throws InvalidCustomProviderError (or ProviderKeyTooLongError for an
 * over-length key, the setProviderKey convention) and touches zero rows.
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
  // QC wave-1 W-1: an id the in-image base models.yml already declares
  // (ark-plan) would be skipped base-wins at synthesis — silently dead on
  // every review — so it is rejected exactly like a built-in collision.
  if (IN_IMAGE_BASE_PROVIDER_IDS.includes(decl.provider_id)) {
    throw new InvalidCustomProviderError(
      `custom provider id ${JSON.stringify(decl.provider_id)} collides with an in-image base provider id`,
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
 * Named-chain name gate (plan 35 T2, spec §4.4): the reserved "default"
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

/** One masked list entry (the settings page shows exactly this — no more). */
export type MaskedProviderKey = {
  provider: string;
  /** Last 4 plaintext characters; "" when the key is too short to mask safely. */
  last4: string;
  /** Last write time (migration 0012); NULL = pre-0012 row (em dash in the view). */
  updated_at: string | null;
};

/** The decrypted per-App configuration (the plan-14 Task 3 consumer face). */
export type AppConfig = {
  appId: string;
  /** provider id → decrypted key; only providers with a stored key appear. */
  keys: Record<string, string>;
  /** Verbatim stored chain; null = unset (missing/empty = that App's reviews fail closed — plan 24 Task 6 / AL-24-5). */
  modelChain: string | null;
};

/** One chain as the settings face sees it (plan 35 T2, spec §4.4). */
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
 * plus `batch` for the atomic multi-write faces (plan 35 T2, spec §4.4):
 * setModelChain's default-row clear-then-set, setModelChainSeats' full-map
 * save, and removeModelChain's seat-reference cascade. A real
 * `D1Database`, the bun:sqlite test double (tests/store/helpers.ts) and
 * the store layer's `D1Like` all satisfy it structurally.
 */
type AppConfigStatement = {
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
   * The App's default chain value (spec §4.4): the 'default' row of
   * app_model_chains, or null when no default row exists (absent = unset =
   * that App's reviews fail closed — plan 24 Task 6 / AL-24-5).
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
   * The App's per-role model overrides for the consumer (plan 35 T2, spec
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
     * Store (or replace) one provider key for the App: encrypts INSIDE with
     * the composite-PK AAD, then upserts the (app_id, provider) row. The
     * plaintext is never persisted, logged, or returned. A key longer than
     * MAX_PROVIDER_KEY_LENGTH throws ProviderKeyTooLongError before any
     * crypto or write (the route answers 400 first; this is the backstop).
     * The upsert maintains the row's write time (migration 0012): a fresh
     * insert writes updated_at == created_at from ONE clock read; re-setting
     * moves both forward. Overwriting a previously verified row with a NEW
     * key also resets verified_at/verified_status to NULL (migration 0015) —
     * verification belongs to the (provider, key) pair, not the row; the new
     * key has not been verified until saveVerifiedKey runs again. (The
     * save-then-verify flow uses saveVerifiedKey; setProviderKey is the
     * legacy unverified path and any leftover caller must not inherit a
     * stale verified_status.)
     */
    async setProviderKey(appId: string, provider: string, plainKey: string): Promise<void> {
      if (plainKey.length > MAX_PROVIDER_KEY_LENGTH) {
        throw new ProviderKeyTooLongError();
      }
      const keyEnc = await box.encryptSecret(plainKey, providerKeyAad(appId, provider));
      await db
        .prepare(
          // One clock read for BOTH timestamps (migration 0012): a fresh insert
          // guarantees updated_at == created_at deterministically (SQLite cannot
          // alias a VALUES expression, so the CTE holds the single read); the
          // upsert moves both forward on re-set (today's created_at semantics).
          `WITH now AS (SELECT datetime('now') AS ts)
           INSERT INTO app_provider_keys (app_id, provider, key_enc, created_at, updated_at)
           VALUES (?, ?, ?, (SELECT ts FROM now), (SELECT ts FROM now))
           ON CONFLICT (app_id, provider) DO UPDATE SET
             key_enc = excluded.key_enc,
             created_at = (SELECT ts FROM now),
             updated_at = (SELECT ts FROM now),
             verified_at = NULL,
             verified_status = NULL`,
        )
        .bind(appId, provider, keyEnc)
        .run();
    },

    /**
     * Store one provider key AFTER successful verification (plan 31 T3): the
     * verified analogue of setProviderKey — encrypts with the SAME
     * composite-PK AAD, upserts the (app_id, provider) row with the
     * verification bookkeeping (migration 0015: verified_at = now +
     * verified_status = 'ok'), and upserts the App's verified-model cache row
     * under the SELECTOR-FACING provider key (modelCacheProviderKey — an
     * `ark` BYOK key caches under "ark-plan", spec §6.1) as ONE atomic
     * db.batch (D1 batch is transactional; a mid-save failure rolls back both
     * statements, so a verified key with no cache row is impossible).
     * `models` may be [] (a provider that only got an auth-probe has an
     * empty cache — that is the "probe-only" signal Task 4's member
     * validation falls back to syntax-only on). Bounds/backstop contract
     * identical to setProviderKey (a key longer than MAX_PROVIDER_KEY_LENGTH
     * throws ProviderKeyTooLongError before any crypto or write; the callers
     * that still write UNverified rows via setProviderKey keep compiling —
     * Task 4 switches the save flow over; until then those rows stay
     * verified_status NULL = legacy unverified).
     */
    async saveVerifiedKey(appId: string, provider: string, plainKey: string, models: string[]): Promise<void> {
      if (plainKey.length > MAX_PROVIDER_KEY_LENGTH) {
        throw new ProviderKeyTooLongError();
      }
      const keyEnc = await box.encryptSecret(plainKey, providerKeyAad(appId, provider));
      // modelCacheProviderKey maps the BYOK id to the selector-facing cache
      // key (ark → ark-plan) — the ONLY place that relationship is applied.
      const cacheProvider = modelCacheProviderKey(provider);
      // One clock read per statement pair (the 0012 T1 convention); the key
      // upsert moves created_at/updated_at forward exactly like setProviderKey.
      await db.batch([
        db.prepare(
          `WITH now AS (SELECT datetime('now') AS ts)
           INSERT INTO app_provider_keys (app_id, provider, key_enc, created_at, updated_at, verified_at, verified_status)
           VALUES (?, ?, ?, (SELECT ts FROM now), (SELECT ts FROM now), (SELECT ts FROM now), 'ok')
           ON CONFLICT (app_id, provider) DO UPDATE SET
             key_enc = excluded.key_enc,
             created_at = (SELECT ts FROM now),
             updated_at = (SELECT ts FROM now),
             verified_at = excluded.verified_at,
             verified_status = excluded.verified_status`,
        ).bind(appId, provider, keyEnc),
        db.prepare(
          `WITH now AS (SELECT datetime('now') AS ts)
           INSERT INTO app_provider_models (app_id, provider, models_json, fetched_at)
           VALUES (?, ?, ?, (SELECT ts FROM now))
           ON CONFLICT (app_id, provider) DO UPDATE SET
             models_json = excluded.models_json,
             fetched_at = (SELECT ts FROM now)`,
        ).bind(appId, cacheProvider, JSON.stringify(models)),
      ]);
    },

    /**
     * Delete one provider key row — and the App's verified-model cache row
     * for the same provider, in ONE atomic batch (a removed key must not
     * linger as "verified" in the settings dropdown; saveVerifiedKey writes
     * both rows transactionally, so removal is transactional too). The cache
     * row lives under the SELECTOR-FACING provider key — modelCacheProviderKey
     * maps an `ark` BYOK key to its "ark-plan" cache row (spec §6.1), so
     * `removeProviderKey(appId, "ark")` deletes that row as well. Returns
     * whether THIS call removed the key row (an unconfigured provider — or
     * any provider the allowlist could never have stored — is a no-op
     * returning false).
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
     * Masked key list for the settings page: decrypts each row in memory and
     * reduces it to provider + last-4 + last-update time (migration 0012;
     * NULL for rows written before 0012 — the view's em dash placeholder).
     * The plaintext NEVER appears in the return value — and because this is
     * the only list face, it cannot leak into HTML either.
     */
    async listProviderKeys(appId: string): Promise<MaskedProviderKey[]> {
      const res = await db
        .prepare(`SELECT * FROM app_provider_keys WHERE app_id = ? ORDER BY provider ASC`)
        .bind(appId)
        .all<AppProviderKeyRow>();
      const masked: MaskedProviderKey[] = [];
      for (const row of res.results) {
        const plain = await box.decryptSecret(row.key_enc, providerKeyAad(row.app_id, row.provider));
        masked.push({ provider: row.provider, last4: maskTail(plain), updated_at: row.updated_at });
      }
      return masked;
    },

    /**
     * Store the App's default model chain VERBATIM (the route has already
     * validated ≥1 selector), or clear it: `null` AND any blank chain
     * (empty or whitespace-only — the route's 空 = 清除 semantics, plan 15
     * alignment) REMOVE the 'default' row (absent = unset; a chain-less
     * App's reviews fail closed in the consumer with `per-App config
     * incomplete: app <id>: missing model chain` — plan 24 Task 6; no
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
     * Decrypt the App's full configuration for the consumer (Task 3 env
     * assembly): provider-id → plaintext key for every stored provider, plus
     * the model chain. No config → `{ keys: {}, modelChain: null }`. An
     * undecryptable row throws (tamper/misconfiguration is never swallowed).
     */
    async getAppConfig(appId: string): Promise<AppConfig> {
      const res = await db
        .prepare(`SELECT * FROM app_provider_keys WHERE app_id = ? ORDER BY provider ASC`)
        .bind(appId)
        .all<AppProviderKeyRow>();
      const keys: Record<string, string> = {};
      for (const row of res.results) {
        keys[row.provider] = await box.decryptSecret(row.key_enc, providerKeyAad(row.app_id, row.provider));
      }
      return { appId, keys, modelChain: await readModelChain(appId) };
    },

    /**
     * The App's verified-model cache (plan 31 Interfaces read face): every
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
     * The App's chains (settings face, plan 35 T2): every app_model_chains
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
     * Create or replace one NAMED chain (plan 35 T2, spec §4.4): the name
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
     * The App's seat → chain-name map (settings face, plan 35 T2): role →
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
     * row (absent = default chain, spec §4.4). Validation BEFORE any
     * write: an off-vocabulary role throws UnknownModelRoleError and a
     * content-bearing chain_name that names no stored chain throws
     * UnknownModelChainError (the route re-renders 400 first; these are
     * the backstop for direct callers). An unknown app_id fails the FK on
     * insert (fail-loud, same as every write here); clearing an unmapped
     * seat is a quiet no-op.
     */
    async setModelChainSeat(appId: string, role: string, chainName: string): Promise<void> {
      assertModelRole(role);
      if (chainName.trim() === "" || chainName === DEFAULT_CHAIN_NAME) {
        await deleteModelChainSeat(appId, role);
        return;
      }
      await assertChainExists(appId, chainName);
      await upsertModelChainSeat(appId, role, chainName);
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
     * Bulk face for the settings single-save (the plan-17 4-row editor,
     * now chain references, plan 35 T2): validates EVERY (role, chain_name)
     * entry BEFORE any write (one bad entry → typed throw, zero rows
     * touched), then applies the whole map as ONE atomic `db.batch` —
     * blank / "default" = clear (absent = default chain), content =
     * verbatim chain reference. D1 batch is transactional: a mid-save
     * failure rolls back every statement, so a partially applied seat map
     * is impossible and the route's "nothing was stored" failure notice
     * stays truthful. An empty map is a no-op (no batch is issued).
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
      const statements = entries.map(([role, chainName]) =>
        chainName.trim() === "" || chainName === DEFAULT_CHAIN_NAME
          ? deleteModelChainSeatStatement(appId, role)
          : upsertModelChainSeatStatement(appId, role, chainName),
      );
      if (statements.length > 0) {
        await db.batch(statements);
      }
    },

    /**
     * The App's per-role model overrides for the consumer (plan 35 T2, spec
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
     * Store (or replace) one custom-provider declaration for the App (plan
     * 23 T2): validates the full AL-23-1/AL-23-2 shape, encrypts the key
     * INSIDE with the composite-PK AAD, then upserts the (app_id,
     * provider_id) row. The plaintext key is never persisted, logged, or
     * returned — it exists only as the api_key_enc envelope (the Task 3
     * consumer decrypts it with the same AAD). model_ids is stored as a
     * TEXT JSON array (AL-23-1 DDL). An invalid declaration throws
     * InvalidCustomProviderError / ProviderKeyTooLongError before any
     * crypto or write (the route answers 400 first; this is the backstop).
     * The declaration-count bound (MAX_CUSTOM_PROVIDER_COUNT, QC wave-1 W-2)
     * is growth-only: a NEW id at the cap throws before any crypto or write;
     * re-declaring an EXISTING id (an update, not growth) always proceeds.
     * The cap is enforced ATOMICALLY (PR #10 cap-race fix): the new-id
     * insert is conditional (`WHERE count < cap`), so two concurrent saves
     * racing for the last slot cannot both land — the loser's insert matches
     * zero rows and throws the cap error. The pre-check below stays as the
     * fast 400 path (defense in depth, both layers).
     * The upsert maintains the row's write time from ONE clock read (the
     * 0012 T1 convention): a fresh insert writes updated_at == created_at;
     * re-declaring moves both forward.
     */
    async upsertCustomProvider(appId: string, decl: AppCustomProvider, plainKey: string): Promise<void> {
      assertCustomProvider(decl, plainKey);
      // Growth-only cap: only a provider id with NO row yet can push the App
      // past MAX_CUSTOM_PROVIDER_COUNT declarations (an upsert of an existing
      // id replaces the row in place — no count change). Two SELECTs on the
      // new-declaration path, zero on the update path; small next to the
      // encrypt (accepted — same posture as the consumer's no-cache re-reads).
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
      const keyEnc = await box.encryptSecret(plainKey, customProviderAad(appId, decl.provider_id));
      if (isNew) {
        // Atomic cap (PR #10 cap-race fix): the INSERT only fires while the
        // App is under the cap — a concurrent save that won the last slot
        // makes this one match zero rows (changes === 0) and the cap error
        // is thrown instead of a silent over-cap insert. One clock read for
        // both timestamps (the 0012 T1 convention, same as the upsert).
        const res = await db
          .prepare(
            `WITH now AS (SELECT datetime('now') AS ts)
             INSERT INTO app_custom_providers (app_id, provider_id, base_url, api, model_ids, api_key_enc, created_at, updated_at, verified_at, verified_status)
             SELECT ?, ?, ?, ?, ?, ?, (SELECT ts FROM now), (SELECT ts FROM now), (SELECT ts FROM now), 'ok'
             WHERE (SELECT COUNT(*) FROM app_custom_providers WHERE app_id = ?) < ${MAX_CUSTOM_PROVIDER_COUNT}`,
          )
          .bind(appId, decl.provider_id, decl.base_url, decl.api, JSON.stringify(decl.model_ids), keyEnc, appId)
          .run();
        if (res.meta.changes === 0) {
          throw new InvalidCustomProviderError(`custom provider cap (${MAX_CUSTOM_PROVIDER_COUNT}) reached`);
        }
        return;
      }
      await db
        .prepare(
          `WITH now AS (SELECT datetime('now') AS ts)
           INSERT INTO app_custom_providers (app_id, provider_id, base_url, api, model_ids, api_key_enc, created_at, updated_at, verified_at, verified_status)
           VALUES (?, ?, ?, ?, ?, ?, (SELECT ts FROM now), (SELECT ts FROM now), (SELECT ts FROM now), 'ok')
           ON CONFLICT (app_id, provider_id) DO UPDATE SET
             base_url = excluded.base_url,
             api = excluded.api,
             model_ids = excluded.model_ids,
             api_key_enc = excluded.api_key_enc,
             created_at = (SELECT ts FROM now),
             updated_at = (SELECT ts FROM now),
             verified_at = excluded.verified_at,
             verified_status = excluded.verified_status`,
        )
        .bind(appId, decl.provider_id, decl.base_url, decl.api, JSON.stringify(decl.model_ids), keyEnc)
        .run();
    },

    /**
     * Delete one custom-provider declaration. Returns whether THIS call
     * removed a row (an undeclared provider id is an idempotent no-op
     * returning false, mirroring removeProviderKey's tolerance).
     */
    async removeCustomProvider(appId: string, providerId: string): Promise<boolean> {
      const res = await db
        .prepare(`DELETE FROM app_custom_providers WHERE app_id = ? AND provider_id = ?`)
        .bind(appId, providerId)
        .run();
      return res.meta.changes > 0;
    },

    /**
     * The settings-page list face (plan 23 T2): every declaration for the
     * App, provider_id-ascending, as the decrypt-free AppCustomProvider
     * shape — the key material NEVER appears (it exists only as the
     * api_key_enc envelope; the Task 3 consumer decrypts it separately).
     * model_ids is parsed from the stored TEXT JSON array; a malformed row
     * throws (fail-loud, the getAppConfig tamper convention).
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
     * Decrypt the App's custom-provider declarations for the consumer
     * (plan 23 Task 3 models synthesis): the getAppConfig analogue for
     * app_custom_providers — every declaration plus its decrypted key,
     * provider_id-ascending. An undecryptable row throws (tamper /
     * misconfiguration is never swallowed, the getAppConfig convention).
     * The settings list face (listCustomProviders) stays decrypt-free.
     */
    async getCustomProvidersForConsumer(appId: string): Promise<CustomProviderConsumerConfig[]> {
      const res = await db
        .prepare(`SELECT * FROM app_custom_providers WHERE app_id = ? ORDER BY provider_id ASC`)
        .bind(appId)
        .all<AppCustomProviderRow>();
      const out: CustomProviderConsumerConfig[] = [];
      for (const row of res.results) {
        out.push({
          provider_id: row.provider_id,
          base_url: row.base_url,
          api: row.api as CustomProviderApi,
          model_ids: parseModelIdsJson(row.model_ids, "app_custom_providers.model_ids"),
          api_key: await box.decryptSecret(row.api_key_enc, customProviderAad(row.app_id, row.provider_id)),
        });
      }
      return out;
    },
  };
}

/** The store face (useful for route/consumer parameter types). */
export type AppConfigStore = ReturnType<typeof createAppConfigStore>;
