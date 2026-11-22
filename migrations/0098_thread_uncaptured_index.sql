-- 0098_thread_uncaptured_index.sql — index the threads whose line comment is
-- not captured yet.
--
-- `review_threads` and `review_publications` keep their whole history, while
-- only a thread whose line comment was never captured has `review_id IS NULL`.
-- The 15-minute lifecycle reconcile's line lane selects the applied
-- publications that still own such a thread; without this index it walks every
-- applied publication and probes its threads one by one. The partial index
-- holds only the uncaptured threads, and carries `review_id` so the probe is
-- covering and preferred over a full-history index without ANALYZE stats.
CREATE INDEX idx_thread_uncaptured
  ON review_threads (publication_id, review_id)
  WHERE review_id IS NULL;
