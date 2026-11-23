-- 0099_pull_request_retention_index.sql — index the terminal PR ledger rows
-- by last activity.
--
-- The 15-minute sweep deletes `closed` / `merged` rows whose `last_seen_at`
-- is past the retention window (sweepTerminalPullRequests). With no index on
-- either column it scans the whole ledger on every run, and in steady state
-- almost nothing is due. The partial index holds only terminal rows, so the
-- sweep seeks straight to the expired ones; its WHERE must stay identical to
-- the sweep's state predicate or SQLite will not use it.
CREATE INDEX idx_pull_requests_terminal_seen
  ON pull_requests (last_seen_at)
  WHERE state IN ('closed', 'merged');
