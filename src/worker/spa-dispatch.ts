import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import { resolveLocale, type Locale } from "../i18n";
import { getUserByLogin, type DashboardD1 } from "../dashboard/users";
import {
  isPlatformOperator,
  operatorSupportWorkspace,
  signedInLanding,
  workspaceBoot,
  pendingInvitesForLogin,
  workspaceMembershipsWithPlans,
  type WorkspaceBoot,
} from "../dashboard/index";
import { checkEntitlement } from "../dashboard/entitlement";
import { countFreeMembershipsForLogin } from "../dashboard/workspace-store";
import { isFlagEnabled } from "../admin/flags";
import {
  FIRST_INSTANCE_COOKIE,
  SESSION_COOKIE,
  expireCookie,
  readFirstInstanceValue,
  readSessionValue,
} from "../dashboard/session";
import { removedPage } from "../dashboard/views";
import { injectSpaBoot, type SpaBoot } from "../spa/boot";
import { documentFaceOf, pageDocumentTitle } from "../spa/document-title";
import { localizeDocument } from "./document-locale";
import {
  DASHBOARD_ROOT_PATHS,
  isSpaAssetPath,
  matchSpaRoute,
  settingsTabRedirect,
  targetsFamilyRedirect,
  wantsHtml,
} from "../spa/routes";
import { deploymentModeOf, type DeploymentMode, type Env } from "./env";

type SpaContext = Context<{ Bindings: Env }>;

type ShellAuth =
  | { kind: "shell"; boot: SpaBoot; setCookie?: string }
  | { kind: "redirect"; location: string }
  | { kind: "deny"; response: Response };

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
  const db = (c.env as Env & { DB?: DashboardD1 }).DB;
  if (!db) return { kind: "deny", response: c.text("dashboard storage is not configured", 500) };
  const user = await getUserByLogin(db, session.login);
  if (!user) {
    console.warn(
      JSON.stringify({
        event: "dashboard_access",
        stage: "spa_dispatch",
        reason: "not_a_member",
        login: session.login,
      }),
    );
    c.header("Set-Cookie", expireCookie(SESSION_COOKIE));
    if (c.req.path === "/dashboard/login") {
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

async function workspaceCreationBlock(
  db: DashboardD1,
  login: string,
  mode: DeploymentMode,
): Promise<SpaBoot["createWorkspaceBlockedReason"]> {
  if (!(await isFlagEnabled(db, "workspace_creation_open"))) return "flag";
  if (mode === "self-hosted") return null;
  const verdict = await checkEntitlement({
    db,
    mode,
    workspaceId: null,
    kind: "free-workspace-slot",
    freeMembershipCount: () => countFreeMembershipsForLogin(db, login),
  });
  return verdict.ok ? null : "free_slot";
}

export async function serveSpaIndex(c: SpaContext): Promise<Response> {
  const assets = c.env.ASSETS;
  if (!assets) return new Response("SPA assets unbound", { status: 500 });
  let deploymentMode: DeploymentMode;
  try {
    deploymentMode = deploymentModeOf(c.env.DEPLOYMENT_MODE);
  } catch (error) {
    return c.text((error as Error).message, 500);
  }
  const auth = await readShellAuth(c);
  if (auth.kind === "deny") return auth.response;
  if (auth.kind === "redirect") {
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
  const route = matchSpaRoute(c.req.path);
  const routeRef = route !== null && "workspaceRef" in route ? route.workspaceRef : undefined;
  const login = auth.boot.login !== null && route?.page !== "login" ? auth.boot.login : null;
  const workspace: Promise<WorkspaceBoot> =
    login === null
      ? Promise.resolve({ access: null, memberships: [] })
      : workspaceBoot(c.env, login, routeRef);
  const support = workspace.then((extras) => operatorSupportWorkspace(c.env, extras));
  if (DASHBOARD_ROOT_PATHS.has(c.req.path) && login !== null) {
    const [extras, supportRef] = await Promise.all([workspace, support]);
    if (supportRef !== null) return c.redirect(`/dashboard/${supportRef}/repos`, 302);
    const landing = await signedInLanding(c.env, login, extras);
    if (landing !== "/dashboard") return c.redirect(landing, 302);
  }
  const db = (c.env as Env & { DB?: DashboardD1 }).DB;
  const [extras, supportRef, memberships, pendingInvites, createBlockedReason, assetResponse] =
    await Promise.all([
      workspace,
      support,
      workspace.then(({ memberships }) => workspaceMembershipsWithPlans(c.env, memberships)),
      login === null ? [] : pendingInvitesForLogin(c.env, login),
      login === null || !db ? null : workspaceCreationBlock(db, login, deploymentMode),
      assets.fetch(new URL("/index.html", c.req.url)),
    ]);
  const boot: SpaBoot = {
    ...auth.boot,
    deploymentMode,
    isOperator:
      deploymentMode === "saas" &&
      auth.boot.login !== null &&
      isPlatformOperator(c.env, auth.boot.login),
    ...(firstInstance ? { emptyInstance: true } : {}),
    ...(routeRef ?? supportRef ?? extras.workspaceRef) === undefined
      ? {}
      : { workspaceRef: routeRef ?? supportRef ?? extras.workspaceRef },
    ...(extras.canCreateApp === undefined ? {} : { canCreateApp: extras.canCreateApp }),
    ...(login === null
      ? {}
      : {
          canCreateWorkspace: createBlockedReason === null,
          createWorkspaceBlockedReason: createBlockedReason,
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
  if (c.req.method === "HEAD") {
    return new Response(null, { status: assetResponse.status });
  }
  if (!assetResponse.ok) return assetResponse as unknown as Response;
  const html = await assetResponse.text();
  const headers = new Headers({
    "content-type": "text/html; charset=utf-8",
    "cache-control": "private, no-store",
  });
  if (auth.setCookie) headers.append("set-cookie", auth.setCookie);
  if (firstInstance) headers.append("set-cookie", expireCookie(FIRST_INSTANCE_COOKIE));
  return new Response(
    localizeDocument(
      injectSpaBoot(html, boot),
      boot.locale,
      pageDocumentTitle(boot.locale, route?.page ?? null, documentFaceOf(boot)),
    ),
    {
      status: assetResponse.status,
      headers,
    },
  );
}

export function spaDispatch(): MiddlewareHandler<{ Bindings: Env }> {
  return async (c, next) => {
    const method = c.req.method;
    if (method !== "GET" && method !== "HEAD") return next();
    const url = new URL(c.req.url);
    const pathname = url.pathname;
    const settingsTarget = settingsTabRedirect(pathname, url.search);
    if (settingsTarget !== null) return c.redirect(settingsTarget, 302);
    const renamedTargets = targetsFamilyRedirect(pathname);
    if (renamedTargets !== null) return c.redirect(renamedTargets, 302);
    const assets = c.env.ASSETS;
    if (!assets) return next();
    const accept = c.req.header("Accept") ?? null;
    if (DASHBOARD_ROOT_PATHS.has(pathname) || (matchSpaRoute(pathname) && wantsHtml(accept))) {
      return serveSpaIndex(c);
    }
    if (pathname === "/index.html") return serveSpaIndex(c);
    if (isSpaAssetPath(pathname)) return assets.fetch(new URL(c.req.url)) as unknown as Promise<Response>;
    return next();
  };
}
