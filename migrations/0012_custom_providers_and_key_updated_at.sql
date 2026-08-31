-- 0012_custom_providers_and_key_updated_at.sql — provider-key updated_at
-- (plan 23 Task 1) + custom-provider declarations (plan 23 Task 2).
--
-- SECTION 1 (plan 23 Task 1 — THIS FILE's committed content): the
-- app_provider_keys.updated_at column — polish #6 "masked key last-updated"
-- (iteration spec v0.8 §2.4 item 3 / AC-23c). The store's setProviderKey
-- upsert maintains it on every write (fresh insert: updated_at == created_at
-- moment; re-set: bumped to now), listProviderKeys returns it, and the
-- settings page shows it. Rows written BEFORE this migration carry NULL —
-- the settings page renders an em dash placeholder for those until the key
-- is re-set.
--
-- Append-only: the ALTER adds one nullable column, touches no existing
-- data. Forward-only (SQLite has no down). No FK change — app_provider_keys
-- is untouched structurally beyond the new column.

ALTER TABLE app_provider_keys ADD COLUMN updated_at TEXT;

-- SECTION 2 (plan 23 Task 2): app_custom_providers — per-App custom
-- provider declarations (AL-23-1 DDL). One row per (App, provider_id): a
-- BYOK-style declaration of a NON-built-in model provider (base URL + API
-- protocol + model ids), consumed by the review runner's per-review models
-- synthesis (plan 23 Task 3). The API key is a secretbox envelope
-- (src/dashboard/secretbox.ts) with the composite-PK AAD rowKey
-- `app_custom_providers.api_key_enc:<app_id>:<provider_id>` (0006 L1
-- precedent) — plaintext keys never touch D1, logs, HTML, or git.
--
-- model_ids is a TEXT JSON array (AL-23-1 DDL) — the declaration's model
-- vocabulary, configuration not secrets. api is one of the AL-23-1
-- three-form protocol enum (anthropic-messages | openai-completions |
-- openai-responses); the value domain is enforced producer-side by the
-- dashboard store (CUSTOM_PROVIDER_API_IDS mirror) — no CHECK constraint,
-- the runner side passes unknown values through lazily (0009 precedent).
--
-- Composite PK (app_id, provider_id): exactly one declaration per provider
-- per App. FK references github_apps(id), NO ON DELETE clause (0006/0009
-- precedent: soft-delete is the only removal path; a hard DELETE of an app
-- carrying declaration rows is refused at the schema level).
--
-- Append-only: creates a new table only, touches no existing table. Must
-- apply AFTER 0004 (the FK parent must exist).

CREATE TABLE app_custom_providers (
  app_id      TEXT NOT NULL REFERENCES github_apps(id),
  provider_id TEXT NOT NULL,
  base_url    TEXT NOT NULL,
  api         TEXT NOT NULL,
  model_ids   TEXT NOT NULL,
  api_key_enc TEXT NOT NULL,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL,
  PRIMARY KEY (app_id, provider_id)
);
