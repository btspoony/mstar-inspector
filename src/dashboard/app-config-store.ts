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
 * it structurally (same pattern as apps-store.ts; this store never batches).
 *
 * Semantics (the Task 2 UI + Task 3 consumer call sites rely on these):
 *   - setProviderKey upserts: re-setting a provider replaces the ciphertext
 *     (one row per (app_id, provider) — the composite PK).
 *   - removeProviderKey returns whether a row was deleted (an unconfigured
 *     provider is an idempotent no-op, like setAppStatus).
 *   - listProviderKeys is the settings-page face: provider + masked tail
 *     only, provider-ascending; a key of ≤4 characters reveals NOTHING
 *     (the mask must never render a whole key).
 *   - setModelChain(null) REMOVES the row (absent = unset = global fallback,
 *     Clarify #2: 空 = 全局); a non-null chain upserts verbatim. Read it
 *     back with getModelChain (the settings route prefills the editor from
 *     it WITHOUT decrypting any key material).
 *   - getAppConfig decrypts for the consumer face: an App with no config
 *     yields an EMPTY keys map and a null chain (zero-config compatibility —
 *     the consumer falls back to global env), and an undecryptable row is a
 *     loud throw (tamper/misconfiguration is never swallowed).
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
};

/** A row of `app_model_config` (migration 0006). Absent row = chain unset. */
export type AppModelConfigRow = {
  app_id: string;
  /** Verbatim comma-separated selector chain; NULL = unset (global fallback). */
  model_chain: string | null;
  updated_at: string;
};

/**
 * The provider id allowlist — the keys of the `PROVIDERS` mapping in
 * src/pipeline/providers.ts (18 built-in omp providers, same order). Declared
 * locally, NOT imported: dashboard modules must not import pipeline code
 * (architect decision Q2, src/dashboard/index.ts header). The copy is locked
 * in sync by tests/worker/app-config.test.ts (id-sequence equality against
 * the pipeline mapping — the same coverage-lock pattern as
 * tests/scripts/provider-keys).
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
 * Composite-PK secretbox AAD rowKey (lock L1): the envelope is bound to BOTH
 * primary-key columns of app_provider_keys, joined in DDL order.
 */
function providerKeyAad(appId: string, provider: string): string {
  return `app_provider_keys.key_enc:${appId}:${provider}`;
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
};

/** The decrypted per-App configuration (the plan-14 Task 3 consumer face). */
export type AppConfig = {
  appId: string;
  /** provider id → decrypted key; only providers with a stored key appear. */
  keys: Record<string, string>;
  /** Verbatim stored chain; null = unset (the consumer falls back to OMP_REVIEW_MODEL). */
  modelChain: string | null;
};

/**
 * Narrow D1 face, declared locally so this leaf module imports nothing
 * structural (prepare/bind/first/all/run; no batch — this store never
 * batches).
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

type AppConfigD1 = {
  prepare(query: string): AppConfigStatement;
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

  return {
    /**
     * Store (or replace) one provider key for the App: encrypts INSIDE with
     * the composite-PK AAD, then upserts the (app_id, provider) row. The
     * plaintext is never persisted, logged, or returned.
     */
    async setProviderKey(appId: string, provider: string, plainKey: string): Promise<void> {
      const keyEnc = await box.encryptSecret(plainKey, providerKeyAad(appId, provider));
      await db
        .prepare(
          `INSERT INTO app_provider_keys (app_id, provider, key_enc, created_at)
           VALUES (?, ?, ?, datetime('now'))
           ON CONFLICT (app_id, provider) DO UPDATE SET
             key_enc = excluded.key_enc,
             created_at = datetime('now')`,
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
     * reduces it to provider + last-4 (≤4-char keys reveal nothing). The
     * plaintext NEVER appears in the return value — and because this is the
     * only list face, it cannot leak into HTML either.
     */
    async listProviderKeys(appId: string): Promise<MaskedProviderKey[]> {
      const res = await db
        .prepare(`SELECT * FROM app_provider_keys WHERE app_id = ? ORDER BY provider ASC`)
        .bind(appId)
        .all<AppProviderKeyRow>();
      const masked: MaskedProviderKey[] = [];
      for (const row of res.results) {
        const plain = await box.decryptSecret(row.key_enc, providerKeyAad(row.app_id, row.provider));
        masked.push({ provider: row.provider, last4: maskTail(plain) });
      }
      return masked;
    },

    /**
     * Store the App's model chain VERBATIM (the route has already validated
     * ≥1 selector), or clear it with `null` (row removed — absent = unset =
     * global fallback).
     */
    async setModelChain(appId: string, chain: string | null): Promise<void> {
      if (chain === null) {
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
  };
}

/** The store face (useful for route/consumer parameter types). */
export type AppConfigStore = ReturnType<typeof createAppConfigStore>;
