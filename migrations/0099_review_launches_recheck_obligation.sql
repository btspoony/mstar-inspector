-- The refused round's obligation (I-000686). A refusal that shipped a recheck
-- round owes that round's `recheck` failure row, and the settlement must not be
-- stamped settled while the row is missing — even when the outer Workflow catches
-- the collect failure and settles the rest.
--
-- `recheck_owed_ms`    set while the row is owed; cleared once it is durable.
--                      The settlement rule adds "recheck-row" to the attempt's
--                      obligations while it is set (live settlement AND recovery
--                      read the same marker).
-- `recheck_attributed_ms`
--                      the round's attribution LINE was emitted. A committed row
--                      is not a delivered log line (D1 can lose the reply, or the
--                      host can die between the insert and the log), so the line
--                      is deduplicated by its own fact, not by the insert's
--                      change count.
--
-- Both are nullable and per attempt: one attempt accounts exactly one round.
ALTER TABLE review_launches ADD COLUMN recheck_owed_ms INTEGER;
ALTER TABLE review_launches ADD COLUMN recheck_attributed_ms INTEGER;
