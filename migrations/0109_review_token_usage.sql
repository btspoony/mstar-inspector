-- 0108_review_token_usage.sql — every completed review execution's REAL token
-- spend, one row per (attempt_id, provider, model), attributable to the
-- target that paid for it.
--
-- The primary key IS the idempotency key: a replayed write of the same attempt
-- replaces its own rows and cannot double-count. `target_id`/`workspace_id`
-- are denormalized on purpose — the billing aggregate must not join `reviews`,
-- which a failed or never-published attempt never creates.
CREATE TABLE review_token_usage (
  attempt_id        TEXT NOT NULL,
  provider          TEXT NOT NULL,
  model             TEXT NOT NULL,
  target_id         TEXT NOT NULL,
  workspace_id      TEXT NOT NULL,
  input_tokens      INTEGER NOT NULL,
  output_tokens     INTEGER NOT NULL,
  cache_read_tokens INTEGER NOT NULL,
  cache_write_tokens INTEGER NOT NULL,
  total_tokens      INTEGER NOT NULL,
  requests          INTEGER NOT NULL,
  cost_usd          REAL NOT NULL DEFAULT 0,
  occurred_at       TEXT NOT NULL,
  PRIMARY KEY (attempt_id, provider, model)
);

-- The target aggregate's window scan ("how many tokens did target T spend").
CREATE INDEX idx_review_token_usage_target ON review_token_usage(target_id, occurred_at);
