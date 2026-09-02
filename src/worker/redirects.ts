/**
 * Trailing-slash normalization for `/dashboard*` (plan 29 T3).
 *
 * GET/HEAD only — a 301 would convert POST to GET and break pinned
 * settings/actions. `/dashboard/apps` exact-alias 301 is plan 30; this
 * module only strips a single trailing slash.
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
  if (pathname === "/dashboard" || !pathname.endsWith("/")) return null;
  return `${pathname.slice(0, -1)}${search}`;
}

export function trailingSlashRedirect(): MiddlewareHandler {
  return async (c, next) => {
    const url = new URL(c.req.url);
    const location = normalizeDashboardTrailingSlash(c.req.method, url.pathname, url.search);
    if (location === null) return next();
    return c.redirect(location, 301);
  };
}
