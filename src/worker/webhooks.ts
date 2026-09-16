/**
 * Webhook verification + event filtering (pure, testable).
 *
 * Fail-closed secret policy (compass S4, along M0): missing, empty, or the
 * Probot default "development" secret → reject with zero side effects.
 * Signature verification uses `@octokit/webhooks` (Web Crypto, workerd-safe).
 * Every reject path logs a structured warning (no secret material) so the
 * operator can spot bad configurations / probes (Phase 5 B6).
 *
 * Event whitelist (spec review-trigger-policy §2.1):
 * - `pull_request.{opened,synchronize,reopened}` filtered by the resolved
 *   App's `review_trigger_mode`: `open` auto-triggers `opened` only,
 *   `every_push` (the default) all three, `manual` none.
 * - `issue_comment.created` whose body contains the App's bot mention
 *   `@{appSlug}` as a standalone token (spec §3 grammar), on a pull request
 *   thread, sent by a non-bot whose login is the PR author or the repository
 *   owner (Phase 5 B5 actor allowlist — prevents quota abuse by arbitrary
 *   commenters on public installs).
 * Everything else returns 200 quickly — GitHub retries non-2xx, so
 * uninteresting events must not 4xx.
 */
import { Webhooks } from "@octokit/webhooks";
import { z } from "zod";
import type { ReviewJobPayload } from "../contracts/review-job";
import type { ReviewTriggerMode } from "../dashboard/apps-store";
import type { HandlerLog } from "./handlers";

export const PULL_REQUEST_ACTIONS = ["opened", "synchronize", "reopened"] as const;

/**
 * The per-App trigger inputs classification branches on (spec
 * review-trigger-policy §2 read path): the resolved row's
 * `review_trigger_mode` and its slug (the mention target — one App's
 * mention never triggers another App). The per-App webhook route passes
 * both from the already-resolved row — no second lookup. An omitted
 * context defaults to `every_push` with NO mention target (empty slug never
 * matches — fail-safe: no trigger rather than a spurious one).
 */
export type ReviewTriggerContext = { mode: ReviewTriggerMode; appSlug: string };

/**
 * The GitHub login continuation set (spec §3): `A-Z a-z 0-9 -`. A mention
 * match is a standalone token only when the characters immediately before
 * `@` and immediately after the slug are BOTH outside this set (absent
 * counts as outside). Hyphens continue a login, so `@slug-other` /
 * `@slugbot` never match and an email-shaped `name@slug.host` never matches.
 */
const LOGIN_CONTINUATION = /[a-z0-9-]/;

/**
 * Whether `body` mentions the App's bot: contains `@{appSlug}` (ASCII
 * case-insensitive, literal) as a standalone token per the LOGIN_CONTINUATION
 * boundary rule. Any position in the body; the mention IS the entire
 * grammar (spec §3 — no wording, no commands).
 */
function bodyMentionsApp(body: string, appSlug: string): boolean {
  if (!appSlug) {
    return false;
  }
  const haystack = body.toLowerCase();
  const needle = `@${appSlug}`.toLowerCase();
  let from = 0;
  for (;;) {
    const idx = haystack.indexOf(needle, from);
    if (idx === -1) {
      return false;
    }
    const before = idx > 0 ? haystack[idx - 1]! : "";
    const after = idx + needle.length < haystack.length ? haystack[idx + needle.length]! : "";
    if (!LOGIN_CONTINUATION.test(before) && !LOGIN_CONTINUATION.test(after)) {
      return true;
    }
    from = idx + 1;
  }
}

/**
 * §2.1 matrix for the auto (pull_request) face: `open` enqueues `opened`
 * only; `every_push` enqueues all whitelisted actions; `manual` never
 * auto-triggers (a bot mention is the only trigger).
 */
function autoTriggerAllows(mode: ReviewTriggerMode, action: string): boolean {
  if (mode === "manual") {
    return false;
  }
  return mode === "open" ? action === "opened" : true;
}

/** Webhook body size cap (B6): checked BEFORE the body is buffered (413). */
export const WEBHOOK_BODY_LIMIT = 1_000_000;

/**
 * Module-level verifier cache (QC F-005; the hardening item /
 * architect lock L1): the hot path constructed a `Webhooks` instance per
 * request only to call `verify`, which uses nothing but `options.secret`.
 * KEYED BY CACHEKEY, NOT the raw secret: each entry is `{ secret, webhooks }`
 * under the caller's cache key — each per-App `POST /webhook/:appSlug`
 * route passes its `github_apps.id` — so per-App isolation holds AND a
 * cached entry whose `secret` differs from the caller's current secret
 * (credential rotation) is rebuilt and REPLACED: the rotated secret
 * verifies with the NEW secret only, and the old entry is evicted exactly
 * (no LRU wait). The bound is STRUCTURAL (≤ github_apps rows — keys are
 * drawn from the fixed universe of row ids), so no eviction policy is
 * tunable or needed; an entry outliving its row (soft-deleted App) is dead
 * weight only — that route 404s before classifyWebhook, so the entry can
 * never be hit again. `getWebhooks` stays exported as a test seam to lock
 * the reuse and rotation-replace behavior; the worker always passes an
 * explicit cacheKey, and direct callers that omit it fall back to the
 * legacy secret-keyed memoization.
 */
type VerifierCacheEntry = { secret: string; webhooks: Webhooks };

const webhooksCache = new Map<string, VerifierCacheEntry>();

export function getWebhooks(cacheKey: string, secret: string): Webhooks {
  const cached = webhooksCache.get(cacheKey);
  if (cached !== undefined && cached.secret === secret) {
    return cached.webhooks;
  }
  // First use for this cacheKey, or a SECRET MISMATCH (rotation): build and
  // REPLACE the entry — the old instance (and its old secret) is dropped
  // exactly, never retained alongside the new one.
  const webhooks = new Webhooks({ secret });
  webhooksCache.set(cacheKey, { secret, webhooks });
  return webhooks;
}

/**
 * Verify a signature, treating any throw as invalid (QC F-001). On the
 * deployed Worker, wrangler resolves `@octokit/webhooks-methods` via the
 * `browser` condition → WebCrypto verify → `hexToUInt8Array` throws a
 * TypeError on malformed (non-hex) signatures, while Bun/node resolves the
 * `node` condition → `timingSafeEqual` → returns false. Both must fail
 * closed with 401; this wrapper unifies the two paths and logs the
 * malformed input structurally so the operator can spot it. `event` is the
 * real GitHub event when the caller knows it (log hygiene) — the
 * warn falls back to a stage label, never the literal "unknown".
 */
export async function verifySignature(
  verify: (rawBody: string, signature: string) => Promise<boolean>,
  rawBody: string,
  signature: string,
  log?: HandlerLog,
  event?: string,
): Promise<boolean> {
  try {
    return await verify(rawBody, signature);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log?.warn(
      { event: event ?? "signature_verification_error", reason: "signature verification threw", detail },
      "malformed signature rejected with 401",
    );
    return false;
  }
}

/**
 * Classifier outcome. The `job` payload NEVER carries `appRef`
 * (AL-24-2/4): the classifier is secret-parameterized only and never sees
 * the App identity — the ONLY production attach point is the per-App
 * `POST /webhook/:appSlug` route, which adds `appRef: { appId }` after
 * classification, before enqueue.
 */
export type WebhookOutcome =
  | { kind: "reject"; status: 400 | 401 | 500; reason: string }
  | { kind: "ignore"; reason: string }
  | { kind: "job"; payload: Omit<ReviewJobPayload, "appRef"> };

/** Minimal webhook payload shapes — only the fields the gateway consumes. */
const installationSchema = z.object({ id: z.number() }).nullable().optional();
const repositorySchema = z
  .object({ name: z.string(), owner: z.object({ login: z.string() }) })
  .nullable()
  .optional();

const pullRequestSchema = z.object({
  action: z.string(),
  number: z.number().optional(),
  installation: installationSchema,
  pull_request: z
    .object({
      number: z.number().optional(),
      head: z.object({ sha: z.string().nullable().optional() }).optional(),
    })
    .nullable()
    .optional(),
  repository: repositorySchema,
});

const issueCommentSchema = z.object({
  action: z.string(),
  installation: installationSchema,
  comment: z.object({ body: z.string() }).nullable().optional(),
  issue: z
    .object({
      number: z.number(),
      // PR author (issue.user.login) — the actor allowlist (B5).
      user: z.object({ login: z.string() }).nullable().optional(),
      pull_request: z.unknown().optional(),
    })
    .nullable()
    .optional(),
  repository: repositorySchema,
  // Commenter identity: type (bot guard) + login (actor allowlist, B5).
  sender: z.object({ type: z.string().optional(), login: z.string().optional() }).nullable().optional(),
});

/**
 * Verify the signature and map the event to a review job, an ignore, or a
 * reject. The fail-closed secret check runs first — no verification, no
 * side effects when the secret is missing/empty/"development". The
 * `Webhooks` verifier is constructed lazily only after the secret passes,
 * so an empty/default secret can never reach the crypto path. Each reject
 * path emits a structured warning with a machine reason and NO secret
 * material (Phase 5 B6).
 *
 * Emergency brake (AC4a): `reviewEnabled` is the computed
 * REVIEW_ENABLED state (`!== "false"` — the env is an emergency brake only;
 * per-App `github_apps.review_enabled` is the primary control). When the
 * brake is pulled (exact "false"), EVERY webhook is classified as `ignore`
 * (HTTP 2xx, no queue enqueue) BEFORE any signature work.
 *
 * `log` is optional (defaults to no logging) so the pure classifier stays
 * testable without a sink; the fetch entry passes `defaultLog`.
 *
 * `cacheKey` (the hardening item / architect lock L1) is a
 * MEMOIZATION-ONLY parameter for the verifier cache — a per-App route
 * passes its `github_apps.id`; the classifier NEVER branches on it (same
 * secret + same payload classifies identically whichever key rides along).
 * Omitted → the verifier memoizes under the secret itself (the legacy
 * shape, for direct callers).
 *
 * Warn labels (log hygiene hardening item 3): every structured warn carries
 * the REAL GitHub event in `event` when the header is present, falling back
 * to the stage label (= the machine `reason`) when the header is absent —
 * never the literal "unknown", so log consumers can filter by event alone.
 *
 * `trigger` (spec review-trigger-policy §2 read path) is the resolved
 * App row's mode + slug, passed straight to classifyEvent — the classifier
 * branches on it but still never sees the App identity (no appId).
 */
export async function classifyWebhook(
  secret: string,
  rawBody: string,
  signature: string | null,
  eventName: string | null,
  log?: HandlerLog,
  reviewEnabled = true,
  cacheKey?: string,
  trigger: ReviewTriggerContext = { mode: "every_push", appSlug: "" },
): Promise<WebhookOutcome> {
  if (!reviewEnabled) {
    log?.warn(
      { event: eventName ?? "review_disabled_kill_switch", reason: "review_disabled_kill_switch", detail: "REVIEW_ENABLED is exactly 'false'" },
      "webhook ignored — reviews stopped by the REVIEW_ENABLED emergency brake",
    );
    return { kind: "ignore", reason: "reviews stopped by the REVIEW_ENABLED emergency brake" };
  }
  if (!secret || secret === "development") {
    log?.warn(
      { event: eventName ?? "secret_misconfigured", reason: "secret_misconfigured", detail: "secret missing, empty, or the default 'development'" },
      "webhook rejected with 500 — secret misconfigured",
    );
    return { kind: "reject", status: 500, reason: "webhook secret is missing, empty, or the default 'development'" };
  }
  if (!signature) {
    log?.warn(
      { event: eventName ?? "missing_signature", reason: "missing_signature", detail: "X-Hub-Signature-256 header absent" },
      "webhook rejected with 401 — missing signature",
    );
    return { kind: "reject", status: 401, reason: "missing X-Hub-Signature-256 header" };
  }
  const valid = await verifySignature(
    getWebhooks(cacheKey ?? secret, secret).verify,
    rawBody,
    signature,
    log,
    eventName ?? undefined,
  );
  if (!valid) {
    log?.warn(
      { event: eventName ?? "signature_verification_failed", reason: "signature_verification_failed", detail: "HMAC did not verify (or malformed)" },
      "webhook rejected with 401 — signature verification failed",
    );
    return { kind: "reject", status: 401, reason: "signature verification failed" };
  }
  return classifyEvent(eventName, rawBody, log, reviewEnabled, trigger);
}

/**
 * Event whitelist → ReviewJobPayload. Returns `ignore` for everything else.
 * `reviewEnabled` is the computed REVIEW_ENABLED state (AC4a): when
 * the emergency brake is pulled (exact "false"), every event is ignored
 * (HTTP 2xx, no queue enqueue).
 *
 * `trigger` is the per-App trigger context (spec review-trigger-policy §2):
 * `mode` gates the pull_request auto face (§2.1 matrix) and `appSlug` keys
 * the issue_comment bot mention (§3). Defaults to `every_push` with no
 * mention target.
 */
export function classifyEvent(
  eventName: string | null,
  rawBody: string,
  log?: HandlerLog,
  reviewEnabled = true,
  trigger: ReviewTriggerContext = { mode: "every_push", appSlug: "" },
): WebhookOutcome {
  if (!reviewEnabled) {
    log?.warn(
      { event: eventName ?? "review_disabled_kill_switch", reason: "review_disabled_kill_switch", detail: "REVIEW_ENABLED is exactly 'false'" },
      "event ignored — reviews stopped by the REVIEW_ENABLED emergency brake",
    );
    return { kind: "ignore", reason: "reviews stopped by the REVIEW_ENABLED emergency brake" };
  }
  if (!eventName) {
    return { kind: "ignore", reason: "missing X-GitHub-Event header" };
  }
  if (eventName === "pull_request") {
    return classifyPullRequest(rawBody, trigger.mode);
  }
  if (eventName === "issue_comment") {
    return classifyIssueComment(rawBody, log, trigger.appSlug);
  }
  return { kind: "ignore", reason: `event ${eventName} is not whitelisted` };
}

function classifyPullRequest(rawBody: string, mode: ReviewTriggerMode): WebhookOutcome {
  const parsed = parseBody(rawBody);
  if (parsed === null) {
    return { kind: "reject", status: 400, reason: "invalid JSON body" };
  }
  const result = pullRequestSchema.safeParse(parsed);
  if (!result.success) {
    return { kind: "reject", status: 400, reason: "pull_request payload failed validation" };
  }
  const { action, installation, pull_request, repository } = result.data;
  if (!(PULL_REQUEST_ACTIONS as readonly string[]).includes(action)) {
    return { kind: "ignore", reason: `pull_request action ${action} is not whitelisted` };
  }
  const installationId = installation?.id;
  const owner = repository?.owner.login;
  const repo = repository?.name;
  const prNumber = pull_request?.number ?? result.data.number;
  const headSha = pull_request?.head?.sha ?? null;
  // Malformed-payload reject BEFORE the mode gate: reject stays reserved for
  // malformed payloads in EVERY mode (spec §2.1 — exactly as today).
  if (installationId === undefined || owner === undefined || repo === undefined || prNumber === undefined) {
    return { kind: "reject", status: 400, reason: "pull_request payload missing required fields" };
  }
  // §2.1 matrix: the mode gates the auto face (manual never auto-triggers;
  // open is opened-only). The bot-mention comment face is orthogonal.
  if (!autoTriggerAllows(mode, action)) {
    return { kind: "ignore", reason: `pull_request action ${action} does not auto-trigger in ${mode} mode` };
  }
  return {
    kind: "job",
    payload: {
      installation_id: installationId,
      owner,
      repo,
      pr_number: prNumber,
      head_sha: headSha,
      action,
      triggered_by: "pull_request",
    },
  };
}

function classifyIssueComment(rawBody: string, log: HandlerLog | undefined, appSlug: string): WebhookOutcome {
  const parsed = parseBody(rawBody);
  if (parsed === null) {
    return { kind: "reject", status: 400, reason: "invalid JSON body" };
  }
  const result = issueCommentSchema.safeParse(parsed);
  if (!result.success) {
    return { kind: "reject", status: 400, reason: "issue_comment payload failed validation" };
  }
  const { action, installation, comment, issue, repository, sender } = result.data;
  if (action !== "created") {
    return { kind: "ignore", reason: `issue_comment action ${action} is not whitelisted` };
  }
  // Bare mention (spec review-trigger-policy §3): the body must contain the
  // resolved App's `@{appSlug}` as a standalone token — any position, no
  // required wording. Keyed to the route-resolved slug, so one App's mention
  // never triggers another App.
  const body = comment?.body ?? "";
  if (!bodyMentionsApp(body, appSlug)) {
    return { kind: "ignore", reason: "comment body does not mention the App bot" };
  }
  if (issue?.pull_request == null) {
    return { kind: "ignore", reason: "comment is not on a pull request thread" };
  }
  if (sender?.type === "Bot") {
    return { kind: "ignore", reason: "comment sent by a bot (self-comment loop guard)" };
  }
  // Actor allowlist (B5): only the PR author or the repository owner may
  // trigger a review. Ignore + structured log otherwise (quota abuse guard).
  const actorLogin = sender?.login ?? null;
  const authorLogin = issue?.user?.login ?? null;
  const ownerLogin = repository?.owner?.login ?? null;
  if (actorLogin === null || (actorLogin !== authorLogin && actorLogin !== ownerLogin)) {
    log?.warn(
      {
        // Log hygiene: this warn is only reachable via
        // classifyEvent("issue_comment", …), so `event` carries the REAL
        // GitHub event — filterable, never the literal "unknown".
        event: "issue_comment",
        reason: "actor_not_allowed",
        detail: `actor=${actorLogin ?? "null"} author=${authorLogin ?? "null"} owner=${ownerLogin ?? "null"}`,
      },
      "bot mention ignored — commenter is not the PR author or repo owner",
    );
    return { kind: "ignore", reason: "comment actor is not the PR author or repo owner" };
  }
  const installationId = installation?.id;
  const owner = repository?.owner.login;
  const repo = repository?.name;
  const prNumber = issue?.number;
  if (installationId === undefined || owner === undefined || repo === undefined || prNumber === undefined) {
    return { kind: "reject", status: 400, reason: "issue_comment payload missing required fields" };
  }
  return {
    kind: "job",
    payload: {
      installation_id: installationId,
      owner,
      repo,
      pr_number: prNumber,
      head_sha: null,
      action: "created",
      triggered_by: "issue_comment",
    },
  };
}

function parseBody(rawBody: string): unknown {
  try {
    return JSON.parse(rawBody);
  } catch {
    return null;
  }
}
