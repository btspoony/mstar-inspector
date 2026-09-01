/**
 * D1 store for per-App AI configuration (plan 14 B2 Task 1): the
 * `app_provider_keys` BYOK keys + the `app_model_config` model chain. Spec
 * dashboard-multi-app-platform § Per-App BYOK + § Crypto envelope; migration
 * 0006 is the DDL single source.
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
 * single statement EXCEPT setModelRoles (Phase 5 fix, PR #7 review): the
 * role editor's full-map save is ONE atomic `db.batch` — the only batch on
 * the face, added for multi-write atomicity, never for throughput.
 *
 * Model roles (plan 17 B6): `app_model_roles` (migration 0009) maps each of
 * the 4 audit-seat agent names to its own selector chain per App. The role
 * vocabulary lives here as the MODEL_ROLE_IDS mirror (importing the runner
 * side via src/review is forbidden by the dashboard isolation — Q2), and the
 * selector grammar is validated with the parseModelChain mirror above; both
 * copies are parity-locked by tests/worker/app-config.test.ts. Roles are
 * decrypt-free (selectors are configuration, not secrets) and are consumed
 * by the pipeline consumer as the runner input `modelOverrides` field.
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
 *     plan 15: aligned with the route's 空 = 清除) — REMOVES the row (absent
 *     = unset; AL-24-5: a chain-less App's reviews FAIL CLOSED — the consumer
 *     rejects the message with a structured failure (plan 24 Task 6); there
 *     is no deployment-level chain to fall back to). A chain with content
 *     upserts verbatim. Read it back with getModelChain (the settings route
 *     prefills the editor from it WITHOUT decrypting any key material).
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
};

/** A row of `app_model_config` (migration 0006). Absent row = chain unset. */
export type AppModelConfigRow = {
  app_id: string;
  /** Verbatim comma-separated selector chain; NULL = unset (such an App's reviews fail closed — plan 24 Task 6). */
  model_chain: string | null;
  updated_at: string;
};

/** A row of `app_model_roles` (migration 0009, plan 17). Absent row = the role is unmapped (chain behavior). */
export type AppModelRoleRow = {
  app_id: string;
  /** One of the MODEL_ROLE_IDS audit-seat agent names. */
  role: string;
  /** Verbatim comma-separated selector chain — configuration, not a secret. */
  selector: string;
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
 * Parse the stored TEXT JSON array of model ids (AL-23-1 DDL) — fail-loud
 * on anything that is not a JSON array of strings (the getAppConfig tamper
 * convention): a malformed row throws in the store, never deferring to a
 * caller's `.join` on a non-array.
 */
function parseCustomProviderModelIds(raw: string): string[] {
  const parsed: unknown = JSON.parse(raw);
  if (!Array.isArray(parsed) || !parsed.every((id) => typeof id === "string")) {
    throw new Error(
      `app-config-store: app_custom_providers.model_ids is not a JSON array of strings: ${JSON.stringify(raw)}`,
    );
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
 * Role-vocabulary error (plan 17): a setModelRole/setModelRoles/clearModelRole
 * call named a role outside MODEL_ROLE_IDS. The settings route re-renders 400
 * first (plan 17 Task 3); this typed throw is the backstop for direct callers.
 * Same class convention as ProviderKeyTooLongError (name set for structured
 * logs).
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
 * Validate one (role, selector) entry (plan 17): the role must be on the
 * MODEL_ROLE_IDS vocabulary and a selector WITH content must parse to ≥1
 * comma-separated selector (the parseModelChain mirror). A BLANK selector is
 * legal by design — it clears the mapping.
 */
function assertModelRoleEntry(role: string, selector: string): void {
  assertModelRole(role);
  if (selector.trim() !== "" && parseModelChain(selector).length === 0) {
    throw new InvalidModelSelectorError(selector);
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
 * plus exactly ONE `batch` (the setModelRoles atomic full-map save — the
 * store never batches for any other purpose). A real `D1Database`, the
 * bun:sqlite test double (tests/store/helpers.ts) and the store layer's
 * `D1Like` all satisfy it structurally.
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

  async function readModelChain(appId: string): Promise<string | null> {
    const row = await db
      .prepare(`SELECT model_chain FROM app_model_config WHERE app_id = ?`)
      .bind(appId)
      .first<Pick<AppModelConfigRow, "model_chain">>();
    return row?.model_chain ?? null;
  }

  /**
   * The App's role → selector map, role-ascending for deterministic key
   * order; only MAPPED roles appear (no row = unmapped = chain behavior).
   */
  async function readModelRoles(appId: string): Promise<Record<string, string>> {
    const res = await db
      .prepare(`SELECT role, selector FROM app_model_roles WHERE app_id = ? ORDER BY role ASC`)
      .bind(appId)
      .all<Pick<AppModelRoleRow, "role" | "selector">>();
    const roles: Record<string, string> = {};
    for (const row of res.results) {
      roles[row.role] = row.selector;
    }
    return roles;
  }

  /** Prepared DELETE for one role's mapping row (run() or ride in a batch). */
  function deleteModelRoleStatement(appId: string, role: string): AppConfigStatement {
    return db.prepare(`DELETE FROM app_model_roles WHERE app_id = ? AND role = ?`).bind(appId, role);
  }

  /** Prepared verbatim upsert of one role's selector (run() or ride in a batch). */
  function upsertModelRoleStatement(appId: string, role: string, selector: string): AppConfigStatement {
    return db
      .prepare(
        `INSERT INTO app_model_roles (app_id, role, selector)
         VALUES (?, ?, ?)
         ON CONFLICT (app_id, role) DO UPDATE SET
           selector = excluded.selector`,
      )
      .bind(appId, role, selector);
  }

  /** Delete one role's mapping row (idempotent — an unmapped role deletes nothing). */
  async function deleteModelRole(appId: string, role: string): Promise<void> {
    await deleteModelRoleStatement(appId, role).run();
  }

  /** Upsert one role's selector VERBATIM (one row per (app_id, role) composite PK). */
  async function upsertModelRole(appId: string, role: string, selector: string): Promise<void> {
    await upsertModelRoleStatement(appId, role, selector).run();
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
     * moves both forward.
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
             updated_at = (SELECT ts FROM now)`,
        )
        .bind(appId, provider, keyEnc)
        .run();
    },

    /**
     * Delete one provider key row. Returns whether THIS call removed a row
     * (an unconfigured provider — or any provider the allowlist could never
     * have stored — is a no-op returning false).
     */
    async removeProviderKey(appId: string, provider: string): Promise<boolean> {
      const res = await db
        .prepare(`DELETE FROM app_provider_keys WHERE app_id = ? AND provider = ?`)
        .bind(appId, provider)
        .run();
      return res.meta.changes > 0;
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
     * Store the App's model chain VERBATIM (the route has already validated
     * ≥1 selector), or clear it: `null` AND any blank chain (empty or
     * whitespace-only — the route's 空 = 清除 semantics, plan 15 alignment)
     * REMOVE the row (absent = unset; a chain-less App's reviews fail closed
     * in the consumer — plan 24 Task 6; no deployment-level fallback exists).
     * A chain with content upserts verbatim, interior/trailing whitespace
     * included.
     */
    async setModelChain(appId: string, chain: string | null): Promise<void> {
      if (chain === null || chain.trim() === "") {
        await db.prepare(`DELETE FROM app_model_config WHERE app_id = ?`).bind(appId).run();
        return;
      }
      await db
        .prepare(
          `INSERT INTO app_model_config (app_id, model_chain, updated_at)
           VALUES (?, ?, datetime('now'))
           ON CONFLICT (app_id) DO UPDATE SET
             model_chain = excluded.model_chain,
             updated_at = datetime('now')`,
        )
        .bind(appId, chain)
        .run();
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
     * The App's per-role selector map (plan 17 B6): role → verbatim selector
     * chain, only the MAPPED roles appear; an App with no mapped roles
     * yields `{}` (= today's chain behavior). Decrypt-free by design — a
     * model selector is configuration, not a secret (the 0006 model_chain
     * rationale) — the pipeline consumer reads this per message to build the
     * runner input `modelOverrides` field, so a dashboard role update
     * applies to the very next review.
     */
    getAppModelRoles(appId: string): Promise<Record<string, string>> {
      return readModelRoles(appId);
    },

    /**
     * Map (or replace) one role's selector VERBATIM, or clear the mapping: a
     * BLANK selector (empty / whitespace-only — the setModelChain 空 = 清除
     * convention) DELETES the row. Validation BEFORE any write: an
     * off-vocabulary role throws UnknownModelRoleError and a content-bearing
     * selector that parses to zero selectors throws InvalidModelSelectorError
     * (the route re-renders 400 first; these are the backstop for direct
     * callers). An unknown app_id fails the FK on insert (fail-loud, same as
     * every write here); clearing an unmapped role is a quiet no-op.
     */
    async setModelRole(appId: string, role: string, selector: string): Promise<void> {
      assertModelRoleEntry(role, selector);
      if (selector.trim() === "") {
        await deleteModelRole(appId, role);
        return;
      }
      await upsertModelRole(appId, role, selector);
    },

    /**
     * Remove one role's mapping explicitly (idempotent — an unmapped role,
     * like any role the vocabulary could never have stored, is a no-op
     * returning nothing, mirroring removeProviderKey's tolerance).
     */
    async clearModelRole(appId: string, role: string): Promise<void> {
      assertModelRole(role);
      await deleteModelRole(appId, role);
    },

    /**
     * Bulk face for the settings single-save (plan 17 Task 3's 4-row editor):
     * validates EVERY (role, selector) entry BEFORE any write (one bad entry
     * → typed throw, zero rows touched), then applies the whole map as ONE
     * atomic `db.batch` (Phase 5 fix, PR #7 review) — blank = clear, content
     * = verbatim upsert. D1 batch is transactional: a mid-save failure rolls
     * back every statement, so a partially applied role map is impossible and
     * the route's "nothing was stored" failure notice stays truthful. An
     * empty map is a no-op (no batch is issued).
     */
    async setModelRoles(appId: string, selectors: Record<string, string>): Promise<void> {
      for (const [role, selector] of Object.entries(selectors)) {
        assertModelRoleEntry(role, selector);
      }
      const statements = Object.entries(selectors).map(([role, selector]) =>
        selector.trim() === ""
          ? deleteModelRoleStatement(appId, role)
          : upsertModelRoleStatement(appId, role, selector),
      );
      if (statements.length > 0) {
        await db.batch(statements);
      }
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
             INSERT INTO app_custom_providers (app_id, provider_id, base_url, api, model_ids, api_key_enc, created_at, updated_at)
             SELECT ?, ?, ?, ?, ?, ?, (SELECT ts FROM now), (SELECT ts FROM now)
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
           INSERT INTO app_custom_providers (app_id, provider_id, base_url, api, model_ids, api_key_enc, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, (SELECT ts FROM now), (SELECT ts FROM now))
           ON CONFLICT (app_id, provider_id) DO UPDATE SET
             base_url = excluded.base_url,
             api = excluded.api,
             model_ids = excluded.model_ids,
             api_key_enc = excluded.api_key_enc,
             created_at = (SELECT ts FROM now),
             updated_at = (SELECT ts FROM now)`,
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
        model_ids: parseCustomProviderModelIds(row.model_ids),
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
          model_ids: parseCustomProviderModelIds(row.model_ids),
          api_key: await box.decryptSecret(row.api_key_enc, customProviderAad(row.app_id, row.provider_id)),
        });
      }
      return out;
    },
  };
}

/** The store face (useful for route/consumer parameter types). */
export type AppConfigStore = ReturnType<typeof createAppConfigStore>;
