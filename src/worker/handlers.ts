/**
 * Webhook job handlers — structured logging, KV idempotency pre-check,
 * queue enqueue (plan 04 Task 2).
 *
 * Hot path: no GitHub API calls, no diff fetch, no review — verify + enqueue
 * only (webhook 5s timeout budget; sha comes from the webhook payload).
 *
 * Idempotency (compass S4 / plan Clarify 4):
 * - KV key only for non-null `head_sha`; a null sha must never become a KV
 *   key — `/review` commands always enqueue.
 * - KV has no atomic conditional write (`noneMatch` is not in
 *   workers-types), so this is get-then-put with a race window; the D1
 *   UNIQUE constraint (plan 05) is the durable fallback.
 * - KV read/write failure → conservative pass: log a warning and enqueue
 *   anyway (D1 fallback covers duplicates).
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

export type HandlerLog = {
  info: (fields: WorkerEventLog, msg?: string) => void;
  warn: (fields: WorkerEventLog, msg?: string) => void;
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
 * KV put-if-absent (get-then-put). Returns true when the key already exists
 * (idempotency hit → caller skips). On KV failure, returns false (conservative
 * pass) and logs a warning — the D1 UNIQUE constraint (plan 05) is the
 * durable duplicate guard.
 *
 * simplify: get-then-put has a race window for concurrent duplicate
 * deliveries; KV offers no atomic conditional write. D1 UNIQUE (05) is the
 * upgrade path.
 */
export async function putIfAbsent(
  kv: KVNamespace,
  key: string,
  fields: WorkerEventLog,
  log: HandlerLog,
): Promise<boolean> {
  try {
    const existing = await kv.get(key);
    if (existing !== null) {
      return true;
    }
    await kv.put(key, "1", { expirationTtl: IDEMPOTENCY_SECONDS });
    return false;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    log.warn(fields, `idempotency KV error — enqueueing anyway (D1 fallback): ${detail}`);
    return false;
  }
}

/**
 * Handle a classified review job: log the seven-field structured event, run
 * the idempotency pre-check (non-null head_sha only), and enqueue.
 */
export async function handleReviewJob(
  payload: ReviewJobPayload,
  deps: HandlerDeps,
): Promise<HandleOutcome> {
  const fields = toEventLog(payload);

  if (payload.head_sha !== null) {
    const key = idemKey({
      installation_id: payload.installation_id,
      owner: payload.owner,
      repo: payload.repo,
      pr_number: payload.pr_number,
      head_sha: payload.head_sha,
    });
    const alreadySeen = await putIfAbsent(deps.env.IDEMPOTENCY_KV, key, fields, deps.log);
    if (alreadySeen) {
      deps.log.info(fields, "idempotency hit — skipping enqueue");
      return { kind: "skipped", reason: "idempotency hit" };
    }
  }

  await deps.env.REVIEW_QUEUE.send(payload);
  deps.log.info(fields, "review job enqueued");
  return { kind: "enqueued" };
}
