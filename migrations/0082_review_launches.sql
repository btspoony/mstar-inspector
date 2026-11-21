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
-- it: `persisted` on a persisted row, `failed` on a failed row, and NULL on
-- every other state. A `launched` row therefore never carries an outcome by
-- construction, which is why it is the only `unknown` and the only state that
-- holds container and capacity. The CHECK below is written with `IS` and a
-- CASE, never with `(result_outcome = 'failed') = (state = 'failed')`: the
-- latter is three-valued and SQLite ACCEPTS a NULL outcome on a terminal row.
--
-- `abandoned` is a CLAIM, not an observation: cleanup CASes
-- `provisioned → abandoned` and destroys only when the CAS won. A losing CAS
-- means a concurrent attempt moved the row to `launched`, so the container may
-- be paying and cleanup returns `unknown` instead of destroying it.
--
-- `check_key` + `check_generation` + `check_owed_ms` record an OWED Check
-- settlement: the association is the Check row's own `attempt_key` PLUS its
-- generation (a key alone names the attempt, and an older generation's mark
-- must never match a newer row), and the instant is the obligation's own due
-- time, advanced on every failed attempt so the backoff is honoured. All three
-- are written together, only after a publication is durable and the Check has
-- not concluded, and cleared only by a conclusion.
CREATE TABLE review_launches (
  attempt_id TEXT PRIMARY KEY,
  -- The Check attempt key, FROZEN when the attempt is created (or, for a
  -- delivery that carried no head, the instant the checkout first knows one).
  -- Every later phase — publication, settlement, cleanup — READS it from this
  -- row; none re-derives it. A head supersession is a new attempt with its own
  -- key, so the association never has to reconcile a key that moved underneath.
  attempt_key TEXT,
  -- The Check generation that key belongs to, frozen at the SAME instant: a
  -- later generation is another attempt's row, so it is never looked up.
  attempt_generation INTEGER,
  state TEXT NOT NULL CHECK (state IN ('provisioned', 'launched', 'persisted', 'failed', 'abandoned')),
  claimed_at_ms INTEGER NOT NULL,
  launched_at_ms INTEGER,
  persisted_at_ms INTEGER,
  failed_at_ms INTEGER,
  abandoned_at_ms INTEGER,
  result_json TEXT,
  result_outcome TEXT CHECK (result_outcome IS NULL OR result_outcome IN ('persisted', 'failed')),
  check_key TEXT,
  check_generation INTEGER,
  check_owed_ms INTEGER,
  CHECK ((launched_at_ms IS NOT NULL) = (state IN ('launched', 'persisted', 'failed'))),
  CHECK ((abandoned_at_ms IS NOT NULL) = (state = 'abandoned')),
  CHECK ((persisted_at_ms IS NOT NULL) = (state = 'persisted')),
  CHECK ((failed_at_ms IS NOT NULL) = (state = 'failed')),
  CHECK ((result_json IS NOT NULL) = (state = 'persisted')),
  -- TOTAL: every state names the exact outcome it carries. `IS` is null-safe,
  -- so a terminal row without its outcome (or a non-terminal row WITH one)
  -- fails the insert instead of passing as NULL.
  CHECK (result_outcome IS (CASE state
    WHEN 'persisted' THEN 'persisted'
    WHEN 'failed' THEN 'failed'
    ELSE NULL
  END)),
  CHECK ((attempt_generation IS NOT NULL) = (attempt_key IS NOT NULL)),
  CHECK ((check_key IS NOT NULL) = (check_owed_ms IS NOT NULL)),
  CHECK ((check_generation IS NOT NULL) = (check_owed_ms IS NOT NULL))
);
