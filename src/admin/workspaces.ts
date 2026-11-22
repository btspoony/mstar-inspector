import { FREE_PLAN_ID, resolveWorkspacePlan } from "../dashboard/entitlement";
import type { DashboardD1, DashboardD1BatchResult } from "../dashboard/users";

/** One `GET /_internal_admin/api/workspaces` row (spec §3.3). */
export type AdminWorkspaceRow = {
  id: string;
  name: string;
  slug: string;
  ownerLogin: string | null;
  memberCount: number;
  pendingInviteCount: number;
  planId: string;
  planName: string;
  includedMembers: number | null;
  createdAt: string;
};

const LIST_SQL = `
  SELECT w.id         AS id,
         w.name       AS name,
         w.slug       AS slug,
         w.created_at AS createdAt,
         (SELECT u.github_login
            FROM workspace_members m
            JOIN users u ON u.id = m.user_id
           WHERE m.workspace_id = w.id AND m.role = 'owner'
           ORDER BY m.created_at, u.github_login
           LIMIT 1) AS ownerLogin,
         (SELECT COUNT(*) FROM workspace_members m
           WHERE m.workspace_id = w.id) AS memberCount,
         (SELECT COUNT(*) FROM workspace_invites i
           WHERE i.workspace_id = w.id
             AND i.status = 'pending' AND i.expires_at > ?1) AS pendingInviteCount,
         COALESCE(s.plan_id, ?2) AS planId,
         p.name AS planName,
         p.included_members AS includedMembers
    FROM workspaces w
    LEFT JOIN workspace_subscriptions s
           ON s.workspace_id = w.id AND s.status = 'active'
    LEFT JOIN plans p ON p.id = COALESCE(s.plan_id, ?2)
   WHERE w.deleted_at IS NULL
   ORDER BY w.created_at DESC, w.id ASC`;

/** Live workspaces with their SQL-side counts, owner and resolved plan limits. */
export async function listWorkspaces(db: DashboardD1, now: string): Promise<AdminWorkspaceRow[]> {
  const rows = await db.prepare(LIST_SQL).bind(now, FREE_PLAN_ID).all<AdminWorkspaceRow>();
  return rows.results;
}

/**
 * Outcome of {@link setWorkspacePlan}. `unknown_plan` and `unknown_workspace`
 * write nothing: the route turns them into a 400 and a 404, and the caller can
 * tell "the catalogue has no such plan" from "the tenant is gone".
 */
export type SetWorkspacePlanOutcome =
  | { kind: "ok"; planId: string }
  | { kind: "unknown_plan" }
  | { kind: "unknown_workspace" };

const SUBSCRIPTION_UPSERT_SQL = `
  INSERT INTO workspace_subscriptions (workspace_id, plan_id, status, created_at, updated_at)
  VALUES (?1, ?2, 'active', ?3, ?3)
  ON CONFLICT (workspace_id) DO UPDATE SET
    plan_id = excluded.plan_id,
    status = 'active',
    updated_at = excluded.updated_at`;

const AUDIT_INSERT_SQL = `
  INSERT INTO platform_audit_events
    (id, actor_login, action, target_type, target_id, detail_json, created_at)
  VALUES (?1, ?2, 'workspace.plan.set', 'workspace', ?3, ?4, ?5)`;

/**
 * The workspace slug grammar, 2–39 lowercase letters/digits/hyphens starting
 * with a letter or digit — the rule the deleted owner route enforced before
 * slug authoring moved here.
 */
export const WORKSPACE_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]{1,38}$/;

/**
 * Outcome of {@link setWorkspaceSlug}. `unknown_workspace` writes nothing; the
 * two conflicts are the store's own guards, and the route turns each into a
 * distinct 409 so the operator can tell them apart.
 */
export type SetWorkspaceSlugOutcome =
  | { kind: "ok"; slug: string }
  | { kind: "slug_taken" }
  | { kind: "slug_is_workspace_id" }
  | { kind: "unknown_workspace" };

const SLUG_UPDATE_SQL = `UPDATE workspaces SET slug = ?1
   WHERE id = ?2
     AND deleted_at IS NULL
     AND NOT EXISTS (SELECT 1 FROM workspaces WHERE slug = ?1 COLLATE NOCASE AND id <> ?2)
     AND NOT EXISTS (SELECT 1 FROM workspaces WHERE id = ?1 AND id <> ?2)`;

const SLUG_AUDIT_SQL = `
  INSERT INTO platform_audit_events
    (id, actor_login, action, target_type, target_id, detail_json, created_at)
  SELECT ?1, ?2, 'workspace.slug.set', 'workspace', ?3,
         json_object('before', (SELECT slug FROM workspaces WHERE id = ?3), 'after', ?4),
         ?5
   WHERE EXISTS (
     SELECT 1 FROM workspaces
      WHERE id = ?3
        AND deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM workspaces WHERE slug = ?4 COLLATE NOCASE AND id <> ?3)
        AND NOT EXISTS (SELECT 1 FROM workspaces WHERE id = ?4 AND id <> ?3)
   )`;

const SLUG_CONFLICT_SQL = `SELECT
     EXISTS (SELECT 1 FROM workspaces WHERE slug = ?1 COLLATE NOCASE AND id <> ?2) AS slug_taken,
     EXISTS (SELECT 1 FROM workspaces WHERE id = ?1 AND id <> ?2) AS id_taken`;

/**
 * Rename one workspace's slug. The guarded UPDATE and its audit row are ONE
 * `batch` (one D1 transaction), so an accepted write appends exactly one ledger
 * row and a refused one appends none. A concurrent write that slipped past the
 * guards lands on the slug UNIQUE index, which maps to `slug_taken` rather than
 * a 500.
 */
export async function setWorkspaceSlug(
  db: DashboardD1,
  input: { workspaceId: string; slug: string; actorLogin: string; now: string },
): Promise<SetWorkspaceSlugOutcome> {
  let results: DashboardD1BatchResult[];
  try {
    results = await db.batch([
      db
        .prepare(SLUG_AUDIT_SQL)
        .bind(crypto.randomUUID(), input.actorLogin, input.workspaceId, input.slug, input.now),
      db.prepare(SLUG_UPDATE_SQL).bind(input.slug, input.workspaceId),
    ]);
  } catch (err) {
    if (err instanceof Error && /UNIQUE constraint failed/i.test(err.message)) {
      return { kind: "slug_taken" };
    }
    throw err;
  }
  if ((results[1]?.meta.changes ?? 0) > 0) return { kind: "ok", slug: input.slug };

  const guard = await db
    .prepare(SLUG_CONFLICT_SQL)
    .bind(input.slug, input.workspaceId)
    .first<{ slug_taken: number; id_taken: number }>();
  if (guard?.slug_taken) return { kind: "slug_taken" };
  if (guard?.id_taken) return { kind: "slug_is_workspace_id" };
  return { kind: "unknown_workspace" };
}

/**
 * Assign one workspace's plan (spec §3.2).
 *
 * The plan id is validated against the catalogue first, so an unknown id is a
 * refusal with no write at all — `plans` is read-only at runtime, so that read
 * cannot go stale between the check and the batch. A downgrade below the live
 * member count is deliberately allowed: it blocks NEW invites through the seat
 * guard every invite write carries (src/dashboard/invite-store.ts:164), and it
 * never removes a member — no membership row is touched here.
 *
 * `previousPlanId` is what the workspace RESOLVED to before the write. The
 * console only exists on `saas`, so passing that mode is the registration
 * contract, not a guess.
 */
export async function setWorkspacePlan(
  db: DashboardD1,
  input: { workspaceId: string; planId: string; actorLogin: string; now: string },
): Promise<SetWorkspacePlanOutcome> {
  const plan = await db
    .prepare("SELECT 1 AS found FROM plans WHERE id = ?")
    .bind(input.planId)
    .first<{ found: number }>();
  if (!plan) return { kind: "unknown_plan" };

  const workspace = await db
    .prepare("SELECT 1 AS found FROM workspaces WHERE id = ? AND deleted_at IS NULL")
    .bind(input.workspaceId)
    .first<{ found: number }>();
  if (!workspace) return { kind: "unknown_workspace" };

  const previousPlanId = (await resolveWorkspacePlan(db, input.workspaceId, "saas")).id;
  await db.batch([
    db.prepare(SUBSCRIPTION_UPSERT_SQL).bind(input.workspaceId, input.planId, input.now),
    db
      .prepare(AUDIT_INSERT_SQL)
      .bind(
        crypto.randomUUID(),
        input.actorLogin,
        input.workspaceId,
        JSON.stringify({ before: previousPlanId, after: input.planId }),
        input.now,
      ),
  ]);
  return { kind: "ok", planId: input.planId };
}
