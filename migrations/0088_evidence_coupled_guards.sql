-- The two durable records spec §7.9a's remaining conditions need:
--
-- 1. A line batch's DISPATCH INTENT. The applied publication's journal claim is
--    cleared by apply, so the batch takes a claim of its own — and that claim
--    alone is not proof it was never sent: a lease lapses, a capture write
--    fails, and the same pending rows would look eligible again. Recording the
--    intent inside the SAME conditional transition as the claim makes "took the
--    send right" durable for the batch's lifetime: after it, only read-only
--    discovery may touch the work. A definitive pre-send refusal clears it
--    (nothing left the Worker), which is the one case that may retry.
ALTER TABLE review_publications ADD COLUMN line_dispatch_ms INTEGER;

-- 2. Writer exclusion for ONE degraded target comment. A cleanup may delete a
--    stale degraded marker only when no newer degraded publication can reuse
--    that exact comment; the publishers and the delete therefore contend on the
--    same row. Keyed by the authenticated scope plus the App-owned comment id,
--    with the same epoch/holder protocol as every other lease.
CREATE TABLE degraded_target_leases (
  target_key TEXT PRIMARY KEY,
  holder TEXT,
  lease_epoch INTEGER NOT NULL DEFAULT 0,
  lease_until_ms INTEGER,
  updated_ms INTEGER NOT NULL,
  CHECK ((holder IS NULL) = (lease_until_ms IS NULL))
);
