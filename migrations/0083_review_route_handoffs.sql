-- The two durable handoffs of the review route. Both exist because a
-- transition between "admitted" and "running" must be a RECORD before it is an
-- effect: a JavaScript handoff that can vanish is not a handoff.
--
-- `review_attempt_handoffs` is the admission's handoff record. One row per
-- DELIVERY (the delivery key is the stable identity of the queue message, so a
-- redelivery finds the same row), written BEFORE the Workflow instance is
-- created. `attempt_id` is UNIQUE: a delivery can only ever own one attempt, so
-- a redelivery replays the same attempt id instead of minting a new one that
-- could pay twice. `state` walks the create lifecycle:
--   owed      — a handoff was written, the create is not confirmed yet
--   ambiguous — the create reply was lost: the instance MAY exist; a recovery
--               pass re-enqueues the payload so admission re-tries create
--   created   — the instance is confirmed (created now, or already existing)
--   failed    — a DEFINITE create rejection: the attempt is settled as a failure
--               and the row stays for the next delivery to replay the same id
-- `settled_ms` is the settle-once mark the Workflow's settlement step takes
-- after it completes, so a re-executed settlement step does not settle twice.
--
-- `review_successors` is the moved head's outbox. A settled-as-skipped attempt
-- records the observed head here BEFORE anything is sent; the delivery pass
-- (immediate attempt, then the reconciler) sends it to the queue. The dedupe
-- key is the observed head's identity, so one moved head can never produce two
-- successor admissions. `delivered_ms` is set only after the queue accepted the
-- message; a lost send stays `owed` and is retried by the next pass.
CREATE TABLE review_attempt_handoffs (
  delivery_key TEXT PRIMARY KEY,
  attempt_id TEXT NOT NULL UNIQUE,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('owed', 'ambiguous', 'created', 'failed')),
  settled_ms INTEGER,
  created_ms INTEGER NOT NULL,
  updated_ms INTEGER NOT NULL
);

CREATE INDEX idx_review_attempt_handoffs_recovery
  ON review_attempt_handoffs (state, updated_ms);

CREATE TABLE review_successors (
  dedupe_key TEXT PRIMARY KEY,
  payload_json TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('owed', 'delivered')),
  created_ms INTEGER NOT NULL,
  delivered_ms INTEGER,
  CHECK ((delivered_ms IS NOT NULL) = (state = 'delivered'))
);

CREATE INDEX idx_review_successors_owed
  ON review_successors (state, created_ms);
