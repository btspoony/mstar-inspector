-- 0024_provider_multi_key.sql — per-key provider pools.
--
-- app_provider_keys moves from ONE row per (App, provider) to ONE row per
-- (App, provider, key_id): the new third primary-key column is the first 16
-- hex characters of the key's SHA-256, so re-submitting the same key updates
-- its own row and a second key takes a second slot (at most
-- MAX_KEYS_PER_PROVIDER per pool, enforced producer-side by the store).
-- The secretbox AAD rowKey gains the same column —
-- `app_provider_keys.key_enc:<app_id>:<provider>:<key_id>` (the pre-0024
-- two-segment form stays readable ONLY by the promotion path below).
--
-- Why the tables are rebuilt instead of ALTERed: SQLite cannot change a
-- primary key in place, so the new shape needs create → copy → drop →
-- rename. app_custom_providers loses `api_key_enc` / `verified_at` /
-- `verified_status` the same way — that key material MOVES into the new
-- `app_custom_provider_keys` table (same shape as app_provider_keys: the
-- key's identity, the envelope and its verification bookkeeping are per key,
-- while the declaration keeps base_url / api / model_ids).
--
-- FORWARD-ONLY, and split in two halves by what can run where. D1 migrations
-- are SQL, and SQL cannot decrypt — the key id is derived from the PLAINTEXT
-- — so this file carries the pre-pool rows across VERBATIM (old envelope,
-- old timestamps, old verification bookkeeping) under the empty-string
-- key_id sentinel. The store, which holds the master key, completes the
-- promotion on the FIRST TOUCH of such a row: decrypt with the OLD AAD,
-- derive the key id, re-encrypt under the new three-segment AAD and rewrite
-- the row in place. A rollback therefore means reverting the deploy AND
-- restoring the D1 snapshot taken before the apply.
--
-- Append-only in spirit: no table is dropped other than the two it rebuilds
-- (their rows are copied first), and no row is deleted. FK references
-- github_apps(id), NO ON DELETE clause (0006/0009/0012 precedent: soft-delete
-- is the only removal path; a hard DELETE of an app carrying key rows is
-- refused at the schema level). Must apply AFTER 0004 (the FK parent), 0006
-- (app_provider_keys), 0012/0015 (the columns being carried over) and 0004.

-- SECTION 1: app_provider_keys → the per-key pool shape.

CREATE TABLE app_provider_keys_pool (
  app_id          TEXT NOT NULL REFERENCES github_apps(id),
  provider        TEXT NOT NULL,
  key_id          TEXT NOT NULL,
  key_enc         TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT,
  verified_at     TEXT,
  verified_status TEXT,
  PRIMARY KEY (app_id, provider, key_id)
);

INSERT INTO app_provider_keys_pool
  (app_id, provider, key_id, key_enc, created_at, updated_at, verified_at, verified_status)
SELECT app_id, provider, '', key_enc, created_at, updated_at, verified_at, verified_status
FROM app_provider_keys;

DROP TABLE app_provider_keys;

ALTER TABLE app_provider_keys_pool RENAME TO app_provider_keys;

-- SECTION 2: app_custom_provider_keys — the custom-provider key material its
-- declaration table no longer holds. Same shape and AAD form as
-- app_provider_keys (the `provider` column carries the declaration's
-- provider_id).

CREATE TABLE app_custom_provider_keys (
  app_id          TEXT NOT NULL REFERENCES github_apps(id),
  provider        TEXT NOT NULL,
  key_id          TEXT NOT NULL,
  key_enc         TEXT NOT NULL,
  created_at      TEXT NOT NULL,
  updated_at      TEXT,
  verified_at     TEXT,
  verified_status TEXT,
  PRIMARY KEY (app_id, provider, key_id)
);

INSERT INTO app_custom_provider_keys
  (app_id, provider, key_id, key_enc, created_at, updated_at, verified_at, verified_status)
SELECT app_id, provider_id, '', api_key_enc, created_at, updated_at, verified_at, verified_status
FROM app_custom_providers;

-- SECTION 3: app_custom_providers → the declaration-only shape.

CREATE TABLE app_custom_providers_decl (
  app_id      TEXT NOT NULL REFERENCES github_apps(id),
  provider_id TEXT NOT NULL,
  base_url    TEXT NOT NULL,
  api         TEXT NOT NULL,
  model_ids   TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (app_id, provider_id)
);

INSERT INTO app_custom_providers_decl (app_id, provider_id, base_url, api, model_ids, created_at, updated_at)
SELECT app_id, provider_id, base_url, api, model_ids, created_at, updated_at
FROM app_custom_providers;

DROP TABLE app_custom_providers;

ALTER TABLE app_custom_providers_decl RENAME TO app_custom_providers;
