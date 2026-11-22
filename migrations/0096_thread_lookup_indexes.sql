-- 0096_thread_lookup_indexes.sql — index review_threads by finding and by publication.
--
-- `review_threads` keeps one row per posted line comment and is never pruned,
-- but its only indexes were the recovery queue and the PR scope. Every review
-- round reads it by finding (`finding_row_id IN (...)` with
-- `superseded_by_publication_id IS NULL`: recheck target association, thread
-- binding, discussion capture, and the per-intent supersede write) and by
-- publication (line-batch state, dispatch intent, discovery bound); each of
-- those scanned the whole table.
--
-- The finding index is partial: every finding read targets live associations,
-- and superseded rows, which accumulate with each re-post, stay out of it.
CREATE INDEX idx_thread_live_finding
  ON review_threads (finding_row_id)
  WHERE superseded_by_publication_id IS NULL;

CREATE INDEX idx_thread_publication
  ON review_threads (publication_id, review_id);
