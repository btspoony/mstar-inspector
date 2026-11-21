-- One row per review attempt: the only authority to provision its container,
-- the one fence in front of the paid step, and the record that the paid step's
-- result is durable.
--
-- `attempt_id` is the PRIMARY KEY, so the database — not a caller — refuses a
-- second row for the same attempt. The row's creation is the first-provisioning
-- claim: only the caller whose INSERT created it may start a container for this
-- attempt, so a replayed prepare cannot stamp a replacement as the original.
--
-- `state` walks forward only, and its MEANING is the whole retention contract
-- (plan Task 4b): `provisioned` = a container may be allocated but the paid
-- exec was NEVER sent; `launched` = the paid exec was sent and may have been
-- charged; `persisted` = a result is on the row; `failed` = the paid call
-- returned a nonzero status. The claim statements are conditional on the state
-- they leave, so a statement that would take the paid step twice matches zero
-- rows. `launched` is written in the same statement that is about to send the
-- exec — never earlier — so a failure while minting or writing input leaves the
-- row `provisioned`, which cleanup may still release.
--
-- The CHECKs couple each state to the facts that make it true: a `launched`
-- row carries its instant, `persisted` carries the instant AND the result,
-- `failed` carries its instant and the failed outcome.
--
-- `result_outcome` records the terminal outcome where the state machine permits
-- it: `persisted` on a persisted row, `failed` on a failed row. A `launched`
-- row with an outcome is the plan's "may destroy" case; a `launched` row
-- WITHOUT one is the only `unknown`, and only it holds container and capacity.
--
-- `check_key` + `check_owed_ms` record an OWED Check settlement: the key is the
-- Check row's own `attempt_key` (the association is that derived identity, not
-- two random UUIDs), and the instant is the obligation's own due time, so the
-- recovery select honours the backoff instead of bypassing it. Both are written
-- together, only after a publication is durable and the Check has not
-- concluded, and cleared only by the conclusion.
CREATE TABLE review_launches (
  attempt_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('provisioned', 'launched', 'persisted', 'failed')),
  claimed_at_ms INTEGER NOT NULL,
  launched_at_ms INTEGER,
  persisted_at_ms INTEGER,
  failed_at_ms INTEGER,
  result_json TEXT,
  result_outcome TEXT CHECK (result_outcome IS NULL OR result_outcome IN ('persisted', 'failed')),
  check_key TEXT,
  check_owed_ms INTEGER,
  CHECK ((launched_at_ms IS NOT NULL) = (state <> 'provisioned')),
  CHECK ((persisted_at_ms IS NOT NULL) = (state = 'persisted')),
  CHECK ((failed_at_ms IS NOT NULL) = (state = 'failed')),
  CHECK ((result_json IS NOT NULL) = (state = 'persisted')),
  CHECK ((result_outcome = 'persisted') = (state = 'persisted')),
  CHECK ((result_outcome = 'failed') = (state = 'failed')),
  CHECK ((check_key IS NOT NULL) = (check_owed_ms IS NOT NULL))
);
