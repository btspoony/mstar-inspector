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
 * Build the KV idempotency key: `idem:{installation_id}:{owner}/{repo}:{pr_number}:{head_sha}`.
 * Throws on empty head_sha — a null/empty sha must never become a KV key
 * (compass contracts B: `/review` has no sha → enqueue without KV write).
 */
export function idemKey(key: IdempotencyKey): string {
  if (!key.head_sha) {
    throw new Error("idemKey: head_sha must be a non-empty string");
  }
  return `idem:${key.installation_id}:${key.owner}/${key.repo}:${key.pr_number}:${key.head_sha}`;
}
