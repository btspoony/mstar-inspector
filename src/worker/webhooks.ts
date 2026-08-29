/**
 * Webhook verification + event filtering (pure, testable).
 *
 * Fail-closed secret policy (compass S4, along M0): missing, empty, or the
 * Probot default "development" secret → reject with zero side effects.
 * Signature verification uses `@octokit/webhooks` (Web Crypto, workerd-safe).
 * Every reject path logs a structured warning (no secret material) so the
 * operator can spot bad configurations / probes (Phase 5 B6).
 *
 * Event whitelist (compass S4 / plan Clarify 3):
 * - `pull_request.{opened,synchronize,reopened}`
 * - `issue_comment.created` whose body is EXACTLY `/review` or starts with
 *   `/review ` (case-sensitive; `/reviewing` must not trigger), on a pull
 *   request thread, sent by a non-bot whose login is the PR author or the
 *   repository owner (Phase 5 B5 actor allowlist — prevents quota abuse by
 *   arbitrary commenters on public installs).
 * Everything else returns 200 quickly — GitHub retries non-2xx, so
 * uninteresting events must not 4xx.
 */
import { Webhooks } from "@octokit/webhooks";
import { z } from "zod";
import type { ReviewJobPayload } from "../contracts/review-job";
import type { HandlerLog } from "./handlers";

export const REVIEW_COMMAND_PREFIX = "/review";

export const PULL_REQUEST_ACTIONS = ["opened", "synchronize", "reopened"] as const;

/** Webhook body size cap (B6): checked BEFORE the body is buffered (413). */
export const WEBHOOK_BODY_LIMIT = 1_000_000;

/**
 * Module-level verifier cache (QC F-005): the hot path constructed a
 * `Webhooks` instance per request only to call `verify`, which uses nothing
 * but `options.secret`. Instances are created lazily on first use, after
 * the fail-closed secret check, so a missing/empty/"development" secret
 * never reaches the crypto path. KEYED BY SECRET (plan 13 Task 2): the
 * legacy route and each per-App `POST /webhook/:appSlug` route pass
 * different secrets, and a single-instance cache would verify every later
 * secret against the first-cached one — valid signatures would fail (and
 * the App isolation would be void). One small instance per configured App
 * is negligible; `getWebhooks` stays exported as a test seam to lock the
 * reuse behavior.
 */
const webhooksCache = new Map<string, Webhooks>();

export function getWebhooks(secret: string): Webhooks {
  let cached = webhooksCache.get(secret);
  if (cached === undefined) {
    cached = new Webhooks({ secret });
    webhooksCache.set(secret, cached);
  }
  return cached;
}

/**
 * Verify a signature, treating any throw as invalid (QC F-001). On the
 * deployed Worker, wrangler resolves `@octokit/webhooks-methods` via the
 * `browser` condition → WebCrypto verify → `hexToUInt8Array` throws a
 * TypeError on malformed (non-hex) signatures, while Bun/node resolves the
 * `node` condition → `timingSafeEqual` → returns false. Both must fail
 * closed with 401; this wrapper unifies the two paths and logs the
 * malformed input structurally so the operator can spot it.
 */
export async function verifySignature(
  verify: (rawBody: string, signature: string) => Promise<boolean>,
  rawBody: string,
  signature: string,
  log?: HandlerLog,
): Promise<boolean> {
  try {
    return await verify(rawBody, signature);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log?.warn(
      { event: "unknown", reason: "signature verification threw", detail },
      "malformed signature rejected with 401",
    );
    return false;
  }
}

export type WebhookOutcome =
  | { kind: "reject"; status: 400 | 401 | 500; reason: string }
  | { kind: "ignore"; reason: string }
  | { kind: "job"; payload: ReviewJobPayload };

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
 * Kill-switch (postdeploy feedback T4): `reviewEnabled` is the computed
 * REVIEW_ENABLED state ("true" only). When disabled, EVERY webhook is
 * classified as `ignore` (HTTP 2xx, no queue enqueue) BEFORE any signature
 * work — fail-closed by default (unset REVIEW_ENABLED → disabled).
 *
 * `log` is optional (defaults to no logging) so the pure classifier stays
 * testable without a sink; the fetch entry passes `defaultLog`.
 */
export async function classifyWebhook(
  secret: string,
  rawBody: string,
  signature: string | null,
  eventName: string | null,
  log?: HandlerLog,
  reviewEnabled = true,
): Promise<WebhookOutcome> {
  if (!reviewEnabled) {
    log?.warn(
      { event: "unknown", reason: "review_disabled", detail: "REVIEW_ENABLED is not 'true'" },
      "webhook ignored — reviews disabled by the REVIEW_ENABLED kill-switch",
    );
    return { kind: "ignore", reason: "reviews disabled by the REVIEW_ENABLED kill-switch" };
  }
  if (!secret || secret === "development") {
    log?.warn(
      { event: "unknown", reason: "secret_misconfigured", detail: "secret missing, empty, or the default 'development'" },
      "webhook rejected with 500 — secret misconfigured",
    );
    return { kind: "reject", status: 500, reason: "webhook secret is missing, empty, or the default 'development'" };
  }
  if (!signature) {
    log?.warn(
      { event: "unknown", reason: "missing_signature", detail: "X-Hub-Signature-256 header absent" },
      "webhook rejected with 401 — missing signature",
    );
    return { kind: "reject", status: 401, reason: "missing X-Hub-Signature-256 header" };
  }
  const valid = await verifySignature(getWebhooks(secret).verify, rawBody, signature, log);
  if (!valid) {
    log?.warn(
      { event: "unknown", reason: "signature_verification_failed", detail: "HMAC did not verify (or malformed)" },
      "webhook rejected with 401 — signature verification failed",
    );
    return { kind: "reject", status: 401, reason: "signature verification failed" };
  }
  return classifyEvent(eventName, rawBody, log, reviewEnabled);
}

/**
 * Event whitelist → ReviewJobPayload. Returns `ignore` for everything else.
 * `reviewEnabled` is the computed REVIEW_ENABLED state (T4): when disabled,
 * every event is ignored (HTTP 2xx, no queue enqueue) — fail-closed.
 */
export function classifyEvent(
  eventName: string | null,
  rawBody: string,
  log?: HandlerLog,
  reviewEnabled = true,
): WebhookOutcome {
  if (!reviewEnabled) {
    log?.warn(
      { event: "unknown", reason: "review_disabled", detail: "REVIEW_ENABLED is not 'true'" },
      "event ignored — reviews disabled by the REVIEW_ENABLED kill-switch",
    );
    return { kind: "ignore", reason: "reviews disabled by the REVIEW_ENABLED kill-switch" };
  }
  if (!eventName) {
    return { kind: "ignore", reason: "missing X-GitHub-Event header" };
  }
  if (eventName === "pull_request") {
    return classifyPullRequest(rawBody);
  }
  if (eventName === "issue_comment") {
    return classifyIssueComment(rawBody, log);
  }
  return { kind: "ignore", reason: `event ${eventName} is not whitelisted` };
}

function classifyPullRequest(rawBody: string): WebhookOutcome {
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
  if (installationId === undefined || owner === undefined || repo === undefined || prNumber === undefined) {
    return { kind: "reject", status: 400, reason: "pull_request payload missing required fields" };
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

function classifyIssueComment(rawBody: string, log?: HandlerLog): WebhookOutcome {
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
  // Exact command (B5): `/review` or `/review <anything>` — a bare `/review`
  // prefix (e.g. `/reviewing`) must NOT trigger.
  const body = comment?.body ?? "";
  const trimmed = body.trim();
  if (trimmed !== REVIEW_COMMAND_PREFIX && !trimmed.startsWith(`${REVIEW_COMMAND_PREFIX} `)) {
    return { kind: "ignore", reason: "comment body is not the exact /review command" };
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
        event: "unknown",
        reason: "actor_not_allowed",
        detail: `actor=${actorLogin ?? "null"} author=${authorLogin ?? "null"} owner=${ownerLogin ?? "null"}`,
      },
      "review command ignored — commenter is not the PR author or repo owner",
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
      triggered_by: "review_command",
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
