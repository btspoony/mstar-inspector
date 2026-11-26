-- 0123_review_failures_quota_scope.sql — a quota refusal names WHICH ceiling.
--
-- `review_failures` records a refusal's stage and sentence but not which of the
-- two quota ceilings produced it. The public Check deliberately names no bot and
-- no figure, so without these columns nothing downstream can tell a plan-month
-- refusal from a per-bot one, nor name the bot that blocked the delivery — and an
-- operator debugging "why was this PR refused" has only the sentence to go on.
--
-- `quota_scope` is NULL for every non-quota stage (the columns describe a quota
-- refusal only): 'plan' for the workspace's plan month, 'bot' for one bot's own
-- month. `quota_bot_id` is set only for 'bot' — a plan refusal has no bot to name,
-- and the writer must never fall back to the App id.
--
-- Both nullable, no backfill: historical refusals predate the distinction and a
-- guessed value would be a fabricated attribution.
--
-- Must apply AFTER 0122.

ALTER TABLE review_failures ADD COLUMN quota_scope TEXT
  CHECK (quota_scope IS NULL OR quota_scope IN ('plan', 'bot'));
ALTER TABLE review_failures ADD COLUMN quota_bot_id TEXT REFERENCES review_bots(id);
