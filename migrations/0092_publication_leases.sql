-- The publication lease: authority to perform ONE GitHub mutation for ONE
-- attempt, kept in its own row so it expires and changes hands independently of
-- the attempt's execution lease in `review_checks`.
--
-- Why not reuse the attempt's lease columns: that lease is the EXECUTION claim
-- (PR exclusion plus capacity) and it is renewed as the attempt lives, while a
-- publication right is short, per action and taken only around a send or a
-- recovery. A single `(holder, lease_epoch, lease_until_ms)` triple cannot hold
-- both at once, and an attempt-wide slot would collapse distinct actions — a
-- Check update and a review comment are different mutations with different
-- recovery evidence — into one contender.
--
-- The key is the durable MUTATION identity, never a caller or a delivery:
-- `action_key` is `check:complete` (a Check settlement) or `comment:<id>` (a
-- staged publication upsert). `mode` records what the acquisition was for
-- (`send` or `recover`) WITHOUT being part of the key, so switching modes can
-- never bypass a live holder of the same action.
--
-- Fencing is the same epoch protocol as every other lease in this schema:
-- claim is one conditional statement that takes only a free or expired row and
-- increments `lease_epoch`; release clears holder and expiry under EXACTLY that
-- epoch and never resets it, so a holder whose lease expired cannot release a
-- newer acquisition. `holder` and `lease_until_ms` are NULL together: a row is
-- either held with a live-or-lapsed instant, or free.
CREATE TABLE publication_leases (
  -- The Check attempt this action belongs to (review_checks.id). No foreign
  -- key: a Check-only settlement can be leased before any publication journal
  -- row exists, and a terminal attempt row is retained rather than cascaded.
  attempt_id TEXT NOT NULL,
  action_key TEXT NOT NULL,
  holder TEXT,
  lease_epoch INTEGER NOT NULL DEFAULT 1,
  lease_until_ms INTEGER,
  mode TEXT CHECK (mode IS NULL OR mode IN ('send', 'recover')),
  updated_ms INTEGER NOT NULL,
  PRIMARY KEY (attempt_id, action_key),
  CHECK ((holder IS NULL) = (lease_until_ms IS NULL))
);
