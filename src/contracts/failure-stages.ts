/**
 * The `review_failures.stage` ATTRIBUTION partition — single source of truth
 * (compass contracts B). The cron sweep and the dashboard both ask the same
 * question ("is this row a failure of the review?"), so the list is written
 * once here and interpolated into each query by `sqlStageList`; a hand-written
 * stage literal is what let the count/history asymmetry drift.
 *
 * Zero imports: `src/dashboard/**` may import this module but never
 * `store/pipeline/review` code (architect decision Q2, the same admission
 * `src/contracts/sandbox-images.ts` has), and `src/store/failure-store.ts`
 * re-exports the lists as its producer-vocabulary partition.
 */

/**
 * Stages whose rows record a review that CONTINUED — per-round attribution,
 * never a failure of the review itself. Every COUNT and every list that pages
 * these rows excludes the whole set: the cron sweep's paging count, the
 * dashboard's failure count (list aggregate, detail `counts.failures`) and the
 * per-PR failure history. One rule on both faces, so a tab number never
 * disagrees with the pager below it. The rows stay in `review_failures` —
 * `usage` is the only record of a dropped metered attempt, `recheck` of a
 * round that produced no usable document, and `rate-limit` of a degraded-
 * comment sweep GitHub throttled while the review itself stood — they are just
 * not failures.
 */
export const PAGING_EXCLUDED_STAGES = Object.freeze(["recheck", "usage", "rate-limit"] as const);

/**
 * Render a stage list as the literal body of a SQL `IN (…)` / `NOT IN (…)`
 * comparison (each stage single-quoted and comma-joined, e.g.
 * `'recheck', 'usage'`). Callers supply the operator and parentheses; this
 * helper only renders the list, so it is never valid as an operand sequence
 * of its own.
 */
export function sqlStageList(stages: readonly string[]): string {
  return stages.map((stage) => `'${stage}'`).join(", ");
}

/**
 * The stable `review_failures.error` prefix a GitHub secondary rate limit
 * carries. The consumer writes it once at its single catch and the store
 * counts rows by it, so the 24 h number and the durable text share one source
 * of truth. Plain words on purpose: the shape redaction pass the row also
 * passes through leaves them intact.
 */
export const GITHUB_RATE_LIMIT_PREFIX = "github-secondary-rate-limit: ";

/**
 * The stable `review_failures.error` prefix a GitHub PRIMARY rate limit
 * carries. Its own words on purpose: it must never match a count that reads
 * {@link GITHUB_RATE_LIMIT_PREFIX}, so a primary-limit row cannot inflate the
 * secondary-limit number.
 */
export const GITHUB_PRIMARY_RATE_LIMIT_PREFIX = "github-primary-rate-limit: ";

/** Case-insensitive header read over either header shape a transport exposes. */
function headerValue(headers: unknown, name: string): string | null {
  if (headers === null || typeof headers !== "object") return null;
  if ("get" in headers && typeof headers.get === "function") {
    const value: unknown = headers.get(name);
    return value === null || value === undefined ? null : String(value);
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value === null || value === undefined ? null : String(value);
  }
  return null;
}

/**
 * Which GitHub limit — if any — rejected this call. Duck-typed on the octokit
 * request-error shape (`{status, message, response: {headers}}`), because the
 * error crosses the injected adapter boundary and is never re-wrapped: a
 * plain object, a `Headers` instance and any non-request value all answer
 * without throwing.
 *
 * `429` is the primary limit. GitHub answers `403` for BOTH limits, so a
 * `403` is secondary only when GitHub's secondary signals are present — a
 * `retry-after` header, or a message naming the secondary limit. A `403`
 * whose `x-ratelimit-remaining` is `0` is primary exhaustion (the budget is
 * gone, and none of the secondary signals appeared); a bare `403` is an
 * ordinary permission/not-found rejection and stays unclassified (`null`).
 */
export function classifyGithubRateLimit(err: unknown): "primary" | "secondary" | null {
  if (typeof err !== "object" || err === null) return null;
  const status = "status" in err ? err.status : undefined;
  if (status === 429) return "primary";
  if (status !== 403) return null;
  const response = "response" in err ? err.response : undefined;
  const headers = typeof response === "object" && response !== null && "headers" in response ? response.headers : undefined;
  const message = "message" in err ? err.message : undefined;
  // The secondary signals are checked FIRST: they win over an exhausted
  // budget, which GitHub also reports on a throttled secondary 403.
  if (headerValue(headers, "retry-after") !== null) return "secondary";
  if (typeof message === "string" && /secondary rate limit/i.test(message)) return "secondary";
  if (headerValue(headers, "x-ratelimit-remaining") === "0") return "primary";
  return null;
}
