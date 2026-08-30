/**
 * D1 failure store (plan 18 Task 2, architect verdicts AL-1 + AL-6) — the
 * single write/read authority for the `review_failures` event log
 * (migration 0010). Dedicated leaf, mirroring the app-config-store.ts leaf
 * pattern: `artifact-store.ts` stays the single write authority for
 * `reviews`; this module NEVER touches `reviews` (era 判代 invariant:
 * `reviews.envelope IS NOT NULL ⇔ v1 row` — a failure row is not a review
 * and must not pollute that table).
 *
 * Rows are APPEND-ONLY per-attempt events: the parse-fail degrade path
 * writes one row (stage="parse") before acking; the infra-failure catch
 * writes one best-effort row (stage="runner" | "sandbox" | "pipeline")
 * before each rethrow, so a DLQ'd message leaves up to 3 rows. There is no
 * update/delete face by design — audit-log semantics (the plan-19 sweep
 * counts rows over a created_at window; it never mutates them).
 *
 * The `stage` vocabulary is enforced producer-side (0009 precedent — no
 * CHECK constraint in the DDL): FAILURE_STAGES is the single source and
 * `record` rejects anything off it fail-loud. The BEST-EFFORT contract is
 * the caller's (the consumer wraps `record` in try/catch so an insert
 * failure never masks the degrade/ack or the rethrow) — the store itself
 * never swallows a write error.
 *
 * Module boundary (compass contracts A): type imports from ./types only —
 * no worker/pipeline/session/omp dependencies. The `db` parameter is the
 * narrow D1 face (`D1Like`) so the bun:sqlite test double and a real
 * `D1Database` both satisfy it structurally (same contract as
 * artifact-store.ts).
 */

import type { D1Like } from "./types";

/**
 * The producer-side stage vocabulary (AL-1 + AL-6 extension, frozen):
 * `parse` = the runner's stdout failed parseReviewOutput validation
 * (deterministic model-output failure — degrade + ack path); `runner` =
 * the in-image review run itself failed (non-zero exit / exec error);
 * `sandbox` = container acquisition or an in-sandbox git/diff/numstat/input
 * step failed; `pipeline` = worker-side orchestration (level/credential/
 * config resolution, comment post, …).
 */
export const FAILURE_STAGES: readonly string[] = Object.freeze([
  "parse",
  "runner",
  "sandbox",
  "pipeline",
]);

export type FailureStage = "parse" | "runner" | "sandbox" | "pipeline";

/**
 * One failure event to record. `head_sha` is the AUTHORITATIVE checkout sha
 * when the run reached rev-parse; "" when the failure predates sha
 * resolution (the column is NOT NULL without the 0001 `CHECK (head_sha <>
 * '')` — a failure row exists precisely for runs that never produced a
 * reviewable sha). `error` is the attempt's structured error detail.
 */
export type ReviewFailureInput = {
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
};

/** Default page size for listRecent when the caller does not bound it. */
const LIST_RECENT_DEFAULT_LIMIT = 50;

/** Create the failure store over one D1 handle. */
export function createFailureStore(db: D1Like): FailureStore {
  return {
    async record(input: ReviewFailureInput): Promise<void> {
      if (!FAILURE_STAGES.includes(input.stage)) {
        throw new Error(
          `failure-store: stage ${JSON.stringify(input.stage)} is not on the producer vocabulary (${FAILURE_STAGES.join(" | ")}) — zero rows written`,
        );
      }
      await db
        .prepare(
          `INSERT INTO review_failures (id, installation_id, owner, repo, pr_number, head_sha, stage, error)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          crypto.randomUUID(),
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
  };
}
