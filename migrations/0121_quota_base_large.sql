-- 0121_quota_base_large.sql — the large base weights and the 1000 RP credit.
--
-- D11/D12 fix the price as `rp = ceil(base(level) × multiplier)` over a large
-- base: quick 50, standard 100, deep 300, with 1 credit = 1000 RP. A large base
-- is what makes ceiling a fractional product lose at most one RP.
--
-- This ships as a QUOTA VERSION, not a constant (Global Constraints): a
-- workspace keeps the prices its month was opened under and adopts these at
-- its next month's first metering (D13), and no historical `rp` row is
-- recomputed.
--
-- `effective_from` is the NEXT month's 1st, deliberately not this month's. The
-- base moves 25–50× while historical `rp` stays as recorded, so a mid-month
-- switch would price two reviews in the same month on two scales and make the
-- month's ceiling meaningless. Landing on a boundary means every workspace
-- crosses over at the same instant, at the moment its month rolls.
--
-- `monthly_rp` scales with the price so no allowance changes: the previous
-- ceilings are multiplied by the ratio between the old and new base for their
-- plan. The scaling factor is `rp_per_credit` of the new profile over the old
-- (1000 / 20 = 50), which is exactly the factor the base grew by.
--
-- `review_bots.multiplier` needs no DDL change: 0115 already created it as
-- `REAL NOT NULL CHECK (multiplier > 0)`, which admits 1.5. What changes is its
-- meaning — it held an integer source rate copied from the profile, and from
-- this release it is the bot's own price factor. A shared bot backfilled with
-- multiplier 10 therefore prices a deep review at `ceil(300 × 10) = 3000 RP`,
-- keeping its old ratio to the base weights.
--
-- The source of the ceilings is the profile in force when this file applies —
-- the newest one that is not this file's own row — so an operator who already
-- published a version is copied from what they published, not from a constant.
--
-- Must apply AFTER 0120 (the source-column drop): this file names no dropped
-- column, but the release order is the contract.

INSERT INTO quota_profiles (
  id, version, effective_from, base_quick, base_standard, base_deep,
  rp_per_credit, notes, created_at, created_by
)
SELECT
  'quota-v2-large-base',
  COALESCE(MAX(version), 0) + 1,
  strftime('%Y-%m-01T00:00:00.000Z', 'now', 'start of month', '+1 month'),
  50,
  100,
  300,
  1000,
  'v2: large base 50/100/300, 1 credit = 1000 RP; ceilings scaled with the price.',
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now'),
  'migration'
FROM quota_profiles
WHERE NOT EXISTS (SELECT 1 FROM quota_profiles WHERE id = 'quota-v2-large-base');

INSERT INTO quota_profile_plans (profile_id, plan_id, monthly_rp)
SELECT
  'quota-v2-large-base',
  q.plan_id,
  CASE WHEN q.monthly_rp IS NULL THEN NULL ELSE q.monthly_rp * 50 END
FROM quota_profile_plans q
WHERE q.profile_id = (
        SELECT id FROM quota_profiles
         WHERE id <> 'quota-v2-large-base'
         ORDER BY effective_from DESC, version DESC
         LIMIT 1
      )
  AND NOT EXISTS (
        SELECT 1 FROM quota_profile_plans WHERE profile_id = 'quota-v2-large-base'
      );
