-- 0021_review_checks.sql — per-attempt review Check registry (plan 68 Task 1,
-- spec review-lifecycle §7.1 second block).
--
-- One row per Check ATTEMPT. A `(app, installation, owner, repo, pr, head_sha,
-- triggered_by, action)` tuple is an `attempt_key`; each fresh attempt is a new
-- GENERATION with its own UUID `id` and its own `external_id`, so a generation,
-- an external ID and a known remote `check_run_id` are never recycled
-- (spec §7.1/§7.9). `review_publications` (0020) supplies the publication proof
-- this row's conclusion is derived from; nothing here is reviewer-visible.
--
-- The DDL below is copied verbatim from spec §7.1 — the spec stays the single
-- normative copy (plan convention: DDL single source; the migration file is the
-- executable form, edits go through the spec first).
--
-- `idx_check_one_open` is the load-bearing constraint: UNIQUE over
-- `(attempt_key)` restricted to `terminal_ms IS NULL` permits AT MOST ONE
-- nonterminal generation per attempt key. `(attempt_key, generation)` alone
-- cannot do that — two concurrent claims would each pick a different MAX+1.
-- The claim batch relies on this index to lose races rather than to win them,
-- so a losing insert surfaces as a UNIQUE violation and the caller rereads the
-- active row instead of assuming its own generation became current.
--
-- Conventions (spec §7.0): timestamps are integer Unix milliseconds from one
-- supplied clock per transaction; `app_id` is the internal `github_apps.id`
-- and `github_app_id` is its numeric GitHub id (not interchangeable). No
-- ON DELETE clauses — the default NO ACTION makes hard deletes of referenced
-- rows impossible at the schema level (the 0004/0020 precedent). Must apply
-- AFTER 0020 (the `publication_id` FK targets `review_publications`).
-- 0020 is untouched by this migration.

CREATE TABLE review_checks (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES github_apps(id), github_app_id INTEGER NOT NULL,
  installation_id INTEGER NOT NULL,
  owner TEXT NOT NULL, repo TEXT NOT NULL, pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL, triggered_by TEXT NOT NULL, action TEXT NOT NULL,
  attempt_key TEXT NOT NULL, generation INTEGER NOT NULL,
  external_id TEXT NOT NULL UNIQUE, check_run_id INTEGER,
  create_state TEXT NOT NULL CHECK(create_state IN ('not-sent','sending','known','unknown')),
  holder TEXT, lease_epoch INTEGER NOT NULL DEFAULT 0, lease_until_ms INTEGER,
  execution_deadline_ms INTEGER NOT NULL,
  desired TEXT NOT NULL CHECK(desired IN ('in_progress','success','neutral','failure')),
  desired_title TEXT, desired_summary TEXT,
  observed TEXT NOT NULL CHECK(observed IN ('unknown','in_progress','success','neutral','failure')),
  recovery_state TEXT NOT NULL CHECK(recovery_state IN ('pending','done','remote-unconfirmed','local-error','suspended')),
  publication_id TEXT REFERENCES review_publications(id),
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_ms INTEGER,
  last_error TEXT, terminal_ms INTEGER,
  created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL,
  UNIQUE(attempt_key,generation)
);
CREATE UNIQUE INDEX idx_check_one_open ON review_checks(attempt_key) WHERE terminal_ms IS NULL;
CREATE INDEX idx_check_recovery ON review_checks(recovery_state,next_attempt_ms,lease_until_ms);
