-- 0049_reviews_duration_ms.sql — how long one review round's run took.
--
-- The detail face shows each published round's run time beside its round
-- ordinal. The consumer measures it from `roundStartedAt` (the instant the
-- review message started processing) to the moment the round's artifact is
-- staged, and binds `Date.now() - roundStartedAt` here.
--
-- Nullable on purpose: every row written before this migration has no measured
-- value, and backfilling a plausible-looking duration from timestamps would
-- fabricate a fact. The UI omits the time when the column is NULL. Append-only
-- on the production DB: one `ALTER TABLE ... ADD COLUMN` on the table 0001
-- created, no data rewrite. Forward-only (SQLite has no down).

ALTER TABLE reviews ADD COLUMN duration_ms INTEGER;
