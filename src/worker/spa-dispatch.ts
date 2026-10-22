/**
 * Worker-side SPA dispatch.
 *
 * GET/HEAD + enumerated SPA page → `ASSETS` `/index.html` with
 * `window.__BOOT__` injected. `/dashboard` is the SPA workbench for EVERY
 * Accept variant (the legacy SSR home is retired); other
 * enumerated pages require HTML navigation (`Accept: text/html`) so API and
 * test clients never get the shell. Direct `GET /index.html` takes the same
 * boot path. `/assets/*` are the Vite hashed files — also ASSETS. Every
 * shell response re-reads membership (QC W-001): a session whose
 * login has no users row gets the removedPage 403 instead of the shell.
 * No valid session → 302 `/dashboard/login` (the old null-boot
 * shell was the render-then-kick flash source); the SPA router guard is the
 * second line. Removed members get the session cookie expired on every
 * shell request — HTML navigation 302s to login, API/fetch keeps the 403.
 * Everything else, including POST and non-HTML GET, falls through to the
 * legacy Hono app (whose mount-level guard then applies).
 */
import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { resolveLocale, type Locale } from "../i18n";
import { getUserByLogin, type DashboardD1 } from "../dashboard/users";
import {
  strictWorkspaceAppsBase,
  strictWorkspaceBoot,
  pendingInvitesForLogin,
} from "../dashboard/index";
import { SESSION_COOKIE, expireCookie, readSessionValue } from "../dashboard/session";
import { removedPage } from "../dashboard/views";
import { injectSpaBoot, type SpaBoot } from "../spa/boot";
import { isSpaAssetPath, matchSpaRoute, wantsHtml } from "../spa/routes";
import type { Env } from "./env";

type SpaContext = Context<{ Bindings: Env }>;

/**
 * Per-request shell auth (QC W-001). spa-dispatch runs
 * BEFORE the dashboard membership guard (src/worker/index.ts), so the
 * boot-injected shell cannot rely on the guard's 403 — a removed member with
 * a still-valid session cookie would get the workbench with their own
 * identity echoed in `window.__BOOT__`. Re-read membership the way the guard
 * does: ONE D1 lookup on the users store, shared with the boot's role (a
 * session-bearing shell request costs a single read). No valid session →
 * 302 `/dashboard/login` (spec §1.3 — the old null-boot shell was the
 * render-then-kick flash source); session with no users row → session cookie
 * expired, HTML navigation 302s to login while API/fetch keeps the
 * removedPage 403 (fetch must not silently follow a 302 into the HTML login
 * page); session with D1 unbound → fail closed like the guard (500).
 */
type ShellAuth =
  | { kind: "shell"; boot: SpaBoot; setCookie?: string }
  | { kind: "redirect"; location: string }
  | { kind: "deny"; response: Response };

/**
 * No valid session (missing secret or unreadable/absent cookie). Dashboard
 * page routes 302 to the login page; the login page itself and `/index.html`
 * are exempt (spec §1.3 — the login page would self-loop, `/index.html` is a
 * static asset never server-redirected) and keep the null-boot shell, where
 * the SPA router guard bounces to login client-side.
 */
function noSessionShell(c: SpaContext, locale: Locale): ShellAuth {
  if (c.req.path === "/index.html" || c.req.path === "/dashboard/login") {
    return { kind: "shell", boot: { locale, login: null, name: null, role: null } };
  }
  return { kind: "redirect", location: "/dashboard/login" };
}

async function readShellAuth(c: SpaContext): Promise<ShellAuth> {
  const locale = resolveLocale(c.req.raw);
  const secret = c.env.DASHBOARD_SESSION_SECRET;
  if (!secret) return noSessionShell(c, locale);
  const session = await readSessionValue(getCookie(c, SESSION_COOKIE), secret);
  if (!session) return noSessionShell(c, locale);
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
    // Actively invalidate the removed member's session. The
    // login page itself serves the null-boot shell (no self-loop); other
    // HTML navigation → expire + 302 login; API/fetch → expire + 403 (a
    // fetch must not silently follow the 302 into the HTML login page).
    c.header("Set-Cookie", expireCookie(SESSION_COOKIE));
    if (c.req.path === "/dashboard/login") {
      // serveSpaIndex builds a raw Response, so the expiry header must ride
      // on the result rather than the context.
      return {
        kind: "shell",
        boot: { locale, login: null, name: null, role: null },
        setCookie: expireCookie(SESSION_COOKIE),
      };
    }
    const response = wantsHtml(c.req.header("Accept") ?? null)
      ? c.redirect("/dashboard/login", 302)
      : c.html(removedPage(session.login, locale), 403);
    return { kind: "deny", response };
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
  if (auth.kind === "redirect") return c.redirect(auth.location, 302);
  // `/dashboard` (the root workbench) is mode-independent, but its first data
  // read derives the base from the pathname — the retired legacy App family —
  // so under `strict` it is a dead end. Send it to the workspace Apps page (the
  // same target the OAuth callback and the login bounce use). The boot extras
  // are resolved FIRST so a login with NO workspace keeps today's shell instead
  // of being sent to a page that answers the outsider 404: that shell is where
  // workspace creation lives (plan 97 AC1). `/index.html` and the login page
  // never take the redirect branch.
  const route = matchSpaRoute(c.req.path);
  const routeSlug = route !== null && "workspaceSlug" in route ? route.workspaceSlug : undefined;
  const extras =
    auth.boot.login === null || route?.page === "login"
      ? {}
      : await strictWorkspaceBoot(c.env, auth.boot.login);
  // The redirect target keeps the resolver that warns when a strict deployment
  // cannot name its workspace (that warning is the operator signal for the
  // landing). A login with no workspace stays on the shell either way.
  if (c.req.path === "/dashboard" && extras.needsWorkspace !== true) {
    const workspaceBase = await strictWorkspaceAppsBase(c.env);
    if (workspaceBase !== null) return c.redirect(workspaceBase, 302);
  }
  // The shell's Apps/brand links need the active workspace, and the shell
  // outlives the URL: a client-side navigation (spaClick → pushState) to the
  // mode-independent Members page changes the pathname but not the boot, so a
  // boot without the slug would strand that page on the legacy
  // `/dashboard/apps` dead end under `strict`. Name the workspace in every
  // sidebar-bearing boot — a workspace-scoped pathname already carries the slug
  // in the URL and the boot copies that, but the boot ALSO carries the caller's
  // workspace role as `canCreateApp` (I-000082: a plain member cannot manage the
  // App the manifest flow creates, so the SPA offers no Create action), and one
  // sole-workspace read answers both — so the read runs on every strict
  // sidebar-bearing boot either way. `/index.html` is the same shell document
  // addressed directly (the SPA router then reads the real pathname), so it
  // takes the same boot. The login page renders no sidebar, and `/dashboard`
  // either redirected above or has no sole workspace to name.
  // The invitee's discovery surface: every live pending invitation for this
  // login, so an invited outsider sees a path to accept without knowing the
  // workspace's ref (they are not a member yet, so no member list names it).
  const pendingInvites =
    auth.boot.login === null || route?.page === "login"
      ? []
      : await pendingInvitesForLogin(c.env, auth.boot.login);
  // Absent fields add nothing, so `off` and a slug-less deployment keep the
  // pre-existing boot (and its JSON key order) byte-identical.
  const boot: SpaBoot = {
    ...auth.boot,
    ...(routeSlug ?? extras.workspaceSlug) === undefined
      ? {}
      : { workspaceSlug: routeSlug ?? extras.workspaceSlug },
    ...(extras.canCreateApp === undefined ? {} : { canCreateApp: extras.canCreateApp }),
    ...(extras.needsWorkspace === true ? { needsWorkspace: true } : {}),
    ...(pendingInvites.length === 0 ? {} : { pendingInvites }),
  };
  const assetResponse = await assets.fetch(new URL("/index.html", c.req.url));
  if (c.req.method === "HEAD") {
    return new Response(null, { status: assetResponse.status });
  }
  if (!assetResponse.ok) return assetResponse as unknown as Response;
  const html = await assetResponse.text();
  const headers: Record<string, string> = {
    "content-type": "text/html; charset=utf-8",
    // QC S-001: the injected boot personalizes the document
    // (login/name/role) — never cache it.
    "cache-control": "private, no-store",
  };
  if (auth.setCookie) headers["set-cookie"] = auth.setCookie;
  return new Response(injectSpaBoot(html, boot), {
    status: assetResponse.status,
    headers,
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
    // `/dashboard` is the SPA workbench for EVERY Accept variant (the
    // legacy SSR home is retired). Other enumerated pages keep the
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
