-- 0108_workspace_admission_defaults.sql — the two admission facts a repository
-- gained after 0067/0057 become inheritable workspace defaults.
--
-- 0070 (draft review) and 0057 (business pause) introduced `review_drafts` and
-- `review_enabled` as TARGET-owned admission facts: a following target still
-- answered them from its own row, because the workspace had no column to
-- inherit from. Operators now set both per workspace, so the two defaults
-- below promote that fact into the workspace layer; `effectiveTargetSettings`
-- answers them from the defaults while `follow_workspace_defaults = 1` and
-- from the row otherwise.
--
-- `DEFAULT 1` matches the answer every row already gives, so the ADD COLUMNs
-- themselves move no data. The UPDATE below is the transition: a target that
-- inherits today answered BOTH admission facts from its own row (0070), so the
-- new defaults must not silently flip a non-default answer. Such a target is
-- detached with the policy values it is running with copied into its row; a
-- target whose row already says drafts-reviewed / reviews-enabled keeps
-- inheriting, because that is what the new default says anyway.
--
-- The snapshot copies `check_min_score` with 60 — DEFAULT_CHECK_MIN_SCORE in
-- src/contracts/review-gate.ts — for a workspace whose floor is NULL, exactly
-- what the absent-row fallback answered before.
--
-- Forward-only.
ALTER TABLE workspaces ADD COLUMN default_review_drafts INTEGER NOT NULL DEFAULT 1
  CHECK (default_review_drafts IN (0, 1));

ALTER TABLE workspaces ADD COLUMN default_review_enabled INTEGER NOT NULL DEFAULT 1
  CHECK (default_review_enabled IN (0, 1));

UPDATE review_targets
   SET review_trigger_mode = COALESCE(
         (SELECT w.default_review_trigger_mode FROM workspaces w
           WHERE w.id = review_targets.workspace_id AND w.deleted_at IS NULL),
         review_trigger_mode),
       review_level = (SELECT w.default_review_level FROM workspaces w
           WHERE w.id = review_targets.workspace_id AND w.deleted_at IS NULL),
       check_min_score = COALESCE(
         (SELECT w.check_min_score FROM workspaces w
           WHERE w.id = review_targets.workspace_id AND w.deleted_at IS NULL),
         60),
       check_pass_verdicts = COALESCE(
         (SELECT w.default_check_pass_verdicts FROM workspaces w
           WHERE w.id = review_targets.workspace_id AND w.deleted_at IS NULL),
         check_pass_verdicts),
       follow_workspace_defaults = 0,
       updated_at = datetime('now')
 WHERE follow_workspace_defaults = 1
   AND deleted_at IS NULL
   AND (review_drafts = 0 OR review_enabled = 0);
