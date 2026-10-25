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
  operatorSupportWorkspace,
  signedInLanding,
  workspaceBoot,
  pendingInvitesForLogin,
  workspaceMembershipsForLogin,
} from "../dashboard/index";
import { freeSlotAvailable } from "../dashboard/entitlement";
import { countFreeMembershipsForLogin } from "../dashboard/workspace-store";
import {
  FIRST_INSTANCE_COOKIE,
  SESSION_COOKIE,
  expireCookie,
  readFirstInstanceValue,
  readSessionValue,
} from "../dashboard/session";
import { removedPage } from "../dashboard/views";
import { injectSpaBoot, type SpaBoot } from "../spa/boot";
import { isSpaAssetPath, matchSpaRoute, wantsHtml } from "../spa/routes";
import { deploymentModeOf, type DeploymentMode, type Env } from "./env";

type SpaContext = Context<{ Bindings: Env }>;

/**
 * Per-request shell auth (QC W-001). spa-dispatch runs
 * BEFORE the dashboard membership guard (src/worker/index.ts), so the
 * boot-injected shell cannot rely on the guard's 403 — a removed member with
 * a still-valid session cookie would get the workbench with their own
 * identity echoed in `window.__BOOT__`. Re-read membership the way the guard
 * does: ONE D1 lookup on the users store per session-bearing shell request. No
 * valid session →
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
    return { kind: "shell", boot: { locale, login: null, name: null } };
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
        boot: { locale, login: null, name: null },
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
    boot: { locale, login: session.login, name: session.name ?? session.login },
  };
}

export async function serveSpaIndex(c: SpaContext): Promise<Response> {
  const assets = c.env.ASSETS;
  if (!assets) return new Response("SPA assets unbound", { status: 500 });
  // The boot payload carries the deployment shape, so an unusable value fails
  // HERE — before any page (login included) is served. No guidance page, no
  // fallback: a deployment that cannot name its shape has no first-login story
  // to tell.
  let deploymentMode: DeploymentMode;
  try {
    deploymentMode = deploymentModeOf(c.env.DEPLOYMENT_MODE);
  } catch (error) {
    return c.text((error as Error).message, 500);
  }
  // The OAuth callback mints a signed, one-shot marker for the ONE sign-in
  // that created a self-hosted instance's first account: it is the last moment
  // the table is empty, so the fact cannot be re-read here. The marker is bound
  // to that login and dropped on read (one-shot), and a SaaS deployment never
  // honours it.
  const auth = await readShellAuth(c);
  if (auth.kind === "deny") return auth.response;
  if (auth.kind === "redirect") {
    // No session, so nothing honours the marker here — but it must not outlive
    // the request either: a surviving marker would tell the post-sign-in shell
    // a story about a sign-in this browser never witnessed.
    if (getCookie(c, FIRST_INSTANCE_COOKIE) !== undefined) {
      c.header("Set-Cookie", expireCookie(FIRST_INSTANCE_COOKIE), { append: true });
    }
    return c.redirect(auth.location, 302);
  }
  const firstInstance =
    deploymentMode === "self-hosted" &&
    auth.boot.login !== null &&
    c.env.DASHBOARD_SESSION_SECRET !== undefined &&
    (await readFirstInstanceValue(
      getCookie(c, FIRST_INSTANCE_COOKIE),
      auth.boot.login,
      c.env.DASHBOARD_SESSION_SECRET,
    ));
  // The marker is NOT spent here. It carries a statement only the shell
  // document can deliver (`emptyInstance` in the boot), and a self-hosted
  // deployer usually lands on a 302 first (`/dashboard` → the workspace Apps
  // page, or an operator's support redirect), so spending it before the
  // branches would burn the guidance on a response that never renders it.
  // `/dashboard` (the root workbench) is mode-independent, but its first data
  // read derives the base from the pathname — the retired legacy App family —
  // so it is a dead end. Send it to the workspace Apps page (the same target
  // the OAuth callback and the login bounce use). The boot extras are resolved
  // FIRST so a login with NO workspace keeps today's shell instead of being
  // sent to a page that answers the outsider 404: that shell is where
  // workspace creation lives. `/index.html` and the login page never take the
  // redirect branch.
  const route = matchSpaRoute(c.req.path);
  const routeRef = route !== null && "workspaceRef" in route ? route.workspaceRef : undefined;
  // The signed-in login of a sidebar-bearing shell; null on the login page and
  // for an anonymous boot (those take no workspace read at all).
  const login = auth.boot.login !== null && route?.page !== "login" ? auth.boot.login : null;
  const extras = login === null ? {} : await workspaceBoot(c.env, login, routeRef);
  // The operator's landing must name the workspace too: the support face reads
  // `/api/support/workspace` off the pathname's workspace segment, and the bare
  // `/dashboard` carries none (root route unregistered → 404). The SAME
  // classifier the workspace gate uses answers it, so the shell cannot call an
  // invitee (or a member) a support visitor.
  const supportRef = login === null ? null : await operatorSupportWorkspace(c.env, login, routeRef);
  // Two independent lists behind the same login gate, so they share ONE round
  // trip — neither reads the other and both key on the login alone.
  // The invitee's discovery surface: every live pending invitation for this
  // login, so an invited outsider sees a path to accept without knowing the
  // workspace's ref (they are not a member yet, so no member list names it).
  // The switcher's list: the same login's live memberships.
  const lists =
    login === null
      ? null
      : await Promise.all([pendingInvitesForLogin(c.env, login), workspaceMembershipsForLogin(c.env, login)]);
  const pendingInvites = lists?.[0] ?? [];
  const memberships = lists?.[1] ?? [];
  if (c.req.path === "/dashboard" && login !== null) {
    if (supportRef !== null) return c.redirect(`/dashboard/${supportRef}/apps`, 302);
    // A login with no workspace of its own still needs a path into the
    // workspace UI; a newcomer (needsWorkspace) keeps the creation surface
    // instead of being sent to a page that answers the outsider 404. A
    // multi-workspace login lands on its FIRST membership's Apps page — a real
    // route — because the root workbench has no workspace segment (its data
    // reads all hang off one) and `/dashboard/apps` is retired (404).
    // ONE landing policy (`signedInLanding`), shared with the OAuth callback
    // and the login bounce, so the root path cannot disagree with sign-in.
    const landing = await signedInLanding(c.env, login);
    if (landing !== "/dashboard") return c.redirect(landing, 302);
  }
  // The create-workspace capability the shell's top-bar menu mirrors: one free
  // workspace per login, `saas` only. The creation route re-checks under its
  // write, so this is copy, not authority. `self-hosted` resolves every
  // workspace to `unlimited`, so creation is always allowed there and the
  // free-membership count is never read (spec §4). A signed-in shell always has
  // a store: `readShellAuth` denied otherwise.
  const freeSlotTaken =
    login !== null &&
    deploymentMode === "saas" &&
    !freeSlotAvailable(
      await countFreeMembershipsForLogin((c.env as Env & { DB: DashboardD1 }).DB, login),
    );
  // The shell's Apps/brand links need the active workspace, and the shell
  // outlives the URL: a client-side navigation (spaClick → pushState) to a page
  // whose pathname names no workspace changes the pathname but not the boot, so
  // a boot without the ref would strand that page on the retired
  // `/dashboard/apps` paths. Name the workspace in every sidebar-bearing boot —
  // a workspace-scoped pathname already carries the ref in the URL and the boot
  // copies that, but the boot ALSO carries the caller's create capability
  // (I-000082: a plain member cannot manage the App the manifest flow creates,
  // so the SPA shows a disabled control with the reason), and one
  // workspace-access read answers both — so the read runs on every
  // sidebar-bearing boot either way.
  // `/index.html` is the same shell document addressed directly (the SPA router
  // then reads the real pathname), so it takes the same boot. The login page
  // renders no sidebar, and `/dashboard` either redirected above or names no
  // workspace of its own.
  // A platform operator under a live grant sees the support face, not the
  // creation surface: `needsWorkspace` below would otherwise offer to create a
  // workspace to someone who is here to read one. The grant also names the
  // workspace (the operator has no membership row to derive it from).
  // Absent fields add nothing, so a ref-less boot keeps its JSON key order.
  const boot: SpaBoot = {
    ...auth.boot,
    deploymentMode,
    ...(firstInstance ? { emptyInstance: true } : {}),
    ...(routeRef ?? supportRef ?? extras.workspaceRef) === undefined
      ? {}
      : { workspaceRef: routeRef ?? supportRef ?? extras.workspaceRef },
    ...(extras.canCreateApp === undefined ? {} : { canCreateApp: extras.canCreateApp }),
    ...(login === null
      ? {}
      : {
          canCreateWorkspace: !freeSlotTaken,
          createWorkspaceBlockedReason: freeSlotTaken ? "free_slot" : null,
        }),
    ...(supportRef === null
      ? extras.needsWorkspace === true
        ? { needsWorkspace: true }
        : extras.workspaceRequired === true
          ? { workspaceRequired: true }
          : {}
      : { supportOnly: true }),
    ...(pendingInvites.length === 0 ? {} : { pendingInvites }),
    ...(memberships.length === 0 ? {} : { memberships }),
  };
  const assetResponse = await assets.fetch(new URL("/index.html", c.req.url));
  // Only the document below delivers the boot, so only it spends the marker.
  // HEAD and an asset failure carry no boot: expiring there would drop the
  // guidance before it ever reached a screen.
  if (c.req.method === "HEAD") {
    return new Response(null, { status: assetResponse.status });
  }
  if (!assetResponse.ok) return assetResponse as unknown as Response;
  const html = await assetResponse.text();
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    // QC S-001: the injected boot personalizes the document
    // (login/name) — never cache it.
    "cache-control": "private, no-store",
  });
  if (auth.setCookie) headers.append("set-cookie", auth.setCookie);
  // One-shot: the guidance is a statement about the sign-in that just
  // happened, never a property of the session, so the marker dies on the one
  // response that carries it (RFC 6265 forbids comma-joining Set-Cookie —
  // append instead). HEAD and an asset failure above return before this line,
  // so neither can spend it for a shell that never showed the boot.
  if (firstInstance) headers.append("set-cookie", expireCookie(FIRST_INSTANCE_COOKIE));
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
