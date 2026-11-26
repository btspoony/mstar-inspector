import { ATTRIBUTION_EXCLUDED_STAGES, sqlStageList } from "../contracts/failure-stages";
import { normalizeRfc3339 } from "../contracts/rfc3339";
import { FINDING_SEVERITIES, MUST_FIX_SEVERITY } from "../contracts/finding-severity";
import { getSandboxImage } from "../contracts/sandbox-images";
import { OFFICIAL_WORKSPACE_KEY } from "./runtime-config-store";

/** A row of `github_apps` (D1 column names, snake_case; migrations 0004/0036). */
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
  created_at: string;
  updated_at: string;
  scope: BotScope;
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
 * A bot-scoped read (SCOPED_BOT_SQL / VISIBLE_BOT_SQL): the BOT's own columns
 * and nothing else. D5/D34 — no App owns a bot: authorization reads
 * `workspace_id` and the bot's own `scope`, never a same-id App row. App
 * fields a surface needs (the mount list) arrive with `install-state-chain`
 * reading `app_install_bots`; until then the mount list is empty.
 */
export type BotScopedRow = {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  scope: BotScope;
  shared_at: string | null;
  sandbox_image_id: string;
  multiplier: number;
  monthly_rp: number | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

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
 * A `github_app_installations` row as the settings health panel reads it
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
 * claim a job, nor `paused`, which would blame a switch that is on),
 * `refused` = verified and classified as a job, then refused at acceptance
 * by a platform gate (200, zero enqueue — `rejected` would claim an HTTP
 * refusal the sender saw as 200).
 * Enforced producer-side: an off-vocabulary outcome throws BEFORE
 * any row is written; the schema has no CHECK (0010 precedent).
 */
export const DELIVERY_OUTCOMES: readonly string[] = Object.freeze([
  "ok",
  "paused",
  "ignored",
  "rejected",
  "skipped",
  "refused",
]);

export type DeliveryOutcome =
  | "ok"
  | "paused"
  | "ignored"
  | "rejected"
  | "skipped"
  | "refused";

/**
 * The verdict tier the dashboard's ordered delivery reads rank on; the
 * expression is migrations/0113_delivery_health_index_refused.sql's index
 * expression byte-for-byte: change both, never one (a drifted index is a
 * silent temp-B-tree, not an error).
 */
const DELIVERY_VERDICT_TIER_SQL = `CASE WHEN outcome IN ('ok', 'paused', 'rejected', 'refused') THEN 0 ELSE 1 END`;

/**
 * Restricts `webhook_deliveries` rows to repositories the bound workspace has a
 * live target for on the same bot. A workspace that does not own a shared bot
 * reads only its own repositories' deliveries; rows without a repository
 * (installation, ping) belong to the owner alone. One `?`: the workspace id.
 */
/** D1 caps a statement at 100 bound parameters; one id per bot plus the optional workspace id. */
const DELIVERY_SUMMARY_CHUNK = 90;

const DELIVERY_WORKSPACE_REPO_SQL = `EXISTS (SELECT 1 FROM review_targets t
  WHERE t.app_id = webhook_deliveries.app_id AND t.workspace_id = ? AND t.deleted_at IS NULL
    AND t.repo_owner IS NOT NULL AND t.repo_name IS NOT NULL
    AND webhook_deliveries.repository_full_name = (t.repo_owner || '/' || t.repo_name) COLLATE NOCASE)`;

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
 * Ledger retention, read from the operator sweep settings: TERMINAL rows
 * (`closed` / `merged`) whose last activity is older than `days` are swept, at
 * most `cap` per run. Open PRs are never swept — a PR that is still open is
 * still a live review target, however old — which is why the predicate keys on
 * `state`, not age alone.
 */
export type PullRequestRetention = { days: number; cap: number };

const PULL_REQUEST_LEDGER_ORDER = "last_seen_at DESC, pr_number DESC";

const PULL_REQUEST_REPO_PREDICATE = " AND owner = ? AND repo = ?";

/**
 * The current-head failure predicate, appended to every failure count the
 * dashboard reports and to the failures page unless it asks for history: a
 * `review_failures` row is attributed to the PR's CURRENT head only when its
 * own `head_sha` equals the head recorded on the same-target ledger row.
 * Empty-head rule: a row with `head_sha = ''` names no head, so it is never
 * attributed to a head — the `<> ''` half excludes it even when the PR's own
 * head_sha is NULL or empty. A NULL ledger head compares false and also
 * matches nothing. Correlation runs through `target_id` (the ledger key), so
 * a same-named PR on a different target's head cannot leak in.
 */
const PULL_REQUEST_HEAD_FAILURE_SQL = `AND f.head_sha <> '' AND f.head_sha = (
    SELECT p.head_sha FROM pull_requests p
    WHERE p.target_id = f.target_id AND p.owner = f.owner AND p.repo = f.repo AND p.pr_number = f.pr_number)`;

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
  app_id: string;
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
  getAppById: `SELECT g.*, w.workspace_id FROM github_apps g INNER JOIN app_workspaces w ON w.app_id = g.id INNER JOIN workspaces ws ON ws.id = w.workspace_id AND ws.deleted_at IS NULL WHERE g.id = ?`,
  getAppForWebhook: `SELECT g.*, w.workspace_id FROM github_apps g INNER JOIN app_workspaces w ON w.app_id = g.id INNER JOIN workspaces ws ON ws.id = w.workspace_id AND ws.deleted_at IS NULL WHERE g.id = ? AND w.workspace_id = ?`,
  getAppByGithubId: `SELECT g.*, w.workspace_id FROM github_apps g INNER JOIN app_workspaces w ON w.app_id = g.id INNER JOIN workspaces ws ON ws.id = w.workspace_id AND ws.deleted_at IS NULL WHERE g.github_app_id = ?`,
  listApps: `SELECT g.*, w.workspace_id FROM github_apps g INNER JOIN app_workspaces w ON w.app_id = g.id WHERE g.deleted_at IS NULL ORDER BY g.created_at DESC, g.id`,
} as const;

const SCOPED_APP_SQL = `SELECT g.*, w.workspace_id FROM github_apps g INNER JOIN app_workspaces w ON w.app_id = g.id INNER JOIN workspaces ws ON ws.id = w.workspace_id AND ws.deleted_at IS NULL WHERE g.github_app_id = ?1 AND g.deleted_at IS NULL AND (w.workspace_id = ?2 OR EXISTS (SELECT 1 FROM review_targets t WHERE t.app_id = g.id AND t.workspace_id = ?2 AND t.deleted_at IS NULL)) ORDER BY (w.workspace_id = ?2) DESC, w.workspace_id LIMIT 1`;

/**
 * The bot-scoped read faces: the BOT's own columns, authorized from its own
 * row. The owner is `review_bots.workspace_id` (D5/D34 — no App owns a bot);
 * a consumer workspace sees the bot through its own `scope = 'shared'` or a
 * live target it already holds on it. No App row is consulted: a bot without
 * a same-id App resolves the same, and a same-id App in another workspace
 * cannot shift the authorization. An all-digits id is rejected before any
 * query — it names the numeric App id space, never a bot (F1).
 */
const SCOPED_BOT_SQL = `SELECT r.* FROM review_bots r INNER JOIN workspaces ws ON ws.id = r.workspace_id AND ws.deleted_at IS NULL WHERE r.id = ?1 AND r.deleted_at IS NULL AND (r.workspace_id = ?2 OR EXISTS (SELECT 1 FROM review_targets t WHERE t.app_id = r.id AND t.workspace_id = ?2 AND t.deleted_at IS NULL)) LIMIT 1`;
const VISIBLE_BOT_SQL = `SELECT r.* FROM review_bots r INNER JOIN workspaces ws ON ws.id = r.workspace_id AND ws.deleted_at IS NULL WHERE r.id = ?1 AND r.deleted_at IS NULL AND (r.workspace_id = ?2 OR r.scope = 'shared') LIMIT 1`;

const UPSERT_INSTALLATION_SQL = {
  authoritative: `INSERT INTO github_app_installations (id, app_id, installation_id, account_login, seen_at)
    VALUES (?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f','now'))
    ON CONFLICT (app_id, installation_id) DO UPDATE SET
      account_login = COALESCE(excluded.account_login, account_login),
      seen_at = strftime('%Y-%m-%d %H:%M:%f','now'),
      removed_at = NULL`,
  inferred: `INSERT INTO github_app_installations (id, app_id, installation_id, account_login, seen_at)
    VALUES (?, ?, ?, ?, strftime('%Y-%m-%d %H:%M:%f','now'))
    ON CONFLICT (app_id, installation_id) DO UPDATE SET
      account_login = COALESCE(account_login, excluded.account_login),
      seen_at = strftime('%Y-%m-%d %H:%M:%f','now')`,
} as const;

/**
 * A row of `review_bots` (D1 column names, snake_case; the entity split,
 * migration 0115): the review configuration entity — model chains keyed beside
 * it, its sandbox image, its price multiplier and monthly quota. Bot
 * soft-delete is a product need (`deleted_at`), backfilled from the pre-split
 * row so the pair dies together.
 */
export type ReviewBotRow = {
  id: string;
  workspace_id: string;
  name: string;
  description: string | null;
  scope: BotScope;
  shared_at: string | null;
  sandbox_image_id: string;
  multiplier: number;
  monthly_rp: number | null;
  deleted_at: string | null;
  created_at: string;
  updated_at: string;
};

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

/**
 * One "Bots I can use" row (D6): the bot's own columns plus its providing
 * workspace's display name, so the list never needs a second lookup.
 */
export type UsableBotListRow = {
  id: string;
  name: string;
  description: string | null;
  workspace_id: string;
  workspace_name: string;
  scope: BotScope;
  shared_at: string | null;
  multiplier: number;
  monthly_rp: number | null;
};

/**
 * "Bots I can use" (D6/D18): the caller's own bots first, then shared ones —
 * name case-insensitively inside each group, the bot id as tie-break. Scoped
 * to the workspace in SQL, so no caller can widen it by dropping a filter.
 */
const USABLE_BOT_LIST_SQL = `
  SELECT r.id, r.name, r.description, r.workspace_id, r.scope, r.shared_at, r.multiplier, r.monthly_rp,
         ws.name AS workspace_name
    FROM review_bots r
    JOIN workspaces ws ON ws.id = r.workspace_id AND ws.deleted_at IS NULL
   WHERE r.deleted_at IS NULL AND (r.workspace_id = ?1 OR r.scope = 'shared')
   ORDER BY (r.workspace_id = ?1) DESC, LOWER(r.name) ASC, r.id ASC`;

const SHARED_BOT_LIST_SQL = `
  SELECT r.id, b.github_slug, r.name,
         (SELECT COUNT(*) FROM review_targets t
           WHERE t.app_id = r.id AND t.workspace_id = ?1 AND t.deleted_at IS NULL) AS target_count
    FROM review_bots r
    JOIN github_apps b ON b.id = r.id AND b.deleted_at IS NULL
   WHERE r.scope = 'shared' AND r.deleted_at IS NULL
   ORDER BY r.name, r.id`;

/** Create the github_apps / github_app_installations store over one D1 handle. */
export function createReviewBotsStore(db: AppsStoreD1) {
  async function sweepTerminalPullRequests({ days, cap }: PullRequestRetention): Promise<number> {
    // The state predicate must stay identical to idx_pull_requests_terminal_seen's WHERE (0099).
    const res = await db
      .prepare(
        `DELETE FROM pull_requests WHERE id IN (
           SELECT id FROM pull_requests
           WHERE state IN ('closed', 'merged')
             AND last_seen_at < datetime('now', ?)
           LIMIT ?
         )`,
      )
      .bind(`-${days} days`, cap)
      .run();
    return res.meta.changes;
  }

  /** True when the workspace has a live, named target on the bot; gates `DELIVERY_WORKSPACE_REPO_SQL` reads. */
  async function hasNamedTarget(appId: string, workspaceId: string): Promise<boolean> {
    const row = await db
      .prepare(
        `SELECT 1 AS hit FROM review_targets
         WHERE app_id = ? AND workspace_id = ? AND deleted_at IS NULL
           AND repo_owner IS NOT NULL AND repo_name IS NOT NULL
         LIMIT 1`,
      )
      .bind(appId, workspaceId)
      .first<{ hit: number }>();
    return row !== null;
  }

  /** `workspaceId` non-null scopes every summary to that workspace's target repositories. */
  async function deliverySummaries(
    appIds: string[],
    workspaceId: string | null = null,
  ): Promise<Record<string, DeliverySummary>> {
    if (appIds.length === 0) return {};
    if (appIds.length > DELIVERY_SUMMARY_CHUNK) {
      const chunks: string[][] = [];
      for (let at = 0; at < appIds.length; at += DELIVERY_SUMMARY_CHUNK) {
        chunks.push(appIds.slice(at, at + DELIVERY_SUMMARY_CHUNK));
      }
      const parts = await Promise.all(chunks.map((chunk) => deliverySummaries(chunk, workspaceId)));
      return Object.assign({}, ...parts);
    }
    const placeholders = appIds.map(() => "?").join(", ");
    const scopeSql = workspaceId === null ? "" : `AND ${DELIVERY_WORKSPACE_REPO_SQL}`;
    const scopeBinds = workspaceId === null ? [] : [workspaceId];
    const [latestRes, rejectedRes] = await Promise.all([
      db
        .prepare(
          `WITH requested(app_id) AS (VALUES ${appIds.map(() => "(?)").join(", ")})
           SELECT app_id, id, event_name, outcome, status_code, repository_full_name, created_at
           FROM webhook_deliveries WHERE rowid IN (
             SELECT (SELECT rowid FROM webhook_deliveries
                     WHERE app_id = requested.app_id ${scopeSql}
                     ORDER BY ${DELIVERY_VERDICT_TIER_SQL}, created_at DESC, rowid DESC
                     LIMIT 1)
             FROM requested
           )`,
        )
        .bind(...appIds, ...scopeBinds)
        .all<WebhookDeliveryRow>(),
      db
        .prepare(
          `SELECT app_id, COUNT(*) AS n FROM webhook_deliveries
           WHERE app_id IN (${placeholders}) AND outcome = 'rejected'
             AND created_at > datetime('now', '-24 hours') ${scopeSql}
           GROUP BY app_id`,
        )
        .bind(...appIds, ...scopeBinds)
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
      if (isAllDigitsId(id)) {
        throw new Error(
          "apps-store: createApp refuses an all-digits id — it could collide with a numeric GitHub App id at the route boundary",
        );
      }
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
                     FROM app_workspaces w
                     JOIN github_apps b ON b.id = w.app_id
                    WHERE w.workspace_id = ?8 AND b.deleted_at IS NULL) < ?9`;
      const results = await db.batch([
        db
          .prepare(
            `INSERT INTO github_apps
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
            `INSERT INTO app_workspaces (app_id, workspace_id)
             SELECT id, ?2 FROM github_apps WHERE id = ?1 AND changes() > 0`,
          )
          .bind(id, input.workspaceId),
        // Every App owns exactly one bot — the same id — the way the entity
        // split created the migrated rows. Owned scope pays its own keys, so
        // multiplier 1; a workspace flips the scope row later through the
        // share/unshare path, which owns the multiplier re-price.
        db
          .prepare(
            // The bot row follows the App row only when this call created it:
            // a retry of the same hold (App row already present) must not
            // duplicate the bot and trip its PRIMARY KEY.
            `INSERT INTO review_bots
               (id, workspace_id, name, multiplier, created_at, updated_at)
             SELECT id, ?2, name, 1, datetime('now'), datetime('now')
              FROM github_apps
             WHERE id = ?1 AND NOT EXISTS (SELECT 1 FROM review_bots b WHERE b.id = ?1)`,
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
      const row = await db.prepare(`SELECT * FROM github_apps WHERE id = ?`).bind(id).first<GithubAppRow>();
      if (!row) {
        throw new Error("apps-store: createApp row vanished on read-back");
      }
      return row;
    },

    async countLiveApps(workspaceId: string): Promise<number> {
      const row = await db
        .prepare(
          `SELECT COUNT(*) AS n
             FROM app_workspaces w
             JOIN github_apps b ON b.id = w.app_id
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

    async getScopedAppByGithubId(
      githubAppId: number,
      workspaceId: string,
    ): Promise<GithubAppTenantRow | null> {
      return db
        .prepare(SCOPED_APP_SQL)
        .bind(githubAppId, workspaceId)
        .first<GithubAppTenantRow>();
    },

    async getScopedBotById(botId: string, workspaceId: string): Promise<BotScopedRow | null> {
      if (isAllDigitsId(botId)) return null;
      return db.prepare(SCOPED_BOT_SQL).bind(botId, workspaceId).first<BotScopedRow>();
    },

    async getVisibleBotById(botId: string, workspaceId: string): Promise<BotScopedRow | null> {
      if (isAllDigitsId(botId)) return null;
      return db.prepare(VISIBLE_BOT_SQL).bind(botId, workspaceId).first<BotScopedRow>();
    },

    async listSharedBots(workspaceId: string): Promise<SharedBotRow[]> {
      const res = await db.prepare(SHARED_BOT_LIST_SQL).bind(workspaceId).all<SharedBotRow>();
      return res.results;
    },

    /**
     * Every bot the workspace may use, in the D18 order the page renders. The
     * store owns the `review_bots` read (tenant read-face allowlist), so the
     * dashboard handler never names the table.
     */
    async listUsableBots(workspaceId: string): Promise<UsableBotListRow[]> {
      const res = await db
        .prepare(USABLE_BOT_LIST_SQL)
        .bind(workspaceId)
        .all<UsableBotListRow>();
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
        .prepare(`SELECT sandbox_image_id FROM review_bots WHERE id = ? AND deleted_at IS NULL`)
        .bind(appId)
        .first<{ sandbox_image_id: string }>();
      return row?.sandbox_image_id ?? null;
    },

    async getBotScope(botId: string): Promise<BotScope | null> {
      const row = await db
        .prepare(`SELECT scope FROM review_bots WHERE id = ? AND deleted_at IS NULL`)
        .bind(botId)
        .first<{ scope: BotScope }>();
      return row?.scope ?? null;
    },

    async getGithubVisibility(appId: string): Promise<GithubVisibility | null> {
      const row = await db
        .prepare(`SELECT github_visibility FROM github_apps WHERE id = ?`)
        .bind(appId)
        .first<{ github_visibility: GithubVisibility | null }>();
      if (!row) return null;
      return row.github_visibility ?? "unknown";
    },

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

    async saveGithubVisibility(id: string, visibility: GithubVisibility): Promise<boolean> {
      const res = await db
        .prepare(
          `UPDATE github_apps SET github_visibility = ?
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
            `UPDATE github_apps SET deleted_at = datetime('now'), updated_at = datetime('now')
             WHERE id = ? AND deleted_at IS NULL`,
          )
          .bind(id),
        // The bot dies with its App: review configuration is meaningless for a
        // deleted App, and the migration backfills the pair's deleted_at
        // together, so the write keeps the invariant the schema started with.
        db
          .prepare(
            `UPDATE review_bots SET deleted_at = datetime('now'), updated_at = datetime('now')
             WHERE id = ? AND deleted_at IS NULL`,
          )
          .bind(id),
        db
          .prepare(
            `UPDATE review_targets SET deleted_at = datetime('now'), updated_at = datetime('now')
             WHERE app_id = ? AND deleted_at IS NULL`,
          )
          .bind(id),
      ]);
      return (botResult?.meta.changes ?? 0) > 0;
    },

    async touchLastWebhook(id: string): Promise<void> {
      await db
        .prepare(`UPDATE github_apps SET last_webhook_at = datetime('now') WHERE id = ?`)
        .bind(id)
        .run();
    },

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

    async touchGithubMetadataAttempt(id: string): Promise<void> {
      await db
        .prepare(
          `UPDATE github_apps SET github_metadata_attempted_at = datetime('now')
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
          `SELECT installation_id, account_login, seen_at FROM github_app_installations
           WHERE app_id = ? AND removed_at IS NULL ORDER BY seen_at DESC, installation_id`,
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
          `SELECT installation_id, account_login, seen_at FROM github_app_installations
           WHERE app_id = ? AND bound_workspace_id = ? AND removed_at IS NULL
           ORDER BY seen_at DESC, installation_id`,
        )
        .bind(appId, workspaceId)
        .all<AppInstallationRow>();
      return res.results;
    },

    /** The installation's live binding; a deleted workspace's binding reads as NULL. */
    async getInstallationBinding(
      appId: string,
      installationId: number,
    ): Promise<{ bound_workspace_id: string | null; removed_at: string | null } | null> {
      return db
        .prepare(
          `SELECT w.id AS bound_workspace_id, i.removed_at FROM github_app_installations i
             LEFT JOIN workspaces w ON w.id = i.bound_workspace_id AND w.deleted_at IS NULL
           WHERE i.app_id = ? AND i.installation_id = ?`,
        )
        .bind(appId, installationId)
        .first<{ bound_workspace_id: string | null; removed_at: string | null }>();
    },

    /**
     * Bind a live installation to a workspace. First binder wins: a row already
     * bound to another live workspace is never rebound here; a binding whose
     * workspace was deleted counts as unbound.
     */
    async bindInstallation(
      appId: string,
      installationId: number,
      workspaceId: string,
    ): Promise<BindInstallationOutcome> {
      const res = await db
        .prepare(
          `UPDATE github_app_installations SET bound_workspace_id = ?3
           WHERE app_id = ?1 AND installation_id = ?2 AND removed_at IS NULL
             AND (bound_workspace_id IS NULL OR bound_workspace_id = ?3
                  OR NOT EXISTS (SELECT 1 FROM workspaces w
                                  WHERE w.id = github_app_installations.bound_workspace_id AND w.deleted_at IS NULL))`,
        )
        .bind(appId, installationId, workspaceId)
        .run();
      if (res.meta.changes > 0) return "bound";
      const row = await db
        .prepare(`SELECT removed_at FROM github_app_installations WHERE app_id = ? AND installation_id = ?`)
        .bind(appId, installationId)
        .first<{ removed_at: string | null }>();
      return row !== null && row.removed_at === null ? "bound_elsewhere" : "unknown";
    },

    async listPendingInstallations(appId: string, workspaceId: string): Promise<AppInstallationRow[]> {
      const res = await db
        .prepare(
          `SELECT i.installation_id, i.account_login, i.seen_at FROM github_app_installations i
             JOIN github_apps b ON b.id = i.app_id
            WHERE i.app_id = ?1 AND i.removed_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM workspaces bw
                               WHERE bw.id = i.bound_workspace_id AND bw.deleted_at IS NULL)
              AND (b.scope = 'shared'
                   OR EXISTS (SELECT 1 FROM app_workspaces w
                               WHERE w.app_id = b.id AND w.workspace_id = ?2))
            ORDER BY i.seen_at DESC, i.installation_id`,
        )
        .bind(appId, workspaceId)
        .all<AppInstallationRow>();
      return res.results;
    },

    /**
     * Every unbound live installation of an App the workspace may install
     * through (its own, or a shared one) — the installed tab's "Waiting to be
     * bound" rows, each carrying its App row id so the UI can name the App.
     */
    async listWorkspacePendingInstallations(
      workspaceId: string,
    ): Promise<Array<AppInstallationRow & { app_id: string }>> {
      const res = await db
        .prepare(
          `SELECT i.installation_id, i.account_login, i.seen_at, i.app_id FROM github_app_installations i
             JOIN github_apps b ON b.id = i.app_id AND b.deleted_at IS NULL
            WHERE i.removed_at IS NULL
              AND NOT EXISTS (SELECT 1 FROM workspaces bw
                               WHERE bw.id = i.bound_workspace_id AND bw.deleted_at IS NULL)
              AND (b.scope = 'shared'
                   OR EXISTS (SELECT 1 FROM app_workspaces w
                               WHERE w.app_id = b.id AND w.workspace_id = ?1))
            ORDER BY i.seen_at DESC, i.installation_id`,
        )
        .bind(workspaceId)
        .all<AppInstallationRow & { app_id: string }>();
      return res.results;
    },

    async getInstallation(
      appId: string,
      installationId: number,
    ): Promise<AppInstallationState | null> {
      return db
        .prepare(
          `SELECT installation_id, account_login, removed_at FROM github_app_installations
           WHERE app_id = ? AND installation_id = ?`,
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
          `UPDATE github_app_installations SET removed_at = strftime('%Y-%m-%d %H:%M:%f','now')
           WHERE app_id = ? AND installation_id = ?`,
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
             UPDATE github_app_installations SET removed_at = strftime('%Y-%m-%d %H:%M:%f','now')
             WHERE app_id = ?
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
             UPDATE github_app_installations SET removed_at = NULL
             WHERE app_id = ?
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
          `INSERT INTO webhook_deliveries (id, app_id, event_name, outcome, status_code, repository_full_name, reason)
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

    /**
     * `workspaceId` non-null scopes the summary to that workspace's target
     * repositories (`DELIVERY_WORKSPACE_REPO_SQL`); null reads the whole App.
     */
    async deliverySummary(appId: string, workspaceId: string | null = null): Promise<DeliverySummary> {
      if (workspaceId === null) return (await deliverySummaries([appId]))[appId]!;
      if (!(await hasNamedTarget(appId, workspaceId))) return { latest: null, rejected24h: 0 };
      const latest = await db
        .prepare(
          `SELECT * FROM webhook_deliveries
           WHERE app_id = ? AND ${DELIVERY_WORKSPACE_REPO_SQL}
           ORDER BY ${DELIVERY_VERDICT_TIER_SQL}, created_at DESC, rowid DESC
           LIMIT 1`,
        )
        .bind(appId, workspaceId)
        .first<WebhookDeliveryRow>();
      const rejected = await db
        .prepare(
          `SELECT COUNT(*) AS n FROM webhook_deliveries
           WHERE app_id = ? AND outcome = 'rejected'
             AND created_at > datetime('now', '-24 hours')
             AND ${DELIVERY_WORKSPACE_REPO_SQL}`,
        )
        .bind(appId, workspaceId)
        .first<{ n: number }>();
      return { latest: latest ?? null, rejected24h: rejected?.n ?? 0 };
    },

    deliverySummaries,

    sweepTerminalPullRequests,

    /**
     * `workspaceId` non-null scopes rows, `total`, `repos` and `types` to that
     * workspace's target repositories (`DELIVERY_WORKSPACE_REPO_SQL`); null
     * reads the whole App.
     */
    async listDeliveries(
      appId: string,
      filters: DeliveryFilters,
      workspaceId: string | null = null,
    ): Promise<DeliveryPage> {
      if (workspaceId !== null && !(await hasNamedTarget(appId, workspaceId))) {
        return { rows: [], total: 0, repos: [], types: [] };
      }
      const scopePredicates = ["app_id = ?"];
      const scopeBinds: string[] = [appId];
      if (workspaceId !== null) {
        scopePredicates.push(DELIVERY_WORKSPACE_REPO_SQL);
        scopeBinds.push(workspaceId);
      }
      const scopeWhere = scopePredicates.join(" AND ");
      const predicates = [...scopePredicates];
      const binds: (string | number)[] = [...scopeBinds];
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
           WHERE ${scopeWhere} AND repository_full_name IS NOT NULL
           ORDER BY repository_full_name`,
        )
        .bind(...scopeBinds)
        .all<{ name: string }>();
      const types = await db
        .prepare(
          `SELECT DISTINCT event_name AS name FROM webhook_deliveries
           WHERE ${scopeWhere} AND event_name IS NOT NULL
           ORDER BY event_name`,
        )
        .bind(...scopeBinds)
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
             (id, app_id, target_id, owner, repo, pr_number, title, state, head_sha, head_at, last_seen_at)
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
                 ${PULL_REQUEST_HEAD_FAILURE_SQL}
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
               ${PULL_REQUEST_HEAD_FAILURE_SQL}
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
      // `page.history === true` is the failures tab's all-history scope: no
      // head predicate at all, so rows the count already excludes — old heads
      // and empty-head rows alike — stay reachable. Any other value is the
      // default current-head scope.
      const headPredicate = page.history === true ? "" : ` ${PULL_REQUEST_HEAD_FAILURE_SQL}`;
      const scopeBinds = ledgerScopeBinds(scope);
      const results = await db.batch([
        db.prepare(pullRequestExistsSql(scope)).bind(...scopeBinds, owner, repo, prNumber),
        db
          .prepare(
            `SELECT COUNT(*) AS n
             FROM review_failures f
             WHERE ${ledgerScopeSql("f", scope)}
               AND f.stage NOT IN (${sqlStageList(ATTRIBUTION_EXCLUDED_STAGES)})${headPredicate}
               AND f.owner = ? AND f.repo = ? AND f.pr_number = ?`,
          )
          .bind(...scopeBinds, owner, repo, prNumber),
        db
          .prepare(
            `SELECT f.stage, f.error, f.message, f.error_code, f.track_id, f.created_at
             FROM review_failures f
             WHERE ${ledgerScopeSql("f", scope)}
               AND f.stage NOT IN (${sqlStageList(ATTRIBUTION_EXCLUDED_STAGES)})${headPredicate}
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


/**
 * The bot/App id disjointness rule (the split, task 4 F1): an App is
 * addressed on App routes by its numeric GitHub App id, so a row id that is
 * ALL DIGITS could collide with one. New rows therefore never get an
 * all-digit id — `createApp` is the only writer and rejects such an id; the
 * two route resolvers reject the wrong shape before any query (an all-digit
 * bot id and a non-digit App path segment both refuse, never fall back).
 * Migrated rows keep their inherited UUID ids, which satisfy the rule.
 */
export function isAllDigitsId(id: string): boolean {
  return /^[0-9]+$/.test(id);
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

/**
 * One live App/bot pair as the operator console lists it (contract § 8.3).
 * Post-split the two scopes are independent columns: `scope`/`shared_at` are
 * the APP's share switch (`github_apps` — who may act through these
 * credentials); `bot_scope`/`bot_shared_at` are the BOT's (`review_bots` —
 * whose workspaces may consume this review configuration).
 */
export type BotScopeRow = {
  id: string;
  name: string;
  github_app_id: number;
  workspace_id: string | null;
  scope: BotScope;
  shared_at: string | null;
  bot_scope: BotScope | null;
  bot_shared_at: string | null;
  deleted_at: string | null;
  workspace_name: string | null;
  is_official: number;
  installation_count: number;
  live_target_count: number;
};

const APP_SCOPE_READ_SQL = `
  SELECT scope, shared_at FROM github_apps WHERE id = ? AND deleted_at IS NULL`;

const REVIEW_BOT_SCOPE_READ_SQL = `
  SELECT scope, shared_at FROM review_bots WHERE id = ? AND deleted_at IS NULL`;

const BOT_SCOPE_LIST_SQL = `
  SELECT b.id, b.name, b.github_app_id, w.workspace_id, b.scope, b.shared_at, b.deleted_at,
         rb.scope AS bot_scope, rb.shared_at AS bot_shared_at,
         ws.name AS workspace_name,
         EXISTS (SELECT 1
                   FROM review_runtime_settings s
                   JOIN workspaces live ON live.id = s.value AND live.deleted_at IS NULL
                  WHERE s.key = '${OFFICIAL_WORKSPACE_KEY}' AND s.value = w.workspace_id) AS is_official,
         (SELECT COUNT(*) FROM github_app_installations i
           WHERE i.app_id = b.id AND i.removed_at IS NULL) AS installation_count,
         (SELECT COUNT(*) FROM review_targets t
           WHERE t.app_id = b.id AND t.deleted_at IS NULL) AS live_target_count
    FROM github_apps b
    LEFT JOIN review_bots rb ON rb.id = b.id
    LEFT JOIN app_workspaces w ON w.app_id = b.id
    LEFT JOIN workspaces ws ON ws.id = w.workspace_id
   WHERE b.deleted_at IS NULL
   ORDER BY b.name, b.id`;

const officialWorkspaceGuardSql = (botIdRef: string) => `EXISTS (
           SELECT 1 FROM app_workspaces w
             JOIN review_runtime_settings s
               ON s.key = '${OFFICIAL_WORKSPACE_KEY}' AND s.value = w.workspace_id
             JOIN workspaces ws ON ws.id = w.workspace_id AND ws.deleted_at IS NULL
            WHERE w.app_id = ${botIdRef})`;

/**
 * The BOT switch's official-workspace guard: the bot's owner is
 * `review_bots.workspace_id` (D5/D34 — no App owns a bot), so the guard binds
 * THAT column directly. app_workspaces answers where an APP is installed —
 * a different question the bot's shareability never reads.
 */
const botOfficialWorkspaceGuardSql = `EXISTS (
           SELECT 1 FROM review_runtime_settings s
             JOIN workspaces ws ON ws.id = s.value AND ws.deleted_at IS NULL
            WHERE s.key = '${OFFICIAL_WORKSPACE_KEY}'
              AND s.value = review_bots.workspace_id)`;

const APP_SCOPE_SHARE_AUDIT_SQL = `
  INSERT INTO platform_audit_events
    (id, actor_login, action, target_type, target_id, detail_json, created_at)
  SELECT ?1, ?2, 'runtime.app_scope.set', 'app', ?3,
         json_object(
           'before', json_object('scope', (SELECT scope FROM github_apps WHERE id = ?3),
                                 'shared_at', (SELECT shared_at FROM github_apps WHERE id = ?3)),
           'after', json_object('scope', 'shared', 'shared_at', ?4)),
         ?5
   WHERE EXISTS (SELECT 1 FROM github_apps b
                  WHERE b.id = ?3 AND b.deleted_at IS NULL AND b.scope <> 'shared'
                    AND ${officialWorkspaceGuardSql("b.id")})`;

const APP_SCOPE_SHARE_SQL = `
  UPDATE github_apps SET scope = 'shared', shared_at = ?2
   WHERE id = ?1 AND deleted_at IS NULL AND scope <> 'shared'
     AND ${officialWorkspaceGuardSql("github_apps.id")}`;

const APP_SCOPE_UNSHARE_AUDIT_SQL = `
  INSERT INTO platform_audit_events
    (id, actor_login, action, target_type, target_id, detail_json, created_at)
  SELECT ?1, ?2, 'runtime.app_scope.set', 'app', ?3,
         json_object(
           'before', json_object('scope', (SELECT scope FROM github_apps WHERE id = ?3),
                                 'shared_at', (SELECT shared_at FROM github_apps WHERE id = ?3)),
           'after', json_object('scope', 'owned', 'shared_at', NULL)),
         ?4
   WHERE EXISTS (SELECT 1 FROM github_apps b
                  WHERE b.id = ?3 AND b.deleted_at IS NULL AND b.scope <> 'owned')`;

const APP_SCOPE_UNSHARE_SQL = `
  UPDATE github_apps SET scope = 'owned', shared_at = NULL
   WHERE id = ?1 AND deleted_at IS NULL AND scope <> 'owned'`;

const REVIEW_BOT_SCOPE_SHARE_AUDIT_SQL = `
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
                    AND ${botOfficialWorkspaceGuardSql.replace("review_bots.workspace_id", "b.workspace_id")})`;

const REVIEW_BOT_SCOPE_SHARE_SQL = `
  UPDATE review_bots SET scope = 'shared', shared_at = ?2
   WHERE id = ?1 AND deleted_at IS NULL AND scope <> 'shared'
     AND ${botOfficialWorkspaceGuardSql}`;

const REVIEW_BOT_SCOPE_UNSHARE_AUDIT_SQL = `
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

const REVIEW_BOT_SCOPE_UNSHARE_SQL = `
  UPDATE review_bots SET scope = 'owned', shared_at = NULL
   WHERE id = ?1 AND deleted_at IS NULL AND scope <> 'owned'`;

/**
 * The shared transition engine behind both share switches. A same-value
 * transition is a no-op that appends nothing; `shared → owned` needs an
 * explicit `confirm: true`; `owned → shared` needs the entity's workspace to
 * BE the official workspace — the guard lives INSIDE the batch statements so
 * a concurrent re-designation cannot be raced through. Unsharing ignores that
 * last condition on purpose (a stale share stays revocable).
 */
async function scopeTransition(
  db: AppsStoreD1,
  input: { id: string; scope: BotScope; confirm?: boolean; actor: string; now: string },
  sql: {
    read: string;
    shareAudit: string;
    share: string;
    unshareAudit: string;
    unshare: string;
  },
): Promise<BotScopeOutcome> {
  const { id, scope, actor, now } = input;
  const current = await db
    .prepare(sql.read)
    .bind(id)
    .first<{ scope: BotScope; shared_at: string | null }>();
  if (!current) return { outcome: "bot_not_found" };
  if (current.scope === scope) return { outcome: "ok", scope, sharedAt: current.shared_at };
  if (scope === "owned" && input.confirm !== true) return { outcome: "confirm_required" };

  const [, write] =
    scope === "shared"
      ? await db.batch([
          db.prepare(sql.shareAudit).bind(crypto.randomUUID(), actor, id, now, now),
          db.prepare(sql.share).bind(id, now),
        ])
      : await db.batch([
          db.prepare(sql.unshareAudit).bind(crypto.randomUUID(), actor, id, now),
          db.prepare(sql.unshare).bind(id),
        ]);

  if ((write?.meta.changes ?? 0) > 0) {
    return { outcome: "ok", scope, sharedAt: scope === "shared" ? now : null };
  }

  const persisted = await db
    .prepare(sql.read)
    .bind(id)
    .first<{ scope: BotScope; shared_at: string | null }>();
  if (persisted === null) return { outcome: "bot_not_found" };
  if (persisted.scope === scope) return { outcome: "ok", scope, sharedAt: persisted.shared_at };
  return { outcome: "outside_official_workspace" };
}

/**
 * The APP share switch: writes `github_apps.scope` — who may act through
 * these credentials — and audits it as `runtime.app_scope.set` on target
 * type `app`. `id` is the App row id.
 */
export async function setAppScope(
  db: AppsStoreD1,
  input: { appId: string; scope: BotScope; confirm?: boolean; actor: string; now: string },
): Promise<BotScopeOutcome> {
  return scopeTransition(
    db,
    { ...input, id: input.appId },
    {
      read: APP_SCOPE_READ_SQL,
      shareAudit: APP_SCOPE_SHARE_AUDIT_SQL,
      share: APP_SCOPE_SHARE_SQL,
      unshareAudit: APP_SCOPE_UNSHARE_AUDIT_SQL,
      unshare: APP_SCOPE_UNSHARE_SQL,
    },
  );
}

/**
 * The BOT share switch: writes `review_bots.scope` — which workspaces may
 * consume this review configuration — and audits it as
 * `runtime.bot_scope.set` on target type `bot`. `id` is the bot row id
 * (equal to the App's this release; keyed independently on purpose).
 */
export async function setReviewBotScope(
  db: AppsStoreD1,
  input: { botId: string; scope: BotScope; confirm?: boolean; actor: string; now: string },
): Promise<BotScopeOutcome> {
  return scopeTransition(
    db,
    { ...input, id: input.botId },
    {
      read: REVIEW_BOT_SCOPE_READ_SQL,
      shareAudit: REVIEW_BOT_SCOPE_SHARE_AUDIT_SQL,
      share: REVIEW_BOT_SCOPE_SHARE_SQL,
      unshareAudit: REVIEW_BOT_SCOPE_UNSHARE_AUDIT_SQL,
      unshare: REVIEW_BOT_SCOPE_UNSHARE_SQL,
    },
  );
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

/**
 * One `review_failures` row as the detail face reads it. `error` carries the
 * mechanism detail an operator needs; `error_code`/`track_id` are NULL on rows
 * recorded before 0106, which the UI renders exactly as it always did.
 */
export type PullRequestFailureDetailRow = {
  stage: string;
  error: string;
  /** The PR author's sentence (migration 0107); NULL on older rows. */
  message: string | null;
  error_code: string | null;
  track_id: string | null;
  created_at: string;
};

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

/** One record section's page request — the route validates the bounds before this.
 * `history` is the failures section's only scope flag: `true` asks for the whole
 * row set (every head plus the headless ones); absent/false means the current head. */
export type PullRequestPageRequest = {
  offset: number;
  limit: number;
  severity?: string | null;
  unclassified?: boolean;
  history?: boolean;
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
