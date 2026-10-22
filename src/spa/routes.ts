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
export const SPA_PAGES = ["apps", "members", "login", "app-detail"] as const;

export type SpaPageId = (typeof SPA_PAGES)[number];

/**
 * `workspaceRef` is the workspace segment — an id or a slug — and is present
 * exactly on a workspace-scoped route: the legacy App paths carry no prefix and
 * therefore no field.
 */
export type SpaRoute =
  | { page: "apps"; pathname: string; workspaceRef?: string }
  | { page: "members"; pathname: string; workspaceRef: string }
  | { page: "login"; pathname: "/dashboard/login" }
  | { page: "app-detail"; pathname: string; slug: string; workspaceRef?: string };

/**
 * First path segments that can never name a workspace (today's routes). ONE
 * set for the SPA matcher and the Worker's route-family gate
 * (`src/dashboard/index.ts`), so a reserved word can never be captured as a
 * workspace on either side of the bundle boundary.
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
 * The non-reserved workspace ref (an id or a slug) a
 * `/dashboard/<ref>/{apps|members|api}…` path is scoped to, otherwise null —
 * the request-path ordering contract's step 1 grammar, mirrored by the Worker's
 * `classifyDashboardPath`. The ONE workspace-path grammar: the route matcher,
 * the API-base derivation (`workspace-base.ts`) and the sidebar links all read
 * it, so a page's prefix cannot disagree with its matched route.
 */
export function workspaceRefOf(pathname: string): string | null {
  const ref = /^\/dashboard\/([^/]+)\/(?:apps|members|api)(?:\/|$)/.exec(pathname)?.[1];
  return ref !== undefined && !RESERVED_WORKSPACE_SLUGS.has(ref) ? ref : null;
}

const APP_DETAIL_PATH = /^\/dashboard\/apps\/([^/]+)(?:\/settings)?$/;
const WORKSPACE_APPS_PATH = /^\/dashboard\/([^/]+)\/apps$/;
const WORKSPACE_MEMBERS_PATH = /^\/dashboard\/([^/]+)\/members$/;
const WORKSPACE_APP_DETAIL_PATH = /^\/dashboard\/([^/]+)\/apps\/([^/]+)(?:\/settings)?$/;

/**
 * ONE matcher entry / page id serves both detail paths: the bare
 * `/dashboard/apps/:slug` (default tab 应用设置) and the legacy
 * `/dashboard/apps/:slug/settings` — a PERMANENT settings-tab deep link
 * (the settings POST family's HTML-nav 302 targets are pinned to it,
 * spec § IA), not a compat shim. The workspace twin
 * (`/dashboard/<workspaceRef>/apps/:slug`, `/settings` likewise) is the same
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
    const appSlug = WORKSPACE_APP_DETAIL_PATH.exec(pathname)?.[2];
    if (appSlug) return { page: "app-detail", pathname, slug: appSlug, workspaceRef };
    return null;
  }
  const slug = APP_DETAIL_PATH.exec(pathname)?.[1];
  if (!slug) return null;
  return { page: "app-detail", pathname, slug };
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
