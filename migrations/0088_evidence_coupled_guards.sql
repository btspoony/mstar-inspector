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

-- Rows that already existed when the column was added had no intent RECORDED,
-- but their batch may have been sent: the value is UNKNOWN, never "not sent".
-- The sentinel makes them permanently discovery-only — no conditional claim can
-- match them, so neither lane can send them after the migration.
UPDATE review_publications SET line_dispatch_ms = -1;

-- 2. Writer exclusion for ONE degraded target comment. A cleanup may delete a
--    stale degraded marker only when no newer degraded publication can reuse
--    that exact comment; the publishers (staging AND recovery send) and the
--    delete therefore contend on the same row. `unresolved_ms` records a delete
--    whose outcome is unknown: while it is set, no writer may reuse the target
--    and no new delete may start until a fresh complete observation proves
--    what happened. The row is keyed by the authenticated scope plus the
--    App-owned comment id, with the same epoch/holder protocol as every other
--    lease.
CREATE TABLE degraded_target_leases (
  bot_id TEXT NOT NULL,
  installation_id INTEGER NOT NULL,
  owner TEXT NOT NULL,
  repo TEXT NOT NULL,
  pr_number INTEGER NOT NULL,
  comment_id INTEGER NOT NULL,
  holder TEXT,
  lease_epoch INTEGER NOT NULL DEFAULT 0,
  lease_until_ms INTEGER,
  unresolved_ms INTEGER,
  updated_ms INTEGER NOT NULL,
  PRIMARY KEY (bot_id, installation_id, owner, repo, pr_number, comment_id),
  CHECK ((holder IS NULL) = (lease_until_ms IS NULL))
);
