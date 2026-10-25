/**
 * The hidden platform console — `/_internal_admin`.
 *
 * Registration: `src/worker/index.ts` mounts this app on the `saas` router
 * only, beside `dashboardApp` and outside `APP_ROUTES`. Admin paths must never
 * join the workspace route table: `isOperatorReadPath`
 * (src/dashboard/index.ts) matches declared `access: "read"` paths by suffix,
 * so an admin row there would widen the operator ceiling for workspace routes.
 *
 * Authorization: every handler re-checks `operatorLogin` itself
 * (`./gate.ts`) — no mounted middleware stands in for it.
 */
import { Hono } from "hono";
import { isPlatformOperator } from "../dashboard/index";
import { listAllActiveSupportGrants } from "../dashboard/operator-store";
import { resolveLocale } from "../i18n";
import { injectSpaBoot } from "../spa/boot";
import { ADMIN_PAGES } from "../spa/admin/pages";
import type { Env } from "../worker/env";
import { isServerFlagKey, isFlagEnabled, listFlags } from "./flags";
import { operatorLogin, type AdminContext } from "./gate";
import { createSupportGrant, revokeSupportGrant } from "./support-grants";
import { listUsers } from "./users";
import { listWorkspaces, setWorkspacePlan } from "./workspaces";

/** One declaration row of this namespace's own route table. */
type AdminRoute = {
  method: "get" | "post" | "patch" | "delete";
  path: string;
  handler: (c: AdminContext) => Response | Promise<Response>;
};

/** The operator's own identity — the read that proves gate → handler wiring. */
async function readMe(c: AdminContext): Promise<Response> {
  const login = await operatorLogin(c);
  if (!login) return c.notFound();
  return c.json({ login });
}

/** Every known flag with its effective value; an absent row reads as enabled. */
async function readFlags(c: AdminContext): Promise<Response> {
  const login = await operatorLogin(c);
  if (!login) return c.notFound();
  const db = c.env.DB;
  if (!db) return c.notFound();
  return c.json({ flags: await listFlags(db) });
}

/**
 * Set one flag. The row and its audit row are ONE `batch` (one D1
 * transaction): either both land or neither does, so every successful write
 * appends exactly one `platform_audit_events` row and a failed write appends
 * none. `detail_json` carries the before/after pair the ledger read needs.
 */
async function setFlag(c: AdminContext): Promise<Response> {
  const login = await operatorLogin(c);
  if (!login) return c.notFound();
  const db = c.env.DB;
  if (!db) return c.notFound();
  let key: unknown;
  let enabled: unknown;
  try {
    const body = (await c.req.json()) as { key?: unknown; enabled?: unknown };
    key = body.key;
    enabled = body.enabled;
  } catch {
    // malformed body → the shape gate's 400, never a 500
  }
  if (!isServerFlagKey(key) || typeof enabled !== "boolean") {
    return c.json({ error: "body must be { key: <server flag key>, enabled: <boolean> }" }, 400);
  }
  const before = await isFlagEnabled(db, key);
  const now = new Date().toISOString();
  await db.batch([
    db
      .prepare(
        `INSERT INTO server_flags (key, enabled, updated_at, updated_by) VALUES (?, ?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET
           enabled = excluded.enabled,
           updated_at = excluded.updated_at,
           updated_by = excluded.updated_by`,
      )
      .bind(key, enabled ? 1 : 0, now, login),
    db
      .prepare(
        `INSERT INTO platform_audit_events
           (id, actor_login, action, target_type, target_id, detail_json, created_at)
         VALUES (?, ?, 'flag.set', 'flag', ?, ?, ?)`,
      )
      .bind(crypto.randomUUID(), login, key, JSON.stringify({ before, after: enabled }), now),
  ]);
  return c.json({ key, enabled });
}

/**
 * Every live workspace with its SQL-side counts, owner login and resolved
 * plan — one statement, so the console never fans out a read per row.
 */
async function readWorkspaces(c: AdminContext): Promise<Response> {
  const login = await operatorLogin(c);
  if (!login) return c.notFound();
  const db = c.env.DB;
  if (!db) return c.notFound();
  return c.json({ workspaces: await listWorkspaces(db, new Date().toISOString()) });
}

/**
 * Every known user with its SQL-side counts — one statement. `isOperator` comes
 * from the env allowlist through `isPlatformOperator`, the same predicate the
 * gate uses, so the listed flag and the authorization decision cannot diverge.
 */
async function readUsers(c: AdminContext): Promise<Response> {
  const login = await operatorLogin(c);
  if (!login) return c.notFound();
  const db = c.env.DB;
  if (!db) return c.notFound();
  const users = await listUsers(db, new Date().toISOString());
  return c.json({
    users: users.map((user) => ({ ...user, isOperator: isPlatformOperator(c.env, user.login) })),
  });
}

/**
 * Assign one workspace's plan. An unknown plan id is a 400 with no write; a
 * downgrade below the live member count is allowed and only blocks new invites
 * (spec §3.2), so this handler never removes a member.
 */
async function assignPlan(c: AdminContext): Promise<Response> {
  const login = await operatorLogin(c);
  if (!login) return c.notFound();
  const db = c.env.DB;
  if (!db) return c.notFound();
  let planId: unknown;
  try {
    const body = (await c.req.json()) as { planId?: unknown };
    planId = body.planId;
  } catch {
    // malformed body → the shape gate's 400, never a 500
  }
  if (typeof planId !== "string" || planId.length === 0) {
    return c.json({ error: "body must be { planId: <id from the plans catalogue> }" }, 400);
  }
  const workspaceId = c.req.param("id");
  if (!workspaceId) return c.notFound();
  const outcome = await setWorkspacePlan(db, {
    workspaceId,
    planId,
    actorLogin: login,
    now: new Date().toISOString(),
  });
  if (outcome.kind === "unknown_plan") {
    return c.json(
      { error: `unknown planId ${JSON.stringify(planId)}: the plans catalogue has no such row` },
      400,
    );
  }
  if (outcome.kind === "unknown_workspace") {
    return c.json({ error: "workspace not found" }, 404);
  }
  return c.json({ workspaceId, planId: outcome.planId });
}

/**
 * Every open support window across workspaces — one statement, newest append
 * per (workspace, operator), expired rows excluded. The console's list reads
 * are deliberately unaudited (spec §4): audit rows attach to writes.
 */
async function readSupportGrants(c: AdminContext): Promise<Response> {
  const login = await operatorLogin(c);
  if (!login) return c.notFound();
  const db = c.env.DB;
  if (!db) return c.notFound();
  return c.json({ grants: await listAllActiveSupportGrants(db, new Date().toISOString()) });
}

/** One `POST /api/support-grants` body; every field is validated below. */
type GrantBody = {
  workspaceId?: unknown;
  operatorLogin?: unknown;
  reason?: unknown;
  ttlHours?: unknown;
};

/**
 * Create one support grant. The body's shape and a usable expiry are decided
 * here; the store write and its single audit row are `./support-grants`.
 */
async function createGrant(c: AdminContext): Promise<Response> {
  const login = await operatorLogin(c);
  if (!login) return c.notFound();
  const db = c.env.DB;
  if (!db) return c.notFound();
  let body: GrantBody = {};
  try {
    body = (await c.req.json()) as GrantBody;
  } catch {
    // malformed body → the shape gate's 400, never a 500
  }
  const invalid = (detail: string) => c.json({ error: `invalid support grant: ${detail}` }, 400);
  const { workspaceId, operatorLogin: targetLogin, reason, ttlHours } = body;
  if (typeof workspaceId !== "string" || workspaceId.length === 0) {
    return invalid("workspaceId must be a non-empty workspace id");
  }
  if (typeof targetLogin !== "string" || targetLogin.length === 0) {
    return invalid("operatorLogin must be a non-empty GitHub login");
  }
  if (typeof reason !== "string" || reason.trim().length === 0) {
    return invalid("reason must be non-empty");
  }
  // The expiry is computed here so an unusable number is a 400, never a
  // `RangeError` out of `toISOString`.
  const now = new Date();
  const expires =
    typeof ttlHours === "number" && Number.isFinite(ttlHours) && ttlHours > 0
      ? new Date(now.getTime() + ttlHours * 3_600_000)
      : null;
  if (expires === null || Number.isNaN(expires.getTime())) {
    return invalid("ttlHours must be a positive number of hours");
  }
  const outcome = await createSupportGrant(db, {
    workspaceId,
    operatorLogin: targetLogin,
    reason,
    grantedBy: login,
    now: now.toISOString(),
    expiresAt: expires.toISOString(),
  });
  if (outcome.kind === "unknown_workspace") {
    return invalid(`workspaceId ${JSON.stringify(workspaceId)} is not a live workspace`);
  }
  return c.json({ grant: outcome.grant }, 201);
}

/**
 * Revoke one grant by id: the row is deleted (a grant is time-boxed access,
 * not history — spec §3.4) and exactly one audit row is appended with the
 * grant's workspace. An unknown id writes nothing.
 */
async function revokeGrant(c: AdminContext): Promise<Response> {
  const login = await operatorLogin(c);
  if (!login) return c.notFound();
  const db = c.env.DB;
  if (!db) return c.notFound();
  const id = c.req.param("id");
  if (!id) return c.notFound();
  const outcome = await revokeSupportGrant(db, {
    id,
    actorLogin: login,
    now: new Date().toISOString(),
  });
  if (outcome.kind === "not_found") {
    return c.json({ error: `no support grant with id ${JSON.stringify(id)}` }, 404);
  }
  return c.json({ id, workspaceId: outcome.workspaceId });
}

/**
 * The console document (`src/spa/admin.html`). `ASSETS` holds it and no other
 * route serves it: spa-dispatch matches only `/index.html` and `/assets/*`, so
 * this gated handler is the document's single entry point.
 */
async function serveDocument(c: AdminContext): Promise<Response> {
  const login = await operatorLogin(c);
  if (!login) return c.notFound();
  const document = await c.env.ASSETS?.fetch(new URL("/admin.html", c.req.url));
  if (!document?.ok) return c.notFound();
  // Minimal admin boot: identity and locale only. None of the workspace boot
  // reads (memberships, invites, support redirects) run for this document.
  const html = injectSpaBoot(await document.text(), {
    locale: resolveLocale(c.req.raw),
    login,
    name: null,
  });
  return c.html(html, 200, { "cache-control": "private, no-store" });
}

const ADMIN_ROUTES: readonly AdminRoute[] = [
  { method: "get", path: "/api/me", handler: readMe },
  { method: "get", path: "/api/flags", handler: readFlags },
  { method: "patch", path: "/api/flags", handler: setFlag },
  { method: "get", path: "/api/workspaces", handler: readWorkspaces },
  { method: "get", path: "/api/users", handler: readUsers },
  { method: "patch", path: "/api/workspaces/:id/plan", handler: assignPlan },
  { method: "get", path: "/api/support-grants", handler: readSupportGrants },
  { method: "post", path: "/api/support-grants", handler: createGrant },
  { method: "delete", path: "/api/support-grants/:id", handler: revokeGrant },
  { method: "get", path: "/", handler: serveDocument },
  ...ADMIN_PAGES.map((page) => ({ method: "get" as const, path: `/${page.id}`, handler: serveDocument })),
];

/** The admin sub-app. Exported as a mountable Hono instance for `src/worker/index.ts`. */
export const adminApp = new Hono<{ Bindings: Env }>();
for (const route of ADMIN_ROUTES) {
  if (route.method === "get") adminApp.get(route.path, route.handler);
  else if (route.method === "post") adminApp.post(route.path, route.handler);
  else if (route.method === "patch") adminApp.patch(route.path, route.handler);
  else adminApp.delete(route.path, route.handler);
}
