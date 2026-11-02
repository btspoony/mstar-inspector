/**
 * D1 store for `github_apps` / `app_installations` — the
 * ONE write authority for multi-App rows. Spec
 * dashboard-multi-app-platform § Data model; migrations 0004/0005 are the
 * DDL single sources.
 *
 * Encrypted columns are opaque here: `private_key_enc` / `webhook_secret_enc`
 * arrive as secretbox envelopes (src/dashboard/secretbox.ts) and are stored
 * verbatim — this module never decrypts, logs, or inspects them, so plaintext
 * credentials never enter the store layer.
 *
 * Module boundary (the global constraints, lock L1): zero-dependency leaf
 * consumed by dashboard routes, the worker webhook face, and the pipeline
 * consumer. Its one import is the zero-dependency sandbox-image contract
 * (src/contracts/sandbox-images.ts — the registry, not
 * pipeline/review code), which bounds the sandbox_image_id value domain.
 * The `db` parameter is a locally-declared narrow D1 face (types
 * only, zero imports) — a real `D1Database`, the bun:sqlite test double
 * (tests/store/helpers.ts), and the store layer's `D1Like` all satisfy it
 * structurally. Declared locally instead of importing `store/types` because
 * dashboard modules must not import store/pipeline/review code (architect
 * decision Q2), and this store never uses D1 batch() — multi-row reads go
 * through IN-list queries (deliverySummaries) — so it needs a narrower face.
 *
 * Semantics (route call sites rely on these):
 *   - getAppForWebhook / getAppByGithubId / getAppById return the row
 *     REGARDLESS of status or deleted_at — callers (webhook route, consumer)
 *     filter active + not deleted per the Multi-App contract.
 *   - The App's local identity is its row `id` (the webhook URL's second
 *     segment); `github_slug` is GitHub's own mutable slug, cached by
 *     saveGithubMetadata and the only source of the `<slug>[bot]` mention
 *     login.
 *   - listApps is the dashboard-list face: non-deleted rows, newest first.
 *   - setAppStatus refuses soft-deleted rows (a deleted app can never be
 *     re-activated) and returns whether a row changed.
 *   - setReviewEnabled (migration 0008) is the per-App pause
 *     switch: writes review_enabled + updated_at (an operator mutation) and
 *     refuses soft-deleted rows exactly like setAppStatus.
 *   - setSandboxImage (migration 0018) is the per-App sandbox
 *     runtime-image selection: the id must be an ENABLED entry of the
 *     sandbox-image registry (plain Error backstop, the recordDelivery
 *     convention — the settings route 400s first), writes sandbox_image_id +
 *     updated_at, and refuses soft-deleted rows exactly like setAppStatus.
 *     createApp omits the column, so the migration 0018 DDL default seeds
 *     'omp'.
 *   - setReviewTriggerMode (migration 0022, spec review-trigger-policy §2)
 *     is the per-App auto-trigger selection: the mode must be on the
 *     REVIEW_TRIGGER_MODES vocabulary (plain Error backstop, the
 *     setSandboxImage convention — the settings route 400s first; the DDL
 *     CHECK is the last-line backstop), writes review_trigger_mode +
 *     updated_at, and refuses soft-deleted rows exactly like setAppStatus.
 *     createApp omits the column, so the migration 0022 DDL default seeds
 *     'every_push' (today's behavior, preserved exactly).
 *   - touchLastWebhook (migration 0008) writes ONLY
 *     last_webhook_at — never updated_at, which stays the operator-mutation
 *     timestamp (L5: the per-webhook frequency of this touch must not churn
 *     the operator timestamp, and the commenter fingerprint ignores
 *     both columns, so the cache cannot be thrashed by it either).
 *   - saveGithubMetadata (migrations 0019/0036) is the SINGLE writer for
 *     the cached GitHub profile columns (github_name / github_description /
 *     github_html_url / github_avatar_url / github_slug +
 *     github_metadata_synced_at):
 *     writes ONLY those six, never updated_at (the touchLastWebhook
 *     machine-trigger precedent — the settings read path's lazy 24h TTL
 *     refresh is the only caller), refuses soft-deleted rows exactly
 *     like setAppStatus, and COALESCE-preserves github_slug so a degraded
 *     fetch cannot clear the cached bot-mention target.
 *   - touchGithubMetadataAttempt (migration 0037) is the SINGLE writer of
 *     github_metadata_attempted_at, stamped after a fetch attempt that
 *     persisted no slug (a failure or a slug-less payload) — never
 *     updated_at. Together with the 0036 NULL-slug staleness rule it bounds
 *     an unsyncable App to one fetch per TTL window instead of one per
 *     settings read.
 *   - listInstallations is the install-health read face for the settings
 *     panel: this App's installations, most recently seen
 *     first.
 *   - softDeleteApp is idempotent — the FIRST deleted_at wins; returns
 *     whether THIS call performed the delete.
 *   - recordDelivery / deliverySummary / listRecentDeliveries (migration
 *     0011) are the webhook_deliveries face: the per-App webhook
 *     route appends one best-effort row per CLASSIFIED delivery (ok /
 *     paused / ignored / rejected — outcome vocabulary DELIVERY_OUTCOMES,
 *     producer-side enforced), and the dashboard reads the health summary +
 *     recent list through the same store (AL-20-1: the legacy face records
 *     nothing).
 *   - deliverySummaries (QC wave 1, W-1) is the BATCHED health
 *     read face for the Apps list: newest verdict row + 24h rejected count for
 *     every requested app in exactly TWO statements regardless of N;
 *     deliverySummary(appId) stays the single-settings-page face.
 *   - event_name is bounded to EVENT_NAME_MAX_LENGTH (64) chars at
 *     persist time — the x-github-event header is attacker-influenced on
 *     the unauthenticated reject path; the DDL has no length constraint.
 *   - Timestamps are SQLite datetime('now') (UTC — the reviews.reviewed_at
 *     convention); createApp ids are caller-supplied (the reviews.id
 *     caller-UUID convention — review pin: secretbox AAD rowKey MUST
 *     equal the row PK, so the caller decides the id before encrypting).
 *     The manifest flow mints that id at start, so the webhook URL is known
 *     before GitHub creates the App.
 *   - UNIQUE / FK violations throw (fail-loud): duplicate github_app_id or
 *     (app_id, installation_id) pairs, and unknown app references are
 *     caller-visible errors, never swallowed.
 */
import { getSandboxImage } from "../contracts/sandbox-images";

/** A row of `github_apps` (D1 column names, snake_case; migrations 0004/0036). */
export type GithubAppRow = {
  /**
   * The local App UID — also the webhook URL's app segment
   * (`/webhook/<workspace_id>/<id>`) and the secretbox AAD row key.
   */
  id: string;
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
  /**
   * Per-App auto-trigger selection (migration 0022, spec
   * review-trigger-policy §2): 'open' | 'every_push' | 'manual'; the DDL
   * default seeds 'every_push' (today's behavior). The bot-mention comment
   * trigger is orthogonal and works in every mode.
   */
  review_trigger_mode: ReviewTriggerMode;
  /** Last verified (2xx) webhook delivery (migration 0008); NULL = never. */
  last_webhook_at: string | null;
  /**
   * Cached GitHub-side App name (migration 0019); NULL = never
   * synced. Distinct from the local `name` recorded at manifest commit.
   */
  github_name: string | null;
  /** Cached GitHub App description (migration 0019); NULL = never synced or none upstream. */
  github_description: string | null;
  /** Cached GitHub App settings-page URL (migration 0019); NULL = never synced. */
  github_html_url: string | null;
  /** Cached App icon URL (`/in/<github_app_id>`, migration 0019); NULL = never synced. */
  github_avatar_url: string | null;
  /**
   * GitHub's own App slug (migration 0036), cached from `GET /app`; NULL =
   * never synced. Mutable upstream and NOT derivable from `name`, which is why
   * it is its own column: the `<github_slug>[bot]` mention login and the
   * dashboard links read it, never the row id or the icon.
   */
  github_slug: string | null;
  /**
   * Last successful GitHub metadata sync (migration 0019, datetime('now')
   * UTC — the last_webhook_at TEXT convention); NULL = never synced. The
   * settings read path's lazy 24h TTL refresh keys off this column.
   */
  github_metadata_synced_at: string | null;
  /**
   * Last metadata fetch ATTEMPT that persisted no slug (migration 0037) —
   * failure, or a successful payload without one. The read path's NULL-slug
   * re-attempt keys off it so a permanently failing App costs at most one
   * fetch per TTL instead of one per settings read.
   */
  github_metadata_attempted_at: string | null;
  /**
   * Selected sandbox runtime image (migration 0018): a registry id from
   * src/contracts/sandbox-images.ts, default 'omp'. The value domain (only
   * ENABLED registry entries) is store-enforced — no DDL CHECK.
   */
  sandbox_image_id: string;
  created_at: string;
  updated_at: string;
  /** Owning workspace (migration 0026); present on every execution-facing read. */
  workspace_id?: string;
};

export type GithubAppStatus = "active" | "disabled";

/**
 * An execution-facing App row: the two resolutions INNER JOIN `app_workspaces`,
 * so `workspace_id` is present by construction. Typing it here (instead of at
 * the call sites with `!`) keeps the invariant where SQL enforces it — a future
 * LEFT JOIN breaks the read's type rather than binding `undefined`.
 */
export type GithubAppTenantRow = GithubAppRow & { workspace_id: string };

/**
 * The per-App auto-trigger vocabulary (migration 0022, spec
 * review-trigger-policy §2 — exact enum spelling is wire-visible: the
 * settings POST body carries it and the SPA replays it). Producer-side
 * enforced like DELIVERY_OUTCOMES: an off-vocabulary mode throws BEFORE any
 * row is written; the DDL CHECK is the last-line backstop. The array is
 * typed against the union, so a misspelled literal here is a compile error;
 * every member must also appear in the migration 0022 CHECK.
 */
export type ReviewTriggerMode = "open" | "every_push" | "manual";

export const REVIEW_TRIGGER_MODES: readonly ReviewTriggerMode[] = Object.freeze([
  "open",
  "every_push",
  "manual",
]);

/** Input for createApp — encrypted payloads are built by the caller. */
export type CreateAppInput = {
  /**
   * Caller-supplied row PK (review pin): the caller encrypts
   * private_key_enc / webhook_secret_enc with secretbox AAD
   * `github_apps.<column>:<id>` BEFORE insert, so the id must exist first —
   * the encrypted columns' AAD rowKey always equals this primary key. Not
   * optional: a store-generated default would make the caller's AAD
   * unknowable and the row undecryptable. The manifest flow mints it at
   * start, because the manifest's webhook URL carries it.
   */
  id: string;
  /**
   * GitHub's App slug, when the caller already knows it. NULL is the honest
   * default ("never synced") — the first metadata sync fills it.
   */
  githubSlug: string | null;
  githubAppId: number;
  name: string;
  /** secretbox envelope of the App PEM (AAD `github_apps.private_key_enc:<id>`). */
  privateKeyEnc: string;
  /** secretbox envelope of the webhook secret (AAD `github_apps.webhook_secret_enc:<id>`). */
  webhookSecretEnc: string;
  createdBy: string;
  /**
   * The workspace the App belongs to. Required: ownership is a caller input,
   * never a store lookup, so a deployment with several workspaces can never
   * silently mis-home an App and no caller can leave the owner unstated.
   */
  workspaceId: string;
};

export type UpsertInstallationInput = {
  appId: string;
  installationId: number;
  /** Absent/null → preserve the stored login (a bare touch must not wipe it). */
  accountLogin?: string | null;
};

/**
 * The GitHub profile fields cached by migrations 0019/0036 — the input
 * (and result) shape of the single metadata write entry `saveGithubMetadata`.
 * src/dashboard/github-app-metadata.ts builds it from `GET /app`'s public
 * profile; the settings read path persists it verbatim. Field names mirror
 * the D1 columns; every field is nullable (per-item upstream degradation).
 */
export type GithubAppMetadataInput = {
  githubName: string | null;
  githubDescription: string | null;
  githubHtmlUrl: string | null;
  githubAvatarUrl: string | null;
  githubSlug: string | null;
};

/**
 * An `app_installations` row as the settings health panel reads it
 * (DDL = migration 0004). The `id` PK is deliberately not projected —
 * the panel keys installations by installation_id.
 */
export type AppInstallationRow = {
  installation_id: number;
  /** GitHub login of the installation account; NULL = never observed. */
  account_login: string | null;
  seen_at: string;
};

/**
 * The producer-side delivery-outcome vocabulary (AL-20-1;
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
 * Outcome tier rank shared by BOTH delivery health faces: 0 = the row carries
 * a review verdict (`ok`, `paused`, `rejected`), 1 = `ignored`, which says
 * nothing about whether review is running (bypass events such as check_run,
 * and whitelisted events the classifier dropped). The event name cannot stand
 * in for this: `check_run` alone can outnumber review traffic by orders of
 * magnitude, and a `pull_request` can legitimately land in `ignored` too. Both
 * faces rank by exactly this expression so they can never disagree.
 */
const DELIVERY_VERDICT_TIER_SQL = `CASE WHEN outcome IN ('ok', 'paused', 'rejected') THEN 0 ELSE 1 END`;

/**
 * Persist bound for the x-github-event header (QC wave 1, seat2
 * hygiene pin): the header is attacker-influenced on the unauthenticated
 * reject path, and the DDL has no length constraint — store the bounded
 * prefix, never the raw blob (GitHub's longest real event names sit well
 * under this; 64 chars is headroom, not a truncation risk for them).
 */
export const EVENT_NAME_MAX_LENGTH = 64;

/**
 * Bound on `listPullRequests`. Any third party who opens a PR mints a ledger
 * row and only TERMINAL rows are swept, so the live set grows with every open
 * PR across every installed repo. 200 is the newest window an operator can
 * act on (a review queue is read at its head, not its tail) and keeps one tab
 * open to a bounded payload; a longer history stays queryable through the
 * ledger itself rather than through this face.
 */
export const PULL_REQUEST_LIST_LIMIT = 200;

/**
 * Retention for the ledger: TERMINAL rows (`closed` / `merged`) whose last
 * activity is older than this window are swept. Open PRs are never swept —
 * a PR that is still open is still a live review target, however old — which
 * is why the predicate keys on `state`, not age alone.
 */
export const PULL_REQUEST_RETENTION_DAYS = 90;

/** Retention row cap per run — bounded work per 15-min sweep (the 0035 rule). */
export const PULL_REQUEST_RETENTION_CAP = 500;

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
 * The dashboard health read face: the App's
 * newest review-verdict delivery row (outcome tier — see deliverySummaries)
 * + the count of `rejected` rows inside the trailing
 * 24h window (`created_at > datetime('now', '-24 hours')` — the sweep
 * window convention). ignored/paused/ok are healthy states and are
 * deliberately NOT counted (AL-20-2).
 */
export type DeliverySummary = {
  latest: WebhookDeliveryRow | null;
  rejected24h: number;
};

/** Input for upsertPullRequest — one VERIFIED `pull_request` delivery. */
export type UpsertPullRequestInput = {
  appId: string;
  owner: string;
  repo: string;
  prNumber: number;
  /** Omitted/null keeps whatever the row already knows. */
  title?: string | null;
  /** The payload's state, already promoted to 'merged' when `merged` was true. */
  state: string;
  headSha?: string | null;
  /**
   * The payload's `pull_request.updated_at` (ISO 8601), so ordering follows
   * GitHub's clock rather than our arrival clock. Omitted/null → now.
   */
  updatedAt?: string | null;
};

/** The PR-ledger read row (`pull_requests` + its newest review, migration 0039). */
export type PullRequestRow = {
  number: number;
  owner: string;
  repo: string;
  title: string | null;
  state: string;
  head_sha: string | null;
  first_seen_at: string;
  last_seen_at: string;
  latest_review: { verdict: string; reviewed_at: string } | null;
  failure_count: number;
};

/**
 * Narrow D1 face, declared locally so this leaf module imports nothing
 * (prepare/bind/first/all/run plus batch — App creation writes the App row
 * and its workspace mapping in ONE transaction).
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

/** One statement's result inside a `batch()` (order matches the input). */
type AppsStoreBatchResult = {
  results: unknown[];
  meta: { changes: number; last_row_id: number };
};

type AppsStoreD1 = {
  prepare(query: string): AppsStoreStatement;
  batch(statements: AppsStoreStatement[]): Promise<AppsStoreBatchResult[]>;
};

/**
 * Tenant read face (migration 0026) — there is exactly one. Every
 * execution-facing App read INNER JOINs `app_workspaces`, so an App with no
 * workspace mapping is invisible to every face; the two resolution reads also
 * require the workspace itself to be live, so a soft-deleted tenant is
 * unresolvable and can never start a review.
 */

/**
 * The two execution-facing App resolutions plus the operator list. FROZEN —
 * do not reword them; call sites and tests assert these exact strings.
 * `listApps` deliberately does NOT filter on `workspaces.deleted_at`: it is
 * the operator read-only list with no execution face, and retiring a tenant
 * must not hide its Apps from operators.
 */
export const APP_READ_SQL = {
  getAppById: `SELECT g.*, w.workspace_id FROM github_apps g INNER JOIN app_workspaces w ON w.app_id = g.id INNER JOIN workspaces ws ON ws.id = w.workspace_id AND ws.deleted_at IS NULL WHERE g.id = ?`,
  getAppForWebhook: `SELECT g.*, w.workspace_id FROM github_apps g INNER JOIN app_workspaces w ON w.app_id = g.id INNER JOIN workspaces ws ON ws.id = w.workspace_id AND ws.deleted_at IS NULL WHERE g.id = ? AND w.workspace_id = ?`,
  getAppByGithubId: `SELECT g.*, w.workspace_id FROM github_apps g INNER JOIN app_workspaces w ON w.app_id = g.id INNER JOIN workspaces ws ON ws.id = w.workspace_id AND ws.deleted_at IS NULL WHERE g.github_app_id = ?`,
  listApps: `SELECT g.*, w.workspace_id FROM github_apps g INNER JOIN app_workspaces w ON w.app_id = g.id WHERE g.deleted_at IS NULL ORDER BY g.created_at DESC, g.id`,
} as const;

/** Create the github_apps / app_installations store over one D1 handle. */
export function createAppsStore(db: AppsStoreD1) {
  /**
   * Bounded ledger retention (migration 0039). Terminal rows only: an open PR
   * is still a review target however stale its clock, so `state` gates the
   * predicate and age only orders what it already excluded. Capped per run so
   * a large backlog drains over successive sweeps instead of stalling one.
   */
  async function sweepTerminalPullRequests(): Promise<number> {
    const res = await db
      .prepare(
        `DELETE FROM pull_requests WHERE id IN (
           SELECT id FROM pull_requests
           WHERE state IN ('closed', 'merged')
             AND last_seen_at < datetime('now', '-${PULL_REQUEST_RETENTION_DAYS} days')
           LIMIT ${PULL_REQUEST_RETENTION_CAP}
         )`,
      )
      .run();
    return res.meta.changes;
  }

  /**
   * BATCHED health-read face (QC wave 1, W-1): the Apps list
   * renders every row's health on each POST re-render, so the per-App
   * deliverySummary fan-out (2N statements) is replaced by exactly TWO
   * statements for any N: (a) the newest row per app — ranked by an outcome
   * tier, newest first inside each tier — via a ROW_NUMBER() window (SQLite
   * 3.25+, D1-supported), and (b) the 24h `rejected` count grouped by app
   * (same window + healthy-outcome exclusion as deliverySummary; AL-20-2).
   *
   * The tier exists because the event name does not predict the outcome:
   * bypass traffic (check_run, ping) massively outnumbers review traffic,
   * and whitelisted events routinely land in `ignored` too — a
   * non-whitelisted pull_request action, an issue comment without the App
   * mention or from a bot author, a comment outside a PR thread. `ignored`
   * is therefore the one outcome that says nothing about whether review is
   * running; ranking by it keeps the health column on noise. Tier 0 is
   * every outcome that carries a real verdict — `ok` (review enqueued),
   * `paused` (the App's switch is off, a state worth surfacing) and
   * `rejected` (the classifier refused the delivery, the failure signal);
   * tier 1 is `ignored`. So an App with any verdict reports the newest of
   * those, an App that has only ever produced noise still falls back to its
   * newest row, and an App with no rows → latest null, rejected24h 0;
   * unknown ids are absent from the result unless the caller asked for them
   * (each requested id gets an entry). deliverySummary(appId) delegates
   * here.
   */
  async function deliverySummaries(appIds: string[]): Promise<Record<string, DeliverySummary>> {
    if (appIds.length === 0) return {};
    const placeholders = appIds.map(() => "?").join(", ");
    const [latestRes, rejectedRes] = await Promise.all([
      db
        .prepare(
          `SELECT app_id, id, event_name, outcome, status_code, created_at FROM (
             SELECT *, ROW_NUMBER() OVER (PARTITION BY app_id
               ORDER BY ${DELIVERY_VERDICT_TIER_SQL},
                        created_at DESC, rowid DESC) AS rn
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
     * the CALLER-SUPPLIED id as the row PK (review pin — the caller's
     * secretbox AAD rowKey is this id), plus its `app_workspaces` mapping to
     * the REQUIRED `input.workspaceId`. Ownership is never discovered: the
     * named workspace must still be live, and a dead target refuses the write
     * with zero rows. The two inserts are ONE batch transaction, so an App
     * never exists without an owner. sandbox_image_id is omitted: the
     * migration 0018 DDL default materializes every new row onto the
     * registry's default image ('omp') — the store face for changing it is
     * setSandboxImage. A UNIQUE violation on github_app_id throws — the
     * commit path turns it into `already_connected` (409).
     */
    async createApp(input: CreateAppInput): Promise<GithubAppRow> {
      const id = input.id;
      // Ownership is a caller input, never a lookup: the named workspace must
      // still be live (a soft-deleted one is refused identically to an unknown
      // id). A clean throw here leaves no half-written App.
      const target = await db
        .prepare(`SELECT id FROM workspaces WHERE id = ? AND deleted_at IS NULL`)
        .bind(input.workspaceId)
        .first<{ id: string }>();
      if (!target) {
        throw new Error("apps-store: createApp target workspace is not live");
      }
      await db.batch([
        db
          .prepare(
            `INSERT INTO github_apps
               (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
                created_by, status, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, 'active', datetime('now'), datetime('now'))`,
          )
          .bind(
            id,
            input.githubSlug,
            input.githubAppId,
            input.name,
            input.privateKeyEnc,
            input.webhookSecretEnc,
            input.createdBy,
          ),
        db
          .prepare(`INSERT INTO app_workspaces (app_id, workspace_id) VALUES (?, ?)`)
          .bind(id, input.workspaceId),
      ]);
      const row = await db.prepare(`SELECT * FROM github_apps WHERE id = ?`).bind(id).first<GithubAppRow>();
      if (!row) {
        throw new Error("apps-store: createApp row vanished on read-back");
      }
      return row;
    },

    /**
     * By the webhook URL's two segments — the App row `id` must belong to the
     * named workspace. Resolves soft-deleted and disabled App rows too
     * (callers filter), but NOT an App whose workspace is soft-deleted, and
     * never an App paired with a workspace it does not belong to.
     */
    async getAppForWebhook(
      workspaceId: string,
      appId: string,
    ): Promise<GithubAppTenantRow | null> {
      return db
        .prepare(APP_READ_SQL.getAppForWebhook)
        .bind(appId, workspaceId)
        .first<GithubAppTenantRow>();
    },

    /**
     * By GitHub's numeric App id; same guards as getAppById (soft-deleted and
     * disabled rows resolve, a soft-deleted workspace does not).
     */
    async getAppByGithubId(githubAppId: number): Promise<GithubAppTenantRow | null> {
      return db
        .prepare(APP_READ_SQL.getAppByGithubId)
        .bind(githubAppId)
        .first<GithubAppTenantRow>();
    },

    /**
     * By id; resolves soft-deleted and disabled App rows too (callers
     * filter), but NOT an App whose workspace is soft-deleted.
     */
    async getAppById(id: string): Promise<GithubAppTenantRow | null> {
      return db.prepare(APP_READ_SQL.getAppById).bind(id).first<GithubAppTenantRow>();
    },

    /** Dashboard list: non-deleted rows, newest first (stable id tiebreak). */
    async listApps(): Promise<GithubAppRow[]> {
      const res = await db.prepare(APP_READ_SQL.listApps).all<GithubAppRow>();
      return res.results;
    },

    /**
     * The App's stored sandbox image id (migration 0018). No tenant join: it
     * returns a configuration value, never a tenant-facing field.
     */
    async getSandboxImageId(appId: string): Promise<string | null> {
      const row = await db
        .prepare(`SELECT sandbox_image_id FROM github_apps WHERE id = ?`)
        .bind(appId)
        .first<{ sandbox_image_id: string }>();
      return row?.sandbox_image_id ?? null;
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
     * Toggle the per-App pause switch (spec 语义锁): 1 = the App's
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
     * Select the per-App review trigger mode (migration 0022, spec
     * review-trigger-policy §2). The mode must be on the
     * REVIEW_TRIGGER_MODES vocabulary — anything else throws BEFORE any
     * write (the setSandboxImage store-enforced value domain backstop; the
     * settings route answers 400 first, and the DDL CHECK is the last line).
     * Writes review_trigger_mode + updated_at (an operator mutation, the
     * setReviewEnabled convention) and refuses soft-deleted rows exactly
     * like setAppStatus. Returns whether a row changed (false also covers
     * unknown ids).
     */
    async setReviewTriggerMode(id: string, mode: ReviewTriggerMode): Promise<boolean> {
      if (!REVIEW_TRIGGER_MODES.includes(mode)) {
        throw new Error(
          `apps-store: review trigger mode ${JSON.stringify(mode)} is not on the vocabulary (${REVIEW_TRIGGER_MODES.join(" | ")}) — zero rows written`,
        );
      }
      const res = await db
        .prepare(
          `UPDATE github_apps SET review_trigger_mode = ?, updated_at = datetime('now')
           WHERE id = ? AND deleted_at IS NULL`,
        )
        .bind(mode, id)
        .run();
      return res.meta.changes > 0;
    },

    /**
     * Select the App's sandbox runtime image (migration 0018). The
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
     * Record the App's most recent verified (2xx) webhook delivery (lock
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
     * Persist one fetched GitHub profile (migrations 0019/0036) — the
     * SINGLE writer for the github_* metadata columns (the settings read
     * path's lazy 24h TTL refresh; no cron/queue retry exists by plan lock).
     * Writes ONLY the six new columns — deliberately NOT updated_at, which
     * stays the operator-mutation timestamp (the touchLastWebhook L5
     * precedent: this write is machine-triggered, at most once per App per
     * TTL window). Refuses soft-deleted rows exactly like setAppStatus.
     * Returns whether a row changed (false also covers unknown ids).
     *
     * `github_slug` is COALESCE-preserved: a degraded fetch (upstream shape
     * change, bot lookup failure) writes NULL, and a cached slug is the only
     * bot-mention target — clearing it would silently disable the trigger, so
     * a null bind keeps the stored value. Every other column is a display
     * value and overwrites honestly.
     */
    async saveGithubMetadata(id: string, metadata: GithubAppMetadataInput): Promise<boolean> {
      const res = await db
        .prepare(
          `UPDATE github_apps
           SET github_name = ?, github_description = ?, github_html_url = ?,
               github_avatar_url = ?, github_slug = COALESCE(?, github_slug),
               github_metadata_synced_at = datetime('now')
           WHERE id = ? AND deleted_at IS NULL`,
        )
        .bind(
          metadata.githubName,
          metadata.githubDescription,
          metadata.githubHtmlUrl,
          metadata.githubAvatarUrl,
          metadata.githubSlug,
          id,
        )
        .run();
      return res.meta.changes > 0;
    },

    /**
     * Stamp `github_metadata_attempted_at` (migration 0037) after a fetch
     * attempt that persisted no slug — the ONLY writer of that column, and,
     * like saveGithubMetadata and touchLastWebhook, deliberately NOT
     * updated_at. The read path's NULL-slug re-attempt reads it, so an App
     * that can never sync (deleted upstream, rotated key, slug-less payload)
     * costs at most one fetch per TTL instead of one per settings read. An
     * unknown or soft-deleted id is a silent no-op: the attempt already
     * happened, and refusing to record it would re-open the loop.
     */
    async touchGithubMetadataAttempt(id: string): Promise<void> {
      await db
        .prepare(
          `UPDATE github_apps SET github_metadata_attempted_at = datetime('now')
           WHERE id = ? AND deleted_at IS NULL`,
        )
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
     * Install-health read face (settings panel): this App's
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
     * Append one delivery row (AL-20-1) — the R2 diagnostics
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
     * Health read face: the App's newest review-verdict delivery row
     * (outcome tier — see deliverySummaries) +
     * the count of `rejected` rows inside the trailing 24h window
     * (`created_at > datetime('now', '-24 hours')` — the sweep
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

    /** Bounded ledger retention — see the local implementation above. */
    sweepTerminalPullRequests,

    /**
     * Recent-deliveries read face (settings panel): THIS App's rows, verdict
     * tier first, newest first inside each tier (created_at has second
     * precision, so rowid breaks ties inside one second — the order is total
     * and deterministic), bounded by the caller's N (default 5).
     *
     * The panel exists for one question — is review flowing? — and bypass
     * traffic (`check_run`, `ping`, …) dwarfs review traffic while landing in
     * `ignored`, so a raw newest-first list renders five identical
     * `check_run · ignored` lines even while reviews run fine. Ranking by the
     * same verdict tier the Apps list health column uses (see
     * DELIVERY_VERDICT_TIER_SQL) keeps the verdict in view. Stored rows are
     * untouched, and an App whose ONLY traffic is bypass rows still returns
     * those rows — the list never goes empty because of the ranking.
     */
    async listRecentDeliveries(appId: string, limit = 5): Promise<WebhookDeliveryRow[]> {
      const res = await db
        .prepare(
          `SELECT * FROM webhook_deliveries
           WHERE app_id = ?
           ORDER BY ${DELIVERY_VERDICT_TIER_SQL}, created_at DESC, rowid DESC
           LIMIT ?`,
        )
        .bind(appId, limit)
        .all<WebhookDeliveryRow>();
      return res.results;
    },

    /**
     * Record one VERIFIED `pull_request` delivery (migration 0039) —
     * idempotent on the UNIQUE (app_id, owner, repo, pr_number) tuple: a PR
     * that arrives several times (opened, synchronize, closed, …) keeps ONE
     * row and `title` / `state` / `head_sha` refresh only when the caller
     * supplies them (a payload that omits a field keeps the last known value
     * rather than blanking it). `first_seen_at` is written once, by the
     * INSERT.
     *
     * Two protections against a late, stale delivery:
     *   - `merged` is TERMINAL. GitHub sends `merged: true` once, on the
     *     `closed` delivery; an `opened`/`synchronize` that arrives afterwards
     *     (out-of-order or replayed) must not rewrite the PR back to `open`.
     *   - `last_seen_at` takes the payload's `updated_at` (GitHub's clock)
     *     through `datetime()`, which also normalises ISO 8601 into the
     *     `YYYY-MM-DD HH:MM:SS` form the column's readers compare against,
     *     and it only ever advances (MAX), so a stale delivery cannot sort the
     *     row to the top either.
     */
    async upsertPullRequest(input: UpsertPullRequestInput): Promise<void> {
      // The caller validates the timestamp (`pullRequestRecord` only passes an
      // RFC 3339 stamp), so this branch is the EXPLICIT "no usable stamp"
      // fallback: arrival time is the only clock left.
      const seenAt = input.updatedAt === undefined || input.updatedAt === null
        ? null
        : input.updatedAt;
      await db
        .prepare(
          `INSERT INTO pull_requests
             (id, app_id, owner, repo, pr_number, title, state, head_sha, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, COALESCE(datetime(?), datetime('now')))
           ON CONFLICT (app_id, owner, repo, pr_number) DO UPDATE SET
             title = COALESCE(excluded.title, title),
             state = CASE WHEN pull_requests.state = 'merged' THEN 'merged' ELSE excluded.state END,
             head_sha = COALESCE(excluded.head_sha, head_sha),
             last_seen_at = MAX(last_seen_at, excluded.last_seen_at)`,
        )
        .bind(
          crypto.randomUUID(),
          input.appId,
          input.owner,
          input.repo,
          input.prNumber,
          input.title ?? null,
          input.state,
          input.headSha ?? null,
          seenAt,
        )
        .run();
    },

    /**
     * PR-ledger list face: the App's most recently active pull requests,
     * newest first. THREE statements per call regardless of N — the rows, the
     * newest review per (owner, repo, pr_number) via a ROW_NUMBER() window
     * (the deliverySummaries shape), and the failure count joined through
     * `app_installations` — never one query per row.
     *
     * Capped at PULL_REQUEST_LIST_LIMIT: any third party who opens a PR mints
     * a row and the retention sweep only drains TERMINAL rows, so the table's
     * live set grows with every open PR across every installed repo. An
     * uncapped list would serialise all of it on every tab open; the cap is
     * the newest window an operator can act on, and the sweep bounds what
     * stays behind it.
     *
     * Failure attribution assumes ONE installation per App. `app_installations`
     * permits the same installation id under two App rows, and in that case a
     * failure row would count toward both — accepted, because the alternative
     * (a constraint) would refuse a legitimate re-install shape, and a
     * cross-App duplicate is a config mistake visible in the delivery health
     * panel, not a silent data problem.
     */
    async listPullRequests(appId: string): Promise<PullRequestRow[]> {
      const results = await db.batch([
        db
          .prepare(
            `SELECT owner, repo, pr_number, title, state, head_sha, first_seen_at, last_seen_at
             FROM pull_requests WHERE app_id = ?
             ORDER BY last_seen_at DESC, pr_number DESC
             LIMIT ?`,
          )
          .bind(appId, PULL_REQUEST_LIST_LIMIT),
        db
          .prepare(
            `SELECT owner, repo, pr_number, verdict, reviewed_at FROM (
               SELECT owner, repo, pr_number, verdict, reviewed_at,
                      ROW_NUMBER() OVER (PARTITION BY owner, repo, pr_number
                        ORDER BY reviewed_at DESC, rowid DESC) AS rn
               FROM reviews WHERE app_id = ?
             ) WHERE rn = 1`,
          )
          .bind(appId),
        db
          .prepare(
            `SELECT f.owner, f.repo, f.pr_number, COUNT(*) AS n
             FROM review_failures f
             JOIN app_installations i ON i.installation_id = f.installation_id AND i.app_id = ?
             GROUP BY f.owner, f.repo, f.pr_number`,
          )
          .bind(appId),
      ]);
      return assemblePullRequests(
        results[0]!.results as PullRequestBaseRow[],
        results[1]!.results as PullRequestReviewRow[],
        results[2]!.results as PullRequestFailureCountRow[],
      );
    },

    /**
     * ONE pull request with its review history, failures and findings — the
     * detail face. The address is the ledger's OWN key
     * (app_id, owner, repo, pr_number): one App can be installed on several
     * repos, and a number is only unique WITHIN a repo, so a number-only
     * lookup would answer with a different repo's PR. A miss is `null` — never
     * a same-number row from another repo.
     *
     * Findings come from `review_findings` (the lifecycle table): it carries
     * `finding_id` and the immutable original as JSON, so `severity` is its
     * `mergeClass` (the vocab-switch mapping `findings.severity` already
     * uses), and `title` / `file_path` / `line` / `body` are read out of
     * `original_json`. Newest lifecycle row first.
     */
    async getPullRequest(
      appId: string,
      owner: string,
      repo: string,
      prNumber: number,
    ): Promise<PullRequestDetail | null> {
      const row = await db
        .prepare(
          `SELECT owner, repo, pr_number, title, state, head_sha, first_seen_at, last_seen_at
           FROM pull_requests WHERE app_id = ? AND owner = ? AND repo = ? AND pr_number = ?`,
        )
        .bind(appId, owner, repo, prNumber)
        .first<PullRequestBaseRow>();
      if (!row) return null;
      const results = await db.batch([
        db
          .prepare(
            `SELECT verdict, summary_md, model, provider, reviewed_at, head_sha
             FROM reviews WHERE app_id = ? AND owner = ? AND repo = ? AND pr_number = ?
             ORDER BY reviewed_at DESC, rowid DESC`,
          )
          .bind(appId, row.owner, row.repo, prNumber),
        db
          .prepare(
            `SELECT f.stage, f.error, f.created_at
             FROM review_failures f
             JOIN app_installations i ON i.installation_id = f.installation_id AND i.app_id = ?
             WHERE f.owner = ? AND f.repo = ? AND f.pr_number = ?
             ORDER BY f.created_at DESC, f.rowid DESC`,
          )
          .bind(appId, row.owner, row.repo, prNumber),
        db
          .prepare(
            `SELECT finding_id,
                    json_extract(original_json, '$.mergeClass') AS severity,
                    json_extract(original_json, '$.title') AS title,
                    json_extract(original_json, '$.filePath') AS file_path,
                    json_extract(original_json, '$.lineStart') AS line,
                    json_extract(original_json, '$.body') AS body
             FROM review_findings
             WHERE app_id = ? AND owner = ? AND repo = ? AND pr_number = ?
             ORDER BY updated_ms DESC, finding_id`,
          )
          .bind(appId, row.owner, row.repo, prNumber),
      ]);
      // The histories ARE the aggregates: reviews come newest first, so the
      // first one is the latest verdict, and the failure rows count themselves.
      const reviews = results[0]!.results as PullRequestReviewDetailRow[];
      const failures = results[1]!.results as PullRequestFailureDetailRow[];
      return {
        pull_request: {
          number: row.pr_number,
          owner: row.owner,
          repo: row.repo,
          title: row.title,
          state: row.state,
          head_sha: row.head_sha,
          first_seen_at: row.first_seen_at,
          last_seen_at: row.last_seen_at,
          latest_review:
            reviews[0] === undefined ? null : { verdict: reviews[0].verdict, reviewed_at: reviews[0].reviewed_at },
          failure_count: failures.length,
        },
        reviews,
        failures,
        // Nullable columns pass through AS THEY ARE: the store reports what
        // the tables hold, and the route's wire mapping decides what the
        // client may receive (a NULL `provider` is a real, common row — the
        // v1 pipeline never records one).
        findings: results[2]!.results as PullRequestFindingRow[],
      };
    },
  };
}

/** The `pull_requests` columns the ledger reads (`number` = `pr_number`). */
type PullRequestBaseRow = {
  owner: string;
  repo: string;
  pr_number: number;
  title: string | null;
  state: string;
  head_sha: string | null;
  first_seen_at: string;
  last_seen_at: string;
};

type PullRequestReviewRow = { owner: string; repo: string; pr_number: number; verdict: string; reviewed_at: string };
type PullRequestFailureCountRow = { owner: string; repo: string; pr_number: number; n: number };
export type PullRequestFindingRow = {
  finding_id: string;
  severity: string | null;
  title: string | null;
  file_path: string | null;
  line: number | null;
  body: string | null;
};

/** One `reviews` row as the detail face reads it — nullable columns honest. */
export type PullRequestReviewDetailRow = {
  verdict: string;
  summary_md: string | null;
  model: string | null;
  provider: string | null;
  reviewed_at: string;
  head_sha: string;
};

export type PullRequestFailureDetailRow = { stage: string; error: string; created_at: string };

/** Detail read result — the row plus its three histories. */
export type PullRequestDetail = {
  pull_request: PullRequestRow;
  reviews: PullRequestReviewDetailRow[];
  failures: PullRequestFailureDetailRow[];
  findings: PullRequestFindingRow[];
};

/**
 * Join the ledger list's three result sets in memory — the tuple
 * (owner, repo, pr_number) is the key, and a PR with no review / no failure
 * reads `latest_review: null`, `failure_count: 0`.
 */
function assemblePullRequests(
  rows: PullRequestBaseRow[],
  reviews: PullRequestReviewRow[],
  failures: PullRequestFailureCountRow[],
): PullRequestRow[] {
  const key = (owner: string, repo: string, pr: number): string => `${owner}\u0000${repo}\u0000${pr}`;
  const reviewByKey = new Map(reviews.map((row) => [key(row.owner, row.repo, row.pr_number), row]));
  const failureByKey = new Map(failures.map((row) => [key(row.owner, row.repo, row.pr_number), row.n]));
  return rows.map((row) => {
    const k = key(row.owner, row.repo, row.pr_number);
    const review = reviewByKey.get(k);
    return {
      number: row.pr_number,
      owner: row.owner,
      repo: row.repo,
      title: row.title,
      state: row.state,
      head_sha: row.head_sha,
      first_seen_at: row.first_seen_at,
      last_seen_at: row.last_seen_at,
      latest_review: review ? { verdict: review.verdict, reviewed_at: review.reviewed_at } : null,
      failure_count: failureByKey.get(k) ?? 0,
    };
  });
}
