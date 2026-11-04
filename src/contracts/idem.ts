/**
 * Idempotency key format + TTL — single source of truth (compass contracts B).
 * 04/05/06 MUST import from here; no second `idem:` literal or magic 86400.
 */
import type { KVNamespace } from "@cloudflare/workers-types";

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
 * - `IDEM_PAUSED` ("paused") — the App is paused (review_enabled=0); the
 *   message was acked with no review.
 * - `IDEM_DEGRADED` ("degraded") — the model output failed validation; the
 *   run ended in a degraded notice, never a review.
 * - `IDEM_SUPERSEDED` ("superseded") — a newer commit overtook this one when
 *   the delivery was acked, so no review ran for it.
 *
 * Only the first two prove the commit has a review that ran or will run;
 * `dropped` / `failed` / `paused` / `degraded` / `superseded` all name a
 * commit that was NOT reviewed, so a redelivery must enqueue again rather
 * than be skipped. `superseded` in particular is not a tombstone: a sha can
 * become the PR head again (force-push A → B → A), and then the ledger
 * comparison — not this stale claim — is what decides whether it is a
 * leftover.
 */
export const IDEM_ENQUEUED = "1";
export const IDEM_DONE = "done";
export const IDEM_DROPPED = "dropped";
export const IDEM_FAILED = "failed";
export const IDEM_PAUSED = "paused";
export const IDEM_DEGRADED = "degraded";
export const IDEM_SUPERSEDED = "superseded";

/** Every claim that names a commit which was NOT reviewed. */
export type AbandonClaim =
  | typeof IDEM_DROPPED
  | typeof IDEM_FAILED
  | typeof IDEM_PAUSED
  | typeof IDEM_DEGRADED
  | typeof IDEM_SUPERSEDED;

/**
 * Write an abandon claim without ever downgrading a completed review: `done`
 * outranks every abandon outcome because it is the durable proof that a commit
 * was reviewed, and erasing it re-reviews (and re-pays for) that commit.
 *
 * Reads first and writes only over a non-`done` claim. A read fault skips the
 * write entirely, leaving the existing claim as it was — callers warn about
 * their own write failure, so this never throws on the read.
 */
export async function putAbandonClaim(
  kv: KVNamespace,
  key: string,
  value: AbandonClaim,
  ttlSeconds: number,
): Promise<void> {
  let current: string | null;
  try {
    current = await kv.get(key);
  } catch {
    return;
  }
  if (current === IDEM_DONE) return;
  await kv.put(key, value, { expirationTtl: ttlSeconds });
}

/**
 * The worker's enqueue pre-check: true only for a claim that a review of this
 * sha is queued or already posted — the two values that make a redelivery
 * pointless.
 *
 * Deliberately identical to `isReviewClaim` in this revision, and kept as its
 * own name because the two answer different questions at different layers:
 * the worker asks "need a job?", the consumer asks "is the newer commit's
 * review coming?". `superseded` is on the FALSE side for both: the sha was
 * skipped once, but a force-push back to it (A → B → A) makes it the head
 * again, and only the ledger comparison may then decide it is a leftover.
 */
export function isEnqueuedClaim(value: string | null): boolean {
  return value === IDEM_ENQUEUED || value === IDEM_DONE;
}

/**
 * The supersede proof: true only for a claim that a review of THIS sha is
 * queued or completed; it rejects `superseded`, since a replaced commit
 * proves nothing about the newer one.
 */
export function isReviewClaim(value: string | null): boolean {
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
