/**
 * Enumerated SPA pages (the `SPA_PAGES` interface; apps route,
 * apps-default root, app-detail two-tab detail page, and their
 * workspace-scoped twins).
 *
 * `/dashboard` and `/dashboard/apps` are one root-routing rule: both render
 * the Apps workbench (the insights home at the root is retired, as is the
 * Worker 301 alias). Under `strict` the same pages live under the workspace
 * prefix (`/dashboard/<workspaceRef>/apps…`) — the Worker's tenant gate
 * admits those paths and this matcher serves their shell. History fallback is
 * this matcher, not wrangler `not_found_handling`.
 */
export const SPA_PAGES = ["apps", "members", "settings", "login", "app-detail"] as const;

export type SpaPageId = (typeof SPA_PAGES)[number];

/**
 * `workspaceRef` is the workspace segment — an id or a slug — and is present
 * exactly on a workspace-scoped route: the legacy App paths carry no prefix and
 * therefore no field.
 */
export type SpaRoute =
  | { page: "apps"; pathname: string; workspaceRef?: string }
  | { page: "members"; pathname: string; workspaceRef: string }
  | { page: "settings"; pathname: string; workspaceRef: string }
  | { page: "login"; pathname: "/dashboard/login" }
  | { page: "app-detail"; pathname: string; appId: string; workspaceRef?: string };

/**
 * First path segments that can never name a workspace (today's routes). ONE
 * set for the SPA matcher and the Worker's route-family gate
 * (`src/dashboard/index.ts`), so a reserved word can never be captured as a
 * workspace on either side of the bundle boundary.
 *
 * Reserved words occupy the FIRST segment after the mount; the route family
 * below is the SECOND. The Worker admits three of the family's four members
 * (`settings` has no Worker route under `/<ref>/`), so the two lists are not
 * interchangeable — only the reserved set is shared verbatim.
 */
export const RESERVED_WORKSPACE_SLUGS: ReadonlySet<string> = new Set([
  "apps",
  "api",
  "oauth",
  "members",
  "login",
  "logout",
  "manifest",
  "locale",
  "healthz",
]);

/**
 * The workspace route family: the SECOND path segment that scopes a page or a
 * route to a workspace. ONE source for the SPA matcher below and the Worker's
 * route-family gate (`src/dashboard/index.ts`), which derives from it.
 */
export const WORKSPACE_FAMILY_SEGMENTS = ["apps", "members", "settings", "api"] as const;

/**
 * The non-reserved workspace ref (an id or a slug) a `/dashboard/<ref>/<family
 * segment>…` path is scoped to, otherwise null — the request-path ordering
 * contract's step 1 grammar, mirrored by the Worker's
 * `classifyDashboardPath`. The ONE workspace-path grammar: the route matcher,
 * the API-base derivation (`workspace-base.ts`) and the sidebar links all read
 * it, so a page's prefix cannot disagree with its matched route.
 */
const WORKSPACE_REF_PATH = new RegExp(
  `^/dashboard/([^/]+)/(?:${WORKSPACE_FAMILY_SEGMENTS.join("|")})(?:/|$)`,
);

export function workspaceRefOf(pathname: string): string | null {
  const ref = WORKSPACE_REF_PATH.exec(pathname)?.[1];
  return ref !== undefined && !RESERVED_WORKSPACE_SLUGS.has(ref) ? ref : null;
}

/**
 * The same path with its workspace segment replaced — every other segment and
 * the query are preserved, so a renamed workspace lands on the SAME page under
 * its new ref. Null when the pathname carries no workspace segment (a
 * deployment-level page has nothing to rewrite).
 */
export function replaceWorkspaceRef(pathname: string, nextRef: string): string | null {
  const match = /^\/dashboard\/([^/]+)(\/.*)?$/.exec(pathname);
  if (!match || match[1] === undefined || RESERVED_WORKSPACE_SLUGS.has(match[1])) return null;
  return `/dashboard/${nextRef}${match[2] ?? ""}`;
}

const APP_DETAIL_PATH = /^\/dashboard\/apps\/([^/]+)(?:\/settings)?$/;
const WORKSPACE_APPS_PATH = /^\/dashboard\/([^/]+)\/apps$/;
const WORKSPACE_MEMBERS_PATH = /^\/dashboard\/([^/]+)\/members$/;
const WORKSPACE_SETTINGS_PATH = /^\/dashboard\/([^/]+)\/settings$/;
const WORKSPACE_APP_DETAIL_PATH = /^\/dashboard\/([^/]+)\/apps\/([^/]+)(?:\/settings)?$/;

/**
 * ONE matcher entry / page id serves both detail paths: the bare
 * `/dashboard/apps/:appId` (default tab 应用设置) and the legacy
 * `/dashboard/apps/:appId/settings` — a PERMANENT settings-tab deep link
 * (the settings POST family's HTML-nav 302 targets are pinned to it,
 * spec § IA), not a compat shim. The workspace twin
 * (`/dashboard/<workspaceRef>/apps/:appId`, `/settings` likewise) is the same
 * page under that workspace's route family. The active tab is query-derived
 * (`?tab=insights`), so every path lands on the same page and the default
 * settings tab.
 */
export function matchSpaRoute(pathname: string): SpaRoute | null {
  switch (pathname) {
    case "/dashboard":
    case "/dashboard/apps":
      return { page: "apps", pathname };
    case "/dashboard/login":
      return { page: "login", pathname };
  }
  const workspaceRef = workspaceRefOf(pathname);
  if (workspaceRef !== null) {
    if (WORKSPACE_APPS_PATH.test(pathname)) return { page: "apps", pathname, workspaceRef };
    if (WORKSPACE_MEMBERS_PATH.test(pathname)) return { page: "members", pathname, workspaceRef };
    if (WORKSPACE_SETTINGS_PATH.test(pathname)) return { page: "settings", pathname, workspaceRef };
    const appId = WORKSPACE_APP_DETAIL_PATH.exec(pathname)?.[2];
    if (appId) return { page: "app-detail", pathname, appId, workspaceRef };
    return null;
  }
  const appId = APP_DETAIL_PATH.exec(pathname)?.[1];
  if (!appId) return null;
  return { page: "app-detail", pathname, appId };
}

/**
 * HTML navigation vs API/test clients. Default Request Accept is star/star
 * (legacy tests, curl) and must NOT take the SPA path.
 */
export function wantsHtml(acceptHeader: string | null): boolean {
  if (!acceptHeader) return false;
  return acceptHeader.split(",").some((part) => part.trim().toLowerCase().startsWith("text/html"));
}

export function isSpaAssetPath(pathname: string): boolean {
  return pathname === "/index.html" || pathname.startsWith("/assets/");
}
