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
import type { FailureCode } from "../contracts/failure-codes";
import type { D1Like, D1StatementLike } from "./types";

export const QUEUE_MAX_ATTEMPTS = 6;

export const FAILURE_STAGES: readonly string[] = Object.freeze([
  "parse",
  "runner",
  "sandbox",
  "pipeline",
  SHARED_BOT_ENTITLEMENT_STAGE,
  QUOTA_STAGE,
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
  /**
   * The closed operator-facing code (`src/contracts/failure-codes.ts`).
   * REQUIRED: a NULL code now means "recorded before classification existed",
   * so a new row that omits one would be indistinguishable from a historical
   * row and unfindable by its incident code.
   */
  code: FailureCode;
  /**
   * For a quota refusal, WHICH ceiling refused: the workspace's plan month
   * ('plan') or one bot's own month ('bot'). Absent for every other stage and
   * for historical rows, where the distinction did not exist.
   */
  quotaScope?: "plan" | "bot" | null;
  /**
   * The bot a 'bot' refusal named. Never the App id: a plan refusal has no bot,
   * and a fabricated id is worse than a NULL an operator can rule out.
   */
  quotaBotId?: string | null;
  /**
   * The attempt id the failure belongs to (the Workflow instance id), or a
   * caller-chosen id for a failure that never reached an attempt. Absent, the
   * row's own id is the track id.
   */
  trackId?: string;
  /**
   * The PR author's one-sentence summary for `code`. Lives beside `error`, not
   * inside it: `error` stays the raw mechanism text every operator counter and
   * exact-text read already depends on. REQUIRED for the same reason as `code`.
   */
  message: string;
};

/** A row of the `review_failures` table (D1 column names, snake_case; migration 0010 + 0106). */
export type ReviewFailureRow = Omit<ReviewFailureInput, "code" | "trackId"> & {
  id: string;
  error_code: string | null;
  track_id: string | null;
  created_at: string;
};

/**
 * The admission-refusal reasons an operator sees on the runtime page. The
 * terminal drop row `handleGuardHeld` writes (`src/pipeline/consumer.ts`)
 * carries the reason inside either error prefix:
 * `review dropped after <n> refused retries: <reason> (…)` or
 * `review dropped: comment claim restore failed: <detail>; admission refused: <reason> (…)`.
 * It is not a column and never becomes a stage value, so the read below
 * derives it. New drop formats in `handleGuardHeld` must extend the
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
  record(input: ReviewFailureInput): Promise<void>;
  /**
   * Rewrite a row's CLASSIFICATION after the fact (code + author sentence) when
   * a step recorded it before the outcome was known. Append-only would leave a
   * summary that contradicts what actually happened.
   */
  reclassify(input: { id: string; code: FailureCode; message: string }): Promise<void>;
  listRecent(limit?: number): Promise<ReviewFailureRow[]>;
  countAdmissionDrops24h(): Promise<AdmissionDropCounts>;
};

/**
 * The operator read's counted gauges on top of the append/read contract. Split
 * from {@link FailureStore} so the consumer's test doubles stay complete
 * without a verb they never call.
 */
export type FailureStoreWithCounts = FailureStore & {
  countGithubRateLimited24h(): Promise<number>;
};

const LIST_RECENT_DEFAULT_LIMIT = 50;

/**
 * The two sentence shapes an admission drop writes. Matched with a prefix
 * `substr` plus `instr`, never `LIKE`: D1 answers
 * `LIKE or GLOB pattern too complex: SQLITE_ERROR` once a stored `error` is
 * long enough for a wildcard pattern's backtracking to overrun SQLite's step
 * budget, which turned the operator gauge into a 500 for the whole runtime
 * read. Keep new drop formats on these predicates.
 */
const ADMISSION_DROP_AFTER_PREFIX = "review dropped after ";
const ADMISSION_DROP_RESTORE_PREFIX = "review dropped: comment claim restore failed: ";

const admissionDropMatch = (reason: AdmissionDropReason): string =>
  `((substr(error, 1, ${ADMISSION_DROP_AFTER_PREFIX.length}) = '${ADMISSION_DROP_AFTER_PREFIX}'
     AND instr(error, ' refused retries: ${reason} (') > 0)
    OR (substr(error, 1, ${ADMISSION_DROP_RESTORE_PREFIX.length}) = '${ADMISSION_DROP_RESTORE_PREFIX}'
     AND instr(error, '; admission refused: ${reason} (') > 0))`;

const ADMISSION_DROP_SQL = `SELECT CASE
    ${ADMISSION_DROP_REASONS.map(
      (reason) => `WHEN ${admissionDropMatch(reason)} THEN '${reason}'`,
    ).join("\n    ")}
  END AS reason,
  COUNT(*) AS drops
FROM review_failures
WHERE stage = 'pipeline'
  AND created_at > datetime('now', '-24 hours')
  AND (${ADMISSION_DROP_REASONS.map((reason) => admissionDropMatch(reason)).join("\n    OR ")})
GROUP BY reason`;

const GITHUB_RATE_LIMITED_SQL = `SELECT COUNT(*) AS count
FROM review_failures
WHERE created_at > datetime('now', '-24 hours')
  AND error LIKE ?`;

/** `review_failures.stage` is a producer vocabulary — reject anything off it before writing. */
export function assertFailureStage(stage: string): void {
  if (!FAILURE_STAGES.includes(stage)) {
    throw new Error(
      `failure-store: stage ${JSON.stringify(stage)} is not on the producer vocabulary (${FAILURE_STAGES.join(" | ")}) — zero rows written`,
    );
  }
}

/**
 * The route recovery pass's terminal settlement failure: ONE row per ATTEMPT,
 * keyed by the attempt itself, so a re-pass or two concurrent passes can never
 * mint a second row for one attempt. The caller commits this in the SAME
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
      `INSERT INTO review_failures (id, target_id, installation_id, owner, repo, pr_number, head_sha, stage, error, error_code, track_id, message, quota_scope, quota_bot_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
      input.code ?? null,
      input.trackId ?? rowId,
      input.message ?? null,
      input.quotaScope ?? null,
      input.quotaBotId ?? null,
    );
}

/** Create the failure store over one D1 handle. */
export function createFailureStore(db: D1Like): FailureStoreWithCounts {
  return {
    async reclassify(input: { id: string; code: FailureCode; message: string }): Promise<void> {
      await db
        .prepare("UPDATE review_failures SET error_code = ?, message = ? WHERE id = ?")
        .bind(input.code, input.message, input.id)
        .run();
    },
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
      // An explicit identity is required for reclassification; without one the
      // row's own id IS the track id: one value, written twice, so a failure
      // that never reached an attempt is still locatable.
      const rowId = crypto.randomUUID();
      await db
        .prepare(
          `INSERT INTO review_failures (id, target_id, installation_id, owner, repo, pr_number, head_sha, stage, error, error_code, track_id, message, quota_scope, quota_bot_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
          input.code ?? null,
          input.trackId ?? rowId,
          input.message ?? null,
          input.quotaScope ?? null,
          input.quotaBotId ?? null,
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
