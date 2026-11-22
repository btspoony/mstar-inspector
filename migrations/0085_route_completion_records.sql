-- Two records that must say what actually happened, not that something was
-- attempted.
--
-- `review_attempt_handoffs.settled_effects` — the settlement's COMPLETION
-- record: a JSON array of the effects that landed (the failure row, the Check
-- conclusion, the failed-claim stamp). `settled_ms` is written only when the
-- required set for that settlement is complete, so a mark can never certify an
-- effect that is missing; the effects array is what a replay (and an operator)
-- reads to see what is still owed. A settlement that has no handoff row (a
-- direct phase caller) writes nothing, as before.
--
-- `review_successors.generation` — bumped on every re-arm of an owed row. A
-- sender that read the row before a re-arm carries the OLD generation and must
-- not deliver over the new one: the pre-send check refuses it and the delivered
-- mark (itself generation-scoped) can never bury a fresher obligation.
ALTER TABLE review_attempt_handoffs ADD COLUMN settled_effects TEXT;

ALTER TABLE review_successors ADD COLUMN generation INTEGER NOT NULL DEFAULT 0;
