-- 0006_app_provider_config.sql — per-App BYOK configuration (plan 14 B2
-- Task 1, spec dashboard-multi-app-platform § Data model, architect locks
-- L1/L2).
--
-- app_provider_keys: one row per (App, provider) API key — the BYOK store.
-- key_enc is an AES-256-GCM secretbox envelope
-- (`v1.<keyId>.<iv_b64>.<ct_b64>`, src/dashboard/secretbox.ts) — plaintext
-- provider keys never touch D1, logs, HTML, or git. The envelope AAD rowKey
-- is the COMPOSITE primary key joined with `:` —
-- `app_provider_keys.key_enc:<app_id>:<provider>` (lock L1, composite-PK
-- rowKey) — so encrypt/decrypt callers must always pass both PK columns in
-- that order.
--
-- app_model_config: the App's model chain, same semantics as the global
-- OMP_REVIEW_MODEL (comma-separated model selectors; first = primary, rest =
-- fallback chain). model_chain stays PLAINTEXT by design: a model selector is
-- configuration, not a secret (plan Done criteria). NULL / absent row =
-- unset → the consumer falls back to the global OMP_REVIEW_MODEL.
--
-- Order constraints (lock L2): both tables reference github_apps(id) — this
-- file must apply AFTER 0004. Append-only on the production DB: creates new
-- tables only, touches no existing table.
-- No ON DELETE clause anywhere (default NO ACTION), 0004/0005 precedent:
-- soft-delete (github_apps.deleted_at) is the ONLY removal path; a hard
-- DELETE of an app carrying config rows is refused at the schema level.

CREATE TABLE app_provider_keys (
  app_id     TEXT NOT NULL REFERENCES github_apps(id),
  provider   TEXT NOT NULL,
  key_enc    TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (app_id, provider)
);

CREATE TABLE app_model_config (
  app_id      TEXT PRIMARY KEY REFERENCES github_apps(id),
  model_chain TEXT,
  updated_at  TEXT NOT NULL
);
