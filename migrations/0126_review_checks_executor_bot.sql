-- 0126_review_checks_executor_bot.sql — a completed Check names the Bot that ran it.
--
-- A rerun of the same head can execute under a different Review Bot (a different
-- model chain, a different sandbox image) and the Check summary is the only
-- surface every review produces. The foreground settlement knows its Bot from the
-- job payload, but the recovery lane's own first freeze and proof correction run
-- with no payload — so the executing Bot's id is persisted on the row instead.
--
-- `begin` is the one writer: once it holds the lease, it records the id with
-- `AND executor_bot_id IS NULL`, so a later invocation can never reassign an
-- attempt to a different Bot. Nullable and unindexed: the column is read by
-- primary key, and a row written before this migration names the Bot as its id
-- (or "unknown" when there is no id either).
--
-- Must apply AFTER 0125.

ALTER TABLE review_checks ADD COLUMN executor_bot_id TEXT REFERENCES review_bots(id);
