-- 0087_terminal_failure_status.sql — the approved category of a terminal
-- review failure, frozen with the attempt's terminal intent (spec
-- review-lifecycle §7.9 "Desired versus observed").
--
-- compass D9 fixes the set: `paused`, `unknown-failure`, `budget-stop`,
-- `cap-stop`. The category SELECTS the approved user-facing wording, so the
-- carrier of the text stays the one frozen summary (`desired_summary`) and no
-- error string is ever interpolated into it. `cap-stop` is its own category:
-- the operator's end-to-end cap is a platform decision, never a generic fault
-- and never the tier's time budget (`budget-stop`).
--
-- NULL is the honest answer for every other terminal shape — a verdict that
-- missed the gate, a success, a neutral skip, or an attempt that already ended
-- without one — and for a WAITING attempt: a row still wanting `in_progress`
-- carries no failure category, because a failure is not a pending state.
ALTER TABLE review_checks ADD COLUMN terminal_failure_status TEXT
  CHECK (terminal_failure_status IS NULL
         OR terminal_failure_status IN ('paused', 'unknown-failure', 'budget-stop', 'cap-stop'));
