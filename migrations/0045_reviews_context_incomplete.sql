-- 0045_reviews_context_incomplete.sql — whether a published round scanned the
-- scope it claims to have reviewed.
--
-- `verdict <> 'incomplete'` was the only base filter for an incremental round.
-- A round that could not fully scan its scope still publishes and still writes
-- its `reviews` row: the diff capture was empty / unreadable / over the byte
-- bound, an increment diff came back empty, or the lifecycle-target or
-- discussion capture failed. The next round would diff against it and silently
-- inherit scope that was never scanned. The fact belongs on the row:
-- `context_incomplete = 1` makes the round a non-base for
-- `findIncrementBase`.
--
-- `NOT NULL DEFAULT 0` keeps every existing row a usable base (they were
-- captured under the pre-column rules) and lets a put that does not carry the
-- flag bind `false` without a second branch. Append-only on the production DB:
-- one `ALTER TABLE ... ADD COLUMN` on the table 0001 created, no data rewrite.
-- Forward-only (SQLite has no down).

ALTER TABLE reviews ADD COLUMN context_incomplete INTEGER NOT NULL DEFAULT 0;
