-- 0097_publication_attempt_identity_index.sql — index the attempt that staged a
-- publication journal row.
--
-- The route recovery pass asks, per persisted-but-unpublished candidate, whether
-- THIS attempt already staged a body — head-independent, because a headless
-- delivery resolves its own checkout head. The journal's identity lives inside
-- `payload_json` (`admittedAttemptId`, else `attemptId`), so without an
-- expression index that probe scans the whole retained publication history,
-- including other tenants. The index is scope-prefixed with the same
-- (bot_id, installation_id, owner, repo, pr_number) columns the probe
-- constrains, so an unrelated tenant's rows never leave the B-tree.
CREATE INDEX idx_review_publications_attempt_identity
  ON review_publications (
    bot_id,
    installation_id,
    owner,
    repo,
    pr_number,
    COALESCE(json_extract(payload_json, '$.admittedAttemptId'), json_extract(payload_json, '$.attemptId'))
  );
