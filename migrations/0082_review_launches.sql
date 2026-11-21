-- One row per review attempt: the only authority to provision its container,
-- the one fence in front of the paid step, and the record that the paid step's
-- result is durable.
--
-- `attempt_id` is the PRIMARY KEY, so the database — not a caller — refuses a
-- second row for the same attempt. The row's creation is the first-provisioning
-- claim: only the caller whose INSERT created it may start a container for this
-- attempt, so a replayed prepare cannot stamp a replacement as the original.
--
-- `state` walks forward only. The claim statements are conditional on the state
-- they leave (`pending` → `launched`, `launched` → `persisted`), so a statement
-- that would take the paid step or record completion twice matches zero rows.
-- The CHECKs couple each state to the facts that make it true: a row claiming a
-- launch carries its instant, and a `persisted` row carries the instant AND the
-- result itself — completion and result durability are one statement, so no
-- completion can be recorded without the result.
CREATE TABLE review_launches (
  attempt_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('pending', 'launched', 'persisted')),
  claimed_at_ms INTEGER NOT NULL,
  launched_at_ms INTEGER,
  persisted_at_ms INTEGER,
  result_json TEXT,
  CHECK ((launched_at_ms IS NOT NULL) = (state <> 'pending')),
  CHECK ((persisted_at_ms IS NOT NULL) = (state = 'persisted')),
  CHECK ((result_json IS NOT NULL) = (state = 'persisted'))
);
