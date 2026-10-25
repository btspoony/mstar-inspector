-- 0032_unlimited_plan.sql — the `unlimited` plan tier and a nullable seat limit.
--
-- 0031's header makes NULL the contract for a quota column ("a NULL limit means
-- unlimited; never encode unlimited as a sentinel number"), and says explicitly
-- that `included_members` must turn into the same shape the moment a plan with
-- no seat cap exists. That plan is `unlimited`: every quota column is NULL, and
-- the seat limit joins them. So the column relaxes from INTEGER NOT NULL to
-- INTEGER (NULL = no seat cap) and one row is appended.
--
-- No backfill: a NULL limit needs nothing written anywhere else, and no
-- subscription row is rewritten. `unlimited` is assigned to a workspace by
-- resolution (the deployment mode), never by this migration.
--
-- SQLite cannot ALTER a column, so the relaxation is the standard parent-table
-- rebuild: create → copy → drop → re-create. Two details are load-bearing.
--
-- 1. `workspace_subscriptions.plan_id REFERENCES plans(id)` is immediate. A
--    DROP TABLE on a referenced parent runs an implicit DELETE, so it fails
--    while child rows exist — `PRAGMA defer_foreign_keys` carries that gap to
--    the end of the migration's transaction, and D1 runs every migration file
--    inside one implicit transaction.
-- 2. The rows are copied back into a table that is created under the FINAL
--    name, not into a temp table that is then renamed. Re-creating the parent
--    through `ALTER TABLE ... RENAME TO plans` does not clear the deferred
--    violation even though the keys exist again (verified against local D1:
--    the rename form fails the migration with `FOREIGN KEY constraint failed`;
--    the copy-back form applies and the FK stays enforced). The staging table
--    exists only to hold the two rows across the drop.
--
-- `PRAGMA foreign_keys = OFF` is the plain-SQLite half of the same swap: it is
-- the only form that also works when the statements run in autocommit (the test
-- double's `db.exec`). D1 ignores it and relies on the deferred pragma above;
-- it is restored at the end either way.
--
-- Must apply AFTER 0031 (the seeded rows this copies and the child table). No
-- seeded value changes: `free` and `pro` keep their prices, their remaining
-- NULL quotas, five seats and their fixed timestamp. Append-only otherwise —
-- `plans` is the only table this file rebuilds, and every row of it survives.

PRAGMA foreign_keys = OFF;
PRAGMA defer_foreign_keys = true;

CREATE TABLE plans_staging (
  id                       TEXT PRIMARY KEY,
  name                     TEXT NOT NULL,
  monthly_price_cents      INTEGER,
  included_members         INTEGER,
  extra_member_price_cents INTEGER,
  platform_key_limit       INTEGER,
  reviews_included         INTEGER,
  apps_per_workspace       INTEGER,
  created_at               TEXT NOT NULL
);

INSERT INTO plans_staging (
  id, name, monthly_price_cents, included_members, extra_member_price_cents,
  platform_key_limit, reviews_included, apps_per_workspace, created_at
)
SELECT
  id, name, monthly_price_cents, included_members, extra_member_price_cents,
  platform_key_limit, reviews_included, apps_per_workspace, created_at
FROM plans;

DROP TABLE plans;

CREATE TABLE plans (
  id                       TEXT PRIMARY KEY,
  name                     TEXT NOT NULL,
  monthly_price_cents      INTEGER,
  included_members         INTEGER,
  extra_member_price_cents INTEGER,
  platform_key_limit       INTEGER,
  reviews_included         INTEGER,
  apps_per_workspace       INTEGER,
  created_at               TEXT NOT NULL
);

INSERT INTO plans (
  id, name, monthly_price_cents, included_members, extra_member_price_cents,
  platform_key_limit, reviews_included, apps_per_workspace, created_at
)
SELECT
  id, name, monthly_price_cents, included_members, extra_member_price_cents,
  platform_key_limit, reviews_included, apps_per_workspace, created_at
FROM plans_staging;

DROP TABLE plans_staging;

-- The tier itself: every quota NULL, no price configured, fixed timestamp (the
-- seed convention from 0031, so the applied row is byte-identical everywhere).
INSERT INTO plans (
  id, name, monthly_price_cents, included_members, extra_member_price_cents,
  platform_key_limit, reviews_included, apps_per_workspace, created_at
)
VALUES ('unlimited', 'Unlimited', NULL, NULL, NULL, NULL, NULL, NULL, '2026-10-25T00:00:00.000Z');

PRAGMA foreign_keys = ON;
