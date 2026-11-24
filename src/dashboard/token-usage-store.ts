import { clampWindow } from "./insights-store";

/**
 * The bucket columns one aggregate row carries — identical on every
 * (provider, model) row and on the `total` face, declared once so the two
 * cannot drift apart. Wire shape is snake_case and passes through the route
 * untouched, mirroring the other dashboard store leaves.
 */
export type TokenUsageTotals = {
  requests: number;
  input: number;
  cache_read: number;
  cache_write: number;
  output: number;
  total: number;
  cost_usd: number;
};

/** One (provider, model) bucket of the target's token-usage aggregate. */
export type TokenUsageBucketRow = TokenUsageTotals & { provider: string; model: string };

/** The `GET /api/targets/:targetId/token-usage` payload body. */
export type TargetTokenUsage = {
  window_days: number;
  buckets: TokenUsageBucketRow[];
  total: TokenUsageTotals;
};

type TokenUsageStatement = {
  bind(...values: unknown[]): TokenUsageStatement;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
};

/** Narrow D1 face the read depends on (read-only, mirrors InsightsD1). */
export type TokenUsageD1 = {
  prepare(query: string): TokenUsageStatement;
};

/**
 * One target's token spend per (provider, model) for the insights window
 * (default 30 days, clamped to 90 — the same clamp the insights summary
 * applies). Scope is the caller-resolved target plus its workspace: the
 * target/workspace pair rides the rows at write time and both must match,
 * so a path-supplied workspace can never widen the read. `occurred_at` is
 * the write-time instant (`new Date().toISOString()`), so both half-open
 * `[now - window, now)` bounds are generated as ISO-8601 UTC strings from
 * one `nowMs` and bound verbatim — a pure string comparison over the
 * production format. No live rows in the window yields an empty `buckets`
 * list and a zero total.
 */
export async function readTargetTokenUsage(
  db: TokenUsageD1,
  scope: { targetId: string; workspaceId: string },
  windowDays?: number,
  nowMs: number = Date.now(),
): Promise<TargetTokenUsage> {
  const days = clampWindow(windowDays);
  const { results } = await db
    .prepare(
      `SELECT
         u.provider AS provider,
         u.model AS model,
         SUM(u.requests) AS requests,
         SUM(u.input_tokens) AS input,
         SUM(u.cache_read_tokens) AS cache_read,
         SUM(u.cache_write_tokens) AS cache_write,
         SUM(u.output_tokens) AS output,
         SUM(u.total_tokens) AS total,
         SUM(u.cost_usd) AS cost_usd
       FROM review_token_usage u
       WHERE u.target_id = ?
         AND u.workspace_id = ?
         AND u.occurred_at >= ?
         AND u.occurred_at < ?
       GROUP BY u.provider, u.model
       ORDER BY u.provider ASC, u.model ASC`,
    )
    .bind(scope.targetId, scope.workspaceId, new Date(nowMs - days * 86_400_000).toISOString(), new Date(nowMs).toISOString())
    .all<TokenUsageBucketRow>();
  const total: TokenUsageTotals = {
    requests: 0,
    input: 0,
    cache_read: 0,
    cache_write: 0,
    output: 0,
    total: 0,
    cost_usd: 0,
  };
  for (const bucket of results) {
    total.requests += bucket.requests;
    total.input += bucket.input;
    total.cache_read += bucket.cache_read;
    total.cache_write += bucket.cache_write;
    total.output += bucket.output;
    total.total += bucket.total;
    total.cost_usd += bucket.cost_usd;
  }

  return { window_days: days, buckets: results, total };
}
