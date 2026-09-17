/**
 * Enumerated SPA pages (the `SPA_PAGES` interface; apps route,
 * apps-default root, app-detail two-tab detail page).
 *
 * `/dashboard` and `/dashboard/apps` are one root-routing rule: both render
 * the Apps workbench (the insights home at the root is retired, as is the
 * Worker 301 alias). History fallback is this matcher, not
 * wrangler `not_found_handling`.
 */
export const SPA_PAGES = ["apps", "members", "login", "app-detail"] as const;

export type SpaPageId = (typeof SPA_PAGES)[number];

export type SpaRoute =
  | { page: "apps"; pathname: "/dashboard" | "/dashboard/apps" }
  | { page: "members"; pathname: "/dashboard/members" }
  | { page: "login"; pathname: "/dashboard/login" }
  | { page: "app-detail"; pathname: string; slug: string };

/**
 * ONE matcher entry / page id serves both detail paths: the bare
 * `/dashboard/apps/:slug` (default tab 应用设置) and the legacy
 * `/dashboard/apps/:slug/settings` — a PERMANENT settings-tab deep link
 * (the settings POST family's HTML-nav 302 targets are pinned to it,
 * spec § IA), not a compat shim. The active tab is query-derived
 * (`?tab=insights`), so both paths land on the same page and the default
 * settings tab.
 */
const APP_DETAIL_PATH = /^\/dashboard\/apps\/([^/]+)(?:\/settings)?$/;

export function matchSpaRoute(pathname: string): SpaRoute | null {
  switch (pathname) {
    case "/dashboard":
    case "/dashboard/apps":
      return { page: "apps", pathname };
    case "/dashboard/members":
      return { page: "members", pathname };
    case "/dashboard/login":
      return { page: "login", pathname };
    default: {
      const slug = APP_DETAIL_PATH.exec(pathname)?.[1];
      if (!slug) return null;
      return { page: "app-detail", pathname, slug };
    }
  }
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
