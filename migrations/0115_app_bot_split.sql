-- 0115_app_bot_split.sql — one review_bots row becomes a GitHub App plus a
-- Review Bot.
--
-- The pre-split `review_bots` row is three things at once: a GitHub App's
-- credentials, a review configuration, and one workspace's ownership of both
-- (ADR 2026-11-25-github-app-review-bot-split). This file renames the row in
-- place to `github_apps` — never rebuilt, because `pull_requests`' ON DELETE
-- CASCADE would empty the ledger before the non-cascading children could even
-- refuse the drop (the 0057:236-240 mechanism) — and creates a NEW
-- `review_bots` table for the review configuration. Both rows inherit the
-- pre-split id, so the credential AAD (`github_apps.private_key_enc:${id}`),
-- the provider-key AAD and the webhook URL keep their bytes.
--
-- Because the two ids are equal, every column that points at the App is
-- renamed `app_id` in this same file; after it, a `bot_id` column may point
-- only at a Review Bot (D34: neither side carries a column for the other — no
-- `review_bots.github_app_id`, no `github_apps.default_bot_id`; the mount in
-- `app_install_bots` is the only relation).
--
-- THE REPLAY CONTRACT (PM resolution): this file is APPLY-ONCE — a schema
-- migration containing `ALTER TABLE ... RENAME` cannot re-run in SQLite, and
-- 0031 is precedent. The ADR's "backfill file rerun after the drop" therefore
-- means the standalone executable `scripts/app-bot-backfill.sql`, not a second
-- application of this file. The three data statements below exist inline
-- because D1 has no include; the script file carries the same statements
-- verbatim and is the artifact a rehearsal or repair re-runs. SYNC CONTRACT:
-- a change to one copy is a change to ALL THREE — this file (inline,
-- apply-once), `scripts/app-bot-backfill.sql` (the replayable artifact) and
-- `scripts/workspace-backfill.sql` (the deploy replay step, which carries
-- the bot backfill and the reviews fill).
--
-- The data statements are idempotent by construction: the bot backfill is
-- guarded by WHERE NOT EXISTS against its own target, and the payload rewrite
-- writes the same value it already wrote. A pre-split row without an owner row
-- aborts the whole file through the guard tables below (the 0057 recipe).
--
-- This file drops no column, and its backfill reads NO column the later drop
-- removes: the bot's `sandbox_image_id` starts at the table default and the
-- App's value copies onto it in the apply-once drop file (D9, D37) before the
-- column falls, so the standalone backfill stays replayable after that drop.
-- The only pre-drop column it does read is `quota_profiles.source_shared`
-- (into the bot multiplier); the two `source_*` columns drop with the
-- quota-relay switch that stops `rpFor` reading them.
--
-- The eight `bot_*` configuration tables cannot follow the parent rename:
-- SQLite rewrites their foreign keys onto `github_apps`, while a bot_id column
-- may point only at a Review Bot. Nothing references them, so each is rebuilt
-- with the 0032/0038 recipe (staging copy under the final name's FK target)
-- pointing at the new `review_bots`, preserving every row.
--
-- Must apply AFTER 0114 (the tail of the pre-split schema).

PRAGMA foreign_keys = OFF;
PRAGMA defer_foreign_keys = true;

-- The App row is rename-only. Every child reference SQLite carries onto
-- `github_apps` is correct for the columns renamed `app_id` below; the eight
-- configuration tables are rebuilt back onto the new `review_bots`.
ALTER TABLE review_bots RENAME TO github_apps;

ALTER TABLE bot_workspaces RENAME TO app_workspaces;
ALTER TABLE app_workspaces RENAME COLUMN bot_id TO app_id;

ALTER TABLE bot_installations RENAME TO github_app_installations;
ALTER TABLE github_app_installations RENAME COLUMN bot_id TO app_id;

-- The new Review Bot: configuration, sandbox, price multiplier and monthly
-- ceiling. No host App column (D5, D34); audit columns are the row's own
-- created/updated pair, copied from the pre-split row.
CREATE TABLE review_bots (
  id              TEXT PRIMARY KEY,
  workspace_id    TEXT NOT NULL REFERENCES workspaces(id),
  name            TEXT NOT NULL,
  description     TEXT,
  scope           TEXT NOT NULL DEFAULT 'owned'
                  CHECK (scope IN ('owned','shared')),
  shared_at       TEXT,
  sandbox_image_id TEXT NOT NULL DEFAULT 'omp',
  multiplier      REAL NOT NULL CHECK (multiplier > 0),
  monthly_rp      INTEGER CHECK (monthly_rp IS NULL OR monthly_rp > 0),
  deleted_at      TEXT,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

-- One bot per App, soft-deleted Apps included (their ownership row exists).
-- An App without an owner row produces no bot — the guard below aborts the
-- migration in that case rather than leaving the App unexecutable.
-- `multiplier` backfills from the profile in force at apply time (the same
-- rule as `resolveQuotaProfile`: the latest `effective_from` at or before now,
-- else the earliest): an owned bot pays its owner's own keys, so multiplier 1;
-- a shared bot keeps the shared price it already charged, so no stored price
-- changes. `monthly_rp` stays NULL — no bot-level cap in this release.
INSERT INTO review_bots (
  id, workspace_id, name, description, scope, shared_at,
  sandbox_image_id, multiplier, monthly_rp, deleted_at, created_at, updated_at
)
SELECT
  g.id,
  w.workspace_id,
  g.name,
  NULL,
  g.scope,
  g.shared_at,
  'omp',
  CASE WHEN g.scope = 'shared' THEN
    COALESCE(
      (SELECT source_shared FROM quota_profiles
        WHERE effective_from <= strftime('%Y-%m-%dT%H:%M:%fZ','now')
        ORDER BY effective_from DESC LIMIT 1),
      (SELECT source_shared FROM quota_profiles ORDER BY effective_from ASC LIMIT 1)
    )
  ELSE 1 END,
  NULL,
  g.deleted_at,
  g.created_at,
  g.updated_at
FROM github_apps g
INNER JOIN app_workspaces w ON w.app_id = g.id
WHERE NOT EXISTS (SELECT 1 FROM review_bots b WHERE b.id = g.id);

-- The eight configuration tables, rebuilt onto the new review_bots. Each
-- keeps its exact column shape and every row; only the foreign key target
-- changes. Nothing references them, so the drop cannot cascade.

CREATE TABLE bot_provider_keys_new (
  bot_id          TEXT NOT NULL REFERENCES review_bots(id),
  provider        TEXT NOT NULL,
  key_id          TEXT NOT NULL,
  key_enc         TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT,
  verified_at     TEXT,
  verified_status TEXT,
  PRIMARY KEY (bot_id, provider, key_id)
);
INSERT INTO bot_provider_keys_new SELECT * FROM bot_provider_keys;
DROP TABLE bot_provider_keys;
ALTER TABLE bot_provider_keys_new RENAME TO bot_provider_keys;

CREATE TABLE bot_model_config_new (
  bot_id      TEXT PRIMARY KEY REFERENCES review_bots(id),
  model_chain TEXT,
  updated_at  TEXT NOT NULL
);
INSERT INTO bot_model_config_new SELECT * FROM bot_model_config;
DROP TABLE bot_model_config;
ALTER TABLE bot_model_config_new RENAME TO bot_model_config;

CREATE TABLE bot_model_roles_new (
  bot_id   TEXT NOT NULL REFERENCES review_bots(id),
  role     TEXT NOT NULL,
  selector TEXT NOT NULL,
  PRIMARY KEY (bot_id, role)
);
INSERT INTO bot_model_roles_new SELECT * FROM bot_model_roles;
DROP TABLE bot_model_roles;
ALTER TABLE bot_model_roles_new RENAME TO bot_model_roles;

CREATE TABLE bot_model_chains_new (
  bot_id     TEXT NOT NULL REFERENCES review_bots(id),
  name       TEXT NOT NULL,
  chain      TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (bot_id, name)
);
INSERT INTO bot_model_chains_new SELECT * FROM bot_model_chains;
DROP TABLE bot_model_chains;
ALTER TABLE bot_model_chains_new RENAME TO bot_model_chains;

CREATE TABLE bot_model_chain_seats_new (
  bot_id     TEXT NOT NULL REFERENCES review_bots(id),
  role       TEXT NOT NULL,
  chain_name TEXT NOT NULL,
  PRIMARY KEY (bot_id, role)
);
INSERT INTO bot_model_chain_seats_new SELECT * FROM bot_model_chain_seats;
DROP TABLE bot_model_chain_seats;
ALTER TABLE bot_model_chain_seats_new RENAME TO bot_model_chain_seats;

CREATE TABLE bot_custom_providers_new (
  bot_id      TEXT NOT NULL REFERENCES review_bots(id),
  provider_id TEXT NOT NULL,
  base_url    TEXT NOT NULL,
  api         TEXT NOT NULL,
  model_ids   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  models_meta TEXT NOT NULL DEFAULT '{}',
  PRIMARY KEY (bot_id, provider_id)
);
INSERT INTO bot_custom_providers_new SELECT * FROM bot_custom_providers;
DROP TABLE bot_custom_providers;
ALTER TABLE bot_custom_providers_new RENAME TO bot_custom_providers;

CREATE TABLE bot_custom_provider_keys_new (
  bot_id          TEXT NOT NULL REFERENCES review_bots(id),
  provider        TEXT NOT NULL,
  key_id          TEXT NOT NULL,
  key_enc         TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT,
  verified_at     TEXT,
  verified_status TEXT,
  PRIMARY KEY (bot_id, provider, key_id)
);
INSERT INTO bot_custom_provider_keys_new SELECT * FROM bot_custom_provider_keys;
DROP TABLE bot_custom_provider_keys;
ALTER TABLE bot_custom_provider_keys_new RENAME TO bot_custom_provider_keys;

CREATE TABLE bot_provider_models_new (
  bot_id      TEXT NOT NULL REFERENCES review_bots(id),
  provider    TEXT NOT NULL,
  key_id      TEXT NOT NULL,
  models_json TEXT NOT NULL,
  fetched_at  TEXT NOT NULL,
  PRIMARY KEY (bot_id, provider, key_id)
);
INSERT INTO bot_provider_models_new SELECT * FROM bot_provider_models;
DROP TABLE bot_provider_models;
ALTER TABLE bot_provider_models_new RENAME TO bot_provider_models;

-- Every publishing column moves to app_id: the value is unchanged (the ids
-- are equal), and the foreign key already names `github_apps` after the
-- parent rename. `pull_requests` keeps its ON DELETE CASCADE — the one child
-- a parent rebuild would empty rather than refuse. The three cursor/lease
-- tables carry the same attribution with no foreign key.
ALTER TABLE review_targets RENAME COLUMN bot_id TO app_id;
ALTER TABLE pull_requests RENAME COLUMN bot_id TO app_id;
ALTER TABLE webhook_deliveries RENAME COLUMN bot_id TO app_id;
ALTER TABLE review_publications RENAME COLUMN bot_id TO app_id;
ALTER TABLE review_threads RENAME COLUMN bot_id TO app_id;
ALTER TABLE review_checks RENAME COLUMN bot_id TO app_id;
ALTER TABLE review_findings RENAME COLUMN bot_id TO app_id;
ALTER TABLE reviews RENAME COLUMN bot_id TO app_id;
ALTER TABLE lifecycle_recovery_cursor RENAME COLUMN bot_id TO app_id;
ALTER TABLE check_reenable_cursor RENAME COLUMN bot_id TO app_id;
ALTER TABLE degraded_target_leases RENAME COLUMN bot_id TO app_id;

-- The executing bot. Backfilled equal to the acting App: in this release one
-- App executes through exactly one bot — its own — so both ids are the same
-- value.
ALTER TABLE reviews ADD COLUMN bot_id TEXT REFERENCES review_bots(id);
UPDATE reviews SET bot_id = app_id WHERE app_id IS NOT NULL AND bot_id IS NULL;

-- The install state and its ordered chain, created empty: the writers (the
-- createApp batch and the bind batch) arrive with the chain plan. The chain
-- binds to its parent state by composite key, so no chain row can name an
-- install state that does not exist, and position order lives per install
-- state — never on the App row and never on the physical installation.
CREATE TABLE app_installations (
  github_app_id TEXT NOT NULL REFERENCES github_apps(id),
  workspace_id  TEXT NOT NULL REFERENCES workspaces(id),
  created_at    TEXT NOT NULL,
  PRIMARY KEY (github_app_id, workspace_id)
);

CREATE TABLE app_install_bots (
  github_app_id TEXT NOT NULL,
  workspace_id  TEXT NOT NULL,
  position      INTEGER NOT NULL,
  bot_id        TEXT NOT NULL REFERENCES review_bots(id),
  PRIMARY KEY (github_app_id, workspace_id, position),
  FOREIGN KEY (github_app_id, workspace_id)
    REFERENCES app_installations(github_app_id, workspace_id)
);

-- Queued comment-trigger payloads predate `botRef.botId`; the sweep resends
-- the stored JSON verbatim, so the queued rows are rewritten here. The bot is
-- the one the split created for that App — the same id — and messages already
-- on the queue are drained inside the maintenance window. Tombstones
-- (payload_json NULL) keep holding nothing. The rewrite is a fixed-point
-- write: a payload that already carries the value gets the same value back.
UPDATE comment_trigger_claims
SET payload_json = json_set(
  payload_json,
  '$.botRef.botId',
  json_extract(payload_json, '$.botRef.appId')
)
WHERE state = 'queued'
  AND payload_json IS NOT NULL
  AND json_extract(payload_json, '$.botRef.appId') IS NOT NULL;

-- Guards (the 0057 recipe): each count must be zero, and the table's own
-- CHECK is what makes a non-zero count fail the migration instead of leaving
-- a row behind. An App without an owner row aborts the whole file and leaves
-- the schema unsplit.

CREATE TABLE guard_app_without_workspace (
  n INTEGER NOT NULL CONSTRAINT guard_app_without_workspace CHECK (n = 0)
);
INSERT INTO guard_app_without_workspace (n)
SELECT COUNT(*) FROM github_apps g
WHERE NOT EXISTS (SELECT 1 FROM app_workspaces w WHERE w.app_id = g.id);
DROP TABLE guard_app_without_workspace;

CREATE TABLE guard_app_without_bot (
  n INTEGER NOT NULL CONSTRAINT guard_app_without_bot CHECK (n = 0)
);
INSERT INTO guard_app_without_bot (n)
SELECT COUNT(*) FROM github_apps g
WHERE NOT EXISTS (SELECT 1 FROM review_bots b WHERE b.id = g.id);
DROP TABLE guard_app_without_bot;

CREATE TABLE guard_queued_claim_without_bot (
  n INTEGER NOT NULL CONSTRAINT guard_queued_claim_without_bot CHECK (n = 0)
);
INSERT INTO guard_queued_claim_without_bot (n)
SELECT COUNT(*) FROM comment_trigger_claims c
WHERE state = 'queued' AND payload_json IS NOT NULL
  AND (
    json_extract(payload_json, '$.botRef.appId') IS NULL
    OR json_extract(payload_json, '$.botRef.botId') IS NULL
    OR NOT EXISTS (
      SELECT 1 FROM github_apps g WHERE g.id = json_extract(payload_json, '$.botRef.appId')
    )
    OR NOT EXISTS (
      SELECT 1 FROM review_bots b WHERE b.id = json_extract(payload_json, '$.botRef.botId')
    )
  );
DROP TABLE guard_queued_claim_without_bot;

PRAGMA foreign_keys = ON;
