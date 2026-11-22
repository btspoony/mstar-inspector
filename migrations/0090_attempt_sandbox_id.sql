-- The provisioning row becomes the PRECONDITION of every container handle, not
-- its side effect (spec §7.9: capacity and PR ownership move only on evidence).
--
-- The insert in `claimReviewAttempt` is the one writer that mints this id, and
-- `reviewAttemptSandbox` is the one reader any caller may use to obtain a
-- handle. So "no row" means "no container" by construction: no code path can
-- start a container for an attempt the database has not heard of, and the id a
-- reader uses is the one the claim committed — never a derivation that could
-- disagree with the row a recovery will read.
ALTER TABLE review_launches ADD COLUMN sandbox_id TEXT;

-- Rows written before the column existed were minted by the same derivation, so
-- the backfill restores exactly what their claim would have written.
UPDATE review_launches SET sandbox_id = 'review-' || lower(attempt_id) WHERE sandbox_id IS NULL;
