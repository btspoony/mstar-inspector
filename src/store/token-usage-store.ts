import type { D1Like, D1StatementLike } from "./types";

/**
 * note: One (provider, model) bucket of a completed review attempt — the
 * payload columns of `review_token_usage` (migration 0108). Structurally
 * identical to the wire's `TokenUsageBucket`, declared here because store
 * leaves keep their "type imports from ./types only" boundary.
 */
export type TokenUsageRow = {
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  total: number;
  requests: number;
  costUsd: number;
};

/**
 * The attempt-keyed write set. `targetId`/`workspaceId` come from the
 * attempt's own ref/payload at the call site — never a re-query that could
 * disagree with the row the attempt was claimed under. `occurredAt` is an
 * ISO-8601 string supplied by the caller (the completion instant, so the
 * window index orders rows by when the spend was recorded).
 */
export type ReviewTokenUsageWrite = {
  attemptId: string;
  targetId: string;
  workspaceId: string;
  occurredAt: string;
  buckets: readonly TokenUsageRow[];
};

/**
 * Idempotent on (attempt_id, provider, model): a replayed write of the same
 * attempt replaces its own rows and cannot double-count. `occurred_at` moves
 * to the replay's instant — the latest observed fact wins, matching the
 * "latest values" rule the completion step retries under.
 */
const UPSERT_TOKEN_USAGE_SQL = `
INSERT INTO review_token_usage (
  attempt_id, provider, model, target_id, workspace_id,
  input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
  total_tokens, requests, cost_usd, occurred_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (attempt_id, provider, model) DO UPDATE SET
  target_id = excluded.target_id,
  workspace_id = excluded.workspace_id,
  input_tokens = excluded.input_tokens,
  output_tokens = excluded.output_tokens,
  cache_read_tokens = excluded.cache_read_tokens,
  cache_write_tokens = excluded.cache_write_tokens,
  total_tokens = excluded.total_tokens,
  requests = excluded.requests,
  cost_usd = excluded.cost_usd,
  occurred_at = excluded.occurred_at
`;

/**
 * The statements persisting one attempt's buckets — one upsert per
 * (provider, model). The caller puts them in ONE D1 batch with the launch
 * completion, so a fault rolls back both sides and a successful execution is
 * never recorded as finished without its usage rows.
 */
export function tokenUsageStatements(db: D1Like, write: ReviewTokenUsageWrite): D1StatementLike[] {
  return write.buckets.map((bucket) =>
    db
      .prepare(UPSERT_TOKEN_USAGE_SQL)
      .bind(
        write.attemptId,
        bucket.provider,
        bucket.model,
        write.targetId,
        write.workspaceId,
        bucket.input,
        bucket.output,
        bucket.cacheRead,
        bucket.cacheWrite,
        bucket.total,
        bucket.requests,
        bucket.costUsd,
        write.occurredAt,
      ),
  );
}
