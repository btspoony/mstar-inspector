/**
 * Central Review Store row/insert types (plan 05 Task 1).
 *
 * Type-only imports only: `IdempotencyKey` from contracts/idem (04 SSOT) and
 * `ReviewOutput` from review/schema (pure zod, M0). No runtime imports — the
 * store module boundary (compass contracts A) forbids worker/pipeline/session
 * dependencies, and these types carry no behavior.
 *
 * Column shapes mirror `migrations/0001_reviews.sql` (DDL single source).
 */

import type { IdempotencyKey } from "../contracts/idem";
import type { ReviewOutput } from "../review/schema";

/** A row of the `reviews` table (D1 column names, snake_case). */
export type ReviewRow = {
  id: string;
  installation_id: number;
  owner: string;
  repo: string;
  pr_number: number;
  head_sha: string;
  base_sha: string | null;
  reviewed_at: string;
  verdict: string;
  summary_md: string | null;
  model: string | null;
  provider: string | null;
  skill_version: string | null;
  raw_output: string | null;
};

/** A row of the `findings` table (D1 column names, snake_case). */
export type FindingRow = {
  id: string;
  review_id: string;
  severity: string;
  category: string | null;
  file_path: string | null;
  line_start: number | null;
  line_end: number | null;
  title: string;
  body: string | null;
  fingerprint: string | null;
  status: string | null;
};

/**
 * Input to `insertReview` (plan 05 interface contract):
 * the idempotency key, the parsed structured output, the raw JSON payload
 * (stored in `raw_output`, truncated at 64KB by the store), and optional
 * model/provider metadata (M2 hardens these to NOT NULL).
 */
export type ReviewInsert = {
  key: IdempotencyKey;
  output: ReviewOutput;
  raw: string;
  model?: string;
  skill_version?: string;
};

/**
 * Outcome of `insertReview`: `inserted` carries the new review id;
 * `duplicate` means the UNIQUE (installation_id, owner, repo, pr_number,
 * head_sha) constraint already has a row (another consumer won the race).
 */
export type StoreResult =
  | { outcome: "inserted"; reviewId: string }
  | { outcome: "duplicate" };

/**
 * Narrow D1 face the store depends on (plan Clarify 5): prepare/bind/first/
 * all/run only. A real `D1Database` satisfies this structurally; tests provide
 * a bun:sqlite-backed implementation via `tests/store/helpers.ts`. The store
 * never touches batch/exec/withSession/dump, so the test double stays small.
 */
export type D1StatementLike = {
  bind(...values: unknown[]): D1StatementLike;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<{ results: T[] }>;
  run<T = Record<string, unknown>>(): Promise<{
    results: T[];
    meta: { changes: number; last_row_id: number };
  }>;
};

export type D1Like = {
  prepare(query: string): D1StatementLike;
};
