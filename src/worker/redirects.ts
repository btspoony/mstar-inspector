/**
 * `/dashboard*` GET/HEAD redirect normalization (plan 29 T3 + plan 30 T4).
 *
 * Two rules, applied in order, at most one 301:
 *   1. Trailing-slash strip: a path ending in `/` (other than `/dashboard`
 *      itself) loses the slash.
 *   2. Exact alias: the stripped path `/dashboard/apps` → `/dashboard`.
 * GET/HEAD only — a 301 would convert POST to GET and break pinned
 * settings/actions. The alias is an EXACT path match, so
 * `/dashboard/apps/:slug/*` (settings, actions) is never caught, and
 * `/dashboard/apps/` reaches `/dashboard` in one hop (no chained redirect).
 */
import type { MiddlewareHandler } from "hono";

/**
 * @returns Location path+query to 301 to, or null to pass through.
 */
export function normalizeDashboardTrailingSlash(
  method: string,
  pathname: string,
  search = "",
): string | null {
  if (method !== "GET" && method !== "HEAD") return null;
  if (!pathname.startsWith("/dashboard")) return null;
  let target = pathname;
  if (target !== "/dashboard" && target.endsWith("/")) target = target.slice(0, -1);
  if (target === "/dashboard/apps") target = "/dashboard";
  if (target === pathname) return null;
  return `${target}${search}`;
}

export function trailingSlashRedirect(): MiddlewareHandler {
  return async (c, next) => {
    const url = new URL(c.req.url);
    const location = normalizeDashboardTrailingSlash(c.req.method, url.pathname, url.search);
    if (location === null) return next();
    return c.redirect(location, 301);
  };
}
