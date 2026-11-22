-- The attempt's QUEUE WAIT origin: the original Queue send stamp, copied onto
-- the delivery's handoff row when admission records it.
--
-- `created_ms` is the admission instant, so queue wait is exactly
-- `created_ms - enqueued_ms` and no caller has to infer it from a later stamp.
-- The queue stamp is NOT recoverable after the fact: a redelivery carries its
-- own timestamp, and `deadline_ms - cap` re-derives the send only if the
-- operator's cap has not changed since admission. Backfilling `created_ms`
-- would report a zero-length queue wait that was never measured, so rows
-- written before this column keep NULL and the operator report counts them as
-- a missing boundary instead of a zero.
--
-- Append-only on the production DB: one nullable column, no rewrite.
ALTER TABLE review_attempt_handoffs ADD COLUMN enqueued_ms INTEGER;

-- The duration report's only predicate is the admission window
-- (`h.created_ms >= ?1 AND h.created_ms < ?2`). The recovery index on
-- (state, updated_ms) cannot bound that range, so without this index the
-- report scans every handoff ever written instead of the window.
CREATE INDEX idx_review_attempt_handoffs_created
  ON review_attempt_handoffs (created_ms);
