-- 0061_plan_shared_bot_allowed.sql — the shared-bot capability on the plan catalogue.
--
-- Attaching a review target to a bot the platform shares is a plan
-- capability, not a per-workspace setting: one boolean column on `plans`
-- answers it, and `src/dashboard/entitlement.ts#assertSharedBotAllowed` is the
-- one function that reads it. Two surfaces consult that function — creating a
-- target on a shared bot, and enqueueing a review for one — so nothing else
-- may spell the rule again.
--
-- Boolean, deliberately: this tier carries no counts and no numeric cap, and
-- NULL is NOT another spelling of "unlimited" here — the column is NOT NULL, so
-- a plan either includes the shared bot or it does not.
--
-- The default is 0, which keeps every plan added later closed until someone
-- says otherwise.
--
-- Order matters: apply this migration BEFORE deploying the Worker that reads
-- the column — the normal `wrangler d1 migrations apply` → deploy order. A
-- Worker that lands first reads a column that does not exist yet and
-- `resolveWorkspacePlans` throws on every call: fail-closed, but a 500 on the
-- webhook and dashboard faces rather than the refusal this gate is for. There
-- is no dual-read window to preserve; the migration is the first step.
--
-- The seed is the capability table, in one place: `pro` and `unlimited`
-- include the shared bot; the seeded `free` row stays at the default. A
-- catalogue-only change — no subscription row is rewritten, so moving a
-- workspace between plans changes the answer on its next attempt, with no
-- restart and no backfill.
--
-- Must apply AFTER 0032 (the seeded `unlimited` row this seeds). Append-only
-- on the production DB: one column, three existing rows.

ALTER TABLE plans ADD COLUMN shared_bot_allowed INTEGER NOT NULL DEFAULT 0;

UPDATE plans SET shared_bot_allowed = 1 WHERE id IN ('pro', 'unlimited');
