-- The settlement's IN-PROGRESS marker, written when the Workflow's settlement
-- step starts and cleared only by its completion mark (settled_ms). It is what
-- the route's recovery pass selects on: a settlement that started and never
-- completed is exactly the row nobody else can finish — the workflow step's
-- retry covers a transient fault within the step, and the resumed instance
-- covers a host death while the instance is still alive, but a settlement that
-- outlived both needs the durable lane. Without this marker, "settled_ms IS
-- NULL" cannot tell a live attempt from an abandoned settlement.
ALTER TABLE review_attempt_handoffs ADD COLUMN settling_ms INTEGER;
