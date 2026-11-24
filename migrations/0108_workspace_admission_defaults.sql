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
-- `DEFAULT 1` keeps the current behaviour for every existing workspace (drafts
-- reviewed, review enabled), and the columns are metadata-only ADD COLUMNs: no
-- data movement, no backfill. Forward-only.
ALTER TABLE workspaces ADD COLUMN default_review_drafts INTEGER NOT NULL DEFAULT 1
  CHECK (default_review_drafts IN (0, 1));

ALTER TABLE workspaces ADD COLUMN default_review_enabled INTEGER NOT NULL DEFAULT 1
  CHECK (default_review_enabled IN (0, 1));
