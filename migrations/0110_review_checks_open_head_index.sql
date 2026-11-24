-- 0110_review_checks_open_head_index.sql — the supersede probe's head index.
--
-- The supersede probe asks the transposed question for a DIFFERENT commit:
-- "does this head have an in-flight attempt?" (nonterminal rows only). That
-- shape has no index on the journal and runs on the admission path of every
-- superseded delivery, so it gets its own partial index — nonterminal rows
-- are a small subset by construction. `bot_id` is migration 0056's rename of
-- the 0021 `app_id` column.
CREATE INDEX IF NOT EXISTS idx_review_checks_open_head
  ON review_checks(bot_id, head_sha)
  WHERE terminal_ms IS NULL;
