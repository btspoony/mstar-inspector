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
  /**
   * One per STARTED execution attempt, minted by the producer before it writes
   * (UNIQUE in the table). It is the identity a failed insert is read back by:
   * earlier attempts for the same review must never answer for this one.
   */
  executionToken: string;
  workspaceId: string;
  occurredAt: string;
};

/**
 * This workspace's started executions at or after `sinceIso` — the
 * month-to-date read behind the settings surface. `occurred_at` is an
 * ISO-8601 UTC string, so the string comparison is the time comparison.
 */
export async function countUsageEventsSince(
  db: D1Like,
  workspaceId: string,
  sinceIso: string,
): Promise<number> {
  const row = await db
    .prepare(`SELECT COUNT(*) AS n FROM usage_events WHERE workspace_id = ? AND occurred_at >= ?`)
    .bind(workspaceId, sinceIso)
    .first<{ n: number }>();
  return row?.n ?? 0;
}

/** Append one started-execution row, minting the attempt `seq`. */
export async function recordUsageEvent(db: D1Like, input: UsageEventInput): Promise<void> {
  await db
    .prepare(
      `INSERT INTO usage_events (review_id, seq, execution_token, workspace_id, occurred_at)
       SELECT ?1, COALESCE(MAX(seq), 0) + 1, ?2, ?3, ?4 FROM usage_events WHERE review_id = ?1`,
    )
    .bind(input.reviewId, input.executionToken, input.workspaceId, input.occurredAt)
    .run();
}

/**
 * Whether THIS execution attempt's row landed — the read-back that tells a
 * PRE-commit insert failure apart from an ambiguous one (the write landed, the
 * driver threw). It asks by `execution_token`, never by a row count: a review
 * may already hold earlier attempts, and a count would mislabel a failed second
 * attempt as applied. Only `false` is backfillable.
 */
export async function hasUsageEventForExecutionToken(
  db: D1Like,
  executionToken: string,
): Promise<boolean> {
  const row = await db
    .prepare(`SELECT 1 AS present FROM usage_events WHERE execution_token = ?`)
    .bind(executionToken)
    .first<{ present: number }>();
  return row !== null;
}
