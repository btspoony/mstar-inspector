-- The workspace an installation of a shared bot is bound to.
--
-- A shared bot is installed on many customers' GitHub accounts, so its
-- `bot_installations` rows are not one tenant's. `bound_workspace_id` records
-- the workspace whose manager proved, through their own GitHub user token, that
-- they administer the installation's account (the bind flow). For a shared bot,
-- the repository walk, target creation and the bind refusal read only rows
-- bound to the caller's workspace; NULL is "not bound to anyone" and grants no
-- workspace its repositories. The webhook upsert never writes this column.
ALTER TABLE bot_installations ADD COLUMN bound_workspace_id TEXT REFERENCES workspaces(id);

CREATE INDEX idx_bot_installations_bound_workspace
  ON bot_installations(bot_id, bound_workspace_id);
