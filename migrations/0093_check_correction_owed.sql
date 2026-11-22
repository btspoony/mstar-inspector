-- A §7.9a correction that a deferred pass never sent (spec §7.9a).
--
-- `reopenTerminalCorrection` once consumed the terminal mark and its proof link
-- in the same statement, so a correction the request budget deferred before
-- dispatch left nothing behind: the next pass had no correction to carry and
-- the reconciler refused the failure GitHub still showed. These two columns are
-- the DURABLE half of a reopened correction, written by the same statement that
-- reopens the row:
--
--   correction_desired    — the conclusion the owed correction must deliver,
--                          decided from the row's own confirmed publication.
--   correction_generation — the row generation it targets. A generation that
--                          has moved makes the obligation stale: nothing is
--                          sent and the stale conclusion is not resurrected.
--
-- Cleared only by the fenced write that records a validated terminal response
-- (the same statement that resolves a successful send), or by the pass that
-- finds the obligation can no longer apply. NULL on both means no correction is
-- owed, which is every row outside a deferred §7.9a revision.
ALTER TABLE review_checks ADD COLUMN correction_desired TEXT
  CHECK (correction_desired IS NULL OR correction_desired IN ('success','neutral','failure'));

ALTER TABLE review_checks ADD COLUMN correction_generation INTEGER
  CHECK ((correction_desired IS NULL) = (correction_generation IS NULL));

-- Whether the owed revision may already have been DISPATCHED. Set by the same
-- terminal-dispatch write that records a send while a debt exists, cleared by a
-- refusal proven pre-send or when the debt settles. The distinction is what
-- lets an undispatched revision be re-decided in place (the authorization to
-- replace the original failure survives a changed conclusion) while a possibly
-- sent one can only be read back: rewriting it could double a request GitHub
-- already received.
ALTER TABLE review_checks ADD COLUMN correction_dispatched_ms INTEGER;
