/**
 * Central Review Store row types (v1 caliber).
 *
 * Type-only module. `D1Like` (the narrow D1 face the store depends on) is
 * reused by the ArtifactStore adapter (`src/store/artifact-store.ts`) and
 * its bun:sqlite test double (`tests/store/helpers.ts`). No runtime imports
 * — the store module boundary (compass contracts A) forbids
 * worker/pipeline/session dependencies.
 *
 * Column shapes mirror `migrations/0001_reviews.sql` +
 * `0002_mstar_review_v1.sql` (DDL single sources). Later append-only
 * migrations extend the table WITHOUT changing these types: migration 0005
 * added `reviews.app_id` (TEXT, NULL = legacy; FK to github_apps), which is
 * bound on WRITE only — the ArtifactStore `put` doc carries the per-App
 * `appId` (src/store/artifact-store.ts) — and `ReviewRow` deliberately
 * omits it because no read path consumes the column.
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
 * Input for the cross-PR recurrence aggregation (AC-21c).
 * Both filters are optional: omitted `window_days` = all-time; omitted
 * `repo` = all repos. `window_days` is used as-is (the API layer
 * owns validation/clamping per AL-22-1).
 */
export type RecurrenceQuery = {
  /** Only reviews with `reviewed_at` within the last N days count. */
  window_days?: number;
  /** Restrict the aggregation to one owner/repo pair. */
  repo?: { owner: string; repo: string };
};

/**
 * One recurrence group: a fingerprint seen in >= 2
 * distinct reviews. `count` = distinct reviews; `repos` = distinct
 * owner/repo pairs among them (sorted); `title_sample` = any one title
 * for the fingerprint (MIN, deterministic).
 */
export type RecurrenceGroup = {
  fingerprint: string;
  title_sample: string;
  count: number;
  repos: string[];
};

/**
 * Raw rows of the finding-lifecycle tables (migration
 * `0020_finding_lifecycle.sql` — DDL single source; spec review-lifecycle
 * §7.1 owns the normative shapes). Snake_case D1 column names, same
 * convention as `ReviewRow` / `FindingRow`. The typed journal domain
 * shapes (`PublicationPayload`, `PublicationRow`, `Lease`, …) live in
 * `src/store/finding-lifecycle.ts` / `src/contracts/recheck.ts`; these are
 * the storage-layer rows they map from. Timestamps are integer Unix
 * milliseconds (spec §7.0), not the datetime TEXT of the 0001 tables.
 */

/** A row of the `review_publications` journal (private — spec §7.1 Visibility). */
export type ReviewPublicationRow = {
  id: string;
  app_id: string;
  installation_id: number;
  owner: string;
  repo: string;
  pr_number: number;
  head_sha: string;
  kind: string;
  phase: string;
  payload_json: string;
  proof_json: string | null;
  holder: string | null;
  lease_epoch: number;
  lease_until_ms: number | null;
  attempts: number;
  next_attempt_ms: number | null;
  recovery_state: string;
  last_error: string | null;
  created_ms: number;
  updated_ms: number;
  confirmed_ms: number | null;
  applied_ms: number | null;
};

/** A row of the `review_findings` lifecycle table. */
export type ReviewFindingRow = {
  id: string;
  app_id: string;
  installation_id: number;
  owner: string;
  repo: string;
  pr_number: number;
  finding_id: string;
  original_json: string;
  first_publication_id: string;
  last_publication_id: string;
  first_seen_sha: string;
  last_seen_sha: string;
  first_seen_round: number;
  last_seen_round: number;
  state: string;
  last_assessment_json: string | null;
  reopen_count: number;
  last_scheduled_ms: number | null;
  last_assessed_ms: number | null;
  created_ms: number;
  updated_ms: number;
};

/** A row of the `review_finding_rounds` per-round assessment history. */
export type ReviewFindingRoundRow = {
  id: string;
  finding_row_id: string;
  publication_id: string;
  head_sha: string;
  round: number;
  assessment_json: string;
  created_ms: number;
};

/** A row of the `review_threads` association/resolution-queue table. */
export type ReviewThreadRow = {
  id: string;
  finding_row_id: string;
  publication_id: string;
  app_id: string;
  installation_id: number;
  owner: string;
  repo: string;
  pr_number: number;
  original_sha: string;
  round: number;
  intent_json: string;
  review_id: number | null;
  comment_id: number | null;
  thread_id: string | null;
  resolution_state: string;
  verified_json: string | null;
  holder: string | null;
  lease_epoch: number;
  lease_until_ms: number | null;
  attempts: number;
  next_attempt_ms: number | null;
  superseded_by_publication_id: string | null;
  resolved_ms: number | null;
  late_change: number;
  last_error: string | null;
  created_ms: number;
  updated_ms: number;
};

/**
 * A row of the `review_checks` attempt registry (migration
 * `0021_review_checks.sql` — spec review-lifecycle §7.1 second block). One row
 * per Check ATTEMPT: `attempt_key` + `generation` identify it, `external_id`
 * is the immutable correlation handle GitHub echoes back, `check_run_id` is
 * the observed remote run id (null until proven). The typed domain shapes
 * (`CheckAttempt`, `CheckIdentity`, …) live in `src/store/review-checks.ts`.
 */
export type ReviewCheckRow = {
  id: string;
  app_id: string;
  github_app_id: number;
  installation_id: number;
  owner: string;
  repo: string;
  pr_number: number;
  head_sha: string;
  triggered_by: string;
  action: string;
  attempt_key: string;
  generation: number;
  external_id: string;
  check_run_id: number | null;
  create_state: string;
  holder: string | null;
  lease_epoch: number;
  lease_until_ms: number | null;
  execution_deadline_ms: number;
  desired: string;
  desired_title: string | null;
  desired_summary: string | null;
  observed: string;
  recovery_state: string;
  publication_id: string | null;
  attempts: number;
  next_attempt_ms: number | null;
  last_error: string | null;
  terminal_ms: number | null;
  created_ms: number;
  updated_ms: number;
};

/**
 * Narrow D1 face the ArtifactStore adapter depends on:
 * prepare/bind/first/all/run + batch. A real `D1Database` satisfies this
 * structurally; tests provide a bun:sqlite-backed implementation via
 * `tests/store/helpers.ts`. The store writes the review row and its
 * findings in ONE atomic D1 batch (review invariant I1, absorbed by the
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
