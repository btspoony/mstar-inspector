/**
 * D1 store for `github_apps` / `app_installations` (plan 13 Task 1) — the
 * ONE write authority for multi-App rows. Spec
 * dashboard-multi-app-platform § Data model; migrations 0004/0005 are the
 * DDL single sources.
 *
 * Encrypted columns are opaque here: `private_key_enc` / `webhook_secret_enc`
 * arrive as secretbox envelopes (src/dashboard/secretbox.ts) and are stored
 * verbatim — this module never decrypts, logs, or inspects them, so plaintext
 * credentials never enter the store layer.
 *
 * Module boundary (plan Global Constraints, lock L1): zero-dependency leaf
 * consumed by dashboard routes, the worker webhook face, and the pipeline
 * consumer. The `db` parameter is a locally-declared narrow D1 face (types
 * only, zero imports) — a real `D1Database`, the bun:sqlite test double
 * (tests/store/helpers.ts), and the store layer's `D1Like` all satisfy it
 * structurally. Declared locally instead of importing `store/types` because
 * dashboard modules must not import store/pipeline/review code (architect
 * decision Q2), and this store never batches, so it needs a narrower face.
 *
 * Semantics (Task 2/3 call sites rely on these):
 *   - getAppBySlug / getAppById return the row REGARDLESS of status or
 *     deleted_at — callers (webhook route, consumer) filter active + not
 *     deleted per the Multi-App contract.
 *   - listApps is the dashboard-list face: non-deleted rows, newest first.
 *   - setAppStatus refuses soft-deleted rows (a deleted app can never be
 *     re-activated) and returns whether a row changed.
 *   - setReviewEnabled (plan 16, migration 0008) is the per-App pause
 *     switch: writes review_enabled + updated_at (an operator mutation) and
 *     refuses soft-deleted rows exactly like setAppStatus.
 *   - touchLastWebhook (plan 16, migration 0008) writes ONLY
 *     last_webhook_at — never updated_at, which stays the operator-mutation
 *     timestamp (L5: the per-webhook frequency of this touch must not churn
 *     the operator timestamp, and the plan-15 commenter fingerprint ignores
 *     both columns, so the cache cannot be thrashed by it either).
 *   - listInstallations is the install-health read face for the settings
 *     panel (plan 16 Task 2): this App's installations, most recently seen
 *     first.
 *   - softDeleteApp is idempotent — the FIRST deleted_at wins; returns
 *     whether THIS call performed the delete.
 *   - upsertInstallation touches seen_at (any webhook carrying
 *     installation_id) and preserves the stored account_login when the
 *     incoming value is absent.
 *   - Timestamps are SQLite datetime('now') (UTC — the reviews.reviewed_at
 *     convention); createApp ids are caller-supplied UUIDs (the reviews.id
 *     caller-UUID convention — the T1 review pin: secretbox AAD rowKey MUST
 *     equal the row PK, so the caller generates the id before encrypting).
 *   - UNIQUE / FK violations throw (fail-loud): duplicate slug,
 *     github_app_id, or (app_id, installation_id) pairs, and unknown app
 *     references are caller-visible errors, never swallowed.
 */

/** A row of `github_apps` (D1 column names, snake_case; migration 0004). */
export type GithubAppRow = {
  id: string;
  slug: string;
  github_app_id: number;
  name: string;
  /** secretbox envelope of the App PEM — opaque, never decrypted here. */
  private_key_enc: string;
  /** secretbox envelope of the App webhook secret — opaque, never decrypted here. */
  webhook_secret_enc: string;
  /** GitHub login of the creating member (creator-or-admin manage rule). */
  created_by: string;
  status: GithubAppStatus;
  /** NULL = live row; a timestamp = soft-deleted (the only removal path). */
  deleted_at: string | null;
  /** Per-App pause switch (migration 0008): 1 = reviewing, 0 = paused. */
  review_enabled: number;
  /** Last verified (2xx) webhook delivery (migration 0008); NULL = never. */
  last_webhook_at: string | null;
  created_at: string;
  updated_at: string;
};

export type GithubAppStatus = "active" | "disabled";

/** Input for createApp — encrypted payloads are built by the caller. */
export type CreateAppInput = {
  /**
   * Caller-supplied row PK (plan 13 T1 review pin): the caller encrypts
   * private_key_enc / webhook_secret_enc with secretbox AAD
   * `github_apps.<column>:<id>` BEFORE insert, so the id must exist first —
   * the encrypted columns' AAD rowKey always equals this primary key. Not
   * optional: a store-generated default would make the caller's AAD
   * unknowable and the row undecryptable.
   */
  id: string;
  slug: string;
  githubAppId: number;
  name: string;
  /** secretbox envelope of the App PEM (AAD `github_apps.private_key_enc:<id>`). */
  privateKeyEnc: string;
  /** secretbox envelope of the webhook secret (AAD `github_apps.webhook_secret_enc:<id>`). */
  webhookSecretEnc: string;
  createdBy: string;
};

export type UpsertInstallationInput = {
  appId: string;
  installationId: number;
  /** Absent/null → preserve the stored login (a bare touch must not wipe it). */
  accountLogin?: string | null;
};

/**
 * An `app_installations` row as the settings health panel reads it (plan 16
 * Task 2; DDL = migration 0004). The `id` PK is deliberately not projected —
 * the panel keys installations by installation_id.
 */
export type AppInstallationRow = {
  installation_id: number;
  /** GitHub login of the installation account; NULL = never observed. */
  account_login: string | null;
  seen_at: string;
};

/**
 * Narrow D1 face, declared locally so this leaf module imports nothing
 * (prepare/bind/first/all/run; no batch — this store never batches).
 */
type AppsStoreStatement = {
  bind(...values: unknown[]): AppsStoreStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run<T = Record<string, unknown>>(): Promise<{
    results: T[];
    meta: { changes: number; last_row_id: number };
  }>;
};

type AppsStoreD1 = {
  prepare(query: string): AppsStoreStatement;
};

/** Create the github_apps / app_installations store over one D1 handle. */
export function createAppsStore(db: AppsStoreD1) {
  return {
    /**
     * Insert a new active app row (status 'active', deleted_at NULL) with
     * the CALLER-SUPPLIED id as the row PK (T1 review pin — the caller's
     * secretbox AAD rowKey is this id). UNIQUE violations on slug
     * or github_app_id throw — the route layer pre-resolves the slug at
     * start, and a commit-time race burns the hold (409) instead of
     * remapping (the manifest registered the webhook URL with GitHub).
     */
    async createApp(input: CreateAppInput): Promise<GithubAppRow> {
      const id = input.id;
      await db
        .prepare(
          `INSERT INTO github_apps
             (id, slug, github_app_id, name, private_key_enc, webhook_secret_enc,
              created_by, status, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 'active', datetime('now'), datetime('now'))`,
        )
        .bind(
          id,
          input.slug,
          input.githubAppId,
          input.name,
          input.privateKeyEnc,
          input.webhookSecretEnc,
          input.createdBy,
        )
        .run();
      const row = await db.prepare(`SELECT * FROM github_apps WHERE id = ?`).bind(id).first<GithubAppRow>();
      if (!row) {
        throw new Error("apps-store: createApp row vanished on read-back");
      }
      return row;
    },

    /** By slug; resolves soft-deleted and disabled rows too (callers filter). */
    async getAppBySlug(slug: string): Promise<GithubAppRow | null> {
      return db.prepare(`SELECT * FROM github_apps WHERE slug = ?`).bind(slug).first<GithubAppRow>();
    },

    /** By id; resolves soft-deleted and disabled rows too (callers filter). */
    async getAppById(id: string): Promise<GithubAppRow | null> {
      return db.prepare(`SELECT * FROM github_apps WHERE id = ?`).bind(id).first<GithubAppRow>();
    },

    /** Dashboard list: non-deleted rows, newest first (stable id tiebreak). */
    async listApps(): Promise<GithubAppRow[]> {
      const res = await db
        .prepare(`SELECT * FROM github_apps WHERE deleted_at IS NULL ORDER BY created_at DESC, id`)
        .all<GithubAppRow>();
      return res.results;
    },

    /**
     * Toggle 'active' | 'disabled'. Refuses soft-deleted rows (returns false,
     * no write) — a deleted app can never be re-activated. Returns whether a
     * row changed (false also covers unknown ids).
     */
    async setAppStatus(id: string, status: GithubAppStatus): Promise<boolean> {
      const res = await db
        .prepare(
          `UPDATE github_apps SET status = ?, updated_at = datetime('now')
           WHERE id = ? AND deleted_at IS NULL`,
        )
        .bind(status, id)
        .run();
      return res.meta.changes > 0;
    },

    /**
     * Toggle the per-App pause switch (plan 16, spec 语义锁 B3): 1 = the App's
     * PRs are reviewed, 0 = paused — webhook face 2xx-ignores with zero
     * enqueue, in-flight messages ack-skip. Writes review_enabled +
     * updated_at (an operator mutation, L5) and refuses soft-deleted rows
     * exactly like setAppStatus (a deleted app can never be re-activated).
     * Returns whether a row changed (false also covers unknown ids).
     */
    async setReviewEnabled(id: string, enabled: boolean): Promise<boolean> {
      const res = await db
        .prepare(
          `UPDATE github_apps SET review_enabled = ?, updated_at = datetime('now')
           WHERE id = ? AND deleted_at IS NULL`,
        )
        .bind(enabled ? 1 : 0, id)
        .run();
      return res.meta.changes > 0;
    },

    /**
     * Soft delete (the only removal path, Clarify #4): stamps deleted_at
     * once — a second call is a no-op returning false and the first
     * timestamp wins. Returns whether THIS call performed the delete.
     */
    async softDeleteApp(id: string): Promise<boolean> {
      const res = await db
        .prepare(
          `UPDATE github_apps SET deleted_at = datetime('now'), updated_at = datetime('now')
           WHERE id = ? AND deleted_at IS NULL`,
        )
        .bind(id)
        .run();
      return res.meta.changes > 0;
    },

    /**
     * Record the App's most recent verified (2xx) webhook delivery (plan 16,
     * L5). Writes ONLY last_webhook_at — deliberately NOT updated_at: this
     * touch runs per webhook (high-frequency), while updated_at must stay
     * the operator-mutation timestamp. An unknown id is a silent no-op (the
     * caller has already verified the signature — there is nothing to fail
     * or retry here).
     */
    async touchLastWebhook(id: string): Promise<void> {
      await db
        .prepare(`UPDATE github_apps SET last_webhook_at = datetime('now') WHERE id = ?`)
        .bind(id)
        .run();
    },

    /**
     * Touch (or create) the (appId, installationId) installation row on any
     * webhook carrying an installation_id. A null/absent accountLogin
     * preserves the stored login (COALESCE with the existing value).
     */
    async upsertInstallation(input: UpsertInstallationInput): Promise<void> {
      await db
        .prepare(
          `INSERT INTO app_installations (id, app_id, installation_id, account_login, seen_at)
           VALUES (?, ?, ?, ?, datetime('now'))
           ON CONFLICT (app_id, installation_id) DO UPDATE SET
             account_login = COALESCE(excluded.account_login, account_login),
             seen_at = datetime('now')`,
        )
        .bind(crypto.randomUUID(), input.appId, input.installationId, input.accountLogin ?? null)
        .run();
    },

    /**
     * Install-health read face (plan 16 Task 2 settings panel): this App's
     * installation rows, most recently seen first (stable installation_id
     * tiebreak). Read-only — the panel never mutates through this face.
     */
    async listInstallations(appId: string): Promise<AppInstallationRow[]> {
      const res = await db
        .prepare(
          `SELECT installation_id, account_login, seen_at FROM app_installations
           WHERE app_id = ? ORDER BY seen_at DESC, installation_id`,
        )
        .bind(appId)
        .all<AppInstallationRow>();
      return res.results;
    },
  };
}
