-- 0056_review_bots_rename.sql — the App family is a review bot.
--
-- `github_apps` holds a GitHub App's credentials and identity, and the tables
-- hanging off it (installations, the workspace ownership row, provider keys,
-- model configuration, provider models) describe that same bot. Calling them
-- `app_*` makes "app" mean two things once review targets exist, so the family
-- and every row that records which bot acted take the bot vocabulary:
-- `review_bots` / `bot_*` / `bot_id`.
--
-- `ALTER TABLE ... RENAME` rewrites the foreign keys and index definitions in
-- place: no table is rebuilt, no row is rewritten, and no ciphertext or public
-- URL is touched. The secretbox AAD literals keep their old spelling on
-- purpose — they bind the ciphertext, not the table.
--
-- `app_owner_allowlist` is not part of the bot family: it describes who may
-- trigger a review. Its column stays `app_id`; only its foreign key follows
-- the parent rename.
--
-- The renamed parent comes first so every child's foreign key resolves
-- against the name that exists when the child is renamed.

ALTER TABLE github_apps RENAME TO review_bots;
ALTER TABLE app_installations RENAME TO bot_installations;
ALTER TABLE app_workspaces RENAME TO bot_workspaces;
ALTER TABLE app_provider_keys RENAME TO bot_provider_keys;
ALTER TABLE app_model_config RENAME TO bot_model_config;
ALTER TABLE app_model_roles RENAME TO bot_model_roles;
ALTER TABLE app_model_chains RENAME TO bot_model_chains;
ALTER TABLE app_model_chain_seats RENAME TO bot_model_chain_seats;
ALTER TABLE app_custom_providers RENAME TO bot_custom_providers;
ALTER TABLE app_custom_provider_keys RENAME TO bot_custom_provider_keys;
ALTER TABLE app_provider_models RENAME TO bot_provider_models;

ALTER TABLE bot_installations RENAME COLUMN app_id TO bot_id;
ALTER TABLE bot_workspaces RENAME COLUMN app_id TO bot_id;
ALTER TABLE bot_provider_keys RENAME COLUMN app_id TO bot_id;
ALTER TABLE bot_model_config RENAME COLUMN app_id TO bot_id;
ALTER TABLE bot_model_roles RENAME COLUMN app_id TO bot_id;
ALTER TABLE bot_model_chains RENAME COLUMN app_id TO bot_id;
ALTER TABLE bot_model_chain_seats RENAME COLUMN app_id TO bot_id;
ALTER TABLE bot_custom_providers RENAME COLUMN app_id TO bot_id;
ALTER TABLE bot_custom_provider_keys RENAME COLUMN app_id TO bot_id;
ALTER TABLE bot_provider_models RENAME COLUMN app_id TO bot_id;
ALTER TABLE reviews RENAME COLUMN app_id TO bot_id;
ALTER TABLE pull_requests RENAME COLUMN app_id TO bot_id;
ALTER TABLE webhook_deliveries RENAME COLUMN app_id TO bot_id;
ALTER TABLE review_publications RENAME COLUMN app_id TO bot_id;
ALTER TABLE review_findings RENAME COLUMN app_id TO bot_id;
ALTER TABLE review_threads RENAME COLUMN app_id TO bot_id;
ALTER TABLE review_checks RENAME COLUMN app_id TO bot_id;

-- SQLite rewrites index definitions but not index names.
DROP INDEX idx_reviews_app_id;
CREATE INDEX idx_reviews_bot_id ON reviews(bot_id);
DROP INDEX idx_webhook_deliveries_app_created;
CREATE INDEX idx_webhook_deliveries_bot_created ON webhook_deliveries(bot_id, created_at);
DROP INDEX idx_pull_requests_app_pr;
CREATE UNIQUE INDEX idx_pull_requests_bot_pr ON pull_requests(bot_id, owner, repo, pr_number);
