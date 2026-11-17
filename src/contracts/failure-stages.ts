/**
 * The `review_failures.stage` EXCLUSION partitions — single source of truth
 * (compass contracts B). The dashboard asks "is this row a failure of the
 * review?" and the cron sweep asks "is this row a platform incident?", so the
 * lists are written once here and interpolated into each query by
 * `sqlStageList`; a hand-written stage literal is what let the count/history
 * asymmetry drift.
 *
 * Zero imports: `src/dashboard/**` may import this module but never
 * `store/pipeline/review` code (architect decision Q2, the same admission
 * `src/contracts/sandbox-images.ts` has), and `src/store/failure-store.ts`
 * re-exports the lists as its producer-vocabulary partition.
 */

/**
 * Stages whose rows record a review that CONTINUED — per-round attribution,
 * never a failure of the review itself. The dashboard's failure count (list
 * aggregate, detail `counts.failures`) and the per-PR failure history exclude
 * the whole set, so a tab number never disagrees with the pager below it. The
 * rows stay in `review_failures` — `usage` is the only record of a dropped
 * metered attempt, `recheck` of a round that produced no usable document, and
 * `rate-limit` of a degraded-comment sweep GitHub throttled while the review
 * itself stood — they are just not failures.
 *
 * Paging is a STRICT SUPERSET of this set ({@link PAGING_EXCLUDED_STAGES}):
 * a row can be a real failure the dashboard must show and still be kept out
 * of the global ops alert. The two questions are asked separately for exactly
 * that reason — extending the paging set must never hide a row from the
 * dashboard.
 */
export const ATTRIBUTION_EXCLUDED_STAGES = Object.freeze(["recheck", "usage", "rate-limit"] as const);

/**
 * Stages the cron sweep's infrastructure alert ignores: the attribution set
 * plus `quota`. A quota refusal is a REAL failure — the dashboard counts and
 * lists it — but it is one tenant's exhausted month, so a global ops page
 * would announce a platform incident for a commercial ceiling. Maintenance
 * stays OUT of both lists: the sweep is what turns a closed platform into an
 * alert instead of a silent dead-letter.
 */
export const PAGING_EXCLUDED_STAGES = Object.freeze([
  ...ATTRIBUTION_EXCLUDED_STAGES,
  "quota",
] as const);

/**
 * The `review_failures.stage` a shared-bot entitlement refusal is recorded
 * under. It joins the failure vocabulary (it is NOT a paging-excluded stage):
 * the delivery produced no review at all, which is exactly what the failure
 * face exists to explain, and the commit stays unblamed by the Check's
 * `neutral` conclusion rather than by hiding the row.
 */
export const SHARED_BOT_ENTITLEMENT_STAGE = "entitlement";

/**
 * The one sentence a shared-bot refusal carries, written once because THREE
 * surfaces must not drift: the delivery's Check summary
 * (`CHECK_SUMMARIES.skippedByDelivery`), the `review_failures.error` text of
 * the same refusal, and the skip returned to the webhook handler.
 *
 * Author-facing, so it names no workspace, no workspace id, no plan id and no
 * upgrade path: the PR author usually sits outside the workspace and can act
 * on none of them, and a tenant name in a public Check publishes one
 * customer's billing state to a third party.
 */
export const SHARED_BOT_ENTITLEMENT_SKIP_REASON =
  "the review target's plan does not include the shared bot";

/**
 * The `review_failures.stage` a quota refusal is recorded under. It is a
 * SEPARATE stage from `entitlement` because the two name different causes: the
 * plan lacks the capability versus this month's consumption reached the plan's
 * RP ceiling. Unlike `entitlement` it IS in `PAGING_EXCLUDED_STAGES` and NOT in
 * `ATTRIBUTION_EXCLUDED_STAGES`: visible as a failure on the dashboard, excluded
 * from infrastructure paging — one tenant's spent month is a commercial
 * ceiling, not a platform incident.
 */
export const QUOTA_STAGE = "quota";

/**
 * The `review_failures.stage` a delivery the maintenance window could not defer
 * is recorded under: the platform was closed and the queue had no redelivery
 * left (a runtime without `message.retry`, or a message already on its last
 * platform delivery). Like `entitlement` it is in NEITHER exclusion list — no
 * review ran, so the row stays counted and the 15-min failure sweep alerts on
 * it instead of the delivery vanishing into the DLQ. Its `error` text carries
 * the one reason token `maintenance_window`.
 */
export const MAINTENANCE_DEFERRED_STAGE = "maintenance_deferred";

/**
 * The one sentence a quota refusal carries. Author-facing for the same reason
 * as its `entitlement` sibling — no plan id, no workspace name, no ceiling
 * figure: the PR author can act on none of them, and the Check is public.
 */
export const QUOTA_SKIP_REASON = "the workspace has reached this month's review quota";

/**
 * The one sentence an UNREADABLE gate carries. It is not a plan fact: the gate
 * could not be computed (a store fault, no quota profile, a plan with no
 * ceiling row), so the delivery was refused fail-closed. Author-facing like its
 * siblings — it names no plan, no workspace and no configuration detail, which
 * belongs on the failure row's log line instead.
 */
export const ENTITLEMENT_UNREADABLE_SKIP_REASON =
  "this delivery could not be checked against the workspace's plan";

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
