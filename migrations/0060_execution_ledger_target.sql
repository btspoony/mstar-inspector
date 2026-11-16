-- 0060_execution_ledger_target.sql — the execution ledgers name their target.
--
-- `review_findings` and `review_failures` are the two per-ATTEMPT ledgers the
-- pipeline appends to: a finding's lifecycle row and a failure event. Both were
-- bot-attributed only, so every tenant read reached their owner through the
-- `pull_requests` join — unique exactly while a bot has one live target. A bot
-- with a second target in a second workspace would then have counted the same
-- finding or failure for BOTH workspaces. This file gives each row its own
-- `target_id`, backfilled from the pull-request row it was written for, so the
-- tenant predicate binds the target directly and the join goes.
--
-- The backfill is EXACT and fails instead of skipping: a row left without a
-- target would be invisible to every workspace face (the predicate is
-- `target_id = ?`), silently dropping a finding or a failure an operator needs.
-- The guards below are the CHECK-constrained tables the 0057 recipe uses — a
-- non-zero count fails the statement, aborting the migration:
--   findings → `CHECK constraint failed: guard_findings_without_target`
--   failures → `CHECK constraint failed: guard_failures_without_target`
--   ambiguous failure candidates → `CHECK constraint failed: guard_failures_ambiguous_target`
--
-- The failures guard is narrower than the findings one, and deliberately so.
-- Both ledgers can outlive their PR row: `sweepTerminalPullRequests` deletes
-- `pull_requests` rows for terminal PRs older than 90 days with no predicate
-- over either ledger (`src/dashboard/apps-store.ts`), and neither table has a
-- FK to it. Once a row's PR is swept, no target can ever be derived for it.
-- Requiring zero NULLs would therefore refuse the migration on any deployment
-- past the retention window — production had 99 such failures across 11 PRs on
-- first apply, and the findings ledger reaches the same state as it ages.
-- So a guard refuses a NULL that COULD have been resolved — at least one
-- candidate row whose own `target_id` is non-NULL, i.e. an attribution the
-- UPDATE should have written — and allows a NULL with no such candidate, which
-- the read faces already treat as legacy and filtered, exactly as they treat a
-- NULL `bot_id`. A candidate row that is itself unattributed is not a candidate:
-- `COUNT(DISTINCT p.target_id)` ignores NULLs and would have read that state as
-- "nothing to attribute", hiding a real miss.
--
-- Both ledgers also carry an ambiguity guard, because the tuple they join on
-- stops being unique once a bot holds a second target (0057 enforces exactly
-- one only at its own apply time). A scalar subquery over several rows would
-- pick one arbitrarily, which is the cross-workspace leak this file closes.
--
-- The ambiguity guard runs BEFORE the failure UPDATE: the same installation id
-- can be recorded under two bots, each with its own pull-request row at the
-- same (owner, repo, pr_number) but pointing at different targets in different
-- workspaces. The scalar subquery would then silently pick one row of several,
-- and the row would vanish from the other workspace's face — the exact leak
-- this file exists to close — while a NULL guard still passed.
--
-- `review_failures` carries no bot id of its own: it is resolved through
-- `bot_installations` (installation → bot), then the pull-request row.
--
-- `audit_events.target_id` is part of the same file because it is the same
-- fact — an audit row that names the target it changed (the park action writes
-- one). It is nullable with no backfill: history names no target, and inventing
-- one would attribute an old operator action to a row that may not have existed
-- when it ran.
--
-- Nullable on the add, never NOT NULL: a NOT NULL add would need a dummy
-- default, and the guards are what refuse an unattributed row at apply time.
-- Every writer binds the target explicitly afterwards; the read faces treat a
-- NULL as legacy and filtered, exactly as they treat a NULL `bot_id`.
--
-- Forward-only. Must apply AFTER 0057 (review_targets) — the FK parent and the
-- backfill's source.

ALTER TABLE review_findings ADD COLUMN target_id TEXT REFERENCES review_targets(id);
ALTER TABLE review_failures ADD COLUMN target_id TEXT REFERENCES review_targets(id);
ALTER TABLE audit_events ADD COLUMN target_id TEXT REFERENCES review_targets(id);

-- A finding belongs to the PR its bot reviewed, keyed on the same tuple the
-- PR ledger uses. That tuple is unique only while a bot holds one live target
-- (0057's guard); once a bot gains a second target, two ledger rows can share
-- it with different targets, and the scalar subquery below would silently pick
-- one. Refuse that state before attributing anything, exactly as the failures
-- path does.
CREATE TABLE guard_findings_ambiguous_target (
  n INTEGER NOT NULL CONSTRAINT guard_findings_ambiguous_target CHECK (n = 0)
);
INSERT INTO guard_findings_ambiguous_target (n)
SELECT COUNT(*) FROM review_findings f
WHERE (
  SELECT COUNT(DISTINCT p.target_id)
  FROM pull_requests p
  WHERE p.bot_id = f.bot_id
    AND p.owner = f.owner
    AND p.repo = f.repo
    AND p.pr_number = f.pr_number
) > 1;
DROP TABLE guard_findings_ambiguous_target;

UPDATE review_findings
SET target_id = (
  SELECT p.target_id FROM pull_requests p
  WHERE p.bot_id = review_findings.bot_id
    AND p.owner = review_findings.owner
    AND p.repo = review_findings.repo
    AND p.pr_number = review_findings.pr_number
);

-- 0057 dropped `idx_pull_requests_bot_pr` when it made the ledger target-keyed,
-- so the finding backfill's `(bot_id, owner, repo, pr_number)` lookup has no
-- index and would scan the whole ledger once per finding row. Recreate it: the
-- pair of keys is exactly what both ledgers join on, and the target-keyed one
-- cannot serve a bot-keyed lookup.
CREATE INDEX idx_pull_requests_bot_pr ON pull_requests(bot_id, owner, repo, pr_number);

-- The failure attribution resolves installation → bot. `bot_installations` is
-- keyed by `bot_id`, so an installation-keyed lookup needs its own index.
CREATE INDEX idx_bot_installations_installation ON bot_installations(installation_id);

-- The candidate set must resolve to EXACTLY one distinct target. Two bots
-- holding the same installation id, with a pull-request row each at the same
-- key but different targets, is the case SQLite would answer with one row of
-- several — refused here, before any attribution is written.
CREATE TABLE guard_failures_ambiguous_target (
  n INTEGER NOT NULL CONSTRAINT guard_failures_ambiguous_target CHECK (n = 0)
);
INSERT INTO guard_failures_ambiguous_target (n)
SELECT COUNT(*) FROM review_failures f
WHERE (
  SELECT COUNT(DISTINCT p.target_id)
  FROM bot_installations i
  JOIN pull_requests p ON p.bot_id = i.bot_id
  WHERE i.removed_at IS NULL
    AND i.installation_id = f.installation_id
    AND p.owner = f.owner
    AND p.repo = f.repo
    AND p.pr_number = f.pr_number
) > 1;
DROP TABLE guard_failures_ambiguous_target;

-- A failure names the installation it ran under, not the bot: resolve
-- installation → bot, then the same PR key.
UPDATE review_failures
SET target_id = (
  SELECT p.target_id
  FROM bot_installations i
  JOIN pull_requests p ON p.bot_id = i.bot_id
  WHERE i.removed_at IS NULL
    AND i.installation_id = review_failures.installation_id
    AND p.owner = review_failures.owner
    AND p.repo = review_failures.repo
    AND p.pr_number = review_failures.pr_number
);

CREATE TABLE guard_findings_without_target (
  n INTEGER NOT NULL CONSTRAINT guard_findings_without_target CHECK (n = 0)
);
INSERT INTO guard_findings_without_target (n)
SELECT COUNT(*) FROM review_findings f
WHERE f.target_id IS NULL
  AND EXISTS (
    SELECT 1 FROM pull_requests p
    WHERE p.bot_id = f.bot_id
      AND p.owner = f.owner
      AND p.repo = f.repo
      AND p.pr_number = f.pr_number
      AND p.target_id IS NOT NULL
  );
DROP TABLE guard_findings_without_target;

CREATE TABLE guard_failures_without_target (
  n INTEGER NOT NULL CONSTRAINT guard_failures_without_target CHECK (n = 0)
);
INSERT INTO guard_failures_without_target (n)
SELECT COUNT(*) FROM review_failures f
WHERE f.target_id IS NULL
  AND EXISTS (
    SELECT 1
    FROM bot_installations i
    JOIN pull_requests p ON p.bot_id = i.bot_id
    WHERE i.removed_at IS NULL
      AND i.installation_id = f.installation_id
      AND p.owner = f.owner
      AND p.repo = f.repo
      AND p.pr_number = f.pr_number
      AND p.target_id IS NOT NULL
  );
DROP TABLE guard_failures_without_target;

-- The tenant predicate is `(target_id, owner, repo, pr_number)`: the counts and
-- lists bind the target alone, the record faces add the PR key. One index per
-- ledger serves both — the target prefix for the aggregate reads, the full key
-- for the per-PR ones.
CREATE INDEX idx_review_findings_target ON review_findings(target_id, owner, repo, pr_number);
CREATE INDEX idx_review_failures_target ON review_failures(target_id, owner, repo, pr_number);
