-- Rotation cursor for the suspended-Check re-enable scan: each pass resumes
-- after the last (installation_id, bot_id) pair the previous pass scanned, so
-- pairs that stay suspended cannot pin the bounded batch. No foreign keys:
-- deleting the cursor's App must not reset the rotation.
CREATE TABLE check_reenable_cursor (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  installation_id INTEGER NOT NULL,
  bot_id TEXT NOT NULL
);
