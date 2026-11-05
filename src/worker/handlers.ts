/**
 * Webhook job handlers — structured logging, KV idempotency pre-check,
 * queue enqueue.
 *
 * Hot path: no GitHub API calls, no diff fetch, no review — verify + enqueue
 * only (webhook 5s timeout budget; sha comes from the webhook payload).
 *
 * Idempotency (compass S4):
 * - A `pull_request` job claims its commit in KV (24h TTL); for commit jobs
 *   the D1 UNIQUE constraint stays the durable backstop.
 * - A bot-mention job states no sha, so it claims its `comment_id` in D1
 *   (`comment_trigger_claims`, migration 0048) BEFORE the queue send, with the
 *   KV comment key kept as a 24h fast path. The row's primary key — never a
 *   KV get-then-put — is what makes "one comment id triggers at most one
 *   review" true under concurrent deliveries, and its `payload_json` is the
 *   outbox record the cron sweep re-sends when a claim outlives its send.
 * - KV has no atomic conditional write (`noneMatch` is not in
 *   workers-types), so the commit claim is get-then-put with a race window;
 *   the D1 UNIQUE constraint is the durable fallback for those jobs.
 * - KV read/write failure → conservative pass: log a warning and enqueue
 *   anyway (the D1 fallback covers duplicate commits). A D1 claim failure is
 *   NOT conservative: without the durable claim the at-most-once invariant is
 *   unprovable, so it propagates and GitHub retries.
 * - Ordering invariant: the D1 comment claim is inserted BEFORE
 *   `REVIEW_QUEUE.send` (so a duplicate is refused before any work) and the
 *   KV key is claimed only AFTER it resolves (so a failed send leaves no KV
 *   key and GitHub's retry re-enqueues instead of being KV-skipped). A failed
 *   send also deletes the D1 claim row, releasing it for that retry.
 */
import type { D1Database, KVNamespace } from "@cloudflare/workers-types";
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
  // `DB` is required here even though fetch-face `Env.DB` is optional: the
  // per-App route fails closed on an unbound DB long before this handler runs.
  env: Pick<Env, "IDEMPOTENCY_KV" | "REVIEW_QUEUE"> & { DB: D1Database };
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
 * false (conservative pass) and logs a warning — for commit jobs the D1
 * UNIQUE constraint is the durable duplicate guard, and a comment job has its
 * own `comment_trigger_claims` row regardless of KV.
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
 * the idempotency pre-check (by commit sha, else by comment id), take the
 * durable claim, enqueue, then write the KV key.
 *
 * A comment-triggered job takes a D1 claim BEFORE the send (migration 0048).
 * The row — not the KV key — is the "at most one review per comment id" proof
 * under concurrent deliveries, and its stored payload is the outbox record the
 * cron sweep re-sends if this isolate dies between the claim and the send.
 */
export async function handleReviewJob(
  payload: ReviewJobPayload,
  deps: HandlerDeps,
): Promise<HandleOutcome> {
  const fields = toEventLog(payload);

  // A commit job claims its sha; a bot-mention job (no sha) claims its comment
  // id — KV as a 24h fast path, D1 as the durable claim below.
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

  // Durable per-comment claim: `INSERT OR IGNORE`, so the row's primary key —
  // not this isolate's read — decides which delivery owns the comment. The
  // losing delivery skips whatever state the row holds (`queued`, `consumed`,
  // `expired`): in every case this comment already claimed its one review.
  //
  // A D1 failure is NOT caught: without the durable claim the invariant cannot
  // be proved, so the webhook 500s and GitHub retries.
  const commentId = payload.comment_id;
  if (commentId !== undefined) {
    const nowMs = Date.now();
    const claim = await deps.env.DB.prepare(
      `INSERT OR IGNORE INTO comment_trigger_claims
         (installation_id, owner, repo, pr_number, comment_id, state, payload_json, attempts, created_ms, queued_ms)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, 0, ?, ?)`,
    )
      .bind(
        payload.installation_id,
        payload.owner,
        payload.repo,
        payload.pr_number,
        commentId,
        JSON.stringify(payload),
        nowMs,
        nowMs,
      )
      .run();
    if (claim.meta.changes === 0) {
      deps.log.info(fields, "duplicate comment trigger — skipping enqueue");
      return { kind: "skipped", reason: "duplicate comment trigger" };
    }
  }

  try {
    await deps.env.REVIEW_QUEUE.send(payload);
  } catch (err) {
    // Seven-field structured log on the send failure path (QC F-002): the
    // operator must be able to map the 500 to the specific event. Rethrow —
    // the 500 signals GitHub to retry, and no KV key is claimed, so the
    // retry re-enqueues instead of being KV-skipped (C1 invariant).
    //
    // The D1 claim is released so that retry can take it again. If the delete
    // itself fails the row stays `queued` and the sweep re-sends its stored
    // payload after the retry window — no lost review either way, and the
    // pipeline's own claim collapses any duplicate that results.
    if (commentId !== undefined) {
      try {
        await deps.env.DB.prepare(
          `DELETE FROM comment_trigger_claims
            WHERE installation_id = ? AND owner = ? AND repo = ? AND pr_number = ? AND comment_id = ?`,
        )
          .bind(payload.installation_id, payload.owner, payload.repo, payload.pr_number, commentId)
          .run();
      } catch (deleteErr) {
        const detail = deleteErr instanceof Error ? deleteErr.message : String(deleteErr);
        deps.log.warn(fields, `comment claim release failed — the sweep will re-send: ${detail}`);
      }
    }
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
