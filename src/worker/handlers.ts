/**
 * Webhook job handlers — structured logging, KV idempotency pre-check,
 * queue enqueue (plan 04 Task 2).
 *
 * Hot path: no GitHub API calls, no diff fetch, no review — verify + enqueue
 * only (webhook 5s timeout budget; sha comes from the webhook payload).
 *
 * Idempotency (compass S4 / plan Clarify 4):
 * - KV key only for non-empty `head_sha`; a null/empty sha must never become
 *   a KV key — `/review` commands always enqueue.
 * - KV has no atomic conditional write (`noneMatch` is not in
 *   workers-types), so this is get-then-put with a race window; the D1
 *   UNIQUE constraint (plan 05) is the durable fallback.
 * - KV read/write failure → conservative pass: log a warning and enqueue
 *   anyway (D1 fallback covers duplicates).
 * - Ordering invariant: the KV key is claimed only AFTER `REVIEW_QUEUE.send`
 *   resolves. A key therefore means "enqueued" — a failed send leaves no key,
 *   so GitHub's retry re-enqueues instead of being KV-skipped.
 */
import type { KVNamespace } from "@cloudflare/workers-types";
import { idemKey, IDEMPOTENCY_SECONDS } from "../contracts/idem";
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
 * Structured log fields for a webhook-face rejection/bookkeeping warn (plan
 * 13 QC F-005; plan 15 log hygiene extended it to the legacy face): the
 * caller's REAL stage label rides `event` — the literal "unknown" no longer
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
  info: (fields: WorkerEventLog, msg?: string) => void;
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
 * Idempotency pre-check: true when the key already exists (skip). On KV
 * failure, returns false (conservative pass) and logs a warning — the D1
 * UNIQUE constraint (plan 05) is the durable duplicate guard.
 */
export async function idempotencyHit(
  kv: KVNamespace,
  key: string,
  fields: WorkerEventLog,
  log: HandlerLog,
): Promise<boolean> {
  try {
    return (await kv.get(key)) !== null;
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
    await kv.put(key, "1", { expirationTtl: IDEMPOTENCY_SECONDS });
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn(fields, `idempotency KV error — enqueueing anyway (D1 fallback): ${detail}`);
  }
}

/**
 * Handle a classified review job: log the seven-field structured event, run
 * the idempotency pre-check (non-empty head_sha only), enqueue, then claim
 * the KV key. A key therefore means "enqueued" — a failed send leaves no
 * key, so GitHub's retry re-enqueues instead of being KV-skipped.
 */
export async function handleReviewJob(
  payload: ReviewJobPayload,
  deps: HandlerDeps,
): Promise<HandleOutcome> {
  const fields = toEventLog(payload);

  // Non-empty sha only: a null/empty sha (e.g. `/review` commands) must
  // never become a KV key and always enqueues (compass S4 / Clarify 4).
  const key =
    payload.head_sha
      ? idemKey({
          installation_id: payload.installation_id,
          owner: payload.owner,
          repo: payload.repo,
          pr_number: payload.pr_number,
          head_sha: payload.head_sha,
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
