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

const ADMIN_ROUTES: readonly AdminRoute[] = [{ method: "get", path: "/api/me", handler: readMe }];

/** The admin sub-app. Exported as a mountable Hono instance for `src/worker/index.ts`. */
export const adminApp = new Hono<{ Bindings: Env }>();
for (const route of ADMIN_ROUTES) adminApp.get(route.path, route.handler);
