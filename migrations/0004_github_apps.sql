-- 0004_github_apps.sql — multi-App foundation (plan 13 Task 1, spec
-- dashboard-multi-app-platform § Data model, architect lock L2).
--
-- github_apps holds one row per audit GitHub App served by this deployment.
-- private_key_enc / webhook_secret_enc are AES-256-GCM secretbox envelopes
-- (`v1.<keyId>.<iv_b64>.<ct_b64>`, src/dashboard/secretbox.ts) — plaintext
-- PEM / webhook secret never touch D1, logs, or HTML. deleted_at is the ONLY
-- removal path (soft delete, Clarify #4); there is deliberately NO ON DELETE
-- clause anywhere in this file — the default NO ACTION makes a hard DELETE
-- of an app referenced by app_installations (here) or reviews (0005)
-- impossible at the schema level.
--
-- Order constraints (lock L2):
--   * github_apps is created BEFORE app_installations (same-file FK).
--   * 0005 (reviews.app_id → github_apps) must apply AFTER this file —
--     SQLite ADD COLUMN ... REFERENCES requires the parent table to exist.
-- Append-only on the production DB: creates new tables only, touches no
-- existing table (0001/0002 DDL untouched).

CREATE TABLE github_apps (
  id                 TEXT PRIMARY KEY,
  slug               TEXT UNIQUE NOT NULL,
  github_app_id      INTEGER UNIQUE NOT NULL,
  name               TEXT NOT NULL,
  private_key_enc    TEXT NOT NULL,
  webhook_secret_enc TEXT NOT NULL,
  created_by         TEXT NOT NULL,
  status             TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','disabled')),
  deleted_at         TEXT,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE app_installations (
  id              TEXT PRIMARY KEY,
  app_id          TEXT NOT NULL REFERENCES github_apps(id),
  installation_id INTEGER NOT NULL,
  account_login   TEXT,
  seen_at         TEXT NOT NULL,
  UNIQUE (app_id, installation_id)
);
