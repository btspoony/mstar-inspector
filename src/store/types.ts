/**
 * Central Review Store row types (v1 caliber, plan 07 Task 4).
 *
 * Type-only module. `D1Like` (the narrow D1 face the store depends on) is
 * reused by the ArtifactStore adapter (`src/store/artifact-store.ts`) and
 * its bun:sqlite test double (`tests/store/helpers.ts`). No runtime imports
 * — the store module boundary (compass contracts A) forbids
 * worker/pipeline/session dependencies.
 *
 * Column shapes mirror `migrations/0001_reviews.sql` +
 * `0002_mstar_review_v1.sql` (DDL single sources).
 */

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
  /**
   * Complete `mstar.review/v1` envelope JSON (v1 rows); NULL on M1-era
   * rows — the row-level era marker (`envelope IS NOT NULL` ⇔ v1 path,
   * migration 0002). New (v1) rows never write `raw_output`; the envelope
   * is the authoritative, losslessly restorable document.
   */
  envelope: string | null;
};

/**
 * A row of the `findings` table (D1 column names, snake_case). For v1 rows
 * `severity` carries the harness merge class (`must-fix` | `should-fix` |
 * `nit` — the single vocab-switch mapping point lives in the ArtifactStore
 * adapter); M1 rows keep critical | warning | suggestion | info. Era is
 * disambiguated by the parent review row's `envelope IS NOT NULL`.
 */
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
 * Narrow D1 face the ArtifactStore adapter depends on (plan Clarify 5):
 * prepare/bind/first/all/run + batch. A real `D1Database` satisfies this
 * structurally; tests provide a bun:sqlite-backed implementation via
 * `tests/store/helpers.ts`. The store writes the review row and its
 * findings in ONE atomic D1 batch (plan 05 T2 review I1, absorbed by the
 * adapter) — it never touches exec/withSession/dump, so the test double
 * stays small.
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

/** One statement's result inside a D1 `batch()` (order matches input). */
export type D1BatchResult = {
  results: unknown[];
  meta: { changes: number; last_row_id: number };
};

export type D1Like = {
  prepare(query: string): D1StatementLike;
  batch(statements: D1StatementLike[]): Promise<D1BatchResult[]>;
};
