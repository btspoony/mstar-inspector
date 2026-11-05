-- 0048: durable per-comment trigger claim (plan T1).
--
-- One row per GitHub `issue_comment` id. The worker inserts it ('queued')
-- BEFORE the queue send, so the primary key — not a KV get-then-put — is what
-- proves "one comment id triggers at most one review". The pipeline then
-- flips it to 'consumed' atomically before any expensive step, which turns
-- at-least-once queue delivery into at-most-once execution: a redelivery, an
-- outbox re-send, or a delivery after the 24h KV claim expired all find a
-- non-'queued' row and ack without running.
--
-- `state`:
--   'queued'   — inserted, the send may or may not have happened; the outbox
--                re-sends rows older than the retry window.
--   'consumed' — the pipeline claimed it; never re-executed, even on failure
--                (a failed comment-triggered review is re-run by posting a new
--                comment, i.e. a new id).
--   'expired'  — the outbox hit its attempt cap; the comment is abandoned.
--
-- `payload_json` is the exact job payload the outbox re-sends — required while
-- the row is 'queued' and cleared to NULL at the terminal transition, so a
-- tombstone holds only scope keys, state and timestamps. `attempts` counts
-- outbox attempts, `created_ms` is the claim instant and `queued_ms` the last
-- send attempt (both epoch milliseconds — integer columns compare and order
-- without string parsing).
--
-- Terminal rows are NEVER deleted: the row is the dedup proof, so deleting a
-- 'consumed'/'expired' tombstone would let a late redelivery of the same
-- comment re-insert and execute. The table is bounded by the number of
-- bot-mention comments, one row each.
CREATE TABLE IF NOT EXISTS comment_trigger_claims (
  installation_id INTEGER NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  comment_id INTEGER NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('queued', 'consumed', 'expired')),
  payload_json TEXT,
  attempts INTEGER NOT NULL DEFAULT 0,
  created_ms INTEGER NOT NULL,
  queued_ms INTEGER NOT NULL,
  consumed_ms INTEGER,
  PRIMARY KEY (installation_id, owner, repo, pr_number, comment_id)
);

-- The outbox scan: `WHERE state = ? AND queued_ms <= ?` (oldest first).
CREATE INDEX IF NOT EXISTS idx_comment_claim_outbox ON comment_trigger_claims(state, queued_ms);
