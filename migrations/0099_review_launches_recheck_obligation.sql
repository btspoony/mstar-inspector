-- The refused round's accounting as DURABLE STATE with a named owner (I-000686).
--
-- A refusal that accounted a recheck round owes two effects: the round's
-- `recheck` shipped-failure row and its attribution line. Collect performs them,
-- and this table is what makes them recoverable when it cannot:
--
-- * `review_recheck_duties` — one row per attempt+round while the accounting is
--   owed. It carries everything a replay needs to finish the round without the
--   dead host's memory: the head, the (already sanitized) shipped-failure detail
--   and the seat's outcome. Written BEFORE any effect, cleared only once both
--   effects are durable, so a settlement rule reading it can never discharge an
--   incomplete ledger — neither the live one nor the scheduled recovery pass.
-- * `review_refusal_pending` — the REFUSAL INTENT itself, written at the gate
--   refusal's entry BEFORE any accounting effect. A refusal whose duty insert
--   never committed is then still distinguishable from an ordinary failure, and
--   the settlement rule can require its effects instead of treating it as
--   nothing owed.
-- * `review_recheck_attributions` — the attribution LINE's own fact. The line is
--   emitted at-least-once (a crash between the log call and this insert may
--   deliver it twice, which the sink accepts); its EXISTENCE is the correctness
--   evidence that the round was accounted to the log.
CREATE TABLE review_recheck_duties (
  attempt_id TEXT PRIMARY KEY,
  head_sha TEXT NOT NULL,
  -- The sanitized `recheck` shipped-failure detail; NULL = the round owes no row
  -- (it sent nothing, or the runner cancelled it by design).
  failure_error TEXT,
  -- The seat's own outcome (`ok` | `failed` | `absent` | `skipped`), for the
  -- attribution line a recovery replay emits.
  outcome TEXT NOT NULL,
  created_ms INTEGER NOT NULL
);

CREATE TABLE review_recheck_attributions (
  attempt_id TEXT PRIMARY KEY,
  created_ms INTEGER NOT NULL
);

CREATE TABLE review_refusal_pending (
  attempt_id TEXT PRIMARY KEY,
  created_ms INTEGER NOT NULL
);
