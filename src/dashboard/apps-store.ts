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
 * consumer. Its imports are zero-dependency contracts only
 * (src/contracts/sandbox-images.ts — the registry, not pipeline/review code —
 * and src/contracts/failure-stages.ts — the `review_failures` stage
 * partition), which bound the sandbox_image_id value domain and keep the
 * failure-count/history SQL off hand-written stage literals, plus the pure
 * types+constants packages/shared/src/runtime.ts, whose closed REVIEW_LEVELS
 * vocabulary is the review-level value domain (imported, never restated).
 * The one engine symbol pair (`PR_VERDICTS` / `PrVerdict`) is the review gate's
 * verdict vocabulary: it is imported, never restated, so a gate value the
 * engine rejects can never be stored (the src/review/schema.ts convention).
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
 *   - setReviewLevel (migration 0047) is the per-App review depth: `null` is
 *     the "follow the operator default" choice and writes the column back to
 *     NULL, a non-null level must be on the shared REVIEW_LEVELS vocabulary
 *     (the setReviewTriggerMode backstop; the DDL CHECK is the last line),
 *     and it writes review_level + updated_at, refusing soft-deleted rows
 *     exactly like setAppStatus. The read face is the row column itself, so
 *     parseAppReviewLevel is the one parser: an off-vocabulary stored value
 *     reads as absent, never as an error.
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
 *   - getCheckGate / saveCheckGate (migration 0045) are the review gate
 *     face: the gate is App configuration, the save refuses a score outside
 *     0..100 and a verdict outside the engine `PR_VERDICTS` vocabulary before
 *     any write (the settings route 400s first; the DDL CHECK is the score
 *     backstop only), and it writes updated_at (an operator mutation).
 *   - getAllowlist / saveAllowlist (migration 0045) are the owner allowlist
 *     face: the switch is App configuration and the owner set is REPLACED
 *     (delete-then-insert in ONE batch), never merged; saveAllowlist refuses
 *     a deduped set past ALLOWLIST_MAX_OWNERS and a soft-deleted or unknown
 *     App before writing (the setAppStatus rule).
 *   - getGithubVisibility / saveGithubVisibility (migration 0045) are the
 *     cached App-visibility face: NULL reads as 'unknown', and the writer is
 *     the metadata refresh's anonymous probe — machine-triggered, so like
 *     saveGithubMetadata it never writes updated_at.
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
 *     (app_id, installation_id) pairs, and unknown app references are
 *     caller-visible errors, never swallowed.
 */
import { PR_VERDICTS, type PrVerdict } from "@mstar-harness/engine";
import { isReviewLevel, REVIEW_LEVELS, type ReviewLevel } from "../../packages/shared/src/runtime";
import { PAGING_EXCLUDED_STAGES, sqlStageList } from "../contracts/failure-stages";
import { normalizeRfc3339 } from "../contracts/rfc3339";
import { MUST_FIX_SEVERITY } from "../contracts/finding-severity";
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
  /** GitHub login of the creating member (the manage rule is the workspace role). */
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
  /**
   * Per-App review depth (migration 0047): 'quick' | 'default' | 'deep' — the
   * packages/shared/src/runtime `REVIEW_LEVELS` vocabulary. NULL = no App
   * choice, i.e. follow the operator default (`review_runtime_settings` key
   * `review.level.default`); there is deliberately no backfill, so every App
   * starts NULL. Read it through parseAppReviewLevel, which treats an
   * off-vocabulary stored value as absent instead of throwing on the review
   * path.
   */
  review_level: string | null;
  /**
   * Review-gate score floor (migration 0045): a published review concludes
   * the Check `success` only when its tally score is at least this value.
   * The DDL CHECK bounds it to 0..100 and seeds 80.
   */
  check_min_score: number;
  /**
   * Review-gate passing verdicts (migration 0045): the JSON array of engine
   * `PR_VERDICTS` spellings that satisfy the gate; the DDL default seeds
   * `["ship it"]`. Written only by saveCheckGate, which validates the
   * vocabulary before the write — read it through getCheckGate.
   */
  check_pass_verdicts: string;
  /**
   * Owner allowlist switch (migration 0045): 1 = only allowlisted repository
   * owners are reviewed, 0 = every owner (today's behavior). Off by default;
   * on with an empty list refuses every owner.
   */
  allowlist_enabled: number;
  /**
   * Cached GitHub App visibility (migration 0045): 'public' | 'private' |
   * 'unknown', written by the anonymous `GET /apps/{slug}` probe. Two callers
   * probe — the metadata refresh and the allowlist save's forced probe — and
   * both treat a no-answer the same way: skip the write and keep the stored
   * value. NULL = never probed; getGithubVisibility reads it as 'unknown'
   * (cannot prove private). Admission never reads this column: the allowlist
   * applies whatever the visibility, which only picks the wording of the
   * allowlist control's private-App note.
   */
  github_visibility: GithubVisibility | null;
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

/**
 * Cached GitHub App visibility (migration 0045, the `github_visibility`
 * column value domain). `unknown` is also what a NULL column reads as. The
 * anonymous `GET /apps/{slug}` probe answers public/404 and `null` to a
 * no-answer; both callers keep the last stored value on `null`.
 */
export type GithubVisibility = "public" | "private" | "unknown";

/**
 * The stored per-App review level (migration 0047), or `null` when the row
 * carries no usable choice: a NULL column (follow the operator default) or a
 * value outside the shared `REVIEW_LEVELS` vocabulary. An off-vocabulary
 * stored value is UNTRUSTED and treated as absent — the review path falls back
 * to the operator default and never throws for a row it cannot read.
 */
export function parseAppReviewLevel(value: unknown): ReviewLevel | null {
  return isReviewLevel(value) ? value : null;
}

/**
 * The per-App review gate (migration 0045): a published review concludes the
 * Check `success` only when its verdict is on `passVerdicts` AND its tally
 * score is at least `minScore`. `passVerdicts` is engine `PR_VERDICTS`
 * vocabulary — saveCheckGate refuses anything else before writing.
 */
export type CheckGate = {
  /** Integer score floor, 0..100 inclusive (the DDL CHECK's domain). */
  minScore: number;
  /** Verdicts that satisfy the gate; `["ship it"]` until saved otherwise. */
  passVerdicts: readonly PrVerdict[];
};

/**
 * The stored verdict array, or `null` when the stored value is unreadable
 * (bad JSON, not an array, or off-vocabulary). `null` is unreadable
 * CONFIGURATION, never "the default": the Check lanes read the gate on every
 * terminalization and must fail closed on a row they cannot read.
 */
function storedPassVerdicts(raw: string): readonly PrVerdict[] | null {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.every((entry) => PR_VERDICTS.includes(entry as PrVerdict))) {
      return parsed as PrVerdict[];
    }
  } catch {
    // unreadable — reported as null below
  }
  return null;
}

/**
 * The per-App owner allowlist (migration 0045): `enabled` is the switch
 * (default off — every owner behaves as before) and `owners` the accepted
 * repository-owner logins. Enabled with an empty list refuses every owner.
 */
export type AppAllowlist = {
  enabled: boolean;
  owners: readonly string[];
};

/**
 * The owner allowlist's accepted size: the whole set is replaced inside ONE D1
 * batch, so an unbounded paste would build an arbitrarily large batch. 100
 * covers every realistic shared install. Enforced by `saveAllowlist` (the
 * layer that states the batch-size invariant) and, for the operator-facing
 * 400, by the settings route.
 */
export const ALLOWLIST_MAX_OWNERS = 100;

/**
 * Collapse the allowlist owner set: GitHub logins are case-insensitive, so
 * `Ada` and `ada` are ONE owner and the first submitted spelling is the one
 * kept. Order is NOT preserved: the table has no sequence column and
 * `getAllowlist` reads `ORDER BY owner_login`, so the settings form lists the
 * owners alphabetically however they were submitted.
 */
export function dedupeOwnerLogins(logins: readonly string[]): string[] {
  const seen = new Set<string>();
  return logins.filter((login) => {
    const folded = login.toLowerCase();
    if (seen.has(folded)) return false;
    seen.add(folded);
    return true;
  });
}

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
  /**
   * True when `accountLogin` is the installation's OWN account, as stated by an
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
 * The ledger list's ONE ordering (newest activity, number as the total-order
 * tiebreak). Shared by the row statement and the aggregate window so the two
 * cannot drift apart.
 */
const PULL_REQUEST_LEDGER_ORDER = "last_seen_at DESC, pr_number DESC";

/**
 * The repository predicate `listPullRequests` carries. It rides INSIDE the
 * window — in the row statement's own WHERE and in both aggregate scopes —
 * never after the cap: a filter applied to the capped rows would hide every
 * repository whose PRs sit behind PULL_REQUEST_LIST_LIMIT.
 */
const PULL_REQUEST_REPO_PREDICATE = " AND owner = ? AND repo = ?";

/**
 * The list's ONE bounded window. Used as the row statement's own predicate and
 * as the scope of both aggregate statements, so the payload is not merely
 * capped: the work is. A repository filter narrows the window ITSELF, so the
 * cap bounds the filtered set and the aggregates keep matching the rows.
 */
function pullRequestWindowSql(repoPredicate: string): string {
  return `SELECT owner, repo, pr_number FROM pull_requests
  WHERE app_id = ?${repoPredicate}
  ORDER BY ${PULL_REQUEST_LEDGER_ORDER} LIMIT ?`;
}

/**
 * Statement 0 of every record-section batch: is this PR on the ledger at all?
 * A section reader answers pages, not PR existence — `total: 0` covers both an
 * empty section and an unknown PR — so existence must be decided in the same
 * batch, and `null` (the route's 404) means "this App never received it".
 */
const PULL_REQUEST_EXISTS_SQL = `SELECT 1 AS found FROM pull_requests
  WHERE app_id = ? AND owner = ? AND repo = ? AND pr_number = ? LIMIT 1`;

/**
 * Slice to `max` UTF-16 units without leaving half a surrogate pair behind
 * (a lone surrogate cannot round-trip through D1's TEXT as valid UTF-8).
 */
function truncateBounded(value: string, max: number): string {
  if (value.length <= max) return value;
  const last = value.charCodeAt(max - 1);
  // A high surrogate at the cut means its low half is the next unit: drop both.
  return value.slice(0, last >= 0xd800 && last <= 0xdbff ? max - 1 : max);
}

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
  /**
   * The delivery's source repository (`owner/name`, migration 0043) — NULL
   * when the payload carried no `repository` (an install / bypass event).
   * Truncated to REPOSITORY_FULL_NAME_MAX_LENGTH (160) chars at persist; see
   * that constant for the trust model (a verified-body field, bounded as
   * defence-in-depth — not an attacker payload bound like `eventName`).
   */
  repositoryFullName: string | null;
};

/** A row of `webhook_deliveries` (D1 column names, snake_case; migration 0011). */
export type WebhookDeliveryRow = {
  id: string;
  app_id: string;
  event_name: string | null;
  outcome: DeliveryOutcome;
  status_code: number | null;
  /** `owner/name` of the source repo (0043); NULL = unknown source. */
  repository_full_name: string | null;
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

/** The `SELECT COUNT(*) AS n` row of a batch statement. */
type CountRow = { n: number };

/** One batch statement's `COUNT(*)` result. */
function countOf(result: AppsStoreBatchResult): number {
  const [row] = result.results as CountRow[];
  return row?.n ?? 0;
}

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

/**
 * The two `upsertInstallation` statements. Which one runs is chosen BEFORE
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
  authoritative: `INSERT INTO app_installations (id, app_id, installation_id, account_login, seen_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT (app_id, installation_id) DO UPDATE SET
      account_login = COALESCE(excluded.account_login, account_login),
      seen_at = datetime('now')`,
  inferred: `INSERT INTO app_installations (id, app_id, installation_id, account_login, seen_at)
    VALUES (?, ?, ?, ?, datetime('now'))
    ON CONFLICT (app_id, installation_id) DO UPDATE SET
      account_login = COALESCE(account_login, excluded.account_login),
      seen_at = datetime('now')`,
} as const;

/** Create the github_apps / app_installations store over one D1 handle. */
export function createAppsStore(db: AppsStoreD1) {
  /**
   * Bounded ledger retention (migration 0039). Terminal rows only: an open PR
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
          `SELECT app_id, id, event_name, outcome, status_code, repository_full_name, created_at FROM (
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

  /**
   * The App's live review locks, keyed by (owner, repo, pr_number) — or `null`
   * when the read failed, because a failed read IS the `unknown` wire value
   * (D16) and must not fail the whole PR face. ONE statement regardless of N:
   * the live set is bounded by the concurrency caps, and the join keeps it
   * inside this App's installations (the same attribution the failure count
   * uses). `expires_at > now` is the pipeline's own acquire predicate, and the
   * bound instant uses the ISO-8601-with-milliseconds form that column is
   * written in — the one form it orders correctly as text. Keys fold case
   * because the lock stores lowercase while the ledger keeps GitHub's spelling.
   */
  async function liveReviewLocks(
    appId: string,
  ): Promise<Map<string, PullRequestLockRow> | null> {
    try {
      const { results } = await db
        .prepare(
          `SELECT r.owner, r.repo, r.pr_number, r.head_sha, r.acquired_at
           FROM review_inflight r
           JOIN app_installations i ON i.installation_id = r.installation_id AND i.app_id = ?
           WHERE r.expires_at > ?`,
        )
        .bind(appId, new Date().toISOString())
        .all<PullRequestLockRow>();
      return new Map(results.map((row) => [pullRequestKey(row.owner, row.repo, row.pr_number), row]));
    } catch {
      return null;
    }
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
     * The App's review gate (migration 0045). Unknown id → null (the
     * getSandboxImageId convention). No tenant join: the gate is a
     * configuration value. A stored verdict array that is unparseable,
     * off-vocabulary or not an array also reads as null — the same
     * "unreadable" meaning, so every consumer fails closed instead of
     * inventing a permissive default.
     */
    async getCheckGate(appId: string): Promise<CheckGate | null> {
      const row = await db
        .prepare(`SELECT check_min_score, check_pass_verdicts FROM github_apps WHERE id = ?`)
        .bind(appId)
        .first<{ check_min_score: number; check_pass_verdicts: string }>();
      if (!row) return null;
      const passVerdicts = storedPassVerdicts(row.check_pass_verdicts);
      if (passVerdicts === null) return null;
      return { minScore: row.check_min_score, passVerdicts };
    },

    /**
     * The App's owner allowlist (migration 0045): the switch plus the owner
     * logins sorted by `owner_login` (SQLite's BINARY collation). The read is
     * alphabetical, NOT submission order — there is no sequence column, so the
     * settings form does not play the list back as it was saved. Unknown id →
     * null. ONE statement, so the switch and the owner set come from the same
     * snapshot — a save landing between two reads could otherwise admit against
     * a switch that no longer applies to the list it was read with.
     */
    async getAllowlist(appId: string): Promise<AppAllowlist | null> {
      const rows = await db
        .prepare(
          `SELECT g.allowlist_enabled AS enabled, a.owner_login
             FROM github_apps g
             LEFT JOIN app_owner_allowlist a ON a.app_id = g.id
            WHERE g.id = ?
            ORDER BY a.owner_login`,
        )
        .bind(appId)
        .all<{ enabled: number; owner_login: string | null }>();
      const [first] = rows.results;
      if (first === undefined) return null;
      return {
        enabled: first.enabled !== 0,
        owners: rows.results.flatMap((row) => (row.owner_login === null ? [] : [row.owner_login])),
      };
    },

    /**
     * The cached GitHub App visibility (migration 0045). Unknown id → null;
     * a never-probed App reads as 'unknown' (the column is NULL), which is
     * treated as "cannot prove private".
     */
    async getGithubVisibility(appId: string): Promise<GithubVisibility | null> {
      const row = await db
        .prepare(`SELECT github_visibility FROM github_apps WHERE id = ?`)
        .bind(appId)
        .first<{ github_visibility: GithubVisibility | null }>();
      if (!row) return null;
      return row.github_visibility ?? "unknown";
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
     * Select the App's review level (migration 0047). `null` is the
     * "follow the operator default" choice and writes the column back to NULL,
     * so it is a successful write, not a no-op. A non-null level must be on the
     * shared `REVIEW_LEVELS` vocabulary — anything else throws BEFORE any write
     * (the setReviewTriggerMode backstop; the settings route 400s first, and
     * the DDL CHECK is the last line). Writes review_level + updated_at (an
     * operator mutation, the setReviewEnabled convention) and refuses
     * soft-deleted rows exactly like setAppStatus. Returns whether a row
     * changed (false also covers unknown ids).
     */
    async setReviewLevel(id: string, level: ReviewLevel | null): Promise<boolean> {
      if (level !== null && !isReviewLevel(level)) {
        throw new Error(
          `apps-store: review level ${JSON.stringify(level)} is not on the vocabulary (${REVIEW_LEVELS.join(" | ")}) — zero rows written`,
        );
      }
      const res = await db
        .prepare(
          `UPDATE github_apps SET review_level = ?, updated_at = datetime('now')
           WHERE id = ? AND deleted_at IS NULL`,
        )
        .bind(level, id)
        .run();
      return res.meta.changes > 0;
    },

    /**
     * Save the App's review gate (migration 0045). The score must be an
     * integer in 0..100 and every verdict must be on the engine `PR_VERDICTS`
     * vocabulary — anything else throws BEFORE any write (the
     * setReviewTriggerMode backstop; the settings route answers 400 first,
     * and the DDL CHECK is the last line for the score). The verdict array is
     * stored as JSON, the form the DDL default uses. Writes the two gate
     * columns + updated_at (an operator mutation) and refuses soft-deleted
     * rows exactly like setAppStatus. Returns whether a row changed (false
     * also covers unknown ids).
     */
    async saveCheckGate(id: string, gate: CheckGate): Promise<boolean> {
      if (!Number.isInteger(gate.minScore) || gate.minScore < 0 || gate.minScore > 100) {
        throw new Error(
          `apps-store: check gate min score ${JSON.stringify(gate.minScore)} is outside 0..100 — zero rows written`,
        );
      }
      for (const verdict of gate.passVerdicts) {
        if (!PR_VERDICTS.includes(verdict)) {
          throw new Error(
            `apps-store: check gate verdict ${JSON.stringify(verdict)} is not on PR_VERDICTS (${PR_VERDICTS.join(" | ")}) — zero rows written`,
          );
        }
      }
      const res = await db
        .prepare(
          `UPDATE github_apps
           SET check_min_score = ?, check_pass_verdicts = ?, updated_at = datetime('now')
           WHERE id = ? AND deleted_at IS NULL`,
        )
        .bind(gate.minScore, JSON.stringify(gate.passVerdicts), id)
        .run();
      return res.meta.changes > 0;
    },

    /**
     * Save the App's owner allowlist (migration 0045): the switch plus the
     * owner set, which is REPLACED — delete-then-insert in ONE batch, so a
     * removal is written by the same operation that adds. Duplicate logins
     * collapse case-insensitively (GitHub logins are case-insensitive; the
     * first spelling is kept), because SQLite's (app_id, owner_login) key is
     * case-sensitive; an empty set is legal and, with the switch on, refuses
     * every owner (fail closed).
     * Refuses a soft-deleted or unknown App BEFORE writing (the setAppStatus
     * rule) and writes updated_at (an operator mutation). Refuses a collapsed
     * set larger than ALLOWLIST_MAX_OWNERS, also before any read: this method
     * is where the one-batch bound is documented, so it enforces it for direct
     * callers too. Returns whether the
     * App row was still live when the batch ran: every batch statement — the
     * DELETE, each INSERT and the UPDATE — repeats the `deleted_at IS NULL`
     * predicate, so a delete landing between the pre-read and the batch writes
     * nothing at all (no orphan owner rows) and the UPDATE's change count
     * reports `false` instead of a save that never took effect.
     */
    async saveAllowlist(id: string, allowlist: AppAllowlist): Promise<boolean> {
      // Collapse first: the INSERT count is the deduped set, so duplicates
      // must not consume the budget.
      const owners = dedupeOwnerLogins(allowlist.owners);
      if (owners.length > ALLOWLIST_MAX_OWNERS) {
        throw new Error(
          `apps-store: owner allowlist holds ${owners.length} logins, above ALLOWLIST_MAX_OWNERS (${ALLOWLIST_MAX_OWNERS}) — zero rows written`,
        );
      }
      const live = await db
        .prepare(`SELECT id FROM github_apps WHERE id = ? AND deleted_at IS NULL`)
        .bind(id)
        .first<{ id: string }>();
      if (!live) return false;
      // Every statement repeats the liveness predicate: a soft delete landing
      // between the pre-read and the batch then writes NO owner rows and does
      // not flip the switch, instead of leaving a deleted App's list behind.
      // ONE batch on purpose: chunking was tried and reverted because a split
      // replace is not atomic — a failed later chunk leaves a partial owner
      // set. The statement count (ALLOWLIST_MAX_OWNERS + 2) stays below any
      // observed D1 batch limit.
      const liveApp = `EXISTS (SELECT 1 FROM github_apps g WHERE g.id = ? AND g.deleted_at IS NULL)`;
      const results = await db.batch([
        db.prepare(`DELETE FROM app_owner_allowlist WHERE app_id = ? AND ${liveApp}`).bind(id, id),
        ...owners.map((owner) =>
          db
            .prepare(
              `INSERT INTO app_owner_allowlist (app_id, owner_login, created_at)
               SELECT ?, ?, datetime('now') WHERE ${liveApp}`,
            )
            .bind(id, owner, id),
        ),
        db
          .prepare(
            `UPDATE github_apps SET allowlist_enabled = ?, updated_at = datetime('now')
             WHERE id = ? AND deleted_at IS NULL`,
          )
          .bind(allowlist.enabled ? 1 : 0, id),
      ]);
      return (results.at(-1)?.meta.changes ?? 0) > 0;
    },

    /**
     * Cache the App's GitHub visibility (migration 0045) from the anonymous
     * probe (the metadata refresh and the allowlist save both call this).
     * Writes ONLY github_visibility — deliberately
     * NOT updated_at, which stays the operator-mutation timestamp (the
     * saveGithubMetadata convention: this write is machine-triggered).
     * Refuses soft-deleted rows exactly like setAppStatus. Returns whether a
     * row changed (false also covers unknown ids).
     */
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
      await db
        .prepare(
          `INSERT INTO webhook_deliveries (id, app_id, event_name, outcome, status_code, repository_full_name)
           VALUES (?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          input.appId,
          eventName,
          input.outcome,
          input.statusCode,
          repositoryFullName,
        )
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
     * and deterministic), bounded by the caller's N (default 10).
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
    async listRecentDeliveries(appId: string, limit = 10): Promise<WebhookDeliveryRow[]> {
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
      // The canonical UTC ISO-8601 spelling (`new Date(v).toISOString()`) is a
      // PRECONDITION of the column, which is ordered lexically — a numeric
      // offset would sort wrongly against the stored `Z` values. Enforced here
      // rather than documented for the caller: a second writer cannot store an
      // unorderable spelling. `null` is the EXPLICIT "no usable stamp"
      // fallback, where arrival time is the only clock left.
      const seenAt = normalizeRfc3339(input.updatedAt) ?? null;
      // The pair below holds at the write: no sha, no stamp — otherwise a
      // delivery that carries a stamp but no sha would move the PR's delivery
      // watermark on behalf of a commit it never named.
      const headAt = input.headSha === undefined || input.headSha === null ? null : seenAt;
      await db
        .prepare(
          `INSERT INTO pull_requests
             (id, app_id, owner, repo, pr_number, title, state, head_sha, head_at, last_seen_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(datetime(?), datetime('now')))
           ON CONFLICT (app_id, owner, repo, pr_number) DO UPDATE SET
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
     * The PR's head watermark — `head_sha` plus the ledger's DELIVERY stamp
     * (migration 0044: the `pull_request.updated_at` of the most recent
     * stamped delivery, not the sha's arrival time) — as ONE strongly
     * consistent point read on the ledger's own UNIQUE key. The queue consumer
     * reads it to decide whether a delivery it just dequeued has already been
     * overtaken by a newer commit.
     *
     * Missing row → `null` (an unknown PR is never a reason to skip), and the
     * two fields are reported as the row holds them — a `null` stamp is
     * "unknown", not "now".
     */
    async selectPrHead(input: {
      appId: string;
      owner: string;
      repo: string;
      prNumber: number;
    }): Promise<{ headSha: string | null; headAt: string | null } | null> {
      const row = await db
        .prepare(
          `SELECT head_sha, head_at FROM pull_requests
           WHERE app_id = ? AND owner = ? AND repo = ? AND pr_number = ?`,
        )
        .bind(input.appId, input.owner, input.repo, input.prNumber)
        .first<{ head_sha: string | null; head_at: string | null }>();
      return row === null ? null : { headSha: row.head_sha, headAt: row.head_at };
    },

    /**
     * PR-ledger list face: the App's most recently active pull requests,
     * newest first, plus the face's whole repository option set, plus each
     * row's D11 reviewing projection. FIVE statements per call regardless of
     * N — the rows, the newest review per (owner, repo, pr_number) via a
     * ROW_NUMBER() window (the deliverySummaries shape), the failure count
     * joined through `app_installations`, the option set, and the App's live
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
     * The fourth statement is that option set: the App's DISTINCT
     * `owner/repo` values with NO LIMIT, because an option set capped like the
     * rows would drop the very repositories the filter exists to reach. It
     * rides the same batch — and binds only `appId` — so opening the list is
     * one round trip, not two.
     *
     * Failure attribution assumes ONE installation per App. `app_installations`
     * permits the same installation id under two App rows, and in that case a
     * failure row would count toward both — accepted, because the alternative
     * (a constraint) would refuse a legitimate re-install shape, and a
     * cross-App duplicate is a config mistake visible in the delivery health
     * panel, not a silent data problem.
     *
     * `PAGING_EXCLUDED_STAGES` rows are NOT failures of the review:
     * both are per-round attribution written for rounds that continued
     * (`recheck` a budget skip / dead seat / invalid document, `usage` a
     * failed `usage_events` insert), so a clean PR would otherwise read a
     * non-zero failure count. This count excludes both, exactly as the sweep
     * and the detail face's own failure count and history do: one rule, so the
     * tab number, the pager and the rows can never disagree.
     */
    async listPullRequests(
      appId: string,
      filter?: { owner: string; repo: string },
    ): Promise<{ rows: PullRequestRow[]; repos: string[] }> {
      // One binding list per window scope: the App, then the repository when
      // the caller filtered. The row statement takes it once before the limit;
      // each aggregate takes its own app_id first, then that same list for the
      // window subquery, then the limit — the order each SQL splices its `?` in.
      const scope = filter === undefined ? [appId] : [appId, filter.owner, filter.repo];
      // ONE suffix feeds the row statement and the window, so a change to the
      // window helper cannot leave the rows filtering after the cap.
      const repoPredicate = filter === undefined ? "" : PULL_REQUEST_REPO_PREDICATE;
      const window = pullRequestWindowSql(repoPredicate);
      // The lock projection rides the same round trip: the ledger batch and
      // the App's live locks are independent reads, and only the first may
      // fail the payload.
      const [results, locks] = await Promise.all([
        db.batch([
          db
            .prepare(
              `SELECT owner, repo, pr_number, title, state, head_sha, first_seen_at, last_seen_at
               FROM pull_requests WHERE app_id = ?${repoPredicate}
               ORDER BY ${PULL_REQUEST_LEDGER_ORDER}
               LIMIT ?`,
            )
            .bind(...scope, PULL_REQUEST_LIST_LIMIT),
          db
            .prepare(
              `SELECT owner, repo, pr_number, verdict, reviewed_at FROM (
                 SELECT owner, repo, pr_number, verdict, reviewed_at,
                        ROW_NUMBER() OVER (PARTITION BY owner, repo, pr_number
                          ORDER BY reviewed_at DESC, rowid DESC) AS rn
                 FROM reviews
                 WHERE app_id = ?
                   AND (owner, repo, pr_number) IN (${window})
               ) WHERE rn = 1`,
            )
            .bind(appId, ...scope, PULL_REQUEST_LIST_LIMIT),
          db
            .prepare(
              `SELECT f.owner, f.repo, f.pr_number, COUNT(*) AS n
               FROM review_failures f
               JOIN app_installations i ON i.installation_id = f.installation_id AND i.app_id = ?
               WHERE f.stage NOT IN (${sqlStageList(PAGING_EXCLUDED_STAGES)})
                 AND (f.owner, f.repo, f.pr_number) IN (${window})
               GROUP BY f.owner, f.repo, f.pr_number`,
            )
            .bind(appId, ...scope, PULL_REQUEST_LIST_LIMIT),
          db
            .prepare(
              `SELECT DISTINCT owner, repo FROM pull_requests WHERE app_id = ?
               ORDER BY owner, repo`,
            )
            .bind(appId),
        ]),
        liveReviewLocks(appId),
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
     * ONE pull request's head row — the detail face's first read. The address
     * is the ledger's OWN key (app_id, owner, repo, pr_number): one App can be
     * installed on several repos, and a number is only unique WITHIN a repo,
     * so a number-only lookup would answer with a different repo's PR. A miss
     * is `null` — never a same-number row from another repo.
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
      appId: string,
      owner: string,
      repo: string,
      prNumber: number,
    ): Promise<PullRequestHeadRow | null> {
      const [results, locks] = await Promise.all([
        db.batch([
          db
            .prepare(
              `SELECT owner, repo, pr_number, title, state, head_sha, first_seen_at, last_seen_at
               FROM pull_requests WHERE app_id = ? AND owner = ? AND repo = ? AND pr_number = ?`,
            )
            .bind(appId, owner, repo, prNumber),
          db
            .prepare(
              `SELECT verdict, summary_md, model, provider, reviewed_at, head_sha FROM reviews
               WHERE app_id = ? AND owner = ? AND repo = ? AND pr_number = ?
               ORDER BY reviewed_at DESC, rowid DESC LIMIT 1`,
            )
            .bind(appId, owner, repo, prNumber),
        ]),
        liveReviewLocks(appId),
      ]);
      const row = results[0]!.results[0] as PullRequestBaseRow | undefined;
      if (row === undefined) return null;
      return {
        ...row,
        latest_review: (results[1]!.results[0] as PullRequestReviewDetailRow | undefined) ?? null,
        reviewing: reviewingOf(locks, owner, repo, prNumber),
      };
    },

    /**
     * The record totals — the head payload's `counts`. Every failure count on
     * this face (this one, the list's `failure_count`, the failures section's
     * `total`) carries ONE rule: `PAGING_EXCLUDED_STAGES` rows are per-round
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
      appId: string,
      owner: string,
      repo: string,
      prNumber: number,
    ): Promise<PullRequestRecordCounts> {
      const results = await db.batch([
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM review_findings
             WHERE app_id = ? AND owner = ? AND repo = ? AND pr_number = ? AND state = 'open'`,
          )
          .bind(appId, owner, repo, prNumber),
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM reviews
             WHERE app_id = ? AND owner = ? AND repo = ? AND pr_number = ?`,
          )
          .bind(appId, owner, repo, prNumber),
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM review_failures f
             JOIN app_installations i ON i.installation_id = f.installation_id AND i.app_id = ?
             WHERE f.stage NOT IN (${sqlStageList(PAGING_EXCLUDED_STAGES)})
               AND f.owner = ? AND f.repo = ? AND f.pr_number = ?`,
          )
          .bind(appId, owner, repo, prNumber),
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM review_findings
             WHERE app_id = ? AND owner = ? AND repo = ? AND pr_number = ? AND state = 'open'
               AND json_extract(original_json, '$.mergeClass') = ?`,
          )
          .bind(appId, owner, repo, prNumber, MUST_FIX_SEVERITY),
      ]);
      return {
        findings: countOf(results[0]!),
        reviews: countOf(results[1]!),
        failures: countOf(results[2]!),
        must_fix: countOf(results[3]!),
      };
    },

    /**
     * One page of a PR's findings, newest LIFECYCLE ROW first, optionally
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
     * The page is ordered by `rowid`, the immutable insert order — `updated_ms`
     * advances every time a review round re-reports an open finding, so
     * ordering by it would move a row between an offset page read and the next
     * (duplicating or skipping it). Reviews and failures sort by their own
     * immutable insert key for the same reason.
     */
    async listPullRequestFindings(
      appId: string,
      owner: string,
      repo: string,
      prNumber: number,
      page: PullRequestPageRequest,
    ): Promise<PullRequestRecordPage<PullRequestFindingRow> | null> {
      const filter =
        page.severity === undefined || page.severity === null
          ? ""
          : " AND json_extract(original_json, '$.mergeClass') = ?";
      const filterBinds = filter === "" ? [] : [page.severity];
      const results = await db.batch([
        db.prepare(PULL_REQUEST_EXISTS_SQL).bind(appId, owner, repo, prNumber),
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM review_findings
             WHERE app_id = ? AND owner = ? AND repo = ? AND pr_number = ? AND state = 'open'${filter}`,
          )
          .bind(appId, owner, repo, prNumber, ...filterBinds),
        db
          .prepare(
            `SELECT finding_id,
                    json_extract(original_json, '$.mergeClass') AS severity,
                    json_extract(original_json, '$.title') AS title,
                    json_extract(original_json, '$.filePath') AS file_path,
                    json_extract(original_json, '$.lineStart') AS line,
                    json_extract(original_json, '$.body') AS body
             FROM review_findings
             WHERE app_id = ? AND owner = ? AND repo = ? AND pr_number = ? AND state = 'open'${filter}
             ORDER BY rowid DESC
             LIMIT ? OFFSET ?`,
          )
          .bind(appId, owner, repo, prNumber, ...filterBinds, page.limit, page.offset),
      ]);
      if (results[0]!.results.length === 0) return null;
      return {
        items: results[2]!.results as PullRequestFindingRow[],
        total: countOf(results[1]!),
      };
    },

    /**
     * One page of a PR's reviews, newest first — the history's first page is
     * its latest verdict. `null` = the App's ledger does not hold this PR.
     */
    async listPullRequestReviews(
      appId: string,
      owner: string,
      repo: string,
      prNumber: number,
      page: PullRequestPageRequest,
    ): Promise<PullRequestRecordPage<PullRequestReviewDetailRow> | null> {
      const results = await db.batch([
        db.prepare(PULL_REQUEST_EXISTS_SQL).bind(appId, owner, repo, prNumber),
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM reviews
             WHERE app_id = ? AND owner = ? AND repo = ? AND pr_number = ?`,
          )
          .bind(appId, owner, repo, prNumber),
        db
          .prepare(
            `SELECT verdict, summary_md, model, provider, reviewed_at, head_sha
             FROM reviews WHERE app_id = ? AND owner = ? AND repo = ? AND pr_number = ?
             ORDER BY reviewed_at DESC, rowid DESC
             LIMIT ? OFFSET ?`,
          )
          .bind(appId, owner, repo, prNumber, page.limit, page.offset),
      ]);
      if (results[0]!.results.length === 0) return null;
      return {
        // Nullable columns pass through AS THEY ARE: the store reports what
        // the tables hold, and the route's wire mapping decides what the
        // client may receive (a NULL `provider` is a real, common row — the
        // v1 pipeline never records one).
        items: results[2]!.results as PullRequestReviewDetailRow[],
        total: countOf(results[1]!),
      };
    },

    /**
     * One page of a PR's review failures, newest first — the diagnostic
     * payload this face exists for. COUNT and SELECT carry the SAME
     * `PAGING_EXCLUDED_STAGES` predicate `countPullRequestRecords` applies, so
     * the tab's number, this `total` and the pager agree with the rendered
     * rows. `null` = the App's ledger does not hold this PR.
     */
    async listPullRequestFailures(
      appId: string,
      owner: string,
      repo: string,
      prNumber: number,
      page: PullRequestPageRequest,
    ): Promise<PullRequestRecordPage<PullRequestFailureDetailRow> | null> {
      const results = await db.batch([
        db.prepare(PULL_REQUEST_EXISTS_SQL).bind(appId, owner, repo, prNumber),
        db
          .prepare(
            `SELECT COUNT(*) AS n
             FROM review_failures f
             JOIN app_installations i ON i.installation_id = f.installation_id AND i.app_id = ?
             WHERE f.stage NOT IN (${sqlStageList(PAGING_EXCLUDED_STAGES)})
               AND f.owner = ? AND f.repo = ? AND f.pr_number = ?`,
          )
          .bind(appId, owner, repo, prNumber),
        db
          .prepare(
            `SELECT f.stage, f.error, f.created_at
             FROM review_failures f
             JOIN app_installations i ON i.installation_id = f.installation_id AND i.app_id = ?
             WHERE f.stage NOT IN (${sqlStageList(PAGING_EXCLUDED_STAGES)})
               AND f.owner = ? AND f.repo = ? AND f.pr_number = ?
             ORDER BY f.created_at DESC, f.rowid DESC
             LIMIT ? OFFSET ?`,
          )
          .bind(appId, owner, repo, prNumber, page.limit, page.offset),
      ]);
      if (results[0]!.results.length === 0) return null;
      return {
        items: results[2]!.results as PullRequestFailureDetailRow[],
        total: countOf(results[1]!),
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

/**
 * The detail head: the ledger row plus its newest review (whole row, nullable)
 * — the header's authoritative verdict and attribution — and the D11
 * live-inflight projection.
 */
export type PullRequestHeadRow = PullRequestBaseRow & {
  latest_review: PullRequestReviewDetailRow | null;
  reviewing: PullRequestReviewing;
};

/** One live `review_inflight` row, narrowed to what the projection carries. */
type PullRequestLockRow = {
  owner: string;
  repo: string;
  pr_number: number;
  head_sha: string;
  acquired_at: string;
};

/** The lock map's key. Folded: the lock stores lowercase, the ledger does not. */
function pullRequestKey(owner: string, repo: string, prNumber: number): string {
  return `${owner.toLowerCase()}\u0000${repo.toLowerCase()}\u0000${prNumber}`;
}

/**
 * One PR's projection from the App-wide lock map. A `null` map is the failed
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
  /** `findings` only: exact `mergeClass`; absent/`null` is no filter. */
  severity?: string | null;
};

/** One record section's page: the rows plus the total the pager counts against. */
export type PullRequestRecordPage<T> = { items: T[]; total: number };

/**
 * Join the ledger list's result sets in memory — the tuple
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
