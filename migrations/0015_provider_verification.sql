-- 0015_provider_verification.sql — provider-key verification columns +
-- verified-model cache (plan 31 Tasks 2+3, spec v1.1-dashboard-platform §6.1).
--
-- SECTION 1 (plan 31 Task 2): verification bookkeeping on the two key stores.
-- app_provider_keys and app_custom_providers each gain two nullable TEXT
-- columns — verified_at (SQLite datetime('now') UTC, written by the store)
-- and verified_status ('ok' | 'failed'; NULL = never verified). Both stores
-- run the same save-then-verify flow (built-in BYOK keys and custom-provider
-- declarations alike, spec §6.1), so both carry the same bookkeeping. Rows
-- written BEFORE this migration naturally carry NULL — legacy unverified
-- rows stay usable exactly as before (verification is additive, never a
-- precondition for the consumer, which keys off the key_enc envelope only).
--
-- Key material is untouched: the plaintext key still exists only as the
-- secretbox envelope (src/dashboard/secretbox.ts, composite-PK AAD rowKey
-- `app_provider_keys.key_enc:<app_id>:<provider>` / 0006 L1 precedent); the
-- new columns are plaintext non-sensitive metadata (spec §6.1 — same
-- distinction as model_chain vs key_enc in 0006). No CHECK constraint: the
-- 'ok'|'failed' value domain is enforced producer-side by the dashboard
-- store (0006/0012 precedent).
--
-- SECTION 2 (plan 31 Task 2): app_provider_models — the per-App verified
-- model cache for BUILT-IN providers (selector-facing provider keys only:
-- the `ark` BYOK key verifies under "ark" but its cached row is written
-- under "ark-plan", the in-image base provider id the chain actually
-- references — spec §6.1). models_json is a TEXT JSON array of verified
-- model ids — configuration, not a secret (0006 model_chain rationale; a
-- model selector is configuration, not a secret). fetched_at is a TEXT
-- timestamp written by the store. Custom providers write NO rows here —
-- their model vocabulary is the declared model_ids (0012), which the
-- settings loader reads directly.
--
-- Composite PK (app_id, provider): exactly one cached model list per
-- provider per App; the verify-store upserts in place on re-verification.
-- FK references github_apps(id), NO ON DELETE clause (0006/0009/0012
-- precedent: soft-delete is the only removal path; a hard DELETE of an app
-- carrying cache rows is refused at the schema level).
--
-- Append-only: four nullable ALTERs + one new table; touches no existing
-- data. Must apply AFTER 0004 (the FK parent) and AFTER 0012 (both ALTERed
-- tables must exist) — filename order puts it last, matching the locked
-- sequence.

ALTER TABLE app_provider_keys ADD COLUMN verified_at TEXT;
ALTER TABLE app_provider_keys ADD COLUMN verified_status TEXT;

ALTER TABLE app_custom_providers ADD COLUMN verified_at TEXT;
ALTER TABLE app_custom_providers ADD COLUMN verified_status TEXT;

CREATE TABLE app_provider_models (
  app_id      TEXT NOT NULL REFERENCES github_apps(id),
  provider    TEXT NOT NULL,
  models_json TEXT NOT NULL,
  fetched_at  TEXT NOT NULL,
  PRIMARY KEY (app_id, provider)
);
