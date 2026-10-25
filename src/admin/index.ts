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
import { operatorLogin, type AdminContext } from "./gate";

/** One declaration row of this namespace's only route table. */
type AdminRoute = {
  method: "get";
  path: string;
  handler: (c: AdminContext) => Response | Promise<Response>;
};

/** The operator's own identity — the read that proves gate → handler wiring. */
async function readMe(c: AdminContext): Promise<Response> {
  const login = await operatorLogin(c);
  if (!login) return c.notFound();
  return c.json({ login });
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
  { method: "get", path: "/", handler: serveDocument },
  ...ADMIN_PAGES.map((page) => ({ method: "get" as const, path: `/${page.id}`, handler: serveDocument })),
];

/** The admin sub-app. Exported as a mountable Hono instance for `src/worker/index.ts`. */
export const adminApp = new Hono<{ Bindings: Env }>();
for (const route of ADMIN_ROUTES) adminApp.get(route.path, route.handler);
