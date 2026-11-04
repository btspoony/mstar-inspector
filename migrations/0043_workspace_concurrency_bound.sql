-- 0043_workspace_concurrency_bound.sql — apply the per-workspace maximum to
-- values stored under the previous, wider range.
--
-- The workspace cap moved from a shared 1..64 range to its own 1..32 maximum
-- (the system level keeps 1..256). A value written under the old range would
-- now read as untrusted by `src/dashboard/runtime-config-store.ts`, degrading
-- that workspace to serial reviews for a number it was once allowed to store.
-- Clamping once, here, keeps every existing row a readable cap; the system row
-- needs no clamp because its old maximum (64) is inside the new one (256).
--
-- An untouched row (NULL) now reads as the 32 default: migration 0040 described
-- the default "as of then" (16), and this file changes the bound it resolves to
-- without rewriting an applied migration.
--
-- The clamp literal below is the value of `WORKSPACE_CONCURRENCY_MAX` in
-- `src/dashboard/runtime-config-store.ts`; `tests/store/migration.test.ts`
-- derives its expectation from that constant, so the two cannot drift apart.
--
-- Append-only on the production DB: one UPDATE, no schema change.

-- Record one ledger row per affected workspace BEFORE the clamp, so support can
-- answer "why is this workspace 32?" after the fact. The deploy has no user
-- actor, so the login is a fixed migration identity.
INSERT INTO platform_audit_events
  (id, actor_login, action, target_type, target_id, detail_json, created_at)
SELECT lower(hex(randomblob(16))),
       'migration',
       'workspace.concurrency.clamp',
       'workspace',
       id,
       json_object('before', max_concurrent_reviews, 'after', 32),
       strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  FROM workspaces
 WHERE max_concurrent_reviews > 32;

UPDATE workspaces SET max_concurrent_reviews = 32 WHERE max_concurrent_reviews > 32;
