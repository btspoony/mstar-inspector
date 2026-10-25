-- 0033_platform_admin.sql — the operator console's platform-scope tables
-- (spec operator-admin-surface §3.1/§4).
--
-- `server_flags` holds the EFFECTIVE flag set, one row per flag an operator has
-- toggled. An ABSENT row is the default state and reads as ENABLED (fail-open
-- to the behaviour the platform shipped with), so this file seeds nothing: a
-- missing row can never break a live consumer, and every flag starts life
-- taking the same path it took before this table existed.
--
-- `platform_audit_events` is the platform-scope ledger (flag toggles, workspace
-- plan assignment). Workspace-scope writes keep using `audit_events`, whose
-- `workspace_id NOT NULL` (0029) platform scope cannot satisfy — that column
-- stays as it is, it is a forward-only contract shared with tenant auditing.
--
-- Tables only: no rows, no backfill, no consumer.

CREATE TABLE server_flags (
  key        TEXT PRIMARY KEY,
  enabled    INTEGER NOT NULL CHECK (enabled IN (0, 1)),
  updated_at TEXT NOT NULL,
  updated_by TEXT NOT NULL
);

CREATE TABLE platform_audit_events (
  id          TEXT PRIMARY KEY,
  actor_login TEXT NOT NULL COLLATE NOCASE,
  action      TEXT NOT NULL,
  target_type TEXT NOT NULL,
  target_id   TEXT NOT NULL,
  detail_json TEXT,
  created_at  TEXT NOT NULL
);

-- The ledger read is newest-first and platform-wide (no workspace filter), so
-- the timestamp is the only ordering key.
CREATE INDEX platform_audit_events_created ON platform_audit_events (created_at);
