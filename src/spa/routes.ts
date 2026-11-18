/**
 * Enumerated SPA pages (the `SPA_PAGES` interface; the four workspace
 * surfaces — repositories, apps, members, settings — the App detail and login).
 *
 * The repository overview is the dashboard default. `/dashboard` and the
 * retired `/dashboard/apps` spelling are not pages: both answer one redirect to
 * `/dashboard/<workspaceRef>/repos`, whose ref the Worker's landing policy
 * names. Under `strict` the same pages live under the workspace prefix
 * (`/dashboard/<workspaceRef>/apps…`) — the Worker's tenant gate admits those
 * paths and this matcher serves their shell. History fallback is this matcher,
 * not wrangler `not_found_handling`.
 */
export const SPA_PAGES = [
  "repos",
  "apps",
  "members",
  "settings",
  "login",
  "app-detail",
] as const;

export type SpaPageId = (typeof SPA_PAGES)[number];

/**
 * `workspaceRef` is the workspace segment — an id or a slug — and is present
 * exactly on a workspace-scoped route: the legacy App paths carry no prefix and
 * therefore no field.
 */
export type SpaRoute =
  | { page: "repos"; pathname: string; workspaceRef: string; targetId?: string }
  | { page: "apps"; pathname: string; workspaceRef: string }
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
 * below is the SECOND. The Worker admits only `apps`, `members` and `api` —
 * `repos` and `settings` are SPA page paths with no Worker route under
 * `/<ref>/` — so the two lists are not interchangeable; only the reserved set
 * is shared verbatim.
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
export const WORKSPACE_FAMILY_SEGMENTS = ["repos", "apps", "members", "settings", "api"] as const;

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

const APP_DETAIL_PATH = /^\/dashboard\/apps\/([^/]+)$/;
const WORKSPACE_REPOS_PATH = /^\/dashboard\/([^/]+)\/repos$/;
const WORKSPACE_REPOS_DETAIL_PATH = /^\/dashboard\/([^/]+)\/repos\/([^/]+)$/;
const WORKSPACE_APPS_PATH = /^\/dashboard\/([^/]+)\/apps$/;
const WORKSPACE_MEMBERS_PATH = /^\/dashboard\/([^/]+)\/members$/;
const WORKSPACE_SETTINGS_PATH = /^\/dashboard\/([^/]+)\/settings$/;
const WORKSPACE_APP_DETAIL_PATH = /^\/dashboard\/([^/]+)\/apps\/([^/]+)$/;
const WORKSPACE_APP_SETTINGS_PATH = /^\/dashboard\/([^/]+)\/apps\/([^/]+)\/settings$/;
const WORKSPACE_APP_BOT_PATH = /^\/dashboard\/([^/]+)\/apps\/([^/]+)\/bot$/;

/**
 * The two dashboard root spellings — `/dashboard` and the retired
 * `/dashboard/apps` page. Neither is a page: the overview is workspace-scoped,
 * so both answer one redirect to the addressed workspace's repository
 * overview. Only the Worker can name that ref (it reads the session's sole
 * workspace, else the login's first membership), so the target is
 * {@link reposHomePath} of a ref it resolves — never something this matcher
 * could decide.
 */
export const DASHBOARD_ROOT_PATHS: ReadonlySet<string> = new Set(["/dashboard", "/dashboard/apps"]);

/** The repository overview of `ref` — the landing every root request resolves to. */
export function reposHomePath(ref: string): string {
  return `/dashboard/${ref}/repos`;
}

/**
 * The app-detail address a retired path spelling resolves to, or null for any
 * other path. Both spellings of the settings face — `…/apps/:appId/settings`
 * and the bot page's `…/apps/:appId/bot` — answer ONE redirect to the tab's own
 * query address and never render a page. That query spelling is the canonical
 * address, so `search` no longer decides the answer — the parameter stays for
 * the dispatch call site's shape. Only the workspace-scoped family can match:
 * the legacy `/dashboard/apps…` family is a 404 before SPA dispatch.
 */
export function settingsTabRedirect(pathname: string, _search: string): string | null {
  const [, ref, appId] = WORKSPACE_APP_SETTINGS_PATH.exec(pathname) ?? [];
  if (ref !== undefined && appId !== undefined) return `/dashboard/${ref}/apps/${appId}?tab=settings`;
  const [, botRef, botAppId] = WORKSPACE_APP_BOT_PATH.exec(pathname) ?? [];
  if (botRef !== undefined && botAppId !== undefined) {
    return `/dashboard/${botRef}/apps/${botAppId}?tab=settings`;
  }
  return null;
}

/**
 * ONE matcher entry / page id serves `/dashboard/apps/:appId` and its
 * workspace twin `/dashboard/<workspaceRef>/apps/:appId` — the App detail,
 * whose tabs are query-derived (`?tab=settings|installations`). The retired
 * `/settings` and `/bot` sub-paths are redirects, not pages, so a sub-path
 * never matches here.
 *
 * The repository overview is `/dashboard/<workspaceRef>/repos`, and one
 * repository is `…/repos/:targetId` — a target UUID, or `all` for the
 * workspace-defaults entry. The two dashboard roots are redirects
 * ({@link DASHBOARD_ROOT_PATHS}), never pages.
 */
export function matchSpaRoute(pathname: string): SpaRoute | null {
  if (pathname === "/dashboard/login") return { page: "login", pathname };
  const workspaceRef = workspaceRefOf(pathname);
  if (workspaceRef !== null) {
    if (WORKSPACE_REPOS_PATH.test(pathname)) return { page: "repos", pathname, workspaceRef };
    if (WORKSPACE_APPS_PATH.test(pathname)) return { page: "apps", pathname, workspaceRef };
    if (WORKSPACE_MEMBERS_PATH.test(pathname)) return { page: "members", pathname, workspaceRef };
    if (WORKSPACE_SETTINGS_PATH.test(pathname)) return { page: "settings", pathname, workspaceRef };
    const targetId = WORKSPACE_REPOS_DETAIL_PATH.exec(pathname)?.[2];
    if (targetId) return { page: "repos", pathname, workspaceRef, targetId };
    const appId = WORKSPACE_APP_DETAIL_PATH.exec(pathname)?.[2];
    if (appId) return { page: "app-detail", pathname, appId, workspaceRef };
    return null;
  }
  const legacyAppId = APP_DETAIL_PATH.exec(pathname)?.[1];
  if (!legacyAppId) return null;
  return { page: "app-detail", pathname, appId: legacyAppId };
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
  return pathname.startsWith("/app-assets/");
}
