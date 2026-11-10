-- 0052_review_checks_terminalize_outcome.sql — why a Check attempt reached its
-- conclusion, recorded on the attempt itself.
--
-- A Check that only terminalized at the 900 s execution deadline left no trace
-- of WHY the consumer did not close it: the terminalize hook's three exits
-- (frozen intent, budget exceeded, hook threw) and the "no handle to
-- terminalize" case all reported through `log.warn` only, and Workers Logs is
-- not queryable after the fact. Recovery then closed the row and overwrote the
-- only evidence. These columns are written by the invocation that owns the
-- attempt (consumer lane) or by the reconciler that took it over, so one query
-- separates "the consumer never ran the hook" from "the hook ran and timed
-- out".
--
-- Values: 'completed' | 'budget-exceeded' | 'hook-failed' | 'no-handle' |
-- 'recovery'. NULL on rows written before this column.
ALTER TABLE review_checks ADD COLUMN terminalize_outcome TEXT;
ALTER TABLE review_checks ADD COLUMN terminalize_ms INTEGER;
