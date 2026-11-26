-- 0117_usage_events_bot_id.sql — every new usage row names its executing bot.
--
-- The usage ledger recorded which workspace paid and which source paid, but
-- never WHICH review bot executed. Per-bot quota and per-bot spend need the
-- attribution on the row itself: it cannot be derived later for a comment-
-- triggered job, whose usage id says `no-sha` while its review id says the
-- resolved head. The column is nullable BY DESIGN and this file writes no
-- backfill: historical rows stay NULL, and quota-relay-repair Task 4 owns the
-- one backfill and its operator report, so there is exactly one owner of the
-- historical rows and no block is forced non-NULL. Metering writes the column
-- from `botRef.botId` in the same release the column ships (D39), so no row
-- written afterwards is NULL.
--
-- Forward-only and re-runnable in neither direction, like every ALTER ADD in
-- migrations/: apply-once. Must apply AFTER 0116 (the last schema change to
-- the split family).

ALTER TABLE usage_events ADD COLUMN bot_id TEXT REFERENCES review_bots(id);
