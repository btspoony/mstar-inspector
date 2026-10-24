/**
 * Usage ledger leaf (migration 0031) — the single write authority for
 * `usage_events`. One row per STARTED execution of a review; `seq` is the
 * attempt number within one `review_id`, minted by the ledger itself so
 * concurrent writers cannot agree on the same value.
 *
 * The insert is ONE statement (`INSERT … SELECT MAX(seq)+1`): the read and
 * the write happen inside the same statement, so there is no read-then-write
 * window. `review_id` has no FK on purpose (an attempt can outlive a review
 * row that rolled back); `workspace_id` does, and an unknown workspace is
 * refused by the schema.
 *
 * Module boundary (compass contracts A): type imports from ./types only — no
 * worker/pipeline/session dependencies (same contract as failure-store.ts).
 */

import type { D1Like } from "./types";

/** The usage row input. `occurredAt` is an ISO-8601 string supplied by the caller. */
export type UsageEventInput = {
  reviewId: string;
  workspaceId: string;
  occurredAt: string;
};

/** Append one started-execution row, minting the attempt `seq`. */
export async function recordUsageEvent(db: D1Like, input: UsageEventInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO usage_events (review_id, seq, workspace_id, occurred_at)
       SELECT ?1, COALESCE(MAX(seq), 0) + 1, ?2, ?3 FROM usage_events WHERE review_id = ?1`,
    )
    .bind(input.reviewId, input.workspaceId, input.occurredAt)
    .run();
}
