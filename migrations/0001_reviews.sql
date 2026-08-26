-- 0001_reviews.sql — Central Review Store DDL (plan 05 Task 1).
--
-- DDL single source of truth: tests execute THIS file (bun:sqlite in-memory)
-- and wrangler applies it to real D1 (--local / --remote). There is no
-- second schema.sql.ts — do not fork this DDL.
--
-- Baseline: solution §5.4, micro-adjustments allowed by plan Clarify 1:
--   * reviews.id is caller-supplied TEXT (UUID) — no autoincrement dependency.
--   * findings.status defaults to 'open'.
--   * reviewed_at defaults to datetime('now') (UTC).
--
-- HARD invariants (must not be weakened):
--   * UNIQUE (installation_id, owner, repo, pr_number, head_sha) is the
--     authoritative dedup key — the store's insertReview relies on it.
--   * head_sha is TEXT NOT NULL — a review without a resolved sha is never
--     stored (compass contracts B / S5). The CHECK backstops the store-layer
--     empty-sha rejection (plan Clarify 1: 仓储拒绝空 sha) at the schema level.

CREATE TABLE reviews (
  id                TEXT PRIMARY KEY,
  installation_id   INTEGER NOT NULL,
  owner             TEXT NOT NULL,
  repo              TEXT NOT NULL,
  pr_number         INTEGER NOT NULL,
  head_sha          TEXT NOT NULL,
  base_sha          TEXT,
  reviewed_at       TEXT NOT NULL DEFAULT (datetime('now')),
  verdict           TEXT NOT NULL,
  summary_md        TEXT,
  model             TEXT,
  provider          TEXT,
  skill_version     TEXT,
  raw_output        TEXT,
  UNIQUE (installation_id, owner, repo, pr_number, head_sha),
  CHECK (head_sha <> '')
);

CREATE TABLE findings (
  id                TEXT PRIMARY KEY,
  review_id         TEXT NOT NULL REFERENCES reviews(id) ON DELETE CASCADE,
  severity          TEXT NOT NULL,
  category          TEXT,
  file_path         TEXT,
  line_start        INTEGER,
  line_end          INTEGER,
  title             TEXT NOT NULL,
  body              TEXT,
  fingerprint       TEXT,
  status            TEXT DEFAULT 'open'
);

CREATE INDEX idx_reviews_repo ON reviews (owner, repo);
CREATE INDEX idx_findings_fingerprint ON findings (fingerprint);
CREATE INDEX idx_findings_severity ON findings (severity);
