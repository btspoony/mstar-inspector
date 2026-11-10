-- 0052_review_checks_terminalize_outcome.sql — why a Check attempt reached its
-- conclusion, recorded on the attempt itself.
--
-- A Check that only terminalized at the 900 s execution deadline left no trace
-- of WHY the consumer did not close it: the terminalize hook's exits (frozen
-- intent, fence refused, budget exceeded, hook threw) and the "no handle to
-- terminalize" case all reported through `log.warn` only, and Workers Logs is
-- not queryable after the fact. Recovery then closed the row and overwrote the
-- only evidence.
--
-- `completed` means the hook actually finished a terminal send — the writer
-- derives it from `observed = desired`, not from "the promise resolved": a hook
-- that freezes nothing (fence refused) or hands the attempt to recovery
-- resolves just as normally, and those rows record `handed-off` instead. The
-- reconciler lane writes nothing here at all.
--
-- `terminalize_elapsed_ms` is how long the consumer waited on its hook —
-- distinct from `terminal_ms`, the row's own terminal timestamp, and from the
-- `review.check.terminalize_timeout_ms` budget of the same name.
ALTER TABLE review_checks ADD COLUMN terminalize_outcome TEXT
  CHECK (terminalize_outcome IS NULL
         OR terminalize_outcome IN ('completed', 'handed-off', 'budget-exceeded',
                                    'hook-failed', 'no-handle'));
ALTER TABLE review_checks ADD COLUMN terminalize_elapsed_ms INTEGER;
