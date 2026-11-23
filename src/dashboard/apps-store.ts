import { ATTRIBUTION_EXCLUDED_STAGES, sqlStageList } from "../contracts/failure-stages";
import { normalizeRfc3339 } from "../contracts/rfc3339";
import { FINDING_SEVERITIES, MUST_FIX_SEVERITY } from "../contracts/finding-severity";
import { getSandboxImage } from "../contracts/sandbox-images";
import { OFFICIAL_WORKSPACE_KEY } from "./runtime-config-store";

/** A row of `review_bots` (D1 column names, snake_case; migrations 0004/0036). */
export type GithubAppRow = {
  id: string;
  github_app_id: number;
  name: string;
  private_key_enc: string;
  webhook_secret_enc: string;
  created_by: string;
  status: GithubAppStatus;
  deleted_at: string | null;
  review_enabled: number;
  github_visibility: GithubVisibility | null;
  last_webhook_at: string | null;
  github_name: string | null;
  github_description: string | null;
  github_html_url: string | null;
  github_avatar_url: string | null;
  github_slug: string | null;
  github_metadata_synced_at: string | null;
  github_metadata_attempted_at: string | null;
  sandbox_image_id: string;
  created_at: string;
  updated_at: string;
  scope: BotScope;
  workspace_id?: string;
};

export type GithubAppStatus = "active" | "disabled";

/**
 * An execution-facing App row: the two resolutions INNER JOIN `bot_workspaces`,
 * so `workspace_id` is present by construction. Typing it here (instead of at
 * the call sites with `!`) keeps the invariant where SQL enforces it — a future
 * LEFT JOIN breaks the read's type rather than binding `undefined`.
 */
export type GithubAppTenantRow = GithubAppRow & { workspace_id: string };

/**
 * Cached GitHub App visibility (migration 0045, the `github_visibility`
 * column value domain). `unknown` is also what a NULL column reads as. The
 * anonymous `GET /apps/{slug}` probe answers public/404 and `null` to a
 * no-answer; both callers keep the last stored value on `null`.
 */
export type GithubVisibility = "public" | "private" | "unknown";

/** Input for createApp — encrypted payloads are built by the caller. */
export type CreateAppInput = {
  id: string;
  githubSlug: string | null;
  githubAppId: number;
  name: string;
  privateKeyEnc: string;
  webhookSecretEnc: string;
  createdBy: string;
  workspaceId: string;
  maxApps: number | null;
};

/**
 * Thrown by {@link createApp} when the guarded insert wrote no row because the
 * workspace already owns `maxApps` live Apps. The cap is decided BY the write,
 * so a concurrent pair cannot both land. Callers map it onto the existing
 * refusal surface; it is not a database fault and must not be retried as one.
 */
export class AppCountExceededError extends Error {
  readonly limit: number;

  constructor(limit: number) {
    super(`apps-store: createApp refused — the workspace already owns ${limit} live Apps`);
    this.name = "AppCountExceededError";
    this.limit = limit;
  }
}

export type UpsertInstallationInput = {
  appId: string;
  installationId: number;
  accountLogin?: string | null;
  authoritative?: boolean;
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
 * A `bot_installations` row as the settings health panel reads it
 * (DDL = migration 0004). The `id` PK is deliberately not projected —
 * the panel keys installations by installation_id.
 */
export type AppInstallationRow = {
  installation_id: number;
  account_login: string | null;
  seen_at: string;
};

/** The outcome of binding one installation to a workspace. */
export type BindInstallationOutcome = "bound" | "bound_elsewhere" | "unknown";

/**
 * One installation INCLUDING a removed one — the bound-state read. Unlike
 * `AppInstallationRow` (the install-health panel's PRESENT rows), a removed
 * installation is exactly what this answers: a target keeps its binding
 * through an uninstall, and the settings block says reviews stopped.
 */
export type AppInstallationState = {
  installation_id: number;
  account_login: string | null;
  removed_at: string | null;
};

/**
 * The producer-side delivery-outcome vocabulary (AL-20-1;
 * 0010 FAILURE_STAGES precedent; 0011 webhook_deliveries is current):
 * `ok` = job enqueued, `paused` = the App's
 * review switch is off (2xx ignore, zero enqueue), `ignored` = verified but
 * not a reviewable event (e.g. ping), `rejected` = the classifier refused
 * the delivery (400|401|500 — "sent but refused" is the R2 visibility
 * core), `skipped` = verified and admitted by every switch, then refused by
 * the shared-bot capability (200, zero enqueue — neither `ok`, which would
 * claim a job, nor `paused`, which would blame a switch that is on).
 * Enforced producer-side: an off-vocabulary outcome throws BEFORE
 * any row is written; the schema has no CHECK (0010 precedent).
 */
export const DELIVERY_OUTCOMES: readonly string[] = Object.freeze([
  "ok",
  "paused",
  "ignored",
  "rejected",
  "skipped",
]);

export type DeliveryOutcome = "ok" | "paused" | "ignored" | "rejected" | "skipped";

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
 * Persist bound for the source repository name (`owner/name`, migration 0043).
 * A verified-body field: `repository.full_name` rides in the BODY of an
 * HMAC-verified delivery, and the signature check runs before classification,
 * so an unverified request never reaches the read that produces it — this is
 * not attacker-supplied. The bound is therefore defence-in-depth against
 * GitHub's own ceilings (39-char owner + 100-char repo = 139), and the DDL has
 * no length constraint. 160 is headroom, never a truncation risk for a real
 * delivery. The `event_name` bound next to it is the other case: that value is
 * a HEADER, which the unauthenticated reject path really does hand us.
 */
export const REPOSITORY_FULL_NAME_MAX_LENGTH = 160;

/**
 * Persist bound for a delivery's refusal reason (migration 0074). The text is
 * composed by this Worker's own classifier from fixed strings
 * (`src/worker/webhooks.ts` WebhookOutcome's `reject.reason`), never echoed
 * from a request body, so the bound is headroom for a future longer sentence
 * rather than a payload limit — the DDL has no length constraint.
 */
export const DELIVERY_REASON_MAX_LENGTH = 200;

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

const PULL_REQUEST_LEDGER_ORDER = "last_seen_at DESC, pr_number DESC";

const PULL_REQUEST_REPO_PREDICATE = " AND owner = ? AND repo = ?";

/**
 * The tenant scope every ledger read binds: ONE repository target, or every
 * live target of a workspace (which spans bots, so no bot rides here). The
 * route resolves both from the session.
 *
 * The workspace arm is a SUBQUERY, never an id list: the bind count must be a
 * property of the scope KIND, not of how many targets the tenant happens to
 * own. D1 caps a statement's parameters, so a spliced list turns "this
 * workspace has many repositories" into a runtime failure.
 *
 * The target arm re-checks the target/workspace pair in the SAME statement, so
 * a route bug cannot leak another tenant's rows; the workspace arm carries the
 * same re-check as its subquery's own predicate. An empty workspace reads
 * nothing (the subquery matches no id) — an empty payload, not an error.
 */
export type LedgerScope =
  | { kind: "target"; targetId: string; workspaceId: string }
  | { kind: "workspace"; workspaceId: string };

function ledgerScopeSql(alias: string, scope: LedgerScope): string {
  const target = `${alias}.target_id`;
  if (scope.kind === "workspace") {
    return `${target} IN (SELECT t.id FROM review_targets t WHERE t.workspace_id = ? AND t.deleted_at IS NULL)`;
  }
  return `${target} = ? AND EXISTS (SELECT 1 FROM review_targets t WHERE t.id = ${target} AND t.workspace_id = ? AND t.deleted_at IS NULL)`;
}

function ledgerScopeBinds(scope: LedgerScope): string[] {
  return scope.kind === "workspace" ? [scope.workspaceId] : [scope.targetId, scope.workspaceId];
}

function pullRequestWindowSql(repoPredicate: string, scope: LedgerScope): string {
  return `SELECT owner, repo, pr_number FROM pull_requests
  WHERE ${ledgerScopeSql("pull_requests", scope)}${repoPredicate}
  ORDER BY ${PULL_REQUEST_LEDGER_ORDER} LIMIT ?`;
}

function pullRequestExistsSql(scope: LedgerScope): string {
  return `SELECT 1 AS found FROM pull_requests p
  WHERE ${ledgerScopeSql("p", scope)} AND p.owner = ? AND p.repo = ? AND p.pr_number = ? LIMIT 1`;
}

function truncateBounded(value: string, max: number): string {
  if (value.length <= max) return value;
  const last = value.charCodeAt(max - 1);
  return value.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** Input for recordDelivery — one VERIFIED per-App webhook delivery. */
export type RecordDeliveryInput = {
  appId: string;
  eventName: string | null;
  outcome: DeliveryOutcome;
  statusCode: number | null;
  repositoryFullName: string | null;
  reason: string | null;
};

/** A row of `webhook_deliveries` (D1 column names, snake_case; migration 0011). */
export type WebhookDeliveryRow = {
  id: string;
  bot_id: string;
  event_name: string | null;
  outcome: DeliveryOutcome;
  status_code: number | null;
  repository_full_name: string | null;
  reason: string | null;
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

/**
 * The delivery-status filters, already validated by the route: `null` means
 * "no filter", never "empty string matches nothing". `sinceDays` is the
 * caller's closed window in whole days, `eventName` the delivery TYPE (the
 * `x-github-event` name the log stores).
 */
export type DeliveryFilters = {
  repo: string | null;
  sinceDays: number | null;
  eventName: string | null;
  limit: number;
  offset: number;
};

/** One filtered page of deliveries plus the unpaged, matching total. */
export type DeliveryPage = {
  rows: WebhookDeliveryRow[];
  total: number;
  repos: string[];
  types: string[];
};

/** Input for upsertPullRequest — one VERIFIED `pull_request` delivery. */
export type UpsertPullRequestInput = {
  appId: string;
  targetId: string;
  owner: string;
  repo: string;
  prNumber: number;
  title?: string | null;
  state: string;
  headSha?: string | null;
  updatedAt?: string | null;
};

/**
 * The per-PR live-inflight projection (compass D11/D16). `live` means the
 * PR's `review_inflight` row is held right now — the pipeline's own
 * `expires_at > now` predicate, evaluated HERE — and carries the holding
 * attempt's head sha (`""` for a comment trigger) and its acquisition
 * instant. `none` is a successful read with no live row: no row, released,
 * expired, queued or superseded before admission, abandoned after release.
 * `unknown` is a failed read, which a client must never render as idle. No
 * stage, attempt id or expiry crosses this boundary.
 */
export type PullRequestReviewing =
  | { state: "live"; head_sha: string; acquired_at: string }
  | { state: "none" }
  | { state: "unknown" };

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
  reviewing: PullRequestReviewing;
};

type AppsStoreStatement = {
  bind(...values: unknown[]): AppsStoreStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run<T = Record<string, unknown>>(): Promise<{
    results: T[];
    meta: { changes: number; last_row_id: number };
  }>;
};

type AppsStoreBatchResult = {
  results: unknown[];
  meta: { changes: number; last_row_id: number };
};

type AppsStoreD1 = {
  prepare(query: string): AppsStoreStatement;
  batch(statements: AppsStoreStatement[]): Promise<AppsStoreBatchResult[]>;
};

type CountRow = { n: number };

function countOf(result: AppsStoreBatchResult): number {
  const [row] = result.results as CountRow[];
  return row?.n ?? 0;
}


/**
 * The two execution-facing App resolutions plus the operator list. FROZEN —
 * do not reword them; call sites and tests assert these exact strings.
 * `listApps` deliberately does NOT filter on `workspaces.deleted_at`: it is
 * the operator read-only list with no execution face, and retiring a tenant
 * must not hide its Apps from operators.
 */
export const APP_READ_SQL = {
  getAppById: `SELECT g.*, w.workspace_id FROM review_bots g INNER JOIN bot_workspaces w ON w.bot_id = g.id INNER JOIN workspaces ws ON ws.id = w.workspace_id AND ws.deleted_at IS NULL WHERE g.id = ?`,
  getAppForWebhook: `SELECT g.*, w.workspace_id FROM review_bots g INNER JOIN bot_workspaces w ON w.bot_id = g.id INNER JOIN workspaces ws ON ws.id = w.workspace_id AND ws.deleted_at IS NULL WHERE g.id = ? AND w.workspace_id = ?`,
  getAppByGithubId: `SELECT g.*, w.workspace_id FROM review_bots g INNER JOIN bot_workspaces w ON w.bot_id = g.id INNER JOIN workspaces ws ON ws.id = w.workspace_id AND ws.deleted_at IS NULL WHERE g.github_app_id = ?`,
  getVisibleBotByGithubId: `SELECT g.*, w.workspace_id FROM review_bots g INNER JOIN bot_workspaces w ON w.bot_id = g.id INNER JOIN workspaces ws ON ws.id = w.workspace_id AND ws.deleted_at IS NULL WHERE g.github_app_id = ?1 AND g.deleted_at IS NULL AND (w.workspace_id = ?2 OR g.scope = 'shared') ORDER BY (w.workspace_id = ?2) DESC, w.workspace_id LIMIT 1`,
  listApps: `SELECT g.*, w.workspace_id FROM review_bots g INNER JOIN bot_workspaces w ON w.bot_id = g.id WHERE g.deleted_at IS NULL ORDER BY g.created_at DESC, g.id`,
} as const;

const SCOPED_APP_SQL = `SELECT g.*, w.workspace_id FROM review_bots g INNER JOIN bot_workspaces w ON w.bot_id = g.id INNER JOIN workspaces ws ON ws.id = w.workspace_id AND ws.deleted_at IS NULL WHERE g.github_app_id = ?1 AND g.deleted_at IS NULL AND (w.workspace_id = ?2 OR EXISTS (SELECT 1 FROM review_targets t WHERE t.bot_id = g.id AND t.workspace_id = ?2 AND t.deleted_at IS NULL)) ORDER BY (w.workspace_id = ?2) DESC, w.workspace_id LIMIT 1`;

const UPSERT_INSTALLATION_SQL = {
  authoritative: `INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at)
    VALUES (?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f','now'))
    ON CONFLICT (bot_id, installation_id) DO UPDATE SET
      account_login = COALESCE(excluded.account_login, account_login),
      seen_at = strftime('%Y-%m-%d %H:%M:%f','now'),
      removed_at = NULL`,
  inferred: `INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at)
    VALUES (?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f','now'))
    ON CONFLICT (bot_id, installation_id) DO UPDATE SET
      account_login = COALESCE(account_login, excluded.account_login),
      seen_at = strftime('%Y-%m-%d %H:%M:%f','now')`,
} as const;

/**
 * One `shared` bot as a workspace's creation chooser lists it (contract § 7.1).
 * `target_count` is the ADDRESSED workspace's live targets on that bot, so the
 * same bot reads a different number in each workspace that may use it.
 */
export type SharedBotRow = {
  id: string;
  github_slug: string | null;
  name: string;
  target_count: number;
};

const SHARED_BOT_LIST_SQL = `
  SELECT b.id, b.github_slug, b.name,
         (SELECT COUNT(*) FROM review_targets t
           WHERE t.bot_id = b.id AND t.workspace_id = ?1 AND t.deleted_at IS NULL) AS target_count
    FROM review_bots b
   WHERE b.scope = 'shared' AND b.deleted_at IS NULL
   ORDER BY b.name, b.id`;

/** Create the review_bots / bot_installations store over one D1 handle. */
export function createReviewBotsStore(db: AppsStoreD1) {
  async function sweepTerminalPullRequests(): Promise<number> {
    // The state predicate must stay identical to idx_pull_requests_terminal_seen's WHERE (0099).
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

  async function deliverySummaries(appIds: string[]): Promise<Record<string, DeliverySummary>> {
    if (appIds.length === 0) return {};
    const placeholders = appIds.map(() => "?").join(", ");
    const [latestRes, rejectedRes] = await Promise.all([
      db
        .prepare(
          `WITH requested(bot_id) AS (VALUES ${appIds.map(() => "(?)").join(", ")})
           SELECT bot_id, id, event_name, outcome, status_code, repository_full_name, created_at
           FROM webhook_deliveries WHERE rowid IN (
             SELECT (SELECT rowid FROM webhook_deliveries
                     WHERE bot_id = requested.bot_id
                     ORDER BY ${DELIVERY_VERDICT_TIER_SQL}, created_at DESC, rowid DESC
                     LIMIT 1)
             FROM requested
           )`,
        )
        .bind(...appIds)
        .all<WebhookDeliveryRow>(),
      db
        .prepare(
          `SELECT bot_id, COUNT(*) AS n FROM webhook_deliveries
           WHERE bot_id IN (${placeholders}) AND outcome = 'rejected'
             AND created_at > datetime('now', '-24 hours')
           GROUP BY bot_id`,
        )
        .bind(...appIds)
        .all<{ bot_id: string; n: number }>(),
    ]);
    const byApp: Record<string, DeliverySummary> = {};
    for (const appId of appIds) {
      byApp[appId] = { latest: null, rejected24h: 0 };
    }
    for (const row of latestRes.results) {
      const entry = byApp[row.bot_id];
      if (entry) entry.latest = row;
    }
    for (const row of rejectedRes.results) {
      const entry = byApp[row.bot_id];
      if (entry) entry.rejected24h = row.n;
    }
    return byApp;
  }

  async function liveReviewLocks(
    workspaceId: string,
  ): Promise<Map<string, PullRequestLockRow> | null> {
    try {
      const { results } = await db
        .prepare(
          `SELECT r.owner, r.repo, r.pr_number, r.head_sha, r.acquired_at
           FROM review_inflight r
           WHERE r.workspace_id = ? AND r.expires_at > ?`,
        )
        .bind(workspaceId, new Date().toISOString())
        .all<PullRequestLockRow>();
      return new Map(results.map((row) => [pullRequestKey(row.owner, row.repo, row.pr_number), row]));
    } catch {
      console.warn(JSON.stringify({ event: "dashboard_live_lock_read_failed", workspace_id: workspaceId }));
      return null;
    }
  }

  return {
    async createApp(input: CreateAppInput): Promise<GithubAppRow> {
      const id = input.id;
      const liveWorkspace = await db
        .prepare(`SELECT id FROM workspaces WHERE id = ? AND deleted_at IS NULL`)
        .bind(input.workspaceId)
        .first<{ id: string }>();
      if (!liveWorkspace) {
        throw new Error("apps-store: createApp target workspace is not live");
      }
      const capGuard =
        input.maxApps === null
          ? ""
          : `
              AND (SELECT COUNT(*)
                     FROM bot_workspaces w
                     JOIN review_bots b ON b.id = w.bot_id
                    WHERE w.workspace_id = ?8 AND b.deleted_at IS NULL) < ?9`;
      const results = await db.batch([
        db
          .prepare(
            `INSERT INTO review_bots
               (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
                created_by, status, created_at, updated_at)
             SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, 'active', datetime('now'), datetime('now')
              WHERE EXISTS (SELECT 1 FROM workspaces WHERE id = ?8 AND deleted_at IS NULL)${capGuard}`,
          )
          .bind(
            id,
            input.githubSlug,
            input.githubAppId,
            input.name,
            input.privateKeyEnc,
            input.webhookSecretEnc,
            input.createdBy,
            input.workspaceId,
            ...(input.maxApps === null ? [] : [input.maxApps]),
          ),
        db
          .prepare(
            `INSERT INTO bot_workspaces (bot_id, workspace_id)
             SELECT id, ?2 FROM review_bots WHERE id = ?1 AND changes() > 0`,
          )
          .bind(id, input.workspaceId),
      ]);
      if (results[0]!.meta.changes === 0) {
        const stillLive = await db
          .prepare(`SELECT id FROM workspaces WHERE id = ? AND deleted_at IS NULL`)
          .bind(input.workspaceId)
          .first<{ id: string }>();
        if (!stillLive) {
          throw new Error("apps-store: createApp target workspace is not live");
        }
        if (input.maxApps === null) {
          throw new Error("apps-store: createApp row vanished on read-back");
        }
        throw new AppCountExceededError(input.maxApps);
      }
      const row = await db.prepare(`SELECT * FROM review_bots WHERE id = ?`).bind(id).first<GithubAppRow>();
      if (!row) {
        throw new Error("apps-store: createApp row vanished on read-back");
      }
      return row;
    },

    async countLiveApps(workspaceId: string): Promise<number> {
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS n
             FROM bot_workspaces w
             JOIN review_bots b ON b.id = w.bot_id
            WHERE w.workspace_id = ? AND b.deleted_at IS NULL`,
        )
        .bind(workspaceId)
        .first<{ n: number }>();
      return row?.n ?? 0;
    },

    async getAppForWebhook(
      workspaceId: string,
      appId: string,
    ): Promise<GithubAppTenantRow | null> {
      return db
        .prepare(APP_READ_SQL.getAppForWebhook)
        .bind(appId, workspaceId)
        .first<GithubAppTenantRow>();
    },

    async getAppByGithubId(githubAppId: number): Promise<GithubAppTenantRow | null> {
      return db
        .prepare(APP_READ_SQL.getAppByGithubId)
        .bind(githubAppId)
        .first<GithubAppTenantRow>();
    },

    async getVisibleBotByGithubId(
      githubAppId: number,
      workspaceId: string,
    ): Promise<GithubAppTenantRow | null> {
      return db
        .prepare(APP_READ_SQL.getVisibleBotByGithubId)
        .bind(githubAppId, workspaceId)
        .first<GithubAppTenantRow>();
    },

    async getScopedAppByGithubId(
      githubAppId: number,
      workspaceId: string,
    ): Promise<GithubAppTenantRow | null> {
      return db
        .prepare(SCOPED_APP_SQL)
        .bind(githubAppId, workspaceId)
        .first<GithubAppTenantRow>();
    },

    async listSharedBots(workspaceId: string): Promise<SharedBotRow[]> {
      const res = await db.prepare(SHARED_BOT_LIST_SQL).bind(workspaceId).all<SharedBotRow>();
      return res.results;
    },

    async getAppById(id: string): Promise<GithubAppTenantRow | null> {
      return db.prepare(APP_READ_SQL.getAppById).bind(id).first<GithubAppTenantRow>();
    },

    async listApps(): Promise<GithubAppRow[]> {
      const res = await db.prepare(APP_READ_SQL.listApps).all<GithubAppRow>();
      return res.results;
    },

    async getSandboxImageId(appId: string): Promise<string | null> {
      const row = await db
        .prepare(`SELECT sandbox_image_id FROM review_bots WHERE id = ?`)
        .bind(appId)
        .first<{ sandbox_image_id: string }>();
      return row?.sandbox_image_id ?? null;
    },

    async getGithubVisibility(appId: string): Promise<GithubVisibility | null> {
      const row = await db
        .prepare(`SELECT github_visibility FROM review_bots WHERE id = ?`)
        .bind(appId)
        .first<{ github_visibility: GithubVisibility | null }>();
      if (!row) return null;
      return row.github_visibility ?? "unknown";
    },

    async setAppStatus(id: string, status: GithubAppStatus): Promise<boolean> {
      const res = await db
        .prepare(
          `UPDATE review_bots SET status = ?, updated_at = datetime('now')
           WHERE id = ? AND deleted_at IS NULL`,
        )
        .bind(status, id)
        .run();
      return res.meta.changes > 0;
    },

    async setReviewEnabled(id: string, enabled: boolean): Promise<boolean> {
      const res = await db
        .prepare(
          `UPDATE review_bots SET review_enabled = ?, updated_at = datetime('now')
           WHERE id = ? AND deleted_at IS NULL`,
        )
        .bind(enabled ? 1 : 0, id)
        .run();
      return res.meta.changes > 0;
    },

    async saveGithubVisibility(id: string, visibility: GithubVisibility): Promise<boolean> {
      const res = await db
        .prepare(
          `UPDATE review_bots SET github_visibility = ?
           WHERE id = ? AND deleted_at IS NULL`,
        )
        .bind(visibility, id)
        .run();
      return res.meta.changes > 0;
    },

    async setSandboxImage(id: string, imageId: string): Promise<boolean> {
      const image = getSandboxImage(imageId);
      if (!image || !image.enabled) {
        throw new Error(
          `apps-store: sandbox image ${JSON.stringify(imageId)} is not an enabled registry entry — zero rows written`,
        );
      }
      const res = await db
        .prepare(
          `UPDATE review_bots SET sandbox_image_id = ?, updated_at = datetime('now')
           WHERE id = ? AND deleted_at IS NULL`,
        )
        .bind(image.id, id)
        .run();
      return res.meta.changes > 0;
    },

    async softDeleteApp(id: string): Promise<boolean> {
      const [botResult] = await db.batch([
        db
          .prepare(
            `UPDATE review_bots SET deleted_at = datetime('now'), updated_at = datetime('now')
             WHERE id = ? AND deleted_at IS NULL`,
          )
          .bind(id),
        db
          .prepare(
            `UPDATE review_targets SET deleted_at = datetime('now'), updated_at = datetime('now')
             WHERE bot_id = ? AND deleted_at IS NULL`,
          )
          .bind(id),
      ]);
      return (botResult?.meta.changes ?? 0) > 0;
    },

    async touchLastWebhook(id: string): Promise<void> {
      await db
        .prepare(`UPDATE review_bots SET last_webhook_at = datetime('now') WHERE id = ?`)
        .bind(id)
        .run();
    },

    async saveGithubMetadata(id: string, metadata: GithubAppMetadataInput): Promise<boolean> {
      const res = await db
        .prepare(
          `UPDATE review_bots
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

    async touchGithubMetadataAttempt(id: string): Promise<void> {
      await db
        .prepare(
          `UPDATE review_bots SET github_metadata_attempted_at = datetime('now')
           WHERE id = ? AND deleted_at IS NULL`,
        )
        .bind(id)
        .run();
    },

    async upsertInstallation(input: UpsertInstallationInput): Promise<void> {
      const sql = input.authoritative ? UPSERT_INSTALLATION_SQL.authoritative : UPSERT_INSTALLATION_SQL.inferred;
      await db
        .prepare(sql)
        .bind(crypto.randomUUID(), input.appId, input.installationId, input.accountLogin ?? null)
        .run();
    },

    async listInstallations(appId: string): Promise<AppInstallationRow[]> {
      const res = await db
        .prepare(
          `SELECT installation_id, account_login, seen_at FROM bot_installations
           WHERE bot_id = ? AND removed_at IS NULL ORDER BY seen_at DESC, installation_id`,
        )
        .bind(appId)
        .all<AppInstallationRow>();
      return res.results;
    },

    /**
     * The live installations bound to one workspace — the only rows a shared
     * bot's repository walk, target creation and bind may read for that
     * workspace, since the bot's other rows belong to other customers.
     */
    async listInstallationsBoundTo(appId: string, workspaceId: string): Promise<AppInstallationRow[]> {
      const res = await db
        .prepare(
          `SELECT installation_id, account_login, seen_at FROM bot_installations
           WHERE bot_id = ? AND bound_workspace_id = ? AND removed_at IS NULL
           ORDER BY seen_at DESC, installation_id`,
        )
        .bind(appId, workspaceId)
        .all<AppInstallationRow>();
      return res.results;
    },

    async getInstallationBinding(
      appId: string,
      installationId: number,
    ): Promise<{ bound_workspace_id: string | null; removed_at: string | null } | null> {
      return db
        .prepare(
          `SELECT bound_workspace_id, removed_at FROM bot_installations
           WHERE bot_id = ? AND installation_id = ?`,
        )
        .bind(appId, installationId)
        .first<{ bound_workspace_id: string | null; removed_at: string | null }>();
    },

    /**
     * Bind a live installation to a workspace. First binder wins: a row already
     * bound to another workspace is never rebound here.
     */
    async bindInstallation(
      appId: string,
      installationId: number,
      workspaceId: string,
    ): Promise<BindInstallationOutcome> {
      const res = await db
        .prepare(
          `UPDATE bot_installations SET bound_workspace_id = ?3
           WHERE bot_id = ?1 AND installation_id = ?2 AND removed_at IS NULL
             AND (bound_workspace_id IS NULL OR bound_workspace_id = ?3)`,
        )
        .bind(appId, installationId, workspaceId)
        .run();
      if (res.meta.changes > 0) return "bound";
      const row = await db
        .prepare(`SELECT removed_at FROM bot_installations WHERE bot_id = ? AND installation_id = ?`)
        .bind(appId, installationId)
        .first<{ removed_at: string | null }>();
      return row !== null && row.removed_at === null ? "bound_elsewhere" : "unknown";
    },

    async listPendingInstallations(appId: string, workspaceId: string): Promise<AppInstallationRow[]> {
      const res = await db
        .prepare(
          `SELECT i.installation_id, i.account_login, i.seen_at FROM bot_installations i
             JOIN review_bots b ON b.id = i.bot_id
            WHERE i.bot_id = ?1 AND i.removed_at IS NULL
              AND (i.bound_workspace_id IS NULL OR i.bound_workspace_id = ?2)
              AND (b.scope = 'shared'
                   OR EXISTS (SELECT 1 FROM bot_workspaces w
                               WHERE w.bot_id = b.id AND w.workspace_id = ?2))
            ORDER BY i.seen_at DESC, i.installation_id`,
        )
        .bind(appId, workspaceId)
        .all<AppInstallationRow>();
      return res.results;
    },

    async getInstallation(
      appId: string,
      installationId: number,
    ): Promise<AppInstallationState | null> {
      return db
        .prepare(
          `SELECT installation_id, account_login, removed_at FROM bot_installations
           WHERE bot_id = ? AND installation_id = ?`,
        )
        .bind(appId, installationId)
        .first<AppInstallationState>();
    },

    async currentTimestamp(): Promise<string> {
      const row = await db
        .prepare(`SELECT strftime('%Y-%m-%d %H:%M:%f','now') AS now`)
        .first<{ now: string }>();
      if (!row) throw new Error("D1 returned no clock row");
      return row.now;
    },

    async markInstallationRemoved(appId: string, installationId: number): Promise<void> {
      await db
        .prepare(
          `UPDATE bot_installations SET removed_at = strftime('%Y-%m-%d %H:%M:%f','now')
           WHERE bot_id = ? AND installation_id = ?`,
        )
        .bind(appId, installationId)
        .run();
    },

    async reconcileInstallations(
      appId: string,
      liveInstallationIds: readonly number[],
      observedAt: string,
    ): Promise<void> {
      const snapshot = JSON.stringify({ ids: liveInstallationIds, observedAt });
      await db.batch([
        db
          .prepare(
            `WITH snapshot(body) AS (SELECT ?)
             UPDATE bot_installations SET removed_at = strftime('%Y-%m-%d %H:%M:%f','now')
             WHERE bot_id = ?
               AND removed_at IS NULL
               AND seen_at <= (SELECT json_extract(body, '$.observedAt') FROM snapshot)
               AND installation_id NOT IN (
                 SELECT value FROM json_each((SELECT body FROM snapshot), '$.ids')
               )`,
          )
          .bind(snapshot, appId),
        db
          .prepare(
            `WITH snapshot(body) AS (SELECT ?)
             UPDATE bot_installations SET removed_at = NULL
             WHERE bot_id = ?
               AND removed_at IS NOT NULL
               AND removed_at < (SELECT json_extract(body, '$.observedAt') FROM snapshot)
               AND installation_id IN (
                 SELECT value FROM json_each((SELECT body FROM snapshot), '$.ids')
               )`,
          )
          .bind(snapshot, appId),
      ]);
    },

    async recordDelivery(input: RecordDeliveryInput): Promise<void> {
      if (!DELIVERY_OUTCOMES.includes(input.outcome)) {
        throw new Error(
          `apps-store: outcome ${JSON.stringify(input.outcome)} is not on the producer vocabulary (${DELIVERY_OUTCOMES.join(" | ")}) — zero rows written`,
        );
      }
      const eventName = input.eventName === null ? null : truncateBounded(input.eventName, EVENT_NAME_MAX_LENGTH);
      const repositoryFullName =
        input.repositoryFullName === null
          ? null
          : truncateBounded(input.repositoryFullName, REPOSITORY_FULL_NAME_MAX_LENGTH);
      const reason = input.reason === null ? null : truncateBounded(input.reason, DELIVERY_REASON_MAX_LENGTH);
      await db
        .prepare(
          `INSERT INTO webhook_deliveries (id, bot_id, event_name, outcome, status_code, repository_full_name, reason)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          input.appId,
          eventName,
          input.outcome,
          input.statusCode,
          repositoryFullName,
          reason,
        )
        .run();
    },

    async deliverySummary(appId: string): Promise<DeliverySummary> {
      return (await deliverySummaries([appId]))[appId]!;
    },

    deliverySummaries,

    sweepTerminalPullRequests,

    async listDeliveries(appId: string, filters: DeliveryFilters): Promise<DeliveryPage> {
      const predicates = ["bot_id = ?"];
      const binds: (string | number)[] = [appId];
      if (filters.repo !== null) {
        predicates.push("repository_full_name = ?");
        binds.push(filters.repo);
      }
      if (filters.sinceDays !== null) {
        predicates.push("created_at > datetime('now', ?)");
        binds.push(`-${filters.sinceDays} days`);
      }
      if (filters.eventName !== null) {
        predicates.push("event_name = ?");
        binds.push(filters.eventName);
      }
      const where = predicates.join(" AND ");
      const page = await db
        .prepare(
          `SELECT * FROM webhook_deliveries
           WHERE ${where}
           ORDER BY ${DELIVERY_VERDICT_TIER_SQL}, created_at DESC, rowid DESC
           LIMIT ? OFFSET ?`,
        )
        .bind(...binds, filters.limit, filters.offset)
        .all<WebhookDeliveryRow>();
      const counted = await db
        .prepare(`SELECT COUNT(*) AS n FROM webhook_deliveries WHERE ${where}`)
        .bind(...binds)
        .first<{ n: number }>();
      const repos = await db
        .prepare(
          `SELECT DISTINCT repository_full_name AS name FROM webhook_deliveries
           WHERE bot_id = ? AND repository_full_name IS NOT NULL
           ORDER BY repository_full_name`,
        )
        .bind(appId)
        .all<{ name: string }>();
      const types = await db
        .prepare(
          `SELECT DISTINCT event_name AS name FROM webhook_deliveries
           WHERE bot_id = ? AND event_name IS NOT NULL
           ORDER BY event_name`,
        )
        .bind(appId)
        .all<{ name: string }>();
      return {
        rows: page.results,
        total: counted?.n ?? 0,
        repos: repos.results.map((row) => row.name),
        types: types.results.map((row) => row.name),
      };
    },

    async upsertPullRequest(input: UpsertPullRequestInput): Promise<void> {
      if (typeof input.targetId !== "string" || input.targetId === "") {
        throw new Error("upsertPullRequest: targetId is required — the ledger key is (target_id, owner, repo, pr_number)");
      }
      const seenAt = normalizeRfc3339(input.updatedAt) ?? null;
      const headAt = input.headSha === undefined || input.headSha === null ? null : seenAt;
      await db
        .prepare(
          `INSERT INTO pull_requests
             (id, bot_id, target_id, owner, repo, pr_number, title, state, head_sha, head_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(datetime(?), datetime('now')))
           ON CONFLICT (target_id, owner, repo, pr_number) DO UPDATE SET
             title = COALESCE(excluded.title, title),
             state = CASE
               WHEN pull_requests.state = 'merged' THEN 'merged'
               WHEN excluded.last_seen_at >= pull_requests.last_seen_at THEN excluded.state
               ELSE pull_requests.state
             END,
             head_sha = CASE
               WHEN excluded.head_at IS NULL THEN COALESCE(head_sha, excluded.head_sha)
               WHEN head_at IS NULL OR excluded.head_at >= head_at THEN excluded.head_sha
               ELSE head_sha
             END,
             head_at = CASE
               WHEN excluded.head_at IS NULL THEN head_at
               WHEN head_at IS NULL OR excluded.head_at >= head_at THEN excluded.head_at
               ELSE head_at
             END,
             last_seen_at = MAX(last_seen_at, excluded.last_seen_at)`,
        )
        .bind(
          crypto.randomUUID(),
          input.appId,
          input.targetId,
          input.owner,
          input.repo,
          input.prNumber,
          input.title ?? null,
          input.state,
          input.headSha ?? null,
          headAt,
          seenAt,
        )
        .run();
    },

    async selectPrHead(input: {
      targetId: string;
      owner: string;
      repo: string;
      prNumber: number;
    }): Promise<{ headSha: string | null; headAt: string | null } | null> {
      const row = await db
        .prepare(
          `SELECT head_sha, head_at FROM pull_requests
           WHERE target_id = ? AND owner = ? AND repo = ? AND pr_number = ?`,
        )
        .bind(input.targetId, input.owner, input.repo, input.prNumber)
        .first<{ head_sha: string | null; head_at: string | null }>();
      return row === null ? null : { headSha: row.head_sha, headAt: row.head_at };
    },

    async listPullRequests(
      scope: LedgerScope,
      filter?: { owner: string; repo: string },
    ): Promise<{ rows: PullRequestRow[]; repos: string[] }> {
      const repoPredicate = filter === undefined ? "" : PULL_REQUEST_REPO_PREDICATE;
      const scopeBinds = ledgerScopeBinds(scope);
      const window = pullRequestWindowSql(repoPredicate, scope);
      const windowBinds = [
        ...scopeBinds,
        ...(filter === undefined ? [] : [filter.owner, filter.repo]),
        PULL_REQUEST_LIST_LIMIT,
      ];
      const [results, locks] = await Promise.all([
        db.batch([
          db
            .prepare(
              `SELECT owner, repo, pr_number, title, state, head_sha, first_seen_at, last_seen_at
               FROM pull_requests WHERE ${ledgerScopeSql("pull_requests", scope)}${repoPredicate}
               ORDER BY ${PULL_REQUEST_LEDGER_ORDER}
               LIMIT ?`,
            )
            .bind(...windowBinds),
          db
            .prepare(
              `SELECT owner, repo, pr_number, verdict, reviewed_at FROM (
                 SELECT owner, repo, pr_number, verdict, reviewed_at,
                        ROW_NUMBER() OVER (PARTITION BY owner, repo, pr_number
                          ORDER BY reviewed_at DESC, rowid DESC) AS rn
                 FROM reviews r
                 WHERE ${ledgerScopeSql("r", scope)}
                   AND (owner, repo, pr_number) IN (${window})
               ) WHERE rn = 1`,
            )
            .bind(...scopeBinds, ...windowBinds),
          db
            .prepare(
              `SELECT f.owner, f.repo, f.pr_number, COUNT(*) AS n
               FROM review_failures f
               WHERE ${ledgerScopeSql("f", scope)}
                 AND f.stage NOT IN (${sqlStageList(ATTRIBUTION_EXCLUDED_STAGES)})
                 AND (f.owner, f.repo, f.pr_number) IN (${window})
               GROUP BY f.owner, f.repo, f.pr_number`,
            )
            .bind(...scopeBinds, ...windowBinds),
          db
            .prepare(
              `SELECT DISTINCT owner, repo FROM pull_requests
               WHERE ${ledgerScopeSql("pull_requests", scope)}
               ORDER BY owner, repo`,
            )
            .bind(...scopeBinds),
        ]),
        liveReviewLocks(scope.workspaceId),
      ]);
      return {
        rows: assemblePullRequests(
          results[0]!.results as PullRequestBaseRow[],
          results[1]!.results as PullRequestReviewRow[],
          results[2]!.results as PullRequestFailureCountRow[],
          locks,
        ),
        repos: (results[3]!.results as Array<{ owner: string; repo: string }>).map(
          (row) => `${row.owner}/${row.repo}`,
        ),
      };
    },

    async getPullRequestHead(
      scope: LedgerScope,
      owner: string,
      repo: string,
      prNumber: number,
    ): Promise<PullRequestHeadRow | null> {
      const scopeBinds = ledgerScopeBinds(scope);
      const [results, locks] = await Promise.all([
        db.batch([
          db
            .prepare(
              `SELECT owner, repo, pr_number, title, state, head_sha, first_seen_at, last_seen_at
               FROM pull_requests p WHERE ${ledgerScopeSql("p", scope)} AND p.owner = ? AND p.repo = ? AND p.pr_number = ?`,
            )
            .bind(...scopeBinds, owner, repo, prNumber),
          db
            .prepare(
              `SELECT verdict, model, provider, reviewed_at, head_sha FROM reviews r
               WHERE ${ledgerScopeSql("r", scope)} AND r.owner = ? AND r.repo = ? AND r.pr_number = ?
               ORDER BY reviewed_at DESC, rowid DESC LIMIT 1`,
            )
            .bind(...scopeBinds, owner, repo, prNumber),
        ]),
        liveReviewLocks(scope.workspaceId),
      ]);
      const row = results[0]!.results[0] as PullRequestBaseRow | undefined;
      if (row === undefined) return null;
      return {
        ...row,
        latest_review:
          (results[1]!.results[0] as PullRequestHeadRow["latest_review"] | undefined) ?? null,
        reviewing: reviewingOf(locks, owner, repo, prNumber),
      };
    },

    async countPullRequestRecords(
      scope: LedgerScope,
      owner: string,
      repo: string,
      prNumber: number,
    ): Promise<PullRequestRecordCounts> {
      const scopeBinds = ledgerScopeBinds(scope);
      const results = await db.batch([
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM review_findings rf
             WHERE ${ledgerScopeSql("rf", scope)}
               AND rf.owner = ? AND rf.repo = ? AND rf.pr_number = ? AND rf.state = 'open'`,
          )
          .bind(...scopeBinds, owner, repo, prNumber),
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM reviews r
             WHERE ${ledgerScopeSql("r", scope)} AND r.owner = ? AND r.repo = ? AND r.pr_number = ?`,
          )
          .bind(...scopeBinds, owner, repo, prNumber),
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM review_failures f
             WHERE ${ledgerScopeSql("f", scope)}
               AND f.stage NOT IN (${sqlStageList(ATTRIBUTION_EXCLUDED_STAGES)})
               AND f.owner = ? AND f.repo = ? AND f.pr_number = ?`,
          )
          .bind(...scopeBinds, owner, repo, prNumber),
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM review_findings rf
             WHERE ${ledgerScopeSql("rf", scope)}
               AND rf.owner = ? AND rf.repo = ? AND rf.pr_number = ? AND rf.state = 'open'
               AND json_extract(rf.original_json, '$.mergeClass') = ?`,
          )
          .bind(...scopeBinds, owner, repo, prNumber, MUST_FIX_SEVERITY),
      ]);
      return {
        findings: countOf(results[0]!),
        reviews: countOf(results[1]!),
        failures: countOf(results[2]!),
        must_fix: countOf(results[3]!),
      };
    },

    async listPullRequestFindings(
      scope: LedgerScope,
      owner: string,
      repo: string,
      prNumber: number,
      page: PullRequestPageRequest,
    ): Promise<PullRequestRecordPage<PullRequestFindingRow> | null> {
      const unclassified = page.unclassified === true;
      const filter = unclassified
        ? ` AND (json_extract(rf.original_json, '$.mergeClass') IS NULL
                 OR json_extract(rf.original_json, '$.mergeClass') NOT IN (${FINDING_SEVERITIES.map(() => "?").join(", ")}))`
        : page.severity === undefined || page.severity === null
          ? ""
          : " AND json_extract(rf.original_json, '$.mergeClass') = ?";
      const filterBinds: string[] = unclassified
        ? [...FINDING_SEVERITIES]
        : page.severity === undefined || page.severity === null
          ? []
          : [page.severity];
      const scopeBinds = ledgerScopeBinds(scope);
      const results = await db.batch([
        db.prepare(pullRequestExistsSql(scope)).bind(...scopeBinds, owner, repo, prNumber),
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM review_findings rf
             WHERE ${ledgerScopeSql("rf", scope)}
               AND rf.owner = ? AND rf.repo = ? AND rf.pr_number = ? AND rf.state = 'open'${filter}`,
          )
          .bind(...scopeBinds, owner, repo, prNumber, ...filterBinds),
        db
          .prepare(
            `SELECT rf.finding_id,
                    json_extract(rf.original_json, '$.mergeClass') AS severity,
                    json_extract(rf.original_json, '$.title') AS title,
                    json_extract(rf.original_json, '$.filePath') AS file_path,
                    json_extract(rf.original_json, '$.lineStart') AS line,
                    json_extract(rf.original_json, '$.body') AS body,
                    rf.first_seen_round AS review_round
             FROM review_findings rf
             WHERE ${ledgerScopeSql("rf", scope)}
               AND rf.owner = ? AND rf.repo = ? AND rf.pr_number = ? AND rf.state = 'open'${filter}
             ORDER BY rf.rowid DESC
             LIMIT ? OFFSET ?`,
          )
          .bind(...scopeBinds, owner, repo, prNumber, ...filterBinds, page.limit, page.offset),
      ]);
      if (results[0]!.results.length === 0) return null;
      return {
        items: results[2]!.results as PullRequestFindingRow[],
        total: countOf(results[1]!),
      };
    },

    async listPullRequestReviews(
      scope: LedgerScope,
      owner: string,
      repo: string,
      prNumber: number,
      page: PullRequestPageRequest,
    ): Promise<PullRequestRecordPage<PullRequestReviewDetailRow> | null> {
      const scopeBinds = ledgerScopeBinds(scope);
      const results = await db.batch([
        db.prepare(pullRequestExistsSql(scope)).bind(...scopeBinds, owner, repo, prNumber),
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM reviews r
             WHERE ${ledgerScopeSql("r", scope)} AND r.owner = ? AND r.repo = ? AND r.pr_number = ?`,
          )
          .bind(...scopeBinds, owner, repo, prNumber),
        db
          .prepare(
            `SELECT x.verdict, x.model, x.provider, x.reviewed_at, x.head_sha,
                    x.round, x.duration_ms,
                    (SELECT json_group_object(f.severity, f.n)
                       FROM (SELECT severity, COUNT(*) AS n FROM findings
                              WHERE review_id = x.id GROUP BY severity) f) AS severity_counts
             FROM (SELECT r.id, r.rowid AS rid, r.verdict, r.model, r.provider, r.reviewed_at,
                          r.head_sha, r.duration_ms,
                          COALESCE(
                            r.round,
                            ROW_NUMBER() OVER (ORDER BY r.reviewed_at ASC, r.rowid ASC)
                          ) AS round
                   FROM reviews r
                   WHERE ${ledgerScopeSql("r", scope)} AND r.owner = ? AND r.repo = ? AND r.pr_number = ?) x
             ORDER BY x.reviewed_at DESC, x.rid DESC
             LIMIT ? OFFSET ?`,
          )
          .bind(...scopeBinds, owner, repo, prNumber, page.limit, page.offset),
      ]);
      if (results[0]!.results.length === 0) return null;
      return {
        items: results[2]!.results as PullRequestReviewDetailRow[],
        total: countOf(results[1]!),
      };
    },

    async listPullRequestFailures(
      scope: LedgerScope,
      owner: string,
      repo: string,
      prNumber: number,
      page: PullRequestPageRequest,
    ): Promise<PullRequestRecordPage<PullRequestFailureDetailRow> | null> {
      const scopeBinds = ledgerScopeBinds(scope);
      const results = await db.batch([
        db.prepare(pullRequestExistsSql(scope)).bind(...scopeBinds, owner, repo, prNumber),
        db
          .prepare(
            `SELECT COUNT(*) AS n
             FROM review_failures f
             WHERE ${ledgerScopeSql("f", scope)}
               AND f.stage NOT IN (${sqlStageList(ATTRIBUTION_EXCLUDED_STAGES)})
               AND f.owner = ? AND f.repo = ? AND f.pr_number = ?`,
          )
          .bind(...scopeBinds, owner, repo, prNumber),
        db
          .prepare(
            `SELECT f.stage, f.error, f.created_at
             FROM review_failures f
             WHERE ${ledgerScopeSql("f", scope)}
               AND f.stage NOT IN (${sqlStageList(ATTRIBUTION_EXCLUDED_STAGES)})
               AND f.owner = ? AND f.repo = ? AND f.pr_number = ?
             ORDER BY f.created_at DESC, f.rowid DESC
             LIMIT ? OFFSET ?`,
          )
          .bind(...scopeBinds, owner, repo, prNumber, page.limit, page.offset),
      ]);
      if (results[0]!.results.length === 0) return null;
      return {
        items: results[2]!.results as PullRequestFailureDetailRow[],
        total: countOf(results[1]!),
      };
    },
  };
}


/** A bot's scope: `owned` serves its workspace only, `shared` is offered platform-wide. */
export type BotScope = "owned" | "shared";

/**
 * The scope transition's outcome. Refusals are VALUES, not thrown strings: the
 * route maps each one to its frozen status/body pair and never parses a message.
 */
export type BotScopeOutcome =
  | { outcome: "ok"; scope: BotScope; sharedAt: string | null }
  | { outcome: "bot_not_found" }
  | { outcome: "outside_official_workspace" }
  | { outcome: "confirm_required" };

/** One live bot as the operator console lists it (contract § 8.3). */
export type BotScopeRow = {
  id: string;
  name: string;
  github_app_id: number;
  workspace_id: string | null;
  scope: BotScope;
  shared_at: string | null;
  deleted_at: string | null;
  workspace_name: string | null;
  is_official: number;
  installation_count: number;
  live_target_count: number;
};

const BOT_SCOPE_READ_SQL = `
  SELECT scope, shared_at FROM review_bots WHERE id = ? AND deleted_at IS NULL`;

const BOT_SCOPE_LIST_SQL = `
  SELECT b.id, b.name, b.github_app_id, w.workspace_id, b.scope, b.shared_at, b.deleted_at,
         ws.name AS workspace_name,
         EXISTS (SELECT 1
                   FROM review_runtime_settings s
                   JOIN workspaces live ON live.id = s.value AND live.deleted_at IS NULL
                  WHERE s.key = '${OFFICIAL_WORKSPACE_KEY}' AND s.value = w.workspace_id) AS is_official,
         (SELECT COUNT(*) FROM bot_installations i
           WHERE i.bot_id = b.id AND i.removed_at IS NULL) AS installation_count,
         (SELECT COUNT(*) FROM review_targets t
           WHERE t.bot_id = b.id AND t.deleted_at IS NULL) AS live_target_count
    FROM review_bots b
    LEFT JOIN bot_workspaces w ON w.bot_id = b.id
    LEFT JOIN workspaces ws ON ws.id = w.workspace_id
   WHERE b.deleted_at IS NULL
   ORDER BY b.name, b.id`;

const officialWorkspaceGuardSql = (botIdRef: string) => `EXISTS (
           SELECT 1 FROM bot_workspaces w
             JOIN review_runtime_settings s
               ON s.key = '${OFFICIAL_WORKSPACE_KEY}' AND s.value = w.workspace_id
             JOIN workspaces ws ON ws.id = w.workspace_id AND ws.deleted_at IS NULL
            WHERE w.bot_id = ${botIdRef})`;

const BOT_SCOPE_SHARE_AUDIT_SQL = `
  INSERT INTO platform_audit_events
    (id, actor_login, action, target_type, target_id, detail_json, created_at)
  SELECT ?1, ?2, 'runtime.bot_scope.set', 'bot', ?3,
         json_object(
           'before', json_object('scope', (SELECT scope FROM review_bots WHERE id = ?3),
                                 'shared_at', (SELECT shared_at FROM review_bots WHERE id = ?3)),
           'after', json_object('scope', 'shared', 'shared_at', ?4)),
         ?5
   WHERE EXISTS (SELECT 1 FROM review_bots b
                  WHERE b.id = ?3 AND b.deleted_at IS NULL AND b.scope <> 'shared'
                    AND ${officialWorkspaceGuardSql("b.id")})`;

const BOT_SCOPE_SHARE_SQL = `
  UPDATE review_bots SET scope = 'shared', shared_at = ?2
   WHERE id = ?1 AND deleted_at IS NULL AND scope <> 'shared'
     AND ${officialWorkspaceGuardSql("review_bots.id")}`;

const BOT_SCOPE_UNSHARE_AUDIT_SQL = `
  INSERT INTO platform_audit_events
    (id, actor_login, action, target_type, target_id, detail_json, created_at)
  SELECT ?1, ?2, 'runtime.bot_scope.set', 'bot', ?3,
         json_object(
           'before', json_object('scope', (SELECT scope FROM review_bots WHERE id = ?3),
                                 'shared_at', (SELECT shared_at FROM review_bots WHERE id = ?3)),
           'after', json_object('scope', 'owned', 'shared_at', NULL)),
         ?4
   WHERE EXISTS (SELECT 1 FROM review_bots b
                  WHERE b.id = ?3 AND b.deleted_at IS NULL AND b.scope <> 'owned')`;

const BOT_SCOPE_UNSHARE_SQL = `
  UPDATE review_bots SET scope = 'owned', shared_at = NULL
   WHERE id = ?1 AND deleted_at IS NULL AND scope <> 'owned'`;

/**
 * Move one bot between `owned` and `shared`, auditing accepted writes in the
 * same batch. A same-value transition is a no-op that appends nothing;
 * `shared → owned` needs an explicit `confirm: true`; `owned → shared` needs the
 * bot's workspace to BE the official workspace. Unsharing ignores that last
 * condition on purpose (a stale share stays revocable).
 */
export async function setBotScope(
  db: AppsStoreD1,
  input: { botId: string; scope: BotScope; confirm?: boolean; actor: string; now: string },
): Promise<BotScopeOutcome> {
  const { botId, scope, actor, now } = input;
  const current = await db
    .prepare(BOT_SCOPE_READ_SQL)
    .bind(botId)
    .first<{ scope: BotScope; shared_at: string | null }>();
  if (!current) return { outcome: "bot_not_found" };
  if (current.scope === scope) return { outcome: "ok", scope, sharedAt: current.shared_at };
  if (scope === "owned" && input.confirm !== true) return { outcome: "confirm_required" };

  const [, write] =
    scope === "shared"
      ? await db.batch([
          db
            .prepare(BOT_SCOPE_SHARE_AUDIT_SQL)
            .bind(crypto.randomUUID(), actor, botId, now, now),
          db.prepare(BOT_SCOPE_SHARE_SQL).bind(botId, now),
        ])
      : await db.batch([
          db.prepare(BOT_SCOPE_UNSHARE_AUDIT_SQL).bind(crypto.randomUUID(), actor, botId, now),
          db.prepare(BOT_SCOPE_UNSHARE_SQL).bind(botId),
        ]);

  if ((write?.meta.changes ?? 0) > 0) {
    return { outcome: "ok", scope, sharedAt: scope === "shared" ? now : null };
  }

  const persisted = await db
    .prepare(BOT_SCOPE_READ_SQL)
    .bind(botId)
    .first<{ scope: BotScope; shared_at: string | null }>();
  if (persisted === null) return { outcome: "bot_not_found" };
  if (persisted.scope === scope) return { outcome: "ok", scope, sharedAt: persisted.shared_at };
  return { outcome: "outside_official_workspace" };
}

/**
 * Every live bot with its scope and the columns only the console needs
 * (workspace name, the official-workspace flag, live installation and target
 * counts) — name-ordered, one statement.
 */
export async function listBotScopes(db: AppsStoreD1): Promise<BotScopeRow[]> {
  const res = await db.prepare(BOT_SCOPE_LIST_SQL).all<BotScopeRow>();
  return res.results;
}

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
  review_round: number;
};

/** One `reviews` row as the detail face reads it — nullable columns honest. */
export type PullRequestReviewDetailRow = {
  verdict: string;
  model: string | null;
  provider: string | null;
  reviewed_at: string;
  head_sha: string;
  round: number;
  duration_ms: number | null;
  severity_counts: string;
};

export type PullRequestFailureDetailRow = { stage: string; error: string; created_at: string };

/**
 * The detail head: the ledger row plus its newest review (whole row, nullable)
 * — the header's authoritative verdict and attribution — and the D11
 * live-inflight projection. The head read is ONE row plus one lookup, so it
 * carries the review columns alone: the round ordinal/findings tally belong
 * to the paged reviews section.
 */
export type PullRequestHeadRow = PullRequestBaseRow & {
  latest_review: Omit<PullRequestReviewDetailRow, "round" | "duration_ms" | "severity_counts"> | null;
  reviewing: PullRequestReviewing;
};

type PullRequestLockRow = {
  owner: string;
  repo: string;
  pr_number: number;
  head_sha: string;
  acquired_at: string;
};

function pullRequestKey(owner: string, repo: string, prNumber: number): string {
  return `${owner.toLowerCase()}\u0000${repo.toLowerCase()}\u0000${prNumber}`;
}

function reviewingOf(
  locks: Map<string, PullRequestLockRow> | null,
  owner: string,
  repo: string,
  prNumber: number,
): PullRequestReviewing {
  if (locks === null) return { state: "unknown" };
  const lock = locks.get(pullRequestKey(owner, repo, prNumber));
  return lock === undefined
    ? { state: "none" }
    : { state: "live", head_sha: lock.head_sha, acquired_at: lock.acquired_at };
}

/**
 * The record totals (the detail payload's `counts`), plus the PR's own
 * must-fix tally — the family dot's source, independent of any severity filter
 * or loaded page.
 */
export type PullRequestRecordCounts = {
  findings: number;
  reviews: number;
  failures: number;
  must_fix: number;
};

/** One record section's page request — the route validates the bounds before this. */
export type PullRequestPageRequest = {
  offset: number;
  limit: number;
  severity?: string | null;
  unclassified?: boolean;
};

/** One record section's page: the rows plus the total the pager counts against. */
export type PullRequestRecordPage<T> = { items: T[]; total: number };

function assemblePullRequests(
  rows: PullRequestBaseRow[],
  reviews: PullRequestReviewRow[],
  failures: PullRequestFailureCountRow[],
  locks: Map<string, PullRequestLockRow> | null,
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
      reviewing: reviewingOf(locks, row.owner, row.repo, row.pr_number),
    };
  });
}
