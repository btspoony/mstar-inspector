/**
 * D1 failure store (architect verdicts AL-1 + AL-6) — the
 * single write/read authority for the `review_failures` event log
 * (migration 0010). Dedicated leaf, mirroring the app-config-store.ts leaf
 * pattern: `artifact-store.ts` stays the single write authority for
 * `reviews`; this module NEVER touches `reviews` (era 判代 invariant:
 * `reviews.envelope IS NOT NULL ⇔ v1 row` — a failure row is not a review
 * and must not pollute that table).
 *
 * `QUEUE_MAX_ATTEMPTS` lives here because THIS module owns the per-delivery row
 * arithmetic: one message can leave at most one row per delivery, and the two
 * readers that must agree — the consumer's failed-claim stamp and the sweep's
 * default alert threshold — are both derived from it instead of restating it.
 * It is a queue fact, kept in a leaf so neither the worker's cron path nor the
 * review pipeline has to load the other to read it.
 *
 * Rows are APPEND-ONLY per-attempt events: the parse-fail degrade path
 * writes one row (stage="parse") before acking; the infra-failure catch
 * writes one best-effort row (stage="runner" | "sandbox" | "pipeline")
 * before each rethrow, so a DLQ'd message leaves up to QUEUE_MAX_ATTEMPTS rows
 * (one per delivery: 1 initial + the queue's max_retries). There is no update/delete
 * face by design — audit-log semantics (the cron sweep
 * counts rows over a created_at window; it never mutates them).
 *
 * created_at contract (BUG-03, documented — no schema rebuild): `record`
 * NEVER writes created_at — the column is ALWAYS the DDL DEFAULT
 * `datetime('now')` (migration 0010), i.e. the `YYYY-MM-DD HH:MM:SS` UTC
 * format. The cron sweep's TEXT window comparison
 * (`created_at > datetime('now', ?)`) depends on this exact
 * format; a producer that wrote an ISO-8601 or epoch value would silently
 * break the sweep. A CHECK constraint would require a table-rebuild
 * migration (SQLite) — disproportionate for a nit, so the contract is
 * pinned here + by the producer test. Retention is runbook-executed, NOT
 * in the read-only cron sweep (AL-6) — see docs/deploy.md § Maintenance.
 *
 * Module boundary (compass contracts A): type imports from ./types only —
 * no worker/pipeline/session/omp dependencies. The `db` parameter is the
 * narrow D1 face (`D1Like`) so the bun:sqlite test double and a real
 * `D1Database` both satisfy it structurally (same contract as
 * artifact-store.ts).
 */

import {
  ATTRIBUTION_EXCLUDED_STAGES,
  GITHUB_RATE_LIMIT_PREFIX,
  MAINTENANCE_DEFERRED_STAGE,
  QUOTA_STAGE,
  SHARED_BOT_ENTITLEMENT_STAGE,
} from "../contracts/failure-stages";
import type { D1Like, D1StatementLike } from "./types";

/**
 * The producer-side stage vocabulary (AL-1 + AL-6 extension, plus `usage` —
 * frozen): `parse` = the runner's stdout failed parseReviewOutput validation
 * (deterministic model-output failure — degrade + ack path); `runner` =
 * the in-image review run itself failed (non-zero exit / exec error);
 * `sandbox` = container acquisition or an in-sandbox git/diff/numstat/input
 * step failed; `pipeline` = worker-side orchestration (level/credential/
 * config resolution, comment post, …); `usage` = the execution's
 * `usage_events` ledger insert failed and the review continued, so the row is
 * the only record of the dropped metered attempt (it carries the `reviewId`);
 * `recheck` = the recheck round produced no usable document or its own status
 * said `failed` (the round continues with unverifiable rows; the row is the
 * attribution that survives a lost container stderr); `rate-limit` = the
 * degraded-comment sweep was throttled by a GitHub secondary rate limit while
 * the review itself stood (the continuation event, never a review failure);
 * `maintenance_deferred` = a delivery the platform's maintenance window could
 * not hand back to the queue (see {@link MAINTENANCE_DEFERRED_STAGE}).
 */
/**
 * Deliveries a message gets before the queue DLQs it: 1 initial delivery + the
 * queue's `max_retries` (wrangler.jsonc, one retry per guard rung today).
 * `tests/pipeline/queue-config-contract.test.ts` locks it to that config, so the
 * platform and this code cannot drift apart silently.
 *
 * The consumer imports it for its failed-claim stamp; the sweep derives its
 * default alert threshold from it. Kept in this leaf so neither has to load the other.
 */
export const QUEUE_MAX_ATTEMPTS = 6;

export const FAILURE_STAGES: readonly string[] = Object.freeze([
  "parse",
  "runner",
  "sandbox",
  "pipeline",
  // A delivery refused before execution (the plan lacks the shared bot): no
  // review ran, so the row stays paged AND attributed — it is in neither
  // exclusion list.
  SHARED_BOT_ENTITLEMENT_STAGE,
  // A delivery refused at enqueue because the month's RP ceiling is spent: a
  // real failure on the dashboard, kept out of the global ops alert only.
  QUOTA_STAGE,
  // A delivery the maintenance window could not defer: in neither exclusion
  // list, and kept out of the sweep's infrastructure total by its own
  // predicate — its separate existence signal has its own lane.
  MAINTENANCE_DEFERRED_STAGE,
  ...ATTRIBUTION_EXCLUDED_STAGES,
]);

export type FailureStage =
  | "parse"
  | "runner"
  | "sandbox"
  | "pipeline"
  | "entitlement"
  | "quota"
  | typeof MAINTENANCE_DEFERRED_STAGE
  | "usage"
  | "recheck"
  | "rate-limit";

/**
 * The two exclusion partitions of the vocabulary, re-exported from the
 * zero-dependency contract so the store and the dashboard interpolate the
 * SAME lists (the dashboard may not import this module — architect decision
 * Q2 — so the contract is where they are written).
 */
export {
  ATTRIBUTION_EXCLUDED_STAGES,
  MAINTENANCE_DEFERRED_STAGE,
  PAGING_EXCLUDED_STAGES,
  sqlStageList,
} from "../contracts/failure-stages";

/**
 * One failure event to record. `head_sha` is the AUTHORITATIVE checkout sha
 * when the run reached rev-parse; "" when the failure predates sha
 * resolution (the column is NOT NULL without the 0001 `CHECK (head_sha <>
 * '')` — a failure row exists precisely for runs that never produced a
 * reviewable sha). `error` is the attempt's structured error detail.
 * `target_id` is the `review_targets` row the run was executing for: the
 * tenant faces bind it, so a row without one belongs to no workspace.
 */
export type ReviewFailureInput = {
  /**
   * Optional deterministic row key (the attempt, or an attempt+stage). With it the
   * insert is idempotent, so a replay cannot append a second row for one fact;
   * absent, the row gets a random id.
   */
  id?: string;
  target_id: string;
  installation_id: number;
  owner: string;
  repo: string;
  pr_number: number;
  head_sha: string;
  stage: FailureStage;
  error: string;
};

/** A row of the `review_failures` table (D1 column names, snake_case; migration 0010). */
export type ReviewFailureRow = ReviewFailureInput & {
  id: string;
  created_at: string;
};

/**
 * The admission-refusal reasons an operator sees on the runtime page. The
 * terminal drop row `handleGuardHeld` writes (`src/pipeline/consumer.ts`)
 * carries the reason inside either error prefix:
 * `review dropped after <n> refused retries: <reason> (…)` or
 * `review dropped: comment claim restore failed: <detail>; admission refused: <reason> (…)`.
 * It is not a column and never becomes a stage value, so the read below
 * derives it. New drop formats in `handleGuardHeld` must extend the LIKE
 * predicates below to keep these counts complete.
 */
export const ADMISSION_DROP_REASONS = Object.freeze([
  "pr-held",
  "system-cap",
  "workspace-cap",
  "error",
] as const);

export type AdmissionDropReason = (typeof ADMISSION_DROP_REASONS)[number];

/** Admission drops in the trailing 24h, one count per reason (absent = 0). */
export type AdmissionDropCounts = Record<AdmissionDropReason, number>;

export type FailureStore = {
  /**
   * Append one failure event row. Fail-loud: an off-vocabulary stage throws
   * BEFORE any row is written (producer-side enforcement, 0009 precedent);
   * D1 errors propagate. Callers wanting best-effort semantics wrap this in
   * try/catch themselves (the consumer does — an insert failure must never
   * mask the ack or the rethrow).
   */
  record(input: ReviewFailureInput): Promise<void>;
  /**
   * Newest-first read face (the ops/test window scan). `created_at` has
   * second precision (`datetime('now')`), so rowid breaks ties inside one
   * second — the order is total and deterministic.
   */
  listRecent(limit?: number): Promise<ReviewFailureRow[]>;
  /**
   * Terminal admission drops in the trailing 24h, grouped by the reason token
   * of the drop row's prefix. One grouped READ over the rows the pipeline
   * already writes — no new table, writer or stage; every reason is present,
   * absent ones as 0. The `stage = 'pipeline'` + `created_at` window is served
   * by the partial index `idx_review_failures_pipeline_created` (migration
   * 0048), so this per-page-load read scans drop rows only, never the other
   * stages' traffic.
   */
  countAdmissionDrops24h(): Promise<AdmissionDropCounts>;
};

/**
 * The operator read's counted gauges on top of the append/read contract. Split
 * from {@link FailureStore} so the consumer's test doubles stay complete
 * without a verb they never call.
 */
export type FailureStoreWithCounts = FailureStore & {
  /**
   * GitHub secondary-rate-limit rejections in the trailing 24h, counted by the
   * `error` prefix every such row starts with. No stage predicate: the
   * `rate-limit` stage's rows ARE causes of this metric, and the primary-limit
   * prefix is different text, so a primary limit never inflates this number.
   */
  countGithubRateLimited24h(): Promise<number>;
};

/** Default page size for listRecent when the caller does not bound it. */
const LIST_RECENT_DEFAULT_LIMIT = 50;

/**
 * Matches both `review dropped after <n> refused retries: <reason> (…)` and
 * `review dropped: comment claim restore failed: <detail>; admission refused: <reason> (…)`.
 * `%` covers the retry count or restore detail; the open paren ends the reason
 * token. New drop formats in `handleGuardHeld` must extend these LIKE predicates.
 * Built from
 * `ADMISSION_DROP_REASONS` so the union and the SQL cannot diverge (the
 * `sqlStageList` precedent). Values are compile-time literals — no input
 * reaches this text.
 */
const admissionDropLike = (reason: AdmissionDropReason): string =>
  `(error LIKE 'review dropped after % refused retries: ${reason} (%'
    OR error LIKE 'review dropped: comment claim restore failed: %; admission refused: ${reason} (%')`;

const ADMISSION_DROP_SQL = `SELECT CASE
    ${ADMISSION_DROP_REASONS.map(
      (reason) => `WHEN ${admissionDropLike(reason)} THEN '${reason}'`,
    ).join("\n    ")}
  END AS reason,
  COUNT(*) AS drops
FROM review_failures
WHERE stage = 'pipeline'
  AND created_at > datetime('now', '-24 hours')
  AND (${ADMISSION_DROP_REASONS.map((reason) => admissionDropLike(reason)).join("\n    OR ")})
GROUP BY reason`;

/**
 * The secondary-rate-limit count over the same trailing 24h window as the
 * admission drops. The prefix is a bound value (it is a compile-time literal
 * with no wildcard of its own), so the query text stays constant.
 */
const GITHUB_RATE_LIMITED_SQL = `SELECT COUNT(*) AS count
FROM review_failures
WHERE created_at > datetime('now', '-24 hours')
  AND error LIKE ?`;

/** `review_failures.stage` is a producer vocabulary — reject anything off it before writing. */
function assertFailureStage(stage: string): void {
  if (!FAILURE_STAGES.includes(stage)) {
    throw new Error(
      `failure-store: stage ${JSON.stringify(stage)} is not on the producer vocabulary (${FAILURE_STAGES.join(" | ")}) — zero rows written`,
    );
  }
}

/**
 * The route recovery pass's terminal settlement failure: ONE row per ATTEMPT,
 * keyed by the attempt itself, so a re-pass or two concurrent passes can never
 * mint a second randomly identified row. The caller commits this in the SAME
 * D1 batch as the attempt's settle-once mark, which is what makes "the row
 * exists" and "the fact is recorded" a single step.
 */
export function settlementFailureRowStatement(
  db: D1Like,
  input: ReviewFailureInput,
  /** The deterministic row key: the attempt, or the attempt+stage for a per-stage row. */
  rowId: string,
): D1StatementLike {
  assertFailureStage(input.stage);
  return db
    .prepare(
      `INSERT INTO review_failures (id, target_id, installation_id, owner, repo, pr_number, head_sha, stage, error)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO NOTHING`,
    )
    .bind(
      rowId,
      input.target_id,
      input.installation_id,
      input.owner,
      input.repo,
      input.pr_number,
      input.head_sha,
      input.stage,
      input.error,
    );
}

/** Create the failure store over one D1 handle. */
export function createFailureStore(db: D1Like): FailureStoreWithCounts {
  return {
    async record(input: ReviewFailureInput): Promise<void> {
      if (!FAILURE_STAGES.includes(input.stage)) {
        throw new Error(
          `failure-store: stage ${JSON.stringify(input.stage)} is not on the producer vocabulary (${FAILURE_STAGES.join(" | ")}) — zero rows written`,
        );
      }
      // An explicit identity makes the write REPLAY-SAFE: one row per caller-chosen
      // key (an attempt, or an attempt+stage), so a retried collect cannot count
      // the same fact twice.
      if (input.id !== undefined) {
        await settlementFailureRowStatement(db, input, input.id).run();
        return;
      }
      await db
        .prepare(
          `INSERT INTO review_failures (id, target_id, installation_id, owner, repo, pr_number, head_sha, stage, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
          input.target_id,
          input.installation_id,
          input.owner,
          input.repo,
          input.pr_number,
          input.head_sha,
          input.stage,
          input.error,
        )
        .run();
    },

    async listRecent(limit: number = LIST_RECENT_DEFAULT_LIMIT): Promise<ReviewFailureRow[]> {
      const { results } = await db
        .prepare(`SELECT * FROM review_failures ORDER BY created_at DESC, rowid DESC LIMIT ?`)
        .bind(limit)
        .all<ReviewFailureRow>();
      return results;
    },

    async countAdmissionDrops24h(): Promise<AdmissionDropCounts> {
      const { results } = await db
        .prepare(ADMISSION_DROP_SQL)
        .all<{ reason: AdmissionDropReason; drops: number }>();
      const counts = Object.fromEntries(
        ADMISSION_DROP_REASONS.map((reason) => [reason, 0]),
      ) as AdmissionDropCounts;
      for (const row of results) counts[row.reason] = row.drops;
      return counts;
    },

    async countGithubRateLimited24h(): Promise<number> {
      const row = await db
        .prepare(GITHUB_RATE_LIMITED_SQL)
        .bind(`${GITHUB_RATE_LIMIT_PREFIX}%`)
        .first<{ count: number }>();
      return row?.count ?? 0;
    },
  };
}
