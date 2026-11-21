-- Activation is a GUARDED TRANSITION that precedes every container start. The
-- first-provisioning claim (the INSERT in `claimReviewAttempt`) wins it, and
-- `reviewAttemptSandbox` will address nothing without it — so "this attempt may
-- create a container" is a fact the database grants, not one a reader infers
-- from the absence of a row at some earlier instant.
--
-- A successor's takeover claims the same state from the other side: its guarded
-- write revokes an attempt that never activated (or inserts the row, which IS
-- the claim when there is none). Winning that write is what authorises capacity
-- and the PR to move; losing it means the attempt is or was activated, and the
-- only remaining evidence is that attempt's own container answering.
ALTER TABLE review_launches ADD COLUMN activated_ms INTEGER;

-- Rows written before the column existed won the first-provisioning claim, so
-- they were activated. This is the CONSERVATIVE direction: an old row keeps
-- holding its capacity slot until a successor observes and revokes it, rather
-- than becoming free on a claim nobody can verify.
UPDATE review_launches SET activated_ms = claimed_at_ms;
