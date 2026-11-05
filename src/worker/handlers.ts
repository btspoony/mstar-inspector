/**
 * Webhook job handlers — structured logging, KV idempotency pre-check,
 * queue enqueue.
 *
 * Hot path: no GitHub API calls, no diff fetch, no review — verify + enqueue
 * only (webhook 5s timeout budget; sha comes from the webhook payload).
 *
 * Idempotency (compass S4):
 * - KV key for a non-empty `head_sha` (the commit); for a bot-mention job —
 *   which states no sha — by its `comment_id`. A job with neither enqueues
 *   with no key (fail-safe: a duplicate costs a review, never a lost one).
 * - KV has no atomic conditional write (`noneMatch` is not in
 *   workers-types), so this is get-then-put with a race window; for commit
 *   jobs the D1 UNIQUE constraint is the durable fallback.
 * - KV read/write failure → conservative pass: log a warning and enqueue
 *   anyway (the D1 fallback covers duplicate commits).
 * - Ordering invariant: the KV key is claimed only AFTER `REVIEW_QUEUE.send`
 *   resolves. A key therefore means "enqueued" — a failed send leaves no key,
 *   so GitHub's retry re-enqueues instead of being KV-skipped.
 */
import type { KVNamespace } from "@cloudflare/workers-types";
import { idemCommentKey, idemKey, IDEMPOTENCY_SECONDS, IDEM_ENQUEUED, isEnqueuedClaim } from "../contracts/idem";
import type { ReviewJobPayload } from "../contracts/review-job";
import type { Env } from "./env";

/** Seven-field structured event log (along M0 gateway semantics). */
export type WorkerEventLog = {
  event: "pull_request" | "issue_comment";
  action: string;
  installation_id: number;
  owner: string;
  repo: string;
  pr_number: number;
  head_sha: string | null;
};

/**
 * Structured log fields for a webhook-face rejection/bookkeeping warn (QC
 * F-005; log hygiene): the caller's REAL stage label rides
 * `event` — the literal "unknown" no longer
 * exists anywhere — so e.g. `installation_upsert_failed` /
 * `webhook_body_too_large` warns are filterable by event alone. `reason`
 * keeps the same label for the reason-keyed greps.
 */
export type WebhookStageWarnLog = {
  event: string;
  reason: string;
  detail: string;
};

export type HandlerLog = {
  // info widened to the stage-warn shape (AL-23-2): the webhook face's
  // review_paused line rides info — paused is a legitimate ops state
  // answering 2xx — with the same structured fields as its warn siblings.
  info: (fields: WorkerEventLog | WebhookStageWarnLog, msg?: string) => void;
  warn: (fields: WorkerEventLog | WebhookStageWarnLog, msg?: string) => void;
};

export type HandlerDeps = {
  env: Pick<Env, "IDEMPOTENCY_KV" | "REVIEW_QUEUE">;
  log: HandlerLog;
};

export type HandleOutcome =
  | { kind: "enqueued" }
  | { kind: "skipped"; reason: string };

/** Default sink: structured JSON lines on stdout. No secrets are logged. */
export const defaultLog: HandlerLog = {
  info: (fields, msg) => console.log(JSON.stringify({ ...fields, msg: msg ?? "" })),
  warn: (fields, msg) => console.warn(JSON.stringify({ ...fields, msg: msg ?? "" })),
};

function toEventLog(payload: ReviewJobPayload): WorkerEventLog {
  return {
    event: payload.triggered_by === "pull_request" ? "pull_request" : "issue_comment",
    action: payload.action,
    installation_id: payload.installation_id,
    owner: payload.owner,
    repo: payload.repo,
    pr_number: payload.pr_number,
    head_sha: payload.head_sha,
  };
}

/**
 * Idempotency pre-check: true only when the stored value proves this commit
 * needs no new job — "1" (queued) or "done" (already reviewed). A "dropped"
 * (the guard gave the job up), "failed" (the final delivery is heading to the
 * DLQ), "paused" (the App is paused), "degraded" (the run ended in a degraded
 * notice) or "superseded" (a newer commit overtook it at ack time) value means
 * the commit was NEVER reviewed, so a redelivery must enqueue again instead of
 * being skipped. `superseded` is therefore no tombstone: a force-push back to
 * that sha makes it the head again, and the consumer's ledger comparison — not
 * this claim — then decides whether it is a leftover. On KV failure, returns
 * false (conservative pass) and logs a warning — the D1 UNIQUE constraint is
 * the durable duplicate guard.
 */
export async function idempotencyHit(
  kv: KVNamespace,
  key: string,
  fields: WorkerEventLog,
  log: HandlerLog,
): Promise<boolean> {
  try {
    return isEnqueuedClaim(await kv.get(key));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn(fields, `idempotency KV error — enqueueing anyway (D1 fallback): ${detail}`);
    return false;
  }
}

/**
 * Claim the idempotency key AFTER a successful enqueue. A key therefore
 * means "enqueued" — a failed send never leaves a key, so GitHub's retry
 * re-enqueues instead of being KV-skipped. On KV failure, logs a warning
 * and still returns 200 (D1 UNIQUE is the duplicate backstop).
 */
export async function claimIdempotency(
  kv: KVNamespace,
  key: string,
  fields: WorkerEventLog,
  log: HandlerLog,
): Promise<void> {
  try {
    await kv.put(key, IDEM_ENQUEUED, { expirationTtl: IDEMPOTENCY_SECONDS });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn(fields, `idempotency KV error — enqueueing anyway (D1 fallback): ${detail}`);
  }
}

/**
 * Handle a classified review job: log the seven-field structured event, run
 * the idempotency pre-check (by commit sha, else by comment id), enqueue, then
 * claim the KV key. A key therefore means "enqueued" — a failed send leaves no
 * key, so GitHub's retry re-enqueues instead of being KV-skipped.
 */
export async function handleReviewJob(
  payload: ReviewJobPayload,
  deps: HandlerDeps,
): Promise<HandleOutcome> {
  const fields = toEventLog(payload);

  // A commit job claims its sha; a bot-mention job (no sha) claims its comment
  // id, so one comment can trigger at most one review; a job with neither
  // enqueues unclaimed, as every mention job did before.
  //
  // shortcut: the claim is get-then-put with a 24h TTL, so a duplicate
  // delivery older than that enqueues again — upgrade to a D1 unique comment
  // key only if >24h duplicate deliveries ever matter.
  const key = payload.head_sha
    ? idemKey({
        installation_id: payload.installation_id,
        owner: payload.owner,
        repo: payload.repo,
        pr_number: payload.pr_number,
        head_sha: payload.head_sha,
      })
    : payload.comment_id !== undefined
      ? idemCommentKey({
          installation_id: payload.installation_id,
          owner: payload.owner,
          repo: payload.repo,
          pr_number: payload.pr_number,
          comment_id: payload.comment_id,
        })
      : null;

  if (key !== null) {
    const alreadySeen = await idempotencyHit(deps.env.IDEMPOTENCY_KV, key, fields, deps.log);
    if (alreadySeen) {
      deps.log.info(fields, "idempotency hit — skipping enqueue");
      return { kind: "skipped", reason: "idempotency hit" };
    }
  }

  try {
    await deps.env.REVIEW_QUEUE.send(payload);
  } catch (err) {
    // Seven-field structured log on the send failure path (QC F-002): the
    // operator must be able to map the 500 to the specific event. Rethrow —
    // the 500 signals GitHub to retry, and no KV key is claimed, so the
    // retry re-enqueues instead of being KV-skipped (C1 invariant).
    const detail = err instanceof Error ? err.message : String(err);
    deps.log.warn(fields, `queue send failed — 500 for GitHub retry: ${detail}`);
    throw err;
  }
  if (key !== null) {
    await claimIdempotency(deps.env.IDEMPOTENCY_KV, key, fields, deps.log);
  }
  deps.log.info(fields, "review job enqueued");
  return { kind: "enqueued" };
}
