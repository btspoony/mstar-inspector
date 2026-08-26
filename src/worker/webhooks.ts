/**
 * Webhook verification + event filtering (pure, testable).
 *
 * Fail-closed secret policy (compass S4, along M0): missing, empty, or the
 * Probot default "development" secret → reject with zero side effects.
 * Signature verification uses `@octokit/webhooks` (Web Crypto, workerd-safe).
 *
 * Event whitelist (compass S4 / plan Clarify 3):
 * - `pull_request.{opened,synchronize,reopened}`
 * - `issue_comment.created` whose body starts with `/review` (case-sensitive)
 *   on a pull request thread, and whose sender is NOT a bot (prevents
 *   self-comment loops).
 * Everything else returns 200 quickly — GitHub retries non-2xx, so
 * uninteresting events must not 4xx.
 */
import { Webhooks } from "@octokit/webhooks";
import { z } from "zod";
import type { ReviewJobPayload } from "../contracts/review-job";
import type { HandlerLog } from "./handlers";

export const REVIEW_COMMAND_PREFIX = "/review";

export const PULL_REQUEST_ACTIONS = ["opened", "synchronize", "reopened"] as const;

/**
 * Module-level verifier singleton (QC F-005): the hot path constructed a
 * `Webhooks` instance per request only to call `verify`, which uses nothing
 * but `options.secret`. The instance is created lazily on first use, after
 * the fail-closed secret check, so a missing/empty/"development" secret
 * never reaches the crypto path. Exported as a test seam to lock the reuse
 * behavior.
 */
let webhooks: Webhooks | null = null;

export function getWebhooks(secret: string): Webhooks {
  if (webhooks === null) {
    webhooks = new Webhooks({ secret });
  }
  return webhooks;
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
    .object({ number: z.number(), pull_request: z.unknown().optional() })
    .nullable()
    .optional(),
  repository: repositorySchema,
  sender: z.object({ type: z.string().optional() }).nullable().optional(),
});

/**
 * Verify the signature and map the event to a review job, an ignore, or a
 * reject. The fail-closed secret check runs first — no verification, no
 * side effects when the secret is missing/empty/"development". The
 * `Webhooks` verifier is constructed lazily only after the secret passes,
 * so an empty/default secret can never reach the crypto path.
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
): Promise<WebhookOutcome> {
  if (!secret || secret === "development") {
    return { kind: "reject", status: 500, reason: "webhook secret is missing, empty, or the default 'development'" };
  }
  if (!signature) {
    return { kind: "reject", status: 401, reason: "missing X-Hub-Signature-256 header" };
  }
  const valid = await verifySignature(getWebhooks(secret).verify, rawBody, signature, log);
  if (!valid) {
    return { kind: "reject", status: 401, reason: "signature verification failed" };
  }
  return classifyEvent(eventName, rawBody);
}

/** Event whitelist → ReviewJobPayload. Returns `ignore` for everything else. */
export function classifyEvent(eventName: string | null, rawBody: string): WebhookOutcome {
  if (!eventName) {
    return { kind: "ignore", reason: "missing X-GitHub-Event header" };
  }
  if (eventName === "pull_request") {
    return classifyPullRequest(rawBody);
  }
  if (eventName === "issue_comment") {
    return classifyIssueComment(rawBody);
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

function classifyIssueComment(rawBody: string): WebhookOutcome {
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
  const body = comment?.body ?? "";
  if (!body.startsWith(REVIEW_COMMAND_PREFIX)) {
    return { kind: "ignore", reason: "comment body does not start with /review" };
  }
  if (issue?.pull_request == null) {
    return { kind: "ignore", reason: "comment is not on a pull request thread" };
  }
  if (sender?.type === "Bot") {
    return { kind: "ignore", reason: "comment sent by a bot (self-comment loop guard)" };
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
