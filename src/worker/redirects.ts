/**
 * `/dashboard*` GET/HEAD redirect normalization.
 *
 * Trailing-slash strip: a path ending in `/` (other than `/dashboard`
 * itself) loses the slash. GET/HEAD only — a 301 would convert POST to GET
 * and break pinned settings/actions. `/dashboard/apps` is an enumerated SPA
 * route (the legacy 301 alias to `/dashboard` is retired).
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
