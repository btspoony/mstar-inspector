/**
 * note: D1 store for `review_bots` / `bot_installations` — the
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
 * consumer. Its imports are zero-dependency contracts only
 * (src/contracts/sandbox-images.ts — the registry, not pipeline/review code —
 * and src/contracts/failure-stages.ts — the `review_failures` stage
 * partition), which bound the sandbox_image_id value domain and keep the
 * failure-count/history SQL off hand-written stage literals, plus
 * ./runtime-config-store for the official-workspace key — `setBotScope`'s guard
 * names that row rather than guessing it, and this module never parses it.
 * The `db` parameter is a locally-declared narrow D1 face (types
 * only, zero imports) — a real `D1Database`, the bun:sqlite test double
 * (tests/store/helpers.ts), and the store layer's `D1Like` all satisfy it
 * structurally. Declared locally instead of importing `store/types` because
 * dashboard modules must not import store/pipeline/review code (architect
 * decision Q2). The narrow face carries the operations this store needs:
 * multi-row reads go through IN-list queries (deliverySummaries) and the
 * writes that must commit together — bot creation with its owner mapping, the
 * user-facing delete, the installation reconcile — go through `batch()`.
 *
 * The workspace-owned review configuration — trigger mode, review depth, Check
 * gate, the business pause — lives on `review_targets` and is
 * served by `src/dashboard/targets-store.ts`. This store keeps only the
 * execution identity: credentials, model and sandbox configuration,
 * installations, and `review_enabled` as the OPERATIONAL pause.
 *
 * A bot also carries a SCOPE (migration 0058): `owned` serves its own workspace
 * only, `shared` is offered platform-wide. Only a platform operator writes it,
 * only through `setBotScope`, and only from inside the official workspace —
 * that is a platform authorization, never workspace self-service.
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
 *   - setReviewEnabled (migration 0008) is the per-bot OPERATIONAL pause
 *     switch (a delivery failure, an operator intervention): writes
 *     review_enabled + updated_at and refuses soft-deleted rows exactly like
 *     setAppStatus. The value users change lives on the target; nothing in the
 *     dashboard writes this column.
 *   - setSandboxImage (migration 0018) is the per-App sandbox
 *     runtime-image selection: the id must be an ENABLED entry of the
 *     sandbox-image registry (plain Error backstop, the recordDelivery
 *     convention — the settings route 400s first), writes sandbox_image_id +
 *     updated_at, and refuses soft-deleted rows exactly like setAppStatus.
 *     createApp omits the column, so the migration 0018 DDL default seeds
 *     'omp'.
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
 *   - getGithubVisibility / saveGithubVisibility (migration 0045) are the
 *     cached App-visibility face: NULL reads as 'unknown', and the writer is
 *     the metadata refresh's anonymous probe — machine-triggered, so like
 *     saveGithubMetadata it never writes updated_at.
 *   - listInstallations is the install-health read face for the settings
 *     panel: this App's PRESENT installations (`removed_at IS NULL`), most
 *     recently seen first. markInstallationRemoved / reconcileInstallations
 *     stamp the rows GitHub no longer has — never delete them.
 *   - listPendingInstallations is the 已安装 tab's read face: this bot's live
 *     installations, narrowed to the bots the addressed workspace may use.
 *     Installations are app-level, so no target binding filters them.
 *   - softDeleteApp is idempotent — the FIRST deleted_at wins; returns
 *     whether THIS call performed the delete. It stamps the bot AND every
 *     target the bot owns in ONE batch: the user-facing delete removes one
 *     product surface, and a target left live would keep a deleted bot's
 *     configuration readable.
 *   - recordDelivery / deliverySummary / listDeliveries (migration
 *     0011) are the webhook_deliveries face: the per-App webhook
 *     route appends one best-effort row per CLASSIFIED delivery (ok /
 *     paused / ignored / rejected — outcome vocabulary DELIVERY_OUTCOMES,
 *     producer-side enforced), and the dashboard reads the health summary +
 *     the filtered, paged delivery list through the same store (AL-20-1: the
 *     legacy face records nothing).
 *   - deliverySummaries (QC wave 1, W-1) is the BATCHED health
 *     read face for the Apps list: newest verdict row + 24h rejected count for
 *     every requested app in exactly TWO statements regardless of N;
 *     deliverySummary(appId) stays the single-settings-page face.
 *   - event_name is bounded to EVENT_NAME_MAX_LENGTH (64) chars at
 *     persist time — the x-github-event HEADER is attacker-influenced on
 *     the unauthenticated reject path; the DDL has no length constraint.
 *     repository_full_name carries a bound too (REPOSITORY_FULL_NAME_MAX_LENGTH,
 *     160), but for a different reason: it is a verified-body field,
 *     defence-in-depth against GitHub's own name ceilings — never an
 *     attacker payload bound.
 *   - Timestamps are SQLite datetime('now') (UTC — the reviews.reviewed_at
 *     convention); createApp ids are caller-supplied (the reviews.id
 *     caller-UUID convention — review pin: secretbox AAD rowKey MUST
 *     equal the row PK, so the caller decides the id before encrypting).
 *     The manifest flow mints that id at start, so the webhook URL is known
 *     before GitHub creates the App.
 *   - UNIQUE / FK violations throw (fail-loud): duplicate github_app_id or
 *     (bot_id, installation_id) pairs, and unknown app references are
 *     caller-visible errors, never swallowed.
 */
import { ATTRIBUTION_EXCLUDED_STAGES, sqlStageList } from "../contracts/failure-stages";
import { normalizeRfc3339 } from "../contracts/rfc3339";
import { FINDING_SEVERITIES, MUST_FIX_SEVERITY } from "../contracts/finding-severity";
import { getSandboxImage } from "../contracts/sandbox-images";
import { OFFICIAL_WORKSPACE_KEY } from "./runtime-config-store";

/** A row of `review_bots` (D1 column names, snake_case; migrations 0004/0036). */
export type GithubAppRow = {
  /**
   * note: The local App UID — also the webhook URL's app segment
   * (`/webhook/<workspace_id>/<id>`) and the secretbox AAD row key.
   */
  id: string;
  github_app_id: number;
  name: string;
  /** invariant: secretbox envelope of the App PEM — opaque, never decrypted here. */
  private_key_enc: string;
  /** safety: secretbox envelope of the App webhook secret — opaque, never decrypted here. */
  webhook_secret_enc: string;
  /** note: GitHub login of the creating member (the manage rule is the workspace role). */
  created_by: string;
  status: GithubAppStatus;
  /** invariant: NULL = live row; a timestamp = soft-deleted (the only removal path). */
  deleted_at: string | null;
  /**
   * note: Per-bot OPERATIONAL pause (migration 0008): 1 = running, 0 = paused. The
   * business pause users change lives on the target; both gate enqueue and the
   * in-flight consumer.
   */
  review_enabled: number;
  /**
   * note: Cached GitHub App visibility (migration 0045): 'public' | 'private' |
   * 'unknown', written by the anonymous `GET /apps/{slug}` probe. The
   * metadata refresh is its only caller, and a no-answer skips the write and
   * keeps the stored value. NULL = never probed; getGithubVisibility reads it
   * as 'unknown' (cannot prove private).
   */
  github_visibility: GithubVisibility | null;
  /** invariant: Last verified (2xx) webhook delivery (migration 0008); NULL = never. */
  last_webhook_at: string | null;
  /**
   * invariant: Cached GitHub-side App name (migration 0019); NULL = never
   * synced. Distinct from the local `name` recorded at manifest commit.
   */
  github_name: string | null;
  /** invariant: Cached GitHub App description (migration 0019); NULL = never synced or none upstream. */
  github_description: string | null;
  /** invariant: Cached GitHub App settings-page URL (migration 0019); NULL = never synced. */
  github_html_url: string | null;
  /** invariant: Cached App icon URL (`/in/<github_app_id>`, migration 0019); NULL = never synced. */
  github_avatar_url: string | null;
  /**
   * note: GitHub's own App slug (migration 0036), cached from `GET /app`; NULL =
   * never synced. Mutable upstream and NOT derivable from `name`, which is why
   * it is its own column: the `<github_slug>[bot]` mention login and the
   * dashboard links read it, never the row id or the icon.
   */
  github_slug: string | null;
  /**
   * note: Last successful GitHub metadata sync (migration 0019, datetime('now')
   * UTC — the last_webhook_at TEXT convention); NULL = never synced. The
   * settings read path's lazy 24h TTL refresh keys off this column.
   */
  github_metadata_synced_at: string | null;
  /**
   * note: Last metadata fetch ATTEMPT that persisted no slug (migration 0037) —
   * failure, or a successful payload without one. The read path's NULL-slug
   * re-attempt keys off it so a permanently failing App costs at most one
   * fetch per TTL instead of one per settings read.
   */
  github_metadata_attempted_at: string | null;
  /**
   * note: Selected sandbox runtime image (migration 0018): a registry id from
   * src/contracts/sandbox-images.ts, default 'omp'. The value domain (only
   * ENABLED registry entries) is store-enforced — no DDL CHECK.
   */
  sandbox_image_id: string;
  created_at: string;
  updated_at: string;
  /**
   * invariant: The bot's scope (migration 0058): `owned` serves its own workspace only,
   * `shared` is offered platform-wide. Only `setBotScope` writes it, and
   * `targets-store.resolveByRepo` is its one review-path reader: a shared bot
   * reviews nothing until a workspace adds a repository target on it.
   */
  scope: BotScope;
  /** note: Owning workspace (migration 0026); present on every execution-facing read. */
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
  /**
   * note: Caller-supplied row PK (review pin): the caller encrypts
   * private_key_enc / webhook_secret_enc with secretbox AAD
   * `github_apps.<column>:<id>` BEFORE insert, so the id must exist first —
   * the encrypted columns' AAD rowKey always equals this primary key. Not
   * optional: a store-generated default would make the caller's AAD
   * unknowable and the row undecryptable. The manifest flow mints it at
   * start, because the manifest's webhook URL carries it.
   */
  id: string;
  /**
   * why: GitHub's App slug, when the caller already knows it. NULL is the honest
   * default ("never synced") — the first metadata sync fills it.
   */
  githubSlug: string | null;
  githubAppId: number;
  name: string;
  /** note: secretbox envelope of the App PEM (AAD `github_apps.private_key_enc:<id>`). */
  privateKeyEnc: string;
  /** safety: secretbox envelope of the webhook secret (AAD `github_apps.webhook_secret_enc:<id>`). */
  webhookSecretEnc: string;
  createdBy: string;
  /**
   * invariant: The workspace the App belongs to. Required: ownership is a caller input,
   * never a store lookup, so a deployment with several workspaces can never
   * silently mis-home an App and no caller can leave the owner unstated.
   */
  workspaceId: string;
  /**
   * note: The plan's `apps_per_workspace` cap for that workspace: the count this
   * insert enforces. Required — an omitted cap would be a silent bypass, and
   * the caller already holds the plan from its own entitlement read. `null` is
   * no cap (including `self-hosted`, whose plan answers the unlimited
   * constant); `0` refuses every creation.
   */
  maxApps: number | null;
};

/**
 * Thrown by {@link createApp} when the guarded insert wrote no row because the
 * workspace already owns `maxApps` live Apps. The cap is decided BY the write,
 * so a concurrent pair cannot both land. Callers map it onto the existing
 * refusal surface; it is not a database fault and must not be retried as one.
 */
export class AppCountExceededError extends Error {
  /** invariant: The plan cap the insert compared against (never `null`: a null cap has no guard). */
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
  /** invariant: Absent/null → preserve the stored login (a bare touch must not wipe it). */
  accountLogin?: string | null;
  /**
   * why: True when `accountLogin` is the installation's OWN account, as stated by an
   * `installation.*` event; false (default) when it is the review-path
   * inference from `repository.owner.login`. An authoritative value overwrites
   * whatever is stored; an inferred one only fills an empty column.
   */
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
  /** invariant: GitHub login of the installation account; NULL = never observed. */
  account_login: string | null;
  seen_at: string;
};

/**
 * One installation INCLUDING a removed one — the bound-state read. Unlike
 * `AppInstallationRow` (the install-health panel's PRESENT rows), a removed
 * installation is exactly what this answers: a target keeps its binding
 * through an uninstall, and the settings block says reviews stopped.
 */
export type AppInstallationState = {
  installation_id: number;
  account_login: string | null;
  /** note: NULL = GitHub still has it; a timestamp = observed absent (migration 0055). */
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

/**
 * note: Outcome tier rank shared by BOTH delivery health faces: 0 = the row carries
 * a review verdict (`ok`, `paused`, `rejected`), 1 = `ignored`, which says
 * nothing about whether review is running (bypass events such as check_run,
 * and whitelisted events the classifier dropped). The event name cannot stand
 * in for this: `check_run` alone can outnumber review traffic by orders of
 * magnitude, and a `pull_request` can legitimately land in `ignored` too. Both
 * faces rank by exactly this expression so they can never disagree.
 */
// note: Also a key of idx_webhook_deliveries_bot_health (migration 0080). SQLite
// matches expression indexes only on identical expressions; changes need a new migration.
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

/**
 * invariant: The ledger list's ONE ordering (newest activity, number as the total-order
 * tiebreak). Shared by the row statement and the aggregate window so the two
 * cannot drift apart.
 */
const PULL_REQUEST_LEDGER_ORDER = "last_seen_at DESC, pr_number DESC";

/**
 * note: The repository predicate `listPullRequests` carries. It rides INSIDE the
 * window — in the row statement's own WHERE and in both aggregate scopes —
 * never after the cap: a filter applied to the capped rows would hide every
 * repository whose PRs sit behind PULL_REQUEST_LIST_LIMIT.
 */
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

/**
 * note: The tenant predicate for a ledger statement over `alias`, binding a CONSTANT
 * number of values per scope kind — one for a workspace scope, two for a
 * target scope (its id and the workspace that must own it). Bind order is
 * `ledgerScopeBinds`'.
 */
function ledgerScopeSql(alias: string, scope: LedgerScope): string {
  const target = `${alias}.target_id`;
  if (scope.kind === "workspace") {
    return `${target} IN (SELECT t.id FROM review_targets t WHERE t.workspace_id = ? AND t.deleted_at IS NULL)`;
  }
  return `${target} = ? AND EXISTS (SELECT 1 FROM review_targets t WHERE t.id = ${target} AND t.workspace_id = ? AND t.deleted_at IS NULL)`;
}

/** note: The bind values `ledgerScopeSql` expects, in its own order. */
function ledgerScopeBinds(scope: LedgerScope): string[] {
  return scope.kind === "workspace" ? [scope.workspaceId] : [scope.targetId, scope.workspaceId];
}

/**
 * note: The list's ONE bounded window. Used as the row statement's own predicate and
 * as the scope of both aggregate statements, so the payload is not merely
 * capped: the work is. A repository filter narrows the window ITSELF, so the
 * cap bounds the filtered set and the aggregates keep matching the rows.
 */
function pullRequestWindowSql(repoPredicate: string, scope: LedgerScope): string {
  return `SELECT owner, repo, pr_number FROM pull_requests
  WHERE ${ledgerScopeSql("pull_requests", scope)}${repoPredicate}
  ORDER BY ${PULL_REQUEST_LEDGER_ORDER} LIMIT ?`;
}

/**
 * note: Statement 0 of every record-section batch: is this PR on the ledger at all?
 * A section reader answers pages, not PR existence — `total: 0` covers both an
 * empty section and an unknown PR — so existence must be decided in the same
 * batch, and `null` (the route's 404) means "this target never received it".
 */
function pullRequestExistsSql(scope: LedgerScope): string {
  return `SELECT 1 AS found FROM pull_requests p
  WHERE ${ledgerScopeSql("p", scope)} AND p.owner = ? AND p.repo = ? AND p.pr_number = ? LIMIT 1`;
}

/**
 * note: Slice to `max` UTF-16 units without leaving half a surrogate pair behind
 * (a lone surrogate cannot round-trip through D1's TEXT as valid UTF-8).
 */
function truncateBounded(value: string, max: number): string {
  if (value.length <= max) return value;
  const last = value.charCodeAt(max - 1);
  // note: A high surrogate at the cut means its low half is the next unit: drop both.
  return value.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

/** Input for recordDelivery — one VERIFIED per-App webhook delivery. */
export type RecordDeliveryInput = {
  appId: string;
  /**
   * why: The x-github-event header; NULL when the header was absent. Truncated
   * to EVENT_NAME_MAX_LENGTH (64) chars at persist — the header is
   * attacker-influenced on the unauthenticated reject path.
   */
  eventName: string | null;
  outcome: DeliveryOutcome;
  /** note: The classifier's status for rejected; NULL for every other outcome. */
  statusCode: number | null;
  /**
   * note: The delivery's source repository (`owner/name`, migration 0043) — NULL
   * when the payload carried no `repository` (an install / bypass event).
   * Truncated to REPOSITORY_FULL_NAME_MAX_LENGTH (160) chars at persist; see
   * that constant for the trust model (a verified-body field, bounded as
   * defence-in-depth — not an attacker payload bound like `eventName`).
   */
  repositoryFullName: string | null;
  /**
   * why: The classifier's refusal reason, for a `rejected` delivery; NULL for every
   * other outcome and for rows written before migration 0074. Bounded to
   * DELIVERY_REASON_MAX_LENGTH at persist.
   */
  reason: string | null;
};

/** A row of `webhook_deliveries` (D1 column names, snake_case; migration 0011). */
export type WebhookDeliveryRow = {
  id: string;
  bot_id: string;
  event_name: string | null;
  outcome: DeliveryOutcome;
  status_code: number | null;
  /** note: `owner/name` of the source repo (0043); NULL = unknown source. */
  repository_full_name: string | null;
  /** why: The classifier's refusal reason (0074); NULL = not a reject / not recorded. */
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
  /** invariant: The App's whole repository set — the filter's options, never narrowed. */
  repos: string[];
  /** invariant: The App's whole delivery-type set — the filter's options, never narrowed. */
  types: string[];
};

/** Input for upsertPullRequest — one VERIFIED `pull_request` delivery. */
export type UpsertPullRequestInput = {
  appId: string;
  /**
   * note: The review target the ledger row belongs to (`review_targets.id`).
   * REQUIRED: the ledger's identity is `(target_id, owner, repo, pr_number)`,
   * and a row written without it would be invisible to every tenant read.
   */
  targetId: string;
  owner: string;
  repo: string;
  prNumber: number;
  /** why: Omitted/null keeps whatever the row already knows. */
  title?: string | null;
  /** why: The payload's state, already promoted to 'merged' when `merged` was true. */
  state: string;
  headSha?: string | null;
  /**
   * invariant: The payload's `pull_request.updated_at` (ISO 8601), so ordering follows
   * GitHub's clock rather than our arrival clock. Omitted/null → now.
   * It is ALSO the `head_at` delivery watermark (migration 0044): the stamp
   * the ledger keeps for the most recent stamped delivery of this PR — NOT
   * the arrival time of `headSha`, which a delivery naming the same sha still
   * moves.
   *
   * Omitted/null/malformed → now. Any admitted RFC 3339 spelling (a numeric
   * offset included) is rewritten to UTC ISO-8601 inside the write, because
   * the column is ordered LEXICALLY and a `+02:00` row would sort wrongly
   * against the stored `Z` values.
   */
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

/**
 * why: Narrow D1 face, declared locally so this leaf module imports nothing
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

/** note: One statement's result inside a `batch()` (order matches the input). */
type AppsStoreBatchResult = {
  results: unknown[];
  meta: { changes: number; last_row_id: number };
};

type AppsStoreD1 = {
  prepare(query: string): AppsStoreStatement;
  batch(statements: AppsStoreStatement[]): Promise<AppsStoreBatchResult[]>;
};

/** note: The `SELECT COUNT(*) AS n` row of a batch statement. */
type CountRow = { n: number };

/** note: One batch statement's `COUNT(*)` result. */
function countOf(result: AppsStoreBatchResult): number {
  const [row] = result.results as CountRow[];
  return row?.n ?? 0;
}

/**
 * invariant: Tenant read face (migration 0026) — there is exactly one. Every
 * execution-facing App read INNER JOINs `bot_workspaces`, so an App with no
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
  getAppById: `SELECT g.*, w.workspace_id FROM review_bots g INNER JOIN bot_workspaces w ON w.bot_id = g.id INNER JOIN workspaces ws ON ws.id = w.workspace_id AND ws.deleted_at IS NULL WHERE g.id = ?`,
  getAppForWebhook: `SELECT g.*, w.workspace_id FROM review_bots g INNER JOIN bot_workspaces w ON w.bot_id = g.id INNER JOIN workspaces ws ON ws.id = w.workspace_id AND ws.deleted_at IS NULL WHERE g.id = ? AND w.workspace_id = ?`,
  getAppByGithubId: `SELECT g.*, w.workspace_id FROM review_bots g INNER JOIN bot_workspaces w ON w.bot_id = g.id INNER JOIN workspaces ws ON ws.id = w.workspace_id AND ws.deleted_at IS NULL WHERE g.github_app_id = ?`,
  /**
   * why: The shared-set-aware resolve: the bot the session workspace owns, else a
   * `shared` bot it may use, else nothing. Non-deleted bots only. The owning
   * mapping wins the join when a bot carries both (the ORDER BY), so the
   * returned `workspace_id` is the caller's own whenever it has one and the
   * bot's owner otherwise.
   */
  getVisibleBotByGithubId: `SELECT g.*, w.workspace_id FROM review_bots g INNER JOIN bot_workspaces w ON w.bot_id = g.id INNER JOIN workspaces ws ON ws.id = w.workspace_id AND ws.deleted_at IS NULL WHERE g.github_app_id = ?1 AND g.deleted_at IS NULL AND (w.workspace_id = ?2 OR g.scope = 'shared') ORDER BY (w.workspace_id = ?2) DESC, w.workspace_id LIMIT 1`,
  listApps: `SELECT g.*, w.workspace_id FROM review_bots g INNER JOIN bot_workspaces w ON w.bot_id = g.id WHERE g.deleted_at IS NULL ORDER BY g.created_at DESC, g.id`,
} as const;

/**
 * note: The workspace-scoped App resolve the target pages use: the bot the addressed
 * workspace OWNS (its `bot_workspaces` mapping), or a bot it holds a live
 * target on. Both arms are the pre-0067 visibility rule, unchanged by the
 * repository keying — the second is the entitlement a target carries, and it
 * is what keeps a `shared` bot reachable from the workspace that created a
 * target on it AND a target readable after its share was revoked (`scope` back
 * to `owned`). That revoked-share read is exactly the state the settings face
 * must report as Blocked, so a scope guard on this arm would hide the bot
 * instead of answering it.
 */
const SCOPED_APP_SQL = `SELECT g.*, w.workspace_id FROM review_bots g INNER JOIN bot_workspaces w ON w.bot_id = g.id INNER JOIN workspaces ws ON ws.id = w.workspace_id AND ws.deleted_at IS NULL WHERE g.github_app_id = ?1 AND g.deleted_at IS NULL AND (w.workspace_id = ?2 OR EXISTS (SELECT 1 FROM review_targets t WHERE t.bot_id = g.id AND t.workspace_id = ?2 AND t.deleted_at IS NULL)) ORDER BY (w.workspace_id = ?2) DESC, w.workspace_id LIMIT 1`;

/**
 * note: The two `upsertInstallation` statements. Which one runs is chosen BEFORE
 * `prepare` from `input.authoritative`, so no value ever enters the SQL text.
 *
 * A NULL `accountLogin` preserves whatever is stored in both. They differ only
 * in which side wins a non-null value: an AUTHORITATIVE login (the
 * installation's own account, from an `installation.*` event) overwrites the
 * stored one, while an INFERRED login (`repository.owner.login`, because
 * GitHub omits `installation.account` from `pull_request` / `issue_comment`
 * payloads) only fills an empty column. Inference must therefore never
 * overwrite an authoritative value, while a NULL row still fills from ordinary
 * review traffic.
 */
const UPSERT_INSTALLATION_SQL = {
  // why: An AUTHORITATIVE delivery is the installation's own statement, so it also
  // clears a removal stamp: a reinstall (`installation.created`) makes the row
  // visible again. An INFERRED login is ordinary review traffic and says
  // nothing about install state, so it never clears the stamp.
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

/**
 * note: Every live `shared` bot with that per-workspace count. `owned` and
 * soft-deleted bots are not offered: the set is the platform-wide share, which
 * is the same for every workspace by contract. One D1 read, no GitHub call.
 */
const SHARED_BOT_LIST_SQL = `
  SELECT b.id, b.github_slug, b.name,
         (SELECT COUNT(*) FROM review_targets t
           WHERE t.bot_id = b.id AND t.workspace_id = ?1 AND t.deleted_at IS NULL) AS target_count
    FROM review_bots b
   WHERE b.scope = 'shared' AND b.deleted_at IS NULL
   ORDER BY b.name, b.id`;

/** Create the review_bots / bot_installations store over one D1 handle. */
export function createReviewBotsStore(db: AppsStoreD1) {
  /**
   * invariant: Bounded ledger retention (migration 0039). Terminal rows only: an open PR
   * is still a review target however stale its clock, so `state` gates the
   * predicate and age only orders what it already excluded. Capped per run so
   * a large backlog drains over successive sweeps instead of stalling one.
   *
   * This predicate and `upsertPullRequest`'s write predicate MUST agree — see
   * the invariant documented there. What that guarantees, and what it does
   * not: a swept row's state was written by a delivery whose stamp was >= the
   * stored one, so it is the newest state we could resolve. It is NOT proof
   * that the PR is still closed — two deliveries that share one `updated_at`
   * second cannot be ordered from payload data, and a same-second
   * close→reopen delivered out of order stores `closed` under the reopen's
   * stamp. Accepted: the row is swept rather than kept forever, and the next
   * delivery for that PR (any action) rewrites the row with a newer stamp.
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
   * note: BATCHED health-read face (QC wave 1, W-1): the Apps list
   * renders every row's health on each POST re-render, so the per-App
   * deliverySummary fan-out (2N statements) is replaced by exactly TWO
   * statements for any N: (a) the newest row per app — ranked by an outcome
   * tier, newest first inside each tier — via an indexed top-one lookup
   * per requested app, and (b) the 24h `rejected` count grouped by app
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
   * tier 1 is `ignored` and `skipped` (a delivery the shared-bot capability
   * refused: verified, but no review ran for it, so it carries no verdict of
   * its own). So an App with any verdict reports the newest of
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

  /**
   * note: The workspace's live review locks, keyed by (owner, repo, pr_number) — or
   * `null` when the read failed, because a failed read IS the `unknown` wire
   * value (D16) and must not fail the whole PR face. That `null` is silent in
   * the payload, so the catch also emits one `dashboard_live_lock_read_failed`
   * warn carrying the `workspace_id` — the only trace of which tenant degraded.
   * ONE statement regardless of N: the live set is bounded by the concurrency
   * caps. The read is workspace-scoped, not bot-scoped: `review_inflight`'s own
   * `workspace_id` is the tenant the row was admitted for, and a workspace
   * scope spans bots. `expires_at > now` is the pipeline's own acquire
   * predicate, and the bound instant uses the ISO-8601-with-milliseconds form
   * that column is written in — the one form it orders correctly as text. Keys
   * fold case because the lock stores lowercase while the ledger keeps GitHub's
   * spelling.
   */
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
    /**
     * note: Insert a new active app row (status 'active', deleted_at NULL) with
     * the CALLER-SUPPLIED id as the row PK (review pin — the caller's
     * secretbox AAD rowKey is this id), plus its `bot_workspaces` mapping to
     * the REQUIRED `input.workspaceId`. Ownership is never discovered: the
     * named workspace must still be live. The two inserts are ONE batch
     * transaction, so a bot never exists without an owner. An App creates no
     * review target (D13): creation does not know a repository yet, and a
     * target is born when a repository is added. sandbox_image_id is omitted:
     * the migration 0018 DDL default materializes every new row onto the
     * registry's default image ('omp') — the store face for changing it is
     * setSandboxImage. A UNIQUE violation on github_app_id throws — the
     * commit path turns it into `already_connected` (409).
     *
     * `maxApps` is enforced by the insert itself, not by a read before it: the
     * batch re-counts the workspace's live Apps, so concurrent creations can
     * never land more rows than the cap allows. When exactly one slot is left
     * the loser's guarded insert changes no row and it gets
     * {@link AppCountExceededError}.
     */
    async createApp(input: CreateAppInput): Promise<GithubAppRow> {
      const id = input.id;
      // invariant: Ownership is a caller input, never a lookup: the named workspace must
      // still be live (a soft-deleted one is refused identically to an unknown
      // id). A clean throw here leaves no half-written App.
      const liveWorkspace = await db
        .prepare(`SELECT id FROM workspaces WHERE id = ? AND deleted_at IS NULL`)
        .bind(input.workspaceId)
        .first<{ id: string }>();
      if (!liveWorkspace) {
        throw new Error("apps-store: createApp target workspace is not live");
      }
      // note: The cap is enforced BY the write: the insert carries the workspace's
      // live count, so two concurrent creations cannot both pass a read that
      // both saw under the limit. A NULL cap has no guard at all — binding NULL
      // would make `count < NULL` NULL and refuse every creation.
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
        // note: Conditional too, and bound to THIS batch's insert: `changes()` is the
        // row count of the statement above in this same transaction. A refused
        // (zero-row) insert therefore leaves this one matching nothing — while
        // an id lookup alone would find a CONCURRENT winner's bot under the
        // same caller-supplied id and turn the refusal into a mapping
        // primary-key fault.
        db
          .prepare(
            `INSERT INTO bot_workspaces (bot_id, workspace_id)
             SELECT id, ?2 FROM review_bots WHERE id = ?1 AND changes() > 0`,
          )
          .bind(id, input.workspaceId),
      ]);
      // note: Zero rows is the refusal, classified by its cause: the workspace
      // predicate refused because the tenant was soft-deleted between the read
      // above and this batch, or the cap predicate did. A genuine SQL/UNIQUE
      // error threw out of the batch instead and is never reclassified.
      if (results[0]!.meta.changes === 0) {
        const stillLive = await db
          .prepare(`SELECT id FROM workspaces WHERE id = ? AND deleted_at IS NULL`)
          .bind(input.workspaceId)
          .first<{ id: string }>();
        if (!stillLive) {
          throw new Error("apps-store: createApp target workspace is not live");
        }
        if (input.maxApps === null) {
          // invariant: Unreachable: an uncapped insert for a live workspace always matches.
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

    /**
     * note: How many Apps a workspace currently OWNS: `bot_workspaces` joined to the
     * LIVE `review_bots` rows. A soft-deleted App keeps its mapping row, so the
     * join condition is what frees its slot. `createApp`'s insert re-checks
     * this same count in its own statement (the authority for a concurrent
     * pair); this read is only the commit path's fast-fail pre-check.
     */
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

    /**
     * invariant: By the webhook URL's two segments — the App row `id` must belong to the
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
     * note: By GitHub's numeric App id; same guards as getAppById (soft-deleted and
     * disabled rows resolve, a soft-deleted workspace does not).
     */
    async getAppByGithubId(githubAppId: number): Promise<GithubAppTenantRow | null> {
      return db
        .prepare(APP_READ_SQL.getAppByGithubId)
        .bind(githubAppId)
        .first<GithubAppTenantRow>();
    },

    /**
     * note: By GitHub's numeric App id, resolved against the shared set: the bot's
     * own (live) mapping OR — when the bot is `shared` — any workspace, so a
     * tenant face can read a bot it does not own. `null` for a soft-deleted or
     * `owned` bot outside the caller's workspace.
     */
    async getVisibleBotByGithubId(
      githubAppId: number,
      workspaceId: string,
    ): Promise<GithubAppTenantRow | null> {
      return db
        .prepare(APP_READ_SQL.getVisibleBotByGithubId)
        .bind(githubAppId, workspaceId)
        .first<GithubAppTenantRow>();
    },

    /**
     * note: The target pages' resolve: the workspace's own bot, or any bot it holds
     * a live target on (the same visibility rule `resolveScopedApp` documents).
     * `null` for a soft-deleted bot, a bot with neither this workspace's
     * mapping nor a live target here, or a non-existent id.
     */
    async getScopedAppByGithubId(
      githubAppId: number,
      workspaceId: string,
    ): Promise<GithubAppTenantRow | null> {
      return db
        .prepare(SCOPED_APP_SQL)
        .bind(githubAppId, workspaceId)
        .first<GithubAppTenantRow>();
    },

    /**
     * note: The `shared` bots this workspace may create a target on, each carrying
     * how many live targets the workspace already holds on it. The chooser's
     * list: a read, never a `review_bots` write.
     */
    async listSharedBots(workspaceId: string): Promise<SharedBotRow[]> {
      const res = await db.prepare(SHARED_BOT_LIST_SQL).bind(workspaceId).all<SharedBotRow>();
      return res.results;
    },

    /**
     * note: By id; resolves soft-deleted and disabled App rows too (callers
     * filter), but NOT an App whose workspace is soft-deleted.
     */
    async getAppById(id: string): Promise<GithubAppTenantRow | null> {
      return db.prepare(APP_READ_SQL.getAppById).bind(id).first<GithubAppTenantRow>();
    },

    /** note: Dashboard list: non-deleted rows, newest first (stable id tiebreak). */
    async listApps(): Promise<GithubAppRow[]> {
      const res = await db.prepare(APP_READ_SQL.listApps).all<GithubAppRow>();
      return res.results;
    },

    /**
     * note: The App's stored sandbox image id (migration 0018). No tenant join: it
     * returns a configuration value, never a tenant-facing field.
     */
    async getSandboxImageId(appId: string): Promise<string | null> {
      const row = await db
        .prepare(`SELECT sandbox_image_id FROM review_bots WHERE id = ?`)
        .bind(appId)
        .first<{ sandbox_image_id: string }>();
      return row?.sandbox_image_id ?? null;
    },

    /**
     * why: The cached GitHub App visibility (migration 0045). Unknown id → null;
     * a never-probed App reads as 'unknown' (the column is NULL), which is
     * treated as "cannot prove private".
     */
    async getGithubVisibility(appId: string): Promise<GithubVisibility | null> {
      const row = await db
        .prepare(`SELECT github_visibility FROM review_bots WHERE id = ?`)
        .bind(appId)
        .first<{ github_visibility: GithubVisibility | null }>();
      if (!row) return null;
      return row.github_visibility ?? "unknown";
    },

    /**
     * note: Toggle 'active' | 'disabled'. Refuses soft-deleted rows (returns false,
     * no write) — a deleted app can never be re-activated. Returns whether a
     * row changed (false also covers unknown ids).
     */
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

    /**
     * note: Toggle the per-App pause switch (spec 语义锁): 1 = the App's
     * PRs are reviewed, 0 = paused — webhook face 2xx-ignores with zero
     * enqueue, in-flight messages ack-skip. Writes review_enabled +
     * updated_at (an operator mutation, L5) and refuses soft-deleted rows
     * exactly like setAppStatus (a deleted app can never be re-activated).
     * Returns whether a row changed (false also covers unknown ids).
     */
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

    /**
     * note: Cache the App's GitHub visibility (migration 0045) from the anonymous
     * probe (its one caller is the metadata refresh). Writes ONLY
     * github_visibility — deliberately
     * NOT updated_at, which stays the operator-mutation timestamp (the
     * saveGithubMetadata convention: this write is machine-triggered).
     * Refuses soft-deleted rows exactly like setAppStatus. Returns whether a
     * row changed (false also covers unknown ids).
     */
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

    /**
     * note: Select the App's sandbox runtime image (migration 0018). The
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
          `UPDATE review_bots SET sandbox_image_id = ?, updated_at = datetime('now')
           WHERE id = ? AND deleted_at IS NULL`,
        )
        .bind(image.id, id)
        .run();
      return res.meta.changes > 0;
    },

    /**
     * Soft delete (the only removal path, Clarify #4): stamps deleted_at
     * once on the bot AND on every target the bot owns — one product surface,
     * so a deleted bot must not leave readable review configuration behind.
     * Both statements are ONE batch and both carry `deleted_at IS NULL`, so a
     * second call is a no-op returning false and the first timestamp wins on
     * both rows. Returns whether THIS call performed the delete.
     */
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

    /**
     * note: Record the App's most recent verified (2xx) webhook delivery (lock
     * L5). Writes ONLY last_webhook_at — deliberately NOT updated_at: this
     * touch runs per webhook (high-frequency), while updated_at must stay
     * the operator-mutation timestamp. An unknown id is a silent no-op (the
     * caller has already verified the signature — there is nothing to fail
     * or retry here).
     */
    async touchLastWebhook(id: string): Promise<void> {
      await db
        .prepare(`UPDATE review_bots SET last_webhook_at = datetime('now') WHERE id = ?`)
        .bind(id)
        .run();
    },

    /**
     * note: Persist one fetched GitHub profile (migrations 0019/0036) — the
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

    /**
     * note: Stamp `github_metadata_attempted_at` (migration 0037) after a fetch
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
          `UPDATE review_bots SET github_metadata_attempted_at = datetime('now')
           WHERE id = ? AND deleted_at IS NULL`,
        )
        .bind(id)
        .run();
    },

    /**
     * note: Touch (or create) the (appId, installationId) installation row on any
     * webhook carrying an installation_id. A null/absent accountLogin
     * preserves the stored login; otherwise `authoritative` decides the winner
     * (see UPSERT_INSTALLATION_SQL): an authoritative value overwrites, an
     * inferred one only fills an empty column.
     */
    async upsertInstallation(input: UpsertInstallationInput): Promise<void> {
      const sql = input.authoritative ? UPSERT_INSTALLATION_SQL.authoritative : UPSERT_INSTALLATION_SQL.inferred;
      await db
        .prepare(sql)
        .bind(crypto.randomUUID(), input.appId, input.installationId, input.accountLogin ?? null)
        .run();
    },

    /**
     * note: Install-health read face (settings panel): this App's
     * installation rows, most recently seen first (stable installation_id
     * tiebreak). Read-only — the panel never mutates through this face.
     */
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
     * note: The target page's 已安装 tab: this bot's live installations, most
     * recently seen first. An installation is app-level (D19), so nothing
     * binds it to a target and a removed one is the only exclusion. Empty for
     * a bot the addressed workspace may not use — its visible set is the
     * workspace's own bots plus every `shared` bot.
     */
    async listPendingInstallations(appId: string, workspaceId: string): Promise<AppInstallationRow[]> {
      const res = await db
        .prepare(
          `SELECT i.installation_id, i.account_login, i.seen_at FROM bot_installations i
             JOIN review_bots b ON b.id = i.bot_id
            WHERE i.bot_id = ?1 AND i.removed_at IS NULL
              AND (b.scope = 'shared'
                   OR EXISTS (SELECT 1 FROM bot_workspaces w
                               WHERE w.bot_id = b.id AND w.workspace_id = ?2))
            ORDER BY i.seen_at DESC, i.installation_id`,
        )
        .bind(appId, workspaceId)
        .all<AppInstallationRow>();
      return res.results;
    },

    /**
     * note: One installation of this bot INCLUDING a removed one — the settings
     * block's bound-state read. `removed_at IS NULL` is the present case; a
     * stamped row still answers, because a target keeps its binding through an
     * uninstall and the block has to say that reviews stopped.
     */
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

    /**
     * note: The database's own UTC clock in the sub-second `YYYY-MM-DD HH:MM:SS.SSS`
     * form (`strftime('%Y-%m-%d %H:%M:%f','now')`). A caller captures this
     * BEFORE an upstream read so `reconcileInstallations` can tell which rows
     * predate the snapshot.
     *
     * Sub-second on purpose: a plain `datetime('now')` marker makes every
     * same-second comparison a tie, and the reconcile's two guards need strict
     * order (`reconcileInstallations`). Lexicographic comparison stays valid
     * because every writer of a compared column uses the same form, and a
     * legacy second-resolution value is a prefix of — and therefore sorts
     * before — any fractional value of the same second.
     */
    async currentTimestamp(): Promise<string> {
      const row = await db
        .prepare(`SELECT strftime('%Y-%m-%d %H:%M:%f','now') AS now`)
        .first<{ now: string }>();
      if (!row) throw new Error("D1 returned no clock row");
      return row.now;
    },

    /**
     * note: Stamp one installation row as removed (`installation.deleted`). The row
     * SURVIVES — the credential-routing and failure-attribution joins read
     * `bot_installations`, and the installation's historical reviews still
     * reference it. An unknown pair is a silent no-op: the delivery may
     * predate any local row, and refusing it would change the webhook answer.
     *
     * Writes the sub-second form (`strftime('%Y-%m-%d %H:%M:%f','now')`) so a
     * reconcile snapshot taken later in the same second still orders after it.
     *
     * No order guard: a REPLAYED `installation.deleted` processed after a
     * reinstall's `installation.created` still stamps the row, because the
     * payload carries no reliable delivery order to compare. That window is
     * bounded by the next metadata refresh, whose live set contains the
     * installation and clears the stamp.
     */
    async markInstallationRemoved(appId: string, installationId: number): Promise<void> {
      await db
        .prepare(
          `UPDATE bot_installations SET removed_at = strftime('%Y-%m-%d %H:%M:%f','now')
           WHERE bot_id = ? AND installation_id = ?`,
        )
        .bind(appId, installationId)
        .run();
    },

    /**
     * note: Reconcile this App's installation rows against GitHub's authoritative
     * list (`GET /app/installations`): stamp the active rows the list does not
     * contain and clear the stamp of a stored-removed row the list DOES
     * contain. This is what repairs rows whose `installation.deleted` delivery
     * was missed. Rows are never deleted (see markInstallationRemoved); a null
     * `removed_at` is the only "present" state.
     *
     * `observedAt` is the store clock captured BEFORE the listing was fetched,
     * in the sub-second `strftime('%Y-%m-%d %H:%M:%f','now')` form that every
     * writer of a compared column also uses (`seen_at` in both upserts,
     * `removed_at` from the webhook stamp and from this leg). The list is a
     * snapshot and the table is not, so both statements are gated on it:
     * stamp only `seen_at <= observedAt` (a row written after the snapshot
     * carries a strictly greater fractional stamp and stays present) and clear
     * only `removed_at < observedAt` (a removal delivered after the snapshot is
     * newer news and survives).
     *
     * Same-second ties resolve the SAFE way on both legs because the marker is
     * fractional: a new fractional value in the observation's second sorts
     * after the observation, while a LEGACY second-resolution value
     * (`datetime('now')`, a prefix of its fractional successor) sorts before
     * it. So an old-style removal observed in the same second is still
     * cleared, and a same-second row created after the snapshot is not
     * stamped. Both UPDATEs run in ONE batch, so the stamp and the clear
     * commit together.
     *
     * The snapshot (live ids + observation stamp) travels as ONE JSON value,
     * tested with `json_each`: each statement binds exactly TWO values
     * (appId + the snapshot) however many installations GitHub lists. D1
     * refuses a statement binding more than 100 parameters, and one placeholder
     * per id would cross that at the first full page (`per_page=100`).
     * Chunking is not an alternative — a chunked `NOT IN` would stamp ids that
     * live in another chunk. `json_each('[]')` is an empty set, so an empty
     * list stamps every active row and clears none.
     */
    async reconcileInstallations(
      appId: string,
      liveInstallationIds: readonly number[],
      observedAt: string,
    ): Promise<void> {
      // why: One binding per statement: the `WITH` CTE keeps `json_each` (ids) and
      // `json_extract` (the stamp) reading the same bound value.
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

    /**
     * note: Append one delivery row (AL-20-1) — the R2 diagnostics
     * face. Fail-loud like the rest of this store: an off-vocabulary outcome
     * throws BEFORE any row is written (producer-side enforcement, 0010
     * FAILURE_STAGES precedent); FK violations (unknown appId) throw. The
     * webhook face wraps this in try/catch itself — an insert failure must
     * never change the webhook response (best-effort旁路). The event_name
     * header and the repository_full_name body field are capped at their
     * MAX_LENGTH constants at persist (seat2 hygiene pin) — but only
     * `event_name` is attacker-influenced: it is the x-github-event HEADER,
     * which the unauthenticated reject path does reach. `repository_full_name`
     * comes from the already-parsed, HMAC-verified body, so its bound is
     * defence-in-depth against GitHub's name ceilings, not a payload bound.
     */
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

    /**
     * note: Health read face: the App's newest review-verdict delivery row
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

    /** note: Batched variant of deliverySummary — see the local implementation above. */
    deliverySummaries,

    /** note: Bounded ledger retention — see the local implementation above. */
    sweepTerminalPullRequests,

    /**
     * note: The delivery-status read face: THIS App's rows, filtered and paged in
     * the STORE, with the unpaged total beside the page.
     *
     * Ordering is the panel's original one — verdict tier first, newest first
     * inside each tier (created_at has second precision, so rowid breaks ties
     * inside one second). It stays deterministic under OFFSET paging because
     * rowid is in the ORDER BY: a page boundary cannot repeat or skip a row.
     * The ranking exists because bypass traffic (`check_run`, `ping`, …)
     * dwarfs review traffic while landing in `ignored`, so a raw newest-first
     * list opens with identical `check_run · ignored` lines even while reviews
     * run fine (see DELIVERY_VERDICT_TIER_SQL).
     *
     * The filters narrow BOTH the page and the total — the count is not the
     * unfiltered table size, or the pager would offer pages the filters cannot
     * fill. `repos` / `types` are the App's whole option sets, deliberately
     * NOT narrowed: a filter whose next value sits outside the current result
     * must still be selectable.
     */
    async listDeliveries(appId: string, filters: DeliveryFilters): Promise<DeliveryPage> {
      const predicates = ["bot_id = ?"];
      const binds: (string | number)[] = [appId];
      if (filters.repo !== null) {
        predicates.push("repository_full_name = ?");
        binds.push(filters.repo);
      }
      if (filters.sinceDays !== null) {
        // why: The modifier is a validated integer, so this is not a bound value
        // SQLite could reinterpret.
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

    /**
     * note: Record one VERIFIED `pull_request` delivery (migration 0039) —
     * idempotent on the UNIQUE (bot_id, owner, repo, pr_number) tuple: a PR
     * that arrives several times (opened, synchronize, closed, …) keeps ONE
     * row and `title` / `state` / `head_sha` refresh only when the caller
     * supplies them (a payload that omits a field keeps the last known value
     * rather than blanking it). `first_seen_at` is written once, by the
     * INSERT.
     *
     * The timestamp is the single arbiter for BOTH columns, so the retention
     * predicate and this write agree on what "current" means:
     *   - `last_seen_at` takes the payload's `updated_at` (GitHub's clock)
     *     through `datetime()`, which also normalises ISO 8601 into the
     *     `YYYY-MM-DD HH:MM:SS` form the column's readers compare against, and
     *     it only ever advances (MAX).
     *   - `state` is accepted when the delivery is AT LEAST as new as the
     *     stored stamp. A replayed/out-of-order `closed` cannot overwrite a
     *     newer `open`, which was the shape that let retention delete a PR that
     *     had reopened. `merged` stays terminal regardless (GitHub sends it
     *     once, on the merge).
     *
     * Residual, not denied: `updated_at` is second-granular and delivery order
     * is not guaranteed, so a `closed` and the `reopened` that follows within
     * the SAME second cannot be ordered from payload data. The tie takes the
     * arriving delivery (`>=`), which means such a pair delivered out of order
     * can store `closed` under the reopen's stamp — the deletion shape above,
     * narrowed to same-second ties. `>` would merely invert which arrival wins
     * and would break a legitimate in-order close→reopen, so this layer accepts
     * the tie; any later delivery for the PR rewrites the row with a new stamp.
     *
     * `head_sha` / `head_at` (migration 0044). `head_at` is the ledger's
     * DELIVERY watermark — the `pull_request.updated_at` of the most recent
     * stamped delivery for this PR — not the arrival time of the stored sha,
     * so a delivery naming the same sha still moves it. `head_sha` itself
     * never rewinds:
     *   - a delivery that names a sha with no usable stamp
     *     (`excluded.head_at IS NULL`) only fills a still-unknown sha
     *     (`COALESCE(head_sha, excluded.head_sha)`) and leaves `head_at`
     *     untouched — an out-of-order arrival cannot rewind either column;
     *   - a stamped delivery at least as new as the stored one (or an UNKNOWN
     *     stored one, `head_at IS NULL`) advances both;
     *   - an older stamp → both untouched.
     */
    async upsertPullRequest(input: UpsertPullRequestInput): Promise<void> {
      // note: The target is the row's identity half. Refused here, before any bind,
      // so a caller that forgot it fails loudly instead of writing a row no
      // tenant read can ever reach (target_id is nullable in the DDL).
      if (typeof input.targetId !== "string" || input.targetId === "") {
        throw new Error("upsertPullRequest: targetId is required — the ledger key is (target_id, owner, repo, pr_number)");
      }
      // note: The canonical UTC ISO-8601 spelling (`new Date(v).toISOString()`) is a
      // PRECONDITION of the column, which is ordered lexically — a numeric
      // offset would sort wrongly against the stored `Z` values. Enforced here
      // rather than documented for the caller: a second writer cannot store an
      // unorderable spelling. `null` is the EXPLICIT "no usable stamp"
      // fallback, where arrival time is the only clock left.
      const seenAt = normalizeRfc3339(input.updatedAt) ?? null;
      // why: The pair below holds at the write: no sha, no stamp — otherwise a
      // delivery that carries a stamp but no sha would move the PR's delivery
      // watermark on behalf of a commit it never named.
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

    /**
     * note: The PR's head watermark — `head_sha` plus the ledger's DELIVERY stamp
     * (migration 0044: the `pull_request.updated_at` of the most recent
     * stamped delivery, not the sha's arrival time) — as ONE strongly
     * consistent point read on the ledger's own UNIQUE key. The queue consumer
     * reads it to decide whether a delivery it just dequeued has already been
     * overtaken by a newer commit.
     *
     * EXECUTION read: the job already names the target the webhook resolved,
     * so this binds the ledger key and no workspace. Missing row → `null` (an
     * unknown PR is never a reason to skip), and the two fields are reported
     * as the row holds them — a `null` stamp is "unknown", not "now".
     */
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

    /**
     * note: PR-ledger list face: the App's most recently active pull requests,
     * newest first, plus the face's whole repository option set, plus each
     * row's D11 reviewing projection. FIVE statements per call regardless of
     * N — the rows, the newest review per (owner, repo, pr_number) via a
     * ROW_NUMBER() window, the failure count
     * joined through `bot_installations`, the option set, and the App's live
     * review locks (`liveReviewLocks`) — never one query per row, and never a
     * second round trip for any of them (the lock read is issued beside the
     * batch, not after it).
     *
     * Capped at PULL_REQUEST_LIST_LIMIT: any third party who opens a PR mints
     * a row and the retention sweep only drains TERMINAL rows, so the table's
     * live set grows with every open PR across every installed repo. An
     * uncapped list would serialise all of it on every tab open; the cap is
     * the newest window an operator can act on, and the sweep bounds what
     * stays behind it.
     *
     * The cap bounds the WORK, not just the payload: both aggregate statements
     * are scoped to the same `(owner, repo, pr_number)` window (the identical
     * ORDER BY + LIMIT), so a large review/failure history behind the window is
     * never scanned or thrown away.
     *
     * `filter` narrows the WINDOW ITSELF, not the capped rows: the predicate
     * rides into the row statement and into both aggregate scopes, so the cap
     * bounds the FILTERED set — a repository whose every PR is older than the
     * unfiltered window is still reachable, and the aggregates still agree with
     * the rows. Filtering after the cap would show an empty list for exactly
     * the repositories the filter exists to reach.
     *
     * The fourth statement is that option set: the scope's DISTINCT
     * `owner/repo` values with NO LIMIT, because an option set capped like the
     * rows would drop the very repositories the filter exists to reach. It
     * rides the same batch — and binds only the tenant scope — so opening the
     * list is one round trip, not two.
     *
     * Failure attribution is the row's OWN `target_id` (migration 0060): the
     * bot-keyed join through `bot_installations` and `pull_requests` is gone,
     * so a bot with two targets in two workspaces counts each target's
     * failures once, for that target's workspace only. A row the ledger
     * cannot attribute carries NULL and is invisible here — the migration's
     * guards refuse to leave one behind.
     *
     * `ATTRIBUTION_EXCLUDED_STAGES` rows are NOT failures of the review —
     * each is per-round attribution written for rounds that continued
     * (`recheck` a budget skip / dead seat / invalid document, `usage` a
     * failed `usage_events` insert, `rate-limit` a GitHub-throttled
     * degraded-comment sweep), so a clean PR would otherwise read a non-zero
     * failure count. This count excludes the whole set, exactly as the sweep
     * and the detail face's own failure count and history do: one rule, so the
     * tab number, the pager and the rows can never disagree.
     */
    async listPullRequests(
      scope: LedgerScope,
      filter?: { owner: string; repo: string },
    ): Promise<{ rows: PullRequestRow[]; repos: string[] }> {
      // why: ONE suffix feeds the row statement and the window, so a change to the
      // window helper cannot leave the rows filtering after the cap.
      const repoPredicate = filter === undefined ? "" : PULL_REQUEST_REPO_PREDICATE;
      // note: The tenant binds leading every statement — one for a workspace scope,
      // two for a target scope (its id and the workspace that owns it).
      const scopeBinds = ledgerScopeBinds(scope);
      const window = pullRequestWindowSql(repoPredicate, scope);
      // note: The window's own binds (tenant set, repo filter, cap), spliced after
      // each aggregate's own leading predicate.
      const windowBinds = [
        ...scopeBinds,
        ...(filter === undefined ? [] : [filter.owner, filter.repo]),
        PULL_REQUEST_LIST_LIMIT,
      ];
      // note: The lock projection rides the same round trip: the ledger batch and
      // the App's live locks are independent reads, and only the first may
      // fail the payload.
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

    /**
     * note: ONE pull request's head row — the detail face's first read. The address
     * is the ledger's OWN key (target_id, owner, repo, pr_number): one target
     * can hold several repos, and a number is only unique WITHIN a repo, so a
     * number-only lookup would answer with a different repo's PR. A miss is
     * `null` — never a same-number row from another repo, and never a row
     * whose target belongs to another workspace.
     *
     * The newest review rides along as a whole row: it is the header's ONE
     * authoritative verdict/attribution source, so paging the reviews section
     * can never rewrite the headline. The counts are a separate read
     * (`countPullRequestRecords`), so the head stays one row plus one lookup.
     * The live-inflight projection is a second independent read on the same
     * round trip — the detail face's D11 badge — and its failure degrades that
     * one field to `unknown` rather than failing the head.
     */
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

    /**
     * note: The record totals — the head payload's `counts`. Every failure count on
     * this face (this one, the list's `failure_count`, the failures section's
     * `total`) carries ONE rule: `ATTRIBUTION_EXCLUDED_STAGES` rows are per-round
     * ATTRIBUTION for reviews that continued (`recheck` a budget skip / dead
     * seat / invalid document, `usage` a failed `usage_events` insert), not
     * failures of the review ledger this face pages, so a clean PR never
     * reports one. They stay in `review_failures` for the ops sweep to skip in
     * its own paging signal and for the log tail.
     *
     * `must_fix` is the PR's own count of must-fix findings, unfiltered and
     * unpaged: the family dot answers "does this PR have one", never "does the
     * loaded page show one".
     *
     * Findings are counted by LIFECYCLE STATE, exactly as the findings page is
     * read: `review_findings.state` is `open | addressed | dismissed`, and a
     * finding the pipeline already assessed as addressed or dismissed is not
     * work left on the PR — it must not keep the tab count or the dot alive.
     */
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

    /**
     * note: One page of a PR's findings, newest LIFECYCLE ROW first, optionally
     * filtered by an exact `mergeClass` (the wire's `severity`). The `total` is
     * the FILTERED count — the pager's denominator. `null` means the App's
     * ledger does not hold this PR (the route's 404), decided in the same
     * batch as the page.
     *
     * Findings come from `review_findings` (the lifecycle table): it carries
     * `finding_id` and the immutable original as JSON, so `severity` is its
     * `mergeClass` (the vocab-switch mapping `findings.severity` already
     * uses), and `title` / `file_path` / `line` / `body` are read out of
     * `original_json`.
     *
     * Only `state = 'open'` rows are listed and counted, the same lifecycle
     * predicate `countPullRequestRecords` applies: an addressed or dismissed
     * finding is history, not a record the operator still acts on, and the tab
     * count, the dot and the pager must agree with the list.
     *
     * Each row also carries `review_round`: the ordinal of the round that FIRST
     * reported it, read from `review_findings.first_seen_round` — the value
     * the lifecycle write stamped when the row was inserted. It is stored, not
     * derived from `reviews`. The divergence source is the artifact upsert's
     * `ON CONFLICT (installation_id, owner, repo, pr_number, head_sha) DO
     * NOTHING` (`store/artifact-store.ts`): one `reviews` row per distinct
     * head_sha, so a second review of the same head inserts no row and a
     * derived ordinal would number the two faces from different populations.
     * A published round with zero findings still writes its `reviews` row, and
     * a failed round never owns a finding. Migration 0020 creates the table
     * with `first_seen_round INTEGER NOT NULL` and no predecessor, so every
     * row has one and the read needs no COALESCE.
     *
     * The page is ordered by `rowid`, the immutable insert order — `updated_ms`
     * advances every time a review round re-reports an open finding, so
     * ordering by it would move a row between an offset page read and the next
     * (duplicating or skipping it). Reviews and failures sort by their own
     * immutable insert key for the same reason.
     */
    async listPullRequestFindings(
      scope: LedgerScope,
      owner: string,
      repo: string,
      prNumber: number,
      page: PullRequestPageRequest,
    ): Promise<PullRequestRecordPage<PullRequestFindingRow> | null> {
      const unclassified = page.unclassified === true;
      // invariant: `NOT IN` never matches a NULL column, yet a finding with no
      // `mergeClass` lands in the catch-all bucket too (the SPA reads it as
      // ""), so the complement must admit NULL explicitly.
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

    /**
     * note: One page of a PR's reviews, newest first — the history's first page is
     * its latest verdict. `null` = the App's ledger does not hold this PR.
     *
     * Each row carries the round ORDINAL and that round's run facts. The
     * ordinal is `reviews.round`, the publication round the consumer stamped
     * at insert — the same value `review_findings.first_seen_round` stores, so
     * a finding and the review that reported it print the same number. Rows
     * written before that column fall back to the PR's `reviews` ordered
     * oldest-first (`reviewed_at ASC, rowid ASC`, from 1), which is what the
     * pre-column faces displayed; paging never renumbers, because both
     * expressions cover the whole PR before the newest-first page slice.
     * `duration_ms` is NULL for rows written before the measurement.
     * `severity_counts` is the legacy `findings` rows attributed to that
     * review tallied per severity as JSON text, across every lifecycle
     * state; it is built from the rows themselves so a class added later
     * needs no statement edit. An empty JSON object (`{}`) when the round
     * reported none — `json_group_object` over zero grouped rows yields
     * `{}`, never NULL.
     */
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
        // note: Nullable columns pass through AS THEY ARE: the store reports what
        // the tables hold, and the route's wire mapping decides what the
        // client may receive (a NULL `provider` is a real, common row — the
        // v1 pipeline never records one).
        items: results[2]!.results as PullRequestReviewDetailRow[],
        total: countOf(results[1]!),
      };
    },

    /**
     * note: One page of a PR's review failures, newest first — the diagnostic
     * payload this face exists for. COUNT and SELECT carry the SAME
     * `ATTRIBUTION_EXCLUDED_STAGES` predicate `countPullRequestRecords` applies, so
     * the tab's number, this `total` and the pager agree with the rendered
     * rows. `null` = the App's ledger does not hold this PR.
     */
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

// --- bot scope (migration 0058, contract § 7.1) ------------------------------

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
  /** note: The owning workspace's display name; NULL for an unmapped bot. */
  workspace_name: string | null;
  /** note: 0/1: the bot's workspace IS the platform's official workspace. */
  is_official: number;
  /** note: Live `bot_installations` rows (`removed_at IS NULL`). */
  installation_count: number;
  /** note: Live `review_targets` rows (`deleted_at IS NULL`). */
  live_target_count: number;
};

/** note: The state a transition starts from: the live bot and its current scope. */
const BOT_SCOPE_READ_SQL = `
  SELECT scope, shared_at FROM review_bots WHERE id = ? AND deleted_at IS NULL`;

/**
 * note: The console's list. ONE statement for every bot: the workspace name, the
 * official-workspace comparison and the two counts are correlated subqueries,
 * never a read per row — the operator surface has no paging and a fan-out here
 * would be one round trip per bot.
 *
 * `is_official` resolves the designation the way the runtime read does: the
 * stored id must name a LIVE workspace. A retired tenant leaves both the
 * setting row and `bot_workspaces` behind, so comparing the id alone would
 * enable a share the share guard then refuses (the same predicate is spelled
 * in `officialWorkspaceGuardSql`).
 */
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

/**
 * note: The share's own guard, evaluated INSIDE the batch by both statements: the
 * bot's workspace IS the official workspace right now, and that workspace is
 * live. Reading the designation before the batch would let a share commit
 * against a value an operator had already cleared or re-pointed, so the row is
 * resolved in the same transaction that writes. The key comes from
 * `runtime-config-store`; this module never parses that row.
 */
const officialWorkspaceGuardSql = (botIdRef: string) => `EXISTS (
           SELECT 1 FROM bot_workspaces w
             JOIN review_runtime_settings s
               ON s.key = '${OFFICIAL_WORKSPACE_KEY}' AND s.value = w.workspace_id
             JOIN workspaces ws ON ws.id = w.workspace_id AND ws.deleted_at IS NULL
            WHERE w.bot_id = ${botIdRef})`;

/**
 * note: Audit row + scope write, in ONE batch, both carrying the same guards: the bot
 * is live, its current scope is still the transition's FROM state (so two
 * identical transitions land once), and — for a share — it belongs to the live
 * official workspace. A refused write therefore appends nothing. `before` is a
 * subquery against the not-yet-updated row: a bind cannot read the old value
 * after the write, and the `after` pair is the value the writer computed.
 */
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

/**
 * invariant: Unsharing is NOT gated on the official workspace: a stale share must stay
 * revocable by the only role that can revoke it. It is gated on the FROM state,
 * so a second revoke changes nothing.
 */
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

  // why: Every precondition is re-checked inside the batch, so the pre-read above
  // only names the refusal early — it authorizes nothing.
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

  // why: The guarded write changed nothing, so it appended no audit row either.
  // Re-read to say why: a bot retired in between is "not found"; a row that
  // already holds the target scope means a concurrent identical transition won,
  // which is this call's outcome too, carrying the state that was persisted;
  // otherwise the share's designation guard refused it (the only other guard,
  // since an unshare's FROM state is checked in the same statement).
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

/** note: The `pull_requests` columns the ledger reads (`number` = `pr_number`). */
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
  /** why: The stored ordinal of the round that first reported it (`review_findings.first_seen_round`). */
  review_round: number;
};

/** One `reviews` row as the detail face reads it — nullable columns honest. */
export type PullRequestReviewDetailRow = {
  verdict: string;
  model: string | null;
  provider: string | null;
  reviewed_at: string;
  head_sha: string;
  /**
   * note: The stored publication round (`reviews.round`), which can skip ordinals.
   * Rows written before migration 0050 fall back to their position in the
   * PR's oldest-first review history (1 = first).
   */
  round: number;
  /** note: Wall clock of the round in ms; NULL for rows written before the measurement. */
  duration_ms: number | null;
  /** invariant: Those findings per severity as JSON object text (`{"must-fix":2}`); `{}` when none. */
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

/** note: One live `review_inflight` row, narrowed to what the projection carries. */
type PullRequestLockRow = {
  owner: string;
  repo: string;
  pr_number: number;
  head_sha: string;
  acquired_at: string;
};

/** note: The lock map's key. Folded: the lock stores lowercase, the ledger does not. */
function pullRequestKey(owner: string, repo: string, prNumber: number): string {
  return `${owner.toLowerCase()}\u0000${repo.toLowerCase()}\u0000${prNumber}`;
}

/**
 * note: One PR's projection from the App-wide lock map. A `null` map is the failed
 * read, so the row reads `unknown` — never the idle `none`.
 */
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
  /** invariant: `findings` only: exact `mergeClass`; absent/`null` is no filter. */
  severity?: string | null;
  /**
   * invariant: `findings` only: the complement of `severity` — rows whose `mergeClass` is
   * outside `FINDING_SEVERITIES` (or absent). The route decides the
   * vocabulary; this store only excludes it.
   */
  unclassified?: boolean;
};

/** One record section's page: the rows plus the total the pager counts against. */
export type PullRequestRecordPage<T> = { items: T[]; total: number };

/**
 * note: Join the ledger list's result sets in memory — the tuple
 * (owner, repo, pr_number) is the key, and a PR with no review / no failure
 * reads `latest_review: null`, `failure_count: 0`. The live-inflight
 * projection joins the same tuple; its map being `null` (a failed read) reads
 * `unknown` on every row.
 */
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
