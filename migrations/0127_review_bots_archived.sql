-- 0127_review_bots_archived.sql — a Review Bot can be archived: kept, not run.
--
-- Archive is a product state, not a delete. The row, its chains and its usage
-- history stay where they are, the relay stops selecting the bot, and its owner
-- may restore it by clearing this column. `archived_at IS NULL` therefore means
-- LIVE, which is what every row written before this migration reads — so no
-- backfill runs and a rollback leaves the data valid.
--
-- Additive and unindexed: the relay's chain join tests the column on rows it
-- already walks by primary key, and no surface looks a bot up by archive state.
--
-- Apply-once, like every ALTER ADD in migrations/ (0117): D1's ledger applies a
-- file at most once, and a second apply aborts on the existing column instead of
-- adding a second one or touching a row.
--
-- Must apply AFTER 0126.

ALTER TABLE review_bots ADD COLUMN archived_at TEXT;
