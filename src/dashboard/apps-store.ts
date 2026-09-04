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
 * consumer. Its one import is the zero-dependency sandbox-image contract
 * (src/contracts/sandbox-images.ts — the plan-37 registry, not
 * pipeline/review code), which bounds the sandbox_image_id value domain.
 * The `db` parameter is a locally-declared narrow D1 face (types
 * only, zero imports) — a real `D1Database`, the bun:sqlite test double
 * (tests/store/helpers.ts), and the store layer's `D1Like` all satisfy it
 * structurally. Declared locally instead of importing `store/types` because
 * dashboard modules must not import store/pipeline/review code (architect
 * decision Q2), and this store never uses D1 batch() — multi-row reads go
 * through IN-list queries (deliverySummaries) — so it needs a narrower face.
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
 *   - setSandboxImage (plan 37, migration 0018) is the per-App sandbox
 *     runtime-image selection: the id must be an ENABLED entry of the
 *     sandbox-image registry (plain Error backstop, the recordDelivery
 *     convention — the settings route 400s first), writes sandbox_image_id +
 *     updated_at, and refuses soft-deleted rows exactly like setAppStatus.
 *     createApp omits the column, so the migration 0018 DDL default seeds
 *     'omp'.
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
 *   - recordDelivery / deliverySummary / listRecentDeliveries (plan 20,
 *     migration 0011) are the webhook_deliveries face: the per-App webhook
 *     route appends one best-effort row per CLASSIFIED delivery (ok /
 *     paused / ignored / rejected — outcome vocabulary DELIVERY_OUTCOMES,
 *     producer-side enforced), and the dashboard reads the health summary +
 *     recent list through the same store (AL-20-1: the legacy face records
 *     nothing).
 *   - deliverySummaries (plan 20 QC wave 1, W-1) is the BATCHED health
 *     read face for the Apps list: latest row + 24h rejected count for
 *     every requested app in exactly TWO statements regardless of N;
 *     deliverySummary(appId) stays the single-settings-page face.
 *   - event_name is bounded to EVENT_NAME_MAX_LENGTH (64) chars at
 *     persist time — the x-github-event header is attacker-influenced on
 *     the unauthenticated reject path; the DDL has no length constraint.
 *   - Timestamps are SQLite datetime('now') (UTC — the reviews.reviewed_at
 *     convention); createApp ids are caller-supplied UUIDs (the reviews.id
 *     caller-UUID convention — the T1 review pin: secretbox AAD rowKey MUST
 *     equal the row PK, so the caller generates the id before encrypting).
 *   - UNIQUE / FK violations throw (fail-loud): duplicate slug,
 *     github_app_id, or (app_id, installation_id) pairs, and unknown app
 *     references are caller-visible errors, never swallowed.
 */
import { getSandboxImage } from "../contracts/sandbox-images";

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
  /**
   * Selected sandbox runtime image (migration 0018): a registry id from
   * src/contracts/sandbox-images.ts, default 'omp'. The value domain (only
   * ENABLED registry entries) is store-enforced — no DDL CHECK.
   */
  sandbox_image_id: string;
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
 * The producer-side delivery-outcome vocabulary (plan 20 Task 1, AL-20-1;
 * 0010 FAILURE_STAGES precedent; 0011 webhook_deliveries is current):
 * `ok` = job enqueued, `paused` = the App's
 * review switch is off (2xx ignore, zero enqueue), `ignored` = verified but
 * not a reviewable event (e.g. ping), `rejected` = the classifier refused
 * the delivery (400|401|500 — "sent but refused" is the R2 visibility
 * core). Enforced producer-side: an off-vocabulary outcome throws BEFORE
 * any row is written; the schema has no CHECK (0010 precedent).
 */
export const DELIVERY_OUTCOMES: readonly string[] = Object.freeze([
  "ok",
  "paused",
  "ignored",
  "rejected",
]);

export type DeliveryOutcome = "ok" | "paused" | "ignored" | "rejected";

/**
 * Persist bound for the x-github-event header (plan 20 QC wave 1, seat2
 * hygiene pin): the header is attacker-influenced on the unauthenticated
 * reject path, and the DDL has no length constraint — store the bounded
 * prefix, never the raw blob (GitHub's longest real event names sit well
 * under this; 64 chars is headroom, not a truncation risk for them).
 */
export const EVENT_NAME_MAX_LENGTH = 64;

/** Input for recordDelivery — one VERIFIED per-App webhook delivery. */
export type RecordDeliveryInput = {
  appId: string;
  /**
   * The x-github-event header; NULL when the header was absent. Truncated
   * to EVENT_NAME_MAX_LENGTH (64) chars at persist — the header is
   * attacker-influenced on the unauthenticated reject path.
   */
  eventName: string | null;
  outcome: DeliveryOutcome;
  /** The classifier's status for rejected; NULL for every other outcome. */
  statusCode: number | null;
};

/** A row of `webhook_deliveries` (D1 column names, snake_case; migration 0011). */
export type WebhookDeliveryRow = {
  id: string;
  app_id: string;
  event_name: string | null;
  outcome: DeliveryOutcome;
  status_code: number | null;
  created_at: string;
};

/**
 * The dashboard health read face (plan 20 Task 2 consumes this): the App's
 * LATEST delivery row + the count of `rejected` rows inside the trailing
 * 24h window (`created_at > datetime('now', '-24 hours')` — the plan-19
 * sweep window convention). ignored/paused/ok are healthy states and are
 * deliberately NOT counted (AL-20-2).
 */
export type DeliverySummary = {
  latest: WebhookDeliveryRow | null;
  rejected24h: number;
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
  /**
   * BATCHED health-read face (plan 20 QC wave 1, W-1): the Apps list
   * renders every row's health on each POST re-render, so the per-App
   * deliverySummary fan-out (2N statements) is replaced by exactly TWO
   * statements for any N: (a) the latest row per app — the same
   * created_at DESC, rowid DESC tiebreak as deliverySummary, via a
   * ROW_NUMBER() window (SQLite 3.25+, D1-supported) — and (b) the
   * 24h `rejected` count grouped by app (same window + healthy-outcome
   * exclusion as deliverySummary; AL-20-2). Apps with no rows → latest
   * null, rejected24h 0; unknown ids are absent from the result unless
   * the caller asked for them (each requested id gets an entry).
   * deliverySummary(appId) delegates here.
   */
  async function deliverySummaries(appIds: string[]): Promise<Record<string, DeliverySummary>> {
    if (appIds.length === 0) return {};
    const placeholders = appIds.map(() => "?").join(", ");
    const [latestRes, rejectedRes] = await Promise.all([
      db
        .prepare(
          `SELECT app_id, id, event_name, outcome, status_code, created_at FROM (
             SELECT *, ROW_NUMBER() OVER (PARTITION BY app_id ORDER BY created_at DESC, rowid DESC) AS rn
             FROM webhook_deliveries WHERE app_id IN (${placeholders})
           ) WHERE rn = 1`,
        )
        .bind(...appIds)
        .all<WebhookDeliveryRow>(),
      db
        .prepare(
          `SELECT app_id, COUNT(*) AS n FROM webhook_deliveries
           WHERE app_id IN (${placeholders}) AND outcome = 'rejected'
             AND created_at > datetime('now', '-24 hours')
           GROUP BY app_id`,
        )
        .bind(...appIds)
        .all<{ app_id: string; n: number }>(),
    ]);
    const byApp: Record<string, DeliverySummary> = {};
    for (const appId of appIds) {
      byApp[appId] = { latest: null, rejected24h: 0 };
    }
    for (const row of latestRes.results) {
      const entry = byApp[row.app_id];
      if (entry) entry.latest = row;
    }
    for (const row of rejectedRes.results) {
      const entry = byApp[row.app_id];
      if (entry) entry.rejected24h = row.n;
    }
    return byApp;
  }

  return {
    /**
     * Insert a new active app row (status 'active', deleted_at NULL) with
     * the CALLER-SUPPLIED id as the row PK (T1 review pin — the caller's
     * secretbox AAD rowKey is this id). sandbox_image_id is omitted: the
     * migration 0018 DDL default materializes every new row onto the
     * registry's default image ('omp') — the store face for changing it is
     * setSandboxImage. UNIQUE violations on slug
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
     * Select the App's sandbox runtime image (plan 37, migration 0018). The
     * id must be an ENABLED entry of the src/contracts/sandbox-images.ts
     * registry — anything else throws BEFORE any write (this is the
     * store-enforced value domain the DDL deliberately leaves CHECK-less;
     * the settings route answers 400 first, this is the backstop for direct
     * callers). Writes sandbox_image_id + updated_at (an operator mutation,
     * the setAppStatus convention) and refuses soft-deleted rows exactly
     * like setAppStatus. Returns whether a row changed (false also covers
     * unknown ids).
     */
    async setSandboxImage(id: string, imageId: string): Promise<boolean> {
      const image = getSandboxImage(imageId);
      if (!image || !image.enabled) {
        throw new Error(
          `apps-store: sandbox image ${JSON.stringify(imageId)} is not an enabled registry entry — zero rows written`,
        );
      }
      const res = await db
        .prepare(
          `UPDATE github_apps SET sandbox_image_id = ?, updated_at = datetime('now')
           WHERE id = ? AND deleted_at IS NULL`,
        )
        .bind(image.id, id)
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

    /**
     * Append one delivery row (plan 20 Task 1, AL-20-1) — the R2 diagnostics
     * face. Fail-loud like the rest of this store: an off-vocabulary outcome
     * throws BEFORE any row is written (producer-side enforcement, 0010
     * FAILURE_STAGES precedent); FK violations (unknown appId) throw. The
     * webhook face wraps this in try/catch itself — an insert failure must
     * never change the webhook response (best-effort旁路). The event_name
     * header is capped at EVENT_NAME_MAX_LENGTH chars at persist (seat2
     * hygiene pin).
     */
    async recordDelivery(input: RecordDeliveryInput): Promise<void> {
      if (!DELIVERY_OUTCOMES.includes(input.outcome)) {
        throw new Error(
          `apps-store: outcome ${JSON.stringify(input.outcome)} is not on the producer vocabulary (${DELIVERY_OUTCOMES.join(" | ")}) — zero rows written`,
        );
      }
      const eventName = input.eventName === null ? null : input.eventName.slice(0, EVENT_NAME_MAX_LENGTH);
      await db
        .prepare(
          `INSERT INTO webhook_deliveries (id, app_id, event_name, outcome, status_code)
           VALUES (?, ?, ?, ?, ?)`,
        )
        .bind(crypto.randomUUID(), input.appId, eventName, input.outcome, input.statusCode)
        .run();
    },

    /**
     * Health read face (plan 20 Task 2): the App's LATEST delivery row +
     * the count of `rejected` rows inside the trailing 24h window
     * (`created_at > datetime('now', '-24 hours')` — the plan-19 sweep
     * window convention). ignored/paused/ok are healthy states and are
     * deliberately NOT counted (AL-20-2). An app with no rows → latest
     * null, rejected24h 0. Single-app delegate of the batched
     * deliverySummaries face (the grouped-query implementation).
     */
    async deliverySummary(appId: string): Promise<DeliverySummary> {
      return (await deliverySummaries([appId]))[appId]!;
    },

    /** Batched variant of deliverySummary — see the local implementation above. */
    deliverySummaries,

    /**
     * Recent-deliveries read face (plan 20 Task 2 settings panel): THIS
     * App's rows, newest first (created_at has second precision, so rowid
     * breaks ties inside one second — the order is total and
     * deterministic), bounded by the caller's N (default 5).
     */
    async listRecentDeliveries(appId: string, limit = 5): Promise<WebhookDeliveryRow[]> {
      const res = await db
        .prepare(
          `SELECT * FROM webhook_deliveries
           WHERE app_id = ? ORDER BY created_at DESC, rowid DESC LIMIT ?`,
        )
        .bind(appId, limit)
        .all<WebhookDeliveryRow>();
      return res.results;
    },
  };
}
