-- 0067_repo_target_identity.sql — a review target is one repository, not one
-- installation.
--
-- 0057 split the review configuration off the bot into `review_targets`, but
-- left the target keyed by installation: `installation_id` + `account_login`
-- under the partial unique `review_targets_bot_installation`. That identity
-- cannot name a repository — one installation covers many repos, and its login
-- is mutable. The stable key is GitHub's numeric `repository.id`, with the
-- owner/name pair kept as a display cache a later delivery refreshes.
--
--   repo_id                 INTEGER — GitHub `repository.id`, the identity (D7).
--   repo_owner/repo_name    TEXT — mutable display caches.
--   follow_workspace_defaults INTEGER — 1 reads `workspaces` defaults at read
--                           time; migrated historical rows stay 0 with their
--                           copied config, so no live review changes (D16, J4).
--
-- `repo_id IS NULL` is the historical state awaiting claim (D15): only rows
-- this file leaves behind carry it, and the webhook resolver / 373 backfill are
-- the only writers. Uniqueness therefore rides a partial index that excludes
-- both NULLs and soft-deleted rows: one repository belongs to one workspace,
-- while a deleted row may be re-added and an unclaimed row may still duplicate
-- (the claim path refuses it on owner/name).
--
-- The installation-keyed machinery goes with the columns: `installation_id`,
-- `account_login`, `allowlist_enabled`, the `review_targets_bot_installation`
-- index and the `target_owner_allowlist` table (D18 — its rows go with it and
-- nothing migrates them; the allowlist references targets and nothing
-- references the allowlist, so there is no FK hazard).
--
-- Workspace defaults (D5) live on `workspaces`; the gate floor is the existing
-- `workspaces.check_min_score` (0049), so no fourth column for it.
--
-- `install_claims` is recreated bot-level (D19): the claim bridges the
-- stateless setup redirect to the App, and the App (not a target) is what a
-- signed-in user installs. In-flight rows are dropped deliberately — a claim
-- lives minutes and the user simply presses install again.
--
-- Columns are dropped in place, never by rebuilding the parent table: a D1
-- migration file runs in one transaction, where `PRAGMA foreign_keys = OFF` is
-- inert, so `DROP TABLE review_targets` would fire the children's cascades (the
-- 0057:27-36 recipe, precedent 0057:236-240). Each dropped column carries only
-- its own inline CHECK, which SQLite drops with it.
--
-- No data movement: no backfill of `repo_id` (plan 373 owns it) and no guard
-- table for one. Forward-only.

ALTER TABLE review_targets ADD COLUMN repo_id INTEGER;
ALTER TABLE review_targets ADD COLUMN repo_owner TEXT;
ALTER TABLE review_targets ADD COLUMN repo_name TEXT;
ALTER TABLE review_targets ADD COLUMN follow_workspace_defaults INTEGER NOT NULL DEFAULT 0
  CHECK (follow_workspace_defaults IN (0, 1));

-- Unbound targets are outside the old index on purpose, so the index itself is
-- all that keeps the column alive.
DROP INDEX review_targets_bot_installation;

ALTER TABLE review_targets DROP COLUMN installation_id;
ALTER TABLE review_targets DROP COLUMN account_login;
ALTER TABLE review_targets DROP COLUMN allowlist_enabled;

-- One repository, one workspace. Partial on BOTH predicates: an unclaimed row
-- (NULL) and a soft-deleted row are each outside the claim.
CREATE UNIQUE INDEX review_targets_workspace_repo
  ON review_targets(workspace_id, repo_id)
  WHERE repo_id IS NOT NULL AND deleted_at IS NULL;

-- One named consumer each: id resolution (`(bot_id, repo_id)`), the
-- name-fallback resolution for a delivery without an id (`(bot_id, repo_owner,
-- repo_name)`), the app-visibility probe and the shared-target count
-- (`(bot_id, workspace_id)`), and the workspace-only read scope (`listLive`,
-- the dashboard list). Both workspace indexes are kept: a `(bot_id,
-- workspace_id)` index cannot serve a workspace-only predicate, and neither
-- can the other answer the bot-scoped ones. 0062's single-column index under
-- its second name (`idx_review_targets_workspace_id`) is the exact duplicate
-- of `idx_review_targets_workspace`, so that one goes.
--
-- The name index is built `COLLATE NOCASE`: GitHub repository identities are
-- case-insensitive, and this is the ONE collation every owner/name comparison
-- uses (the store's resolution and duplicate rule, the attribution subquery,
-- both Check-gate reads). An index declared with the collation is what makes
-- those `NOCASE` predicates a seek instead of a scan.
DROP INDEX idx_review_targets_workspace_id;
CREATE INDEX idx_review_targets_bot_repo ON review_targets(bot_id, repo_id);
CREATE INDEX idx_review_targets_bot_owner_name
  ON review_targets(bot_id, repo_owner COLLATE NOCASE, repo_name COLLATE NOCASE);
CREATE INDEX idx_review_targets_bot_workspace ON review_targets(bot_id, workspace_id);
CREATE INDEX idx_review_targets_workspace ON review_targets(workspace_id);

-- Workspace-level defaults a target may inherit from (D5) — the gate floor is
-- the existing `workspaces.check_min_score` (0049), not a second column.
ALTER TABLE workspaces ADD COLUMN default_review_trigger_mode TEXT NOT NULL DEFAULT 'every_push'
  CHECK (default_review_trigger_mode IN ('open','every_push','manual'));
ALTER TABLE workspaces ADD COLUMN default_review_level TEXT
  CHECK (default_review_level IN ('quick','default','deep'));
ALTER TABLE workspaces ADD COLUMN default_check_pass_verdicts TEXT NOT NULL DEFAULT '["ship it"]'
  CHECK (json_valid(default_check_pass_verdicts));

DROP TABLE target_owner_allowlist;

-- Bot-level claims (D19). The in-flight target-keyed rows are dropped with the
-- table: a claim that named a target cannot be replayed against a bot.
DROP TABLE install_claims;

CREATE TABLE install_claims (
  id             TEXT PRIMARY KEY,
  user_id        TEXT NOT NULL REFERENCES users(id),
  workspace_id   TEXT NOT NULL REFERENCES workspaces(id),
  bot_id         TEXT NOT NULL REFERENCES review_bots(id),
  created_at     TEXT NOT NULL,
  expires_at     TEXT NOT NULL,
  consumed_at    TEXT,
  consumed_token TEXT
);

CREATE INDEX install_claims_user_open ON install_claims(user_id, consumed_at);
CREATE UNIQUE INDEX install_claims_live_bot
  ON install_claims(user_id, bot_id) WHERE consumed_at IS NULL;
