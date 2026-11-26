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
-- No backfill. A workspace with no row resolves to the profile in force at read
-- time, and its next metering writes the row — which is the behaviour a
-- backfill would have to guess at, since the only instant it could bind is
-- "now". Existing rows therefore keep the version the month-start rule gave
-- them for the remainder of this month, and the first metering of the next
-- month binds that month.
--
-- Must apply AFTER 0118 (the last migration of the split family).

CREATE TABLE workspace_quota_binding (
  workspace_id TEXT    NOT NULL REFERENCES workspaces(id),
  month        TEXT    NOT NULL,
  profile_id   TEXT    NOT NULL REFERENCES quota_profiles(id),
  PRIMARY KEY  (workspace_id, month)
);

CREATE INDEX idx_workspace_quota_binding_profile ON workspace_quota_binding(profile_id);
