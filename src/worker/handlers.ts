import type { D1Database, KVNamespace } from "@cloudflare/workers-types";
import { idemCommentKey, idemKey, IDEMPOTENCY_SECONDS, IDEM_ENQUEUED, isEnqueuedClaim } from "../contracts/idem";
import {
  ENTITLEMENT_UNREADABLE_SKIP_REASON,
  QUOTA_SKIP_REASON,
  QUOTA_STAGE,
  SHARED_BOT_ENTITLEMENT_SKIP_REASON,
  SHARED_BOT_ENTITLEMENT_STAGE,
} from "../contracts/failure-stages";
import type { ReviewJobPayload } from "../contracts/review-job";
import type { SharedBotRefusal } from "../dashboard/entitlement";
import { CHECK_SUMMARIES } from "../pipeline/checks";
import { FAILURE_SUMMARIES } from "../contracts/failure-codes";
import { createFailureStore, type FailureStage } from "../store/failure-store";
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
  info: (fields: WorkerEventLog | WebhookStageWarnLog, msg?: string) => void;
  warn: (fields: WorkerEventLog | WebhookStageWarnLog, msg?: string) => void;
};

export type HandlerDeps = {
  env: Pick<Env, "IDEMPOTENCY_KV" | "REVIEW_QUEUE"> & { DB: D1Database };
  log: HandlerLog;
  beforeEnqueue?: (payload: ReviewJobPayload) => Promise<ReviewJobPayload | void>;
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

async function runBeforeEnqueue(
  payload: ReviewJobPayload,
  deps: HandlerDeps,
  fields: WorkerEventLog,
  onFailure: string,
): Promise<ReviewJobPayload> {
  if (deps.beforeEnqueue === undefined) return payload;
  try {
    return (await deps.beforeEnqueue(payload)) ?? payload;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    deps.log.warn(fields, `${onFailure}: ${detail}`);
    return payload;
  }
}

/**
 * Why a delivery is refused, as ONE union: the route computes at most one
 * verdict (the quota check runs only in the branch the shared-bot check
 * admitted, so both can never fire) and every consumer of the refusal — the
 * failure row, the Check's skip sentence, the log line — reads it here.
 *
 * `quota-exhausted` carries the numbers the verdict compared; they are for the
 * operator's log line only, never for the author-facing sentence.
 */
export type DeliveryRefusal =
  | SharedBotRefusal
  | { kind: "quota-exhausted"; limit: number; used: number; cost: number }
  | { kind: "entitlement-unreadable" };

/** The `review_failures.stage` a refusal is attributed to. */
export function deliveryRefusalStage(refusal: DeliveryRefusal): FailureStage {
  return refusal.kind === "quota-exhausted" ? QUOTA_STAGE : SHARED_BOT_ENTITLEMENT_STAGE;
}

/**
 * The one sentence a refusal carries, on all three surfaces that repeat it.
 *
 * `entitlement-unreadable` gets its own sentence rather than reusing the
 * capability's: the author is told nothing that is untrue about their plan, and
 * the operator reading the same row learns the gate could not answer.
 */
export function deliveryRefusalReason(refusal: DeliveryRefusal): string {
  switch (refusal.kind) {
    case "quota-exhausted":
      return QUOTA_SKIP_REASON;
    case "entitlement-unreadable":
      return ENTITLEMENT_UNREADABLE_SKIP_REASON;
    case "shared-bot-not-included":
      return SHARED_BOT_ENTITLEMENT_SKIP_REASON;
  }
}

async function refuseDelivery(
  payload: ReviewJobPayload,
  deps: HandlerDeps,
  fields: WorkerEventLog,
  refusal: DeliveryRefusal,
): Promise<HandleOutcome> {
  await runBeforeEnqueue(
    payload,
    deps,
    fields,
    "pre-enqueue hook failed — the refusal still holds",
  );

  try {
    await createFailureStore(deps.env.DB).record({
      target_id: payload.targetId,
      installation_id: payload.installation_id,
      owner: payload.owner,
      repo: payload.repo,
      pr_number: payload.pr_number,
      head_sha: payload.head_sha ?? "",
      stage: deliveryRefusalStage(refusal),
      code: "review.delivery.deferred",
      trackId: `${payload.owner}/${payload.repo}#${payload.pr_number}@${payload.head_sha ?? ""}`,
      message: FAILURE_SUMMARIES["review.delivery.deferred"],
      error: CHECK_SUMMARIES.skippedByDelivery(deliveryRefusalReason(refusal)),
    });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    deps.log.warn(fields, `delivery refusal not recorded — delivery still skipped: ${detail}`);
  }

  deps.log.info(fields, `delivery refused (${refusal.kind}) — skipping enqueue`);
  return { kind: "skipped", reason: deliveryRefusalReason(refusal) };
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
 *
 * `refusal` is the route's verdict (shared-bot capability or the month's RP
 * ceiling): non-null skips the whole idempotency surface and takes the
 * {@link refuseDelivery} tail above.
 */
export async function handleReviewJob(
  payload: ReviewJobPayload,
  deps: HandlerDeps,
  refusal: DeliveryRefusal | null = null,
): Promise<HandleOutcome> {
  const fields = toEventLog(payload);

  if (refusal !== null) return refuseDelivery(payload, deps, fields, refusal);

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

  const commentId = payload.comment_id;
  if (commentId !== undefined) {
    const nowMs = Date.now();
    const claim = await deps.env.DB.prepare(
      `INSERT INTO comment_trigger_claims
         (installation_id, owner, repo, pr_number, comment_id, state, payload_json, attempts, created_ms, queued_ms)
       VALUES (?, ?, ?, ?, ?, 'queued', ?, 0, ?, ?)
       ON CONFLICT (installation_id, owner, repo, pr_number, comment_id) DO NOTHING`,
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

  const outgoing = await runBeforeEnqueue(
    payload,
    deps,
    fields,
    "pre-enqueue hook failed — enqueueing anyway",
  );

  try {
    await deps.env.REVIEW_QUEUE.send(outgoing);
  } catch (err) {
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
