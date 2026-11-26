-- 0118_app_install_state_backfill.sql — every App a workspace already installs
-- becomes an install state with its first chain row.
--
-- 0115 created `app_installations` and `app_install_bots` empty; the writers
-- (the createApp batch and the bind batch) arrive with install-state-chain
-- Task 2, so the relations that exist today are materialised here — otherwise
-- the chain read answers nothing for every App that already has one.
--
-- Three live relations mean "this workspace installs this App":
--
--   1. the workspace owns the App        `app_workspaces`
--   2. it bound a live installation     `github_app_installations.bound_workspace_id`
--   3. it holds a live target           `review_targets`
--
-- The union deduplicates them, so `(github_app_id, workspace_id)` stays the one
-- key of the parent table. A deleted App or a deleted workspace contributes no
-- row from any source: an install state is a live-workspace fact, and a row for
-- a retired side would resurrect it in the installed list.
--
-- Each state's chain holds exactly one row, at position 1, naming the bot the
-- split created for that App — 0115 backfilled exactly one bot per App under
-- the App's own id. A live relation whose App has no such bot aborts this file:
-- an install state without its chain mounts no bot, and nothing in this release
-- would repair it (D35). The guard runs before either insert, so the failure
-- names its cause instead of surfacing as a raw foreign-key error, and the
-- transaction leaves the schema unsplit.
--
-- Idempotent by construction: both inserts are guarded by `NOT EXISTS` against
-- their own target, so a second run inside the transaction is a fixed point, and
-- the source table is dropped before the file ends — a repair re-runs the whole
-- file. This file reads no column a later migration drops.
--
-- Must apply AFTER 0117.

-- The source union, in one place: the guard and the two inserts read the same
-- set, and three copies of a three-way UNION would drift.
CREATE TABLE install_state_sources_0118 AS
SELECT w.app_id AS github_app_id, w.workspace_id AS workspace_id
  FROM app_workspaces w
  JOIN github_apps g ON g.id = w.app_id AND g.deleted_at IS NULL
  JOIN workspaces ws ON ws.id = w.workspace_id AND ws.deleted_at IS NULL
UNION
-- A NULL `bound_workspace_id` fails the join: an installation nobody bound
-- grants no workspace its repositories (0104).
SELECT i.app_id, i.bound_workspace_id
  FROM github_app_installations i
  JOIN github_apps g ON g.id = i.app_id AND g.deleted_at IS NULL
  JOIN workspaces ws ON ws.id = i.bound_workspace_id AND ws.deleted_at IS NULL
 WHERE i.removed_at IS NULL
UNION
SELECT t.app_id, t.workspace_id
  FROM review_targets t
  JOIN github_apps g ON g.id = t.app_id AND g.deleted_at IS NULL
  JOIN workspaces ws ON ws.id = t.workspace_id AND ws.deleted_at IS NULL
 WHERE t.deleted_at IS NULL;

-- Abort unless every source relation can name its bot (the 0057 guard recipe:
-- the table's own CHECK is what fails the migration, never a silent skip).
CREATE TABLE guard_install_state_without_bot (
  n INTEGER NOT NULL CONSTRAINT guard_install_state_without_bot CHECK (n = 0)
);
INSERT INTO guard_install_state_without_bot (n)
SELECT COUNT(*) FROM install_state_sources_0118 s
 WHERE NOT EXISTS (SELECT 1 FROM review_bots b WHERE b.id = s.github_app_id);
DROP TABLE guard_install_state_without_bot;

INSERT INTO app_installations (github_app_id, workspace_id, created_at)
SELECT s.github_app_id, s.workspace_id, datetime('now')
  FROM install_state_sources_0118 s
 WHERE NOT EXISTS (
         SELECT 1 FROM app_installations a
          WHERE a.github_app_id = s.github_app_id AND a.workspace_id = s.workspace_id
       );

-- The inherited id IS the bot id: the split gave the App's bot the App's id.
INSERT INTO app_install_bots (github_app_id, workspace_id, position, bot_id)
SELECT s.github_app_id, s.workspace_id, 1, s.github_app_id
  FROM install_state_sources_0118 s
 WHERE NOT EXISTS (
         SELECT 1 FROM app_install_bots ib
          WHERE ib.github_app_id = s.github_app_id AND ib.workspace_id = s.workspace_id
       );

DROP TABLE install_state_sources_0118;
