-- 0020_finding_lifecycle.sql — finding lifecycle, publication journal and
-- resolution queue (spec review-lifecycle §7.1).
--
-- Four append-only tables backing the private pre-publication journal and
-- the durable finding lifecycle:
--   review_publications    staged publication payloads + proof/lease/recovery
--                          state (the journal; NEVER joined by a
--                          reviewer-visible result read — spec §7.1
--                          Visibility: readable only by the consumer, M8
--                          recovery and M7 proof reads);
--   review_findings        row-keyed finding lifecycle (open/addressed/
--                          dismissed) with fair-rotation scheduling columns;
--   review_finding_rounds  per-round assessment history for selected rows;
--   review_threads         preallocated association intents + remote thread
--                          IDs + resolution queue state.
--
-- The DDL below is copied verbatim from spec §7.1 — the spec stays the
-- single normative copy (plan convention: DDL single source; the migration
-- file is the executable form, edits go through the spec first). The
-- `idx_publication_scope` index was added by the QC follow-up
-- (P67-QC-019) and is mirrored in the spec in the same change.
--
-- Conventions (spec §7.0): timestamps are integer Unix milliseconds from
-- one supplied clock per transaction (no mixed datetime/ISO columns);
-- app_id is the internal github_apps.id; owner/repo/pr_number bind the
-- authenticated scope on every row. No ON DELETE clauses — the default NO
-- ACTION makes hard deletes of referenced rows impossible at the schema
-- level (the 0004 precedent). Must apply AFTER 0004 (github_apps must
-- exist for the FKs); the review_checks DDL (spec §7.1 second block) is
-- migration 0021 and is deliberately NOT in this file.

CREATE TABLE review_publications (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES github_apps(id),
  installation_id INTEGER NOT NULL,
  owner TEXT NOT NULL, repo TEXT NOT NULL, pr_number INTEGER NOT NULL,
  head_sha TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('review','degraded')),
  phase TEXT NOT NULL CHECK(phase IN ('prepared','sending','confirmed','applied','failed','unknown','superseded')),
  payload_json TEXT NOT NULL,
  proof_json TEXT,
  holder TEXT, lease_epoch INTEGER NOT NULL DEFAULT 0, lease_until_ms INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_ms INTEGER,
  recovery_state TEXT NOT NULL DEFAULT 'pending' CHECK(recovery_state IN ('pending','done','local-error','suspended')),
  last_error TEXT, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL,
  confirmed_ms INTEGER, applied_ms INTEGER,
  UNIQUE(app_id, installation_id, owner, repo, pr_number, head_sha, kind)
);
CREATE INDEX idx_publication_recovery ON review_publications(recovery_state,next_attempt_ms,lease_until_ms);
-- Scope-led index for the per-message degraded-journal probe (spec §7.7 step
-- 11 / P67-QC-019). `hasUnprovenDegradedPublication` asks "does THIS scope
-- still hold an unproven degraded publication?" on every review message,
-- filtering the full `(app_id, installation_id, owner, repo, pr_number)`
-- scope plus `kind`/`phase`, while `proof_json IS NULL` rides as an index
-- filter. Without it that probe falls back to the scope-only UNIQUE
-- autoindex and discards every non-degraded or terminal row of the scope;
-- review_publications retains failed/superseded rows indefinitely, so the
-- discarded set only grows. `kind` precedes `phase` because kind is a single
-- equality and phase is the optional IN list, keeping the seek prefix as
-- long as possible.
CREATE INDEX idx_publication_scope ON review_publications(app_id,installation_id,owner,repo,pr_number,kind,phase);

CREATE TABLE review_findings (
  id TEXT PRIMARY KEY,
  app_id TEXT NOT NULL REFERENCES github_apps(id), installation_id INTEGER NOT NULL,
  owner TEXT NOT NULL, repo TEXT NOT NULL, pr_number INTEGER NOT NULL,
  finding_id TEXT NOT NULL, original_json TEXT NOT NULL,
  first_publication_id TEXT NOT NULL REFERENCES review_publications(id),
  last_publication_id TEXT NOT NULL REFERENCES review_publications(id),
  first_seen_sha TEXT NOT NULL, last_seen_sha TEXT NOT NULL,
  first_seen_round INTEGER NOT NULL, last_seen_round INTEGER NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('open','addressed','dismissed')),
  last_assessment_json TEXT, reopen_count INTEGER NOT NULL DEFAULT 0,
  last_scheduled_ms INTEGER, last_assessed_ms INTEGER,
  created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL,
  UNIQUE(app_id,installation_id,owner,repo,pr_number,finding_id)
);
CREATE INDEX idx_finding_rotation ON review_findings(app_id,installation_id,owner,repo,pr_number,state,last_scheduled_ms,id);

CREATE TABLE review_finding_rounds (
  id TEXT PRIMARY KEY, finding_row_id TEXT NOT NULL REFERENCES review_findings(id),
  publication_id TEXT NOT NULL REFERENCES review_publications(id),
  head_sha TEXT NOT NULL, round INTEGER NOT NULL,
  assessment_json TEXT NOT NULL, created_ms INTEGER NOT NULL,
  UNIQUE(finding_row_id,publication_id)
);

CREATE TABLE review_threads (
  id TEXT PRIMARY KEY,
  finding_row_id TEXT NOT NULL REFERENCES review_findings(id),
  publication_id TEXT NOT NULL REFERENCES review_publications(id),
  app_id TEXT NOT NULL REFERENCES github_apps(id), installation_id INTEGER NOT NULL,
  owner TEXT NOT NULL, repo TEXT NOT NULL, pr_number INTEGER NOT NULL,
  original_sha TEXT NOT NULL, round INTEGER NOT NULL,
  intent_json TEXT NOT NULL,
  review_id INTEGER, comment_id INTEGER, thread_id TEXT,
  resolution_state TEXT NOT NULL CHECK(resolution_state IN ('pending','retry','needs-recheck','resolved','abandoned','local-error','suspended')),
  verified_json TEXT,
  holder TEXT, lease_epoch INTEGER NOT NULL DEFAULT 0, lease_until_ms INTEGER,
  attempts INTEGER NOT NULL DEFAULT 0, next_attempt_ms INTEGER,
  superseded_by_publication_id TEXT,
  resolved_ms INTEGER, late_change INTEGER NOT NULL DEFAULT 0,
  last_error TEXT, created_ms INTEGER NOT NULL, updated_ms INTEGER NOT NULL,
  UNIQUE(app_id,installation_id,comment_id)
);
CREATE INDEX idx_thread_recovery ON review_threads(resolution_state,next_attempt_ms,lease_until_ms);
