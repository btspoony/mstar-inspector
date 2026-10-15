-- 0025_provider_model_evidence.sql — per-KEY verified-model evidence.
--
-- app_provider_models moves from ONE aggregate row per (App, provider) to ONE
-- row per (App, provider, key_id): each verified key's OWN model report, the
-- key_id being the same plaintext-derived id app_provider_keys carries.
-- The store recomputes what the settings dropdown may offer as the
-- INTERSECTION over the CURRENT pool's keys on every read.
--
-- Why an aggregate row cannot be the answer: the runtime loads the WHOLE
-- pool, so a model only one credential can reach must not be offered while
-- another credential may answer the request — but an aggregate cannot tell
-- WHICH key lost a model, so any write of "the provider's list" both
-- overwrites evidence it does not own (the old rule intersected only in the
-- ON CONFLICT branch, so a re-verification after a deletion cached one key's
-- list verbatim for a multi-key pool) and can never gain back a model the
-- pool as a whole acquired (intersecting a historical aggregate is
-- monotone-decreasing). Per-key rows fix both: a re-verification refreshes
-- exactly that key's report, a deletion removes exactly that key's report,
-- and the recomputed intersection tracks the live pool in both directions.
--
-- SQLite cannot change a primary key in place, so the new shape needs
-- create → copy → drop → rename. The copy is deliberately EMPTY: the
-- pre-0025 rows are un-attributable aggregates (SQL cannot know which key
-- contributed which model — the model list is derived, never key material),
-- and carrying one forward would either be dead data the read face must
-- ignore or the very aggregate this migration exists to remove. This is a
-- rebuildable derived cache (the 0015 DDL's own contract, and the rule
-- deleteProviderKey already documents: "the next verification rebuilds it"),
-- so an App whose provider showed models before the apply shows the
-- probe-only face until its next verification — no phantom model, and no key
-- material touched. Key tables, envelopes and chains are untouched.
--
-- FORWARD-ONLY: a rollback means reverting the deploy AND restoring the
-- pre-apply snapshot taken before the apply (§ Rollback in docs/deploy.md —
-- the same snapshot 0024 needs, since 0024 must be applied before this file).
-- Must apply AFTER 0004 (the FK parent) and AFTER 0015 (the table being
-- rebuilt).

CREATE TABLE app_provider_models_per_key (
  app_id      TEXT NOT NULL REFERENCES github_apps(id),
  provider    TEXT NOT NULL,
  key_id      TEXT NOT NULL,
  models_json TEXT NOT NULL,
  fetched_at  TEXT NOT NULL,
  PRIMARY KEY (app_id, provider, key_id)
);

DROP TABLE app_provider_models;

ALTER TABLE app_provider_models_per_key RENAME TO app_provider_models;
