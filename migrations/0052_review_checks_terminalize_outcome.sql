-- 0052_review_checks_terminalize_outcome.sql — why a Check attempt reached its
-- conclusion, recorded on the attempt itself.
--
-- A Check that only terminalized at the 900 s execution deadline left no trace
-- of WHY the consumer did not close it: the terminalize hook's three exits
-- (frozen intent, budget exceeded, hook threw) and the "no handle to
-- terminalize" case all reported through `log.warn` only, and Workers Logs is
-- not queryable after the fact. Recovery then closed the row and overwrote the
-- only evidence. These columns are written by the invocation that owns the
-- attempt, so one query separates "the consumer never ran the hook" from "the
-- hook ran and timed out".
--
-- The reconciler lane writes nothing here: `terminalize_outcome IS NULL` on a
-- terminal row IS the record that recovery closed it, and `holder` already
-- names `check-reconcile`. `terminalize_elapsed_ms` is how long the consumer
-- waited on its hook — distinct from `terminal_ms`, the row's own terminal
-- timestamp, and from the `review.check.terminalize_timeout_ms` budget.
ALTER TABLE review_checks ADD COLUMN terminalize_outcome TEXT
  CHECK (terminalize_outcome IS NULL
         OR terminalize_outcome IN ('completed', 'budget-exceeded', 'hook-failed', 'no-handle'));
ALTER TABLE review_checks ADD COLUMN terminalize_elapsed_ms INTEGER;
