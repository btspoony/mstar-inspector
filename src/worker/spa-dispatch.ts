/**
 * Worker-side SPA dispatch (plan 29 T3, plan 30 T4).
 *
 * GET/HEAD + enumerated SPA page → `ASSETS` `/index.html` with
 * `window.__BOOT__` injected. `/dashboard` is the SPA workbench for EVERY
 * Accept variant (plan 30 T4 — the legacy SSR home is retired); other
 * enumerated pages require HTML navigation (`Accept: text/html`) so API and
 * test clients never get the shell. Direct `GET /index.html` takes the same
 * boot path. `/assets/*` are the Vite hashed files — also ASSETS. Every
 * shell response re-reads membership (plan 30 QC W-001): a session whose
 * login has no users row gets the removedPage 403 instead of the shell.
 * Everything else, including POST and non-HTML GET, falls through to the
 * legacy Hono app (whose mount-level guard then applies).
 */
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { resolveLocale } from "../i18n";
import { getUserByLogin, type DashboardD1 } from "../dashboard/users";
import { SESSION_COOKIE, readSessionValue } from "../dashboard/session";
import { removedPage } from "../dashboard/views";
import { injectSpaBoot, type SpaBoot } from "../spa/boot";
import { isSpaAssetPath, matchSpaRoute, wantsHtml } from "../spa/routes";
import type { Env } from "./env";

type SpaContext = Context<{ Bindings: Env }>;

/**
 * Per-request shell auth (plan 30 QC W-001). spa-dispatch runs BEFORE the
 * dashboard membership guard (src/worker/index.ts), so the boot-injected
 * shell cannot rely on the guard's 403 — a removed member with a still-valid
 * session cookie would get the workbench with their own identity echoed in
 * `window.__BOOT__`. Re-read membership the way the guard does: ONE D1 lookup
 * on the users store, shared with the boot's role (a session-bearing shell
 * request costs a single read). No session → shell (login null boot); session
 * with no users row → removedPage 403 (plan-12 contract preserved); session
 * with D1 unbound → fail closed like the guard (500).
 */
type ShellAuth =
  | { kind: "shell"; boot: SpaBoot }
  | { kind: "deny"; response: Response };

async function readShellAuth(c: SpaContext): Promise<ShellAuth> {
  const locale = resolveLocale(c.req.raw);
  const secret = c.env.DASHBOARD_SESSION_SECRET;
  if (!secret) return { kind: "shell", boot: { locale, login: null, name: null, role: null } };
  const session = await readSessionValue(getCookie(c, SESSION_COOKIE), secret);
  if (!session) return { kind: "shell", boot: { locale, login: null, name: null, role: null } };
  // Users-store D1 face — the same binding the guard reads through
  // (src/dashboard/index.ts dashboardD1); unbound fails closed like it.
  const db = (c.env as Env & { DB?: DashboardD1 }).DB;
  if (!db) return { kind: "deny", response: c.text("dashboard storage is not configured", 500) };
  const user = await getUserByLogin(db, session.login);
  if (!user) {
    // Same structured convention as the guard's denial (login is public
    // identity — it renders on the removed page).
    console.warn(
      JSON.stringify({
        event: "dashboard_access",
        stage: "spa_dispatch",
        reason: "not_a_member",
        login: session.login,
      }),
    );
    return { kind: "deny", response: c.html(removedPage(session.login, locale), 403) };
  }
  return {
    kind: "shell",
    boot: { locale, login: session.login, name: session.name ?? session.login, role: user.role },
  };
}

export async function serveSpaIndex(c: SpaContext): Promise<Response> {
  const assets = c.env.ASSETS;
  if (!assets) return new Response("SPA assets unbound", { status: 500 });
  const auth = await readShellAuth(c);
  if (auth.kind === "deny") return auth.response;
  const assetResponse = await assets.fetch(new URL("/index.html", c.req.url));
  if (c.req.method === "HEAD") {
    return new Response(null, { status: assetResponse.status });
  }
  if (!assetResponse.ok) return assetResponse as unknown as Response;
  const html = await assetResponse.text();
  return new Response(injectSpaBoot(html, auth.boot), {
    status: assetResponse.status,
    headers: {
      "content-type": "text/html; charset=utf-8",
      // Plan 30 QC S-001: the injected boot personalizes the document
      // (login/name/role) — never cache it.
      "cache-control": "private, no-store",
    },
  });
}

export function spaDispatch(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const method = c.req.method;
    if (method !== "GET" && method !== "HEAD") return next();
    const assets = c.env.ASSETS;
    if (!assets) return next();
    const pathname = new URL(c.req.url).pathname;
    const accept = c.req.header("Accept") ?? null;
    // `/dashboard` is the SPA workbench for EVERY Accept variant (plan 30
    // T4: the legacy SSR home is retired). Other enumerated pages keep the
    // HTML-navigation gate so API/test clients never get the shell.
    if (pathname === "/dashboard" || (matchSpaRoute(pathname) && wantsHtml(accept))) {
      return serveSpaIndex(c);
    }
    // Direct /index.html hits the same boot-injected shell as enumerated pages.
    if (pathname === "/index.html") return serveSpaIndex(c);
    if (isSpaAssetPath(pathname)) return assets.fetch(new URL(c.req.url)) as unknown as Promise<Response>;
    return next();
  };
}
