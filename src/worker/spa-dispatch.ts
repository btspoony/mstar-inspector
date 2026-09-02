/**
 * Worker-side SPA dispatch (plan 29 T3).
 *
 * GET/HEAD + enumerated SPA page + `Accept: text/html` → `ASSETS` `/index.html`
 * with `window.__BOOT__` injected. Direct `GET /index.html` takes the same
 * boot path. `/assets/*` are the Vite hashed files — also ASSETS. Everything
 * else, including POST and non-HTML GET, falls through to the legacy Hono app.
 */
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { resolveLocale } from "../i18n";
import { getUserByLogin } from "../dashboard/users";
import { SESSION_COOKIE, readSessionValue } from "../dashboard/session";
import { injectSpaBoot, type SpaBoot } from "../spa/boot";
import { isSpaAssetPath, matchSpaRoute, wantsHtml } from "../spa/routes";
import type { Env } from "./env";

type SpaContext = Context<{ Bindings: Env }>;

export async function readSpaBoot(c: SpaContext): Promise<SpaBoot> {
  const locale = resolveLocale(c.req.raw);
  const secret = c.env.DASHBOARD_SESSION_SECRET;
  if (!secret) return { locale, login: null, name: null, role: null };
  const session = await readSessionValue(getCookie(c, SESSION_COOKIE), secret);
  if (!session) return { locale, login: null, name: null, role: null };
  let role: SpaBoot["role"] = null;
  if (c.env.DB) {
    const user = await getUserByLogin(c.env.DB, session.login);
    role = user?.role ?? null;
  }
  return {
    locale,
    login: session.login,
    name: session.name ?? session.login,
    role,
  };
}

export async function serveSpaIndex(c: SpaContext): Promise<Response> {
  const assets = c.env.ASSETS;
  if (!assets) return new Response("SPA assets unbound", { status: 500 });
  const assetResponse = await assets.fetch(new URL("/index.html", c.req.url));
  if (c.req.method === "HEAD") {
    return new Response(null, { status: assetResponse.status });
  }
  if (!assetResponse.ok) return assetResponse as unknown as Response;
  const html = await assetResponse.text();
  const boot = await readSpaBoot(c);
  return new Response(injectSpaBoot(html, boot), {
    status: assetResponse.status,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

export function spaDispatch(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const method = c.req.method;
    if (method !== "GET" && method !== "HEAD") return next();
    const assets = c.env.ASSETS;
    if (!assets) return next();
    const pathname = new URL(c.req.url).pathname;
    if (matchSpaRoute(pathname) && wantsHtml(c.req.header("Accept") ?? null)) {
      return serveSpaIndex(c);
    }
    // Direct /index.html hits the same boot-injected shell as enumerated pages.
    if (pathname === "/index.html") return serveSpaIndex(c);
    if (isSpaAssetPath(pathname)) return assets.fetch(new URL(c.req.url)) as unknown as Promise<Response>;
    return next();
  };
}
