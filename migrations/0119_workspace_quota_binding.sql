-- 0119_workspace_quota_binding.sql — a workspace's month is pinned to a version.
--
-- Quota used to be judged by the profile covering the month's 1st: a version
-- published mid-month took effect for everyone at the next boundary, and a
-- workspace created today waited a month for it. D13 replaces that with a
-- per-workspace × month binding: a workspace created today uses the latest
-- version immediately, while one already metering keeps the version its month
-- opened under.
--
-- The write rule is the whole point (D36). `workspace_quota_binding` has ONE
-- writer: the metering batch that appends a workspace's first usage row of a
-- month, `INSERT OR IGNORE` on the primary key so two racing first meterings
-- converge on one row. No reader inserts — a reader that bound a version would
-- lock one for a workspace that never metered this month and would become a
-- second writer, re-opening the mid-month jump this table exists to prevent.
-- With no binding the resolver answers "the profile in force now" and writes
-- nothing.
--
-- `profile_id` references `quota_profiles(id)` rather than copying numbers:
-- a profile is append-only and never edited, so the reference is stable, and
-- `effective_from`-style denormalisation would let the bound row disagree with
-- its profile. `month` is the UTC `YYYY-MM` label `quotaMonth` already produces.
--
-- BACKFILL — this is what keeps a mid-month deploy from repricing a month in
-- progress. The old rule judged a month by the profile covering its 1st, but the
-- new resolver answers the profile in force NOW for an unbound workspace. So
-- every `(workspace, month)` that ALREADY has usage rows and no binding is
-- pinned to the profile in force at THAT MONTH'S FIRST DAY — the version its
-- usage was actually priced under. Without this, a workspace with rows from
-- before the deploy would bind a newer profile on its next metering and mix two
-- price scales inside one month.
--
-- Every future month's first metering still binds for itself, and a workspace
-- that has never metered has no row to bind.
--
-- Must apply AFTER 0118 (the last migration of the split family).

CREATE TABLE workspace_quota_binding (
  workspace_id TEXT    NOT NULL REFERENCES workspaces(id),
  month        TEXT    NOT NULL,
  profile_id   TEXT    NOT NULL REFERENCES quota_profiles(id),
  PRIMARY KEY  (workspace_id, month)
);

CREATE INDEX idx_workspace_quota_binding_profile ON workspace_quota_binding(profile_id);

-- One binding per (workspace, month) that already spent RP, pinned to the
-- profile covering that month's 1st: the version its rows were priced under.
-- `substr(occurred_at, 1, 7)` is the UTC `YYYY-MM` label `quotaMonth` produces,
-- and `occurred_at` is ISO-8601 UTC, so the month is the row's own.
INSERT OR IGNORE INTO workspace_quota_binding (workspace_id, month, profile_id)
SELECT DISTINCT
  u.workspace_id,
  substr(u.occurred_at, 1, 7),
  COALESCE(
    -- the profile in force at that month's first day…
    (SELECT p.id FROM quota_profiles p
      WHERE p.effective_from <= substr(u.occurred_at, 1, 7) || '-01T00:00:00.000Z'
      ORDER BY p.effective_from DESC
      LIMIT 1),
    -- …else the earliest, exactly as `resolveQuotaProfile` answers a month that
    -- precedes every profile.
    (SELECT p.id FROM quota_profiles p ORDER BY p.effective_from ASC LIMIT 1)
  )
FROM usage_events u
WHERE NOT EXISTS (
  SELECT 1 FROM workspace_quota_binding b
   WHERE b.workspace_id = u.workspace_id
     AND b.month = substr(u.occurred_at, 1, 7)
);

-- A deployment with no usage has nothing to bind, and a deployment with no
-- profile has already failed migration 0063. This guard turns the one remaining
-- silent failure — usage rows whose month resolved to no profile at all — into
-- an operator-readable stop instead of a half-priced month.
CREATE TABLE guard_quota_binding_without_profile (
  n INTEGER NOT NULL CONSTRAINT guard_quota_binding_without_profile CHECK (n = 0)
);
INSERT INTO guard_quota_binding_without_profile (n)
SELECT COUNT(*) FROM usage_events u
WHERE NOT EXISTS (SELECT 1 FROM quota_profiles);
