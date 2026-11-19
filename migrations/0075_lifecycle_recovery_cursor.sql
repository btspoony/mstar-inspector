-- The suspended-pair scan must progress even when every selected pair stays
-- unavailable. No foreign keys: deleting the cursor's App must not reset it.
CREATE TABLE lifecycle_recovery_cursor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  bot_id TEXT NOT NULL,
  installation_id INTEGER NOT NULL
);
