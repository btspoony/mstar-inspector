-- 0068_target_repo_global_unique.sql — a repository belongs to ONE workspace
-- per bot.
--
-- 0067 keyed the target by repository but scoped the uniqueness claim to the
-- workspace (`review_targets_workspace_repo`): on a shared bot two workspaces
-- could each hold a live target for the SAME repository, and `resolveByRepo`
-- binds a delivery by `(bot_id, repo_id)` — so both rows answered the same
-- delivery and the oldest one silently won. The claim is bot-level: one
-- repository, one workspace, per App.
--
-- Partial on both predicates, exactly like the index it replaces: a row still
-- awaiting its claim (`repo_id IS NULL`, 0067's D15 state) and a soft-deleted
-- row are each outside the claim, so a removed repository may be re-added and
-- an unclaimed row stays out of the repository claim (the store refuses the
-- owner/name duplicate separately).
--
-- Forward-only. A live duplicate that predates this file makes the build fail
-- loudly instead of silently picking a winner.
DROP INDEX review_targets_workspace_repo;

CREATE UNIQUE INDEX review_targets_bot_repo_unique
  ON review_targets(bot_id, repo_id)
  WHERE repo_id IS NOT NULL AND deleted_at IS NULL;
