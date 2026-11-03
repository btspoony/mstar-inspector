/**
 * Idempotency key format + TTL — single source of truth (compass contracts B).
 * 04/05/06 MUST import from here; no second `idem:` literal or magic 86400.
 */
export type IdempotencyKey = {
  installation_id: number;
  owner: string;
  repo: string;
  pr_number: number;
  head_sha: string; // non-empty invariant; empty/null must be rejected
};

/** KV TTL for idempotency keys (24h). */
export const IDEMPOTENCY_SECONDS = 86400;

/**
 * The idempotency key's VALUE vocabulary — the one state machine every writer
 * and reader shares:
 * - `IDEM_ENQUEUED` ("1") — the worker sent the job; it is queued or in flight.
 * - `IDEM_DONE` ("done") — the consumer completed the review.
 * - `IDEM_DROPPED` ("dropped") — the in-flight guard gave the job up for good.
 * - `IDEM_FAILED` ("failed") — the final delivery threw; the message is
 *   heading to the DLQ.
 *
 * Only the first two prove the commit has a review that ran or will run; the
 * other two mean the commit was NOT reviewed, so a redelivery must enqueue
 * again rather than be skipped.
 */
export const IDEM_ENQUEUED = "1";
export const IDEM_DONE = "done";
export const IDEM_DROPPED = "dropped";
export const IDEM_FAILED = "failed";

/**
 * True only for the values that prove the commit's job is pending or already
 * reviewed. `dropped` / `failed` / a miss all mean "not reviewed".
 */
export function isEnqueuedClaim(value: string | null): boolean {
  return value === IDEM_ENQUEUED || value === IDEM_DONE;
}

/**
 * Build the KV idempotency key: `idem:{installation_id}:{owner}/{repo}:{pr_number}:{head_sha}`.
 * Throws on empty head_sha — a null/empty sha must never become a KV key
 * (compass contracts B: a comment mention has no sha → enqueue without KV
 * write).
 */
export function idemKey(key: IdempotencyKey): string {
  if (!key.head_sha) {
    throw new Error("idemKey: head_sha must be a non-empty string");
  }
  return `idem:${key.installation_id}:${key.owner}/${key.repo}:${key.pr_number}:${key.head_sha}`;
}
