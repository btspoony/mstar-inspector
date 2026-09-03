-- 0017_app_model_chains.sql — default + named model chains (plan 35 T2,
-- spec §4.4, architect lock 2026-09-03).
--
-- app_model_chains: one row per (App, chain name). The default chain row
-- keeps the RESERVED name 'default' (is_default = 1); named chains are
-- user-named selector chains (is_default = 0). is_default uniqueness per
-- App is enforced producer-side by the store in ONE atomic db.batch
-- (clear-old-set-new, app-config-store.ts) — no CHECK / partial unique
-- index (app-family convention: value domains are store-enforced, the
-- 0006/0009 precedent).
--
-- app_model_chain_seats: one row per (App, role) — the seat's explicit
-- chain reference. ABSENT row = the seat uses the default chain. The
-- app_model_roles.selector column is NOT reused (0009's verbatim-selector
-- semantics stay untouched); the seat table is the new explicit mapping.
--
-- Backfill DML (NEW precedent — the first INSERT…SELECT in the migration
-- set; 0001–0015 are all DDL-only): the pre-chains storage shape
-- (app_model_config.model_chain + app_model_roles rows) is migrated in the
-- same transaction as the DDL —
--   * app_model_config.model_chain non-NULL → the 'default' chain row
--     (is_default = 1). NULL / absent row → no default row (the existing
--     fail-closed semantics, preserved verbatim).
--   * every app_model_roles row → one named chain 'seat-' || role holding
--     the verbatim selector, plus the seat reference row pointing at it —
--     so a migrated seat override resolves byte-identically to the
--     pre-migration modelOverrides map (plan Global Constraints: runner
--     input byte-equivalence is HARD).
--
-- Both tables FK github_apps(id), NO ON DELETE (0006/0009 precedent:
-- soft-delete is the only removal path; a hard DELETE of an app carrying
-- chain rows is refused at the schema level). Append-only: creates new
-- tables only, touches no existing table. Must apply AFTER 0004 (the FK
-- parent must exist).

CREATE TABLE app_model_chains (
  app_id     TEXT NOT NULL REFERENCES github_apps(id),
  name       TEXT NOT NULL,
  chain      TEXT NOT NULL,
  is_default INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  PRIMARY KEY (app_id, name)
);

CREATE TABLE app_model_chain_seats (
  app_id     TEXT NOT NULL REFERENCES github_apps(id),
  role       TEXT NOT NULL,
  chain_name TEXT NOT NULL,
  PRIMARY KEY (app_id, role)
);

INSERT INTO app_model_chains (app_id, name, chain, is_default, created_at, updated_at)
SELECT app_id, 'default', model_chain, 1, datetime('now'), datetime('now')
FROM app_model_config
WHERE model_chain IS NOT NULL;

INSERT INTO app_model_chains (app_id, name, chain, is_default, created_at, updated_at)
SELECT app_id, 'seat-' || role, selector, 0, datetime('now'), datetime('now')
FROM app_model_roles;

INSERT INTO app_model_chain_seats (app_id, role, chain_name)
SELECT app_id, role, 'seat-' || role
FROM app_model_roles;
