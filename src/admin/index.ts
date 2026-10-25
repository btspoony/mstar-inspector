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
import { resolveLocale } from "../i18n";
import { injectSpaBoot } from "../spa/boot";
import { ADMIN_PAGES } from "../spa/admin/pages";
import type { Env } from "../worker/env";
import { isServerFlagKey, isFlagEnabled, listFlags } from "./flags";
import { operatorLogin, type AdminContext } from "./gate";

/** One declaration row of this namespace's own route table. */
type AdminRoute = {
  method: "get" | "patch";
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
  { method: "get", path: "/", handler: serveDocument },
  ...ADMIN_PAGES.map((page) => ({ method: "get" as const, path: `/${page.id}`, handler: serveDocument })),
];

/** The admin sub-app. Exported as a mountable Hono instance for `src/worker/index.ts`. */
export const adminApp = new Hono<{ Bindings: Env }>();
for (const route of ADMIN_ROUTES) {
  if (route.method === "patch") adminApp.patch(route.path, route.handler);
  else adminApp.get(route.path, route.handler);
}
