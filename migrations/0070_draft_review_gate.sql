-- 0070_draft_review_gate.sql — a repository chooses whether a DRAFT pull
-- request is reviewed.
--
-- Today every whitelisted delivery is reviewed, a draft included. This column
-- is the per-repository switch a user flips to hold a draft until its author
-- marks it ready; `ready_for_review` then admits the review once.
--
-- It is a TARGET-OWNED admission fact, the same kind of fact as the business
-- pause (`review_enabled`, 0057): a repository that follows the workspace
-- defaults still owns it, so there is no workspace column to inherit from and
-- flipping `follow_workspace_defaults` never rewrites it (D12). The effective
-- settings reader answers it from the row in BOTH inheritance branches.
--
-- `DEFAULT 1` keeps the current behaviour for every existing row and for a
-- target the create path inserts without naming the column: metadata-only
-- ADD COLUMN, no data movement, no backfill. Forward-only.
ALTER TABLE review_targets ADD COLUMN review_drafts INTEGER NOT NULL DEFAULT 1
  CHECK (review_drafts IN (0, 1));
