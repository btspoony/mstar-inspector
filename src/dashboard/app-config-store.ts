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
 *   - listProviderKeys is the settings-page face: provider + masked tail
 *     only, provider-ascending; a key of ≤4 characters reveals NOTHING
 *     (the mask must never render a whole key).
 *   - setModelChain(null) — or any BLANK chain (empty / whitespace-only,
 *     plan 15: aligned with the route's 空 = 清除) — REMOVES the row (absent
 *     = unset = global fallback, Clarify #2: 空 = 全局); a chain with content
 *     upserts verbatim. Read it back with getModelChain (the settings route
 *     prefills the editor from it WITHOUT decrypting any key material).
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

/** A row of `app_model_roles` (migration 0009, plan 17). Absent row = the role is unmapped (chain behavior). */
export type AppModelRoleRow = {
  app_id: string;
  /** One of the MODEL_ROLE_IDS audit-seat agent names. */
  role: string;
  /** Verbatim comma-separated selector chain — configuration, not a secret. */
  selector: string;
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
 * Provider-key length bound (plan 15 Task 1, spec dashboard-ops-and-role-models
 * § 硬化项 4): a pasted API key longer than this is rejected BEFORE any
 * encryption or D1 write, so an oversized input can never bloat the store.
 */
export const MAX_PROVIDER_KEY_LENGTH = 4096;

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
     */
    async setProviderKey(appId: string, provider: string, plainKey: string): Promise<void> {
      if (plainKey.length > MAX_PROVIDER_KEY_LENGTH) {
        throw new ProviderKeyTooLongError();
      }
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
     * ≥1 selector), or clear it: `null` AND any blank chain (empty or
     * whitespace-only — the route's 空 = 清除 semantics, plan 15 alignment)
     * REMOVE the row (absent = unset = global fallback). A chain with content
     * upserts verbatim, interior/trailing whitespace included.
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
  };
}

/** The store face (useful for route/consumer parameter types). */
export type AppConfigStore = ReturnType<typeof createAppConfigStore>;
