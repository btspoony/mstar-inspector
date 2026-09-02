/**
 * Enumerated SPA pages (plan 29 Interfaces `SPA_PAGES`).
 *
 * This plan's five pages: insights / members / apps / login / settings.
 * `/dashboard` (legacy home) and `/dashboard/apps` 301-alias are NOT in
 * this set — plan 30 owns those. History fallback is this matcher, not
 * wrangler `not_found_handling`.
 */
export const SPA_PAGES = ["insights", "members", "apps", "login", "settings"] as const;

export type SpaPageId = (typeof SPA_PAGES)[number];

export type SpaRoute =
  | { page: "insights"; pathname: "/dashboard/insights" }
  | { page: "members"; pathname: "/dashboard/members" }
  | { page: "apps"; pathname: "/dashboard/apps" }
  | { page: "login"; pathname: "/dashboard/login" }
  | { page: "settings"; pathname: string; slug: string };

const SETTINGS_PATH = /^\/dashboard\/apps\/([^/]+)\/settings$/;

export function matchSpaRoute(pathname: string): SpaRoute | null {
  switch (pathname) {
    case "/dashboard/insights":
      return { page: "insights", pathname };
    case "/dashboard/members":
      return { page: "members", pathname };
    case "/dashboard/apps":
      return { page: "apps", pathname };
    case "/dashboard/login":
      return { page: "login", pathname };
    default: {
      const match = SETTINGS_PATH.exec(pathname);
      const slug = match?.[1];
      if (!slug) return null;
      return { page: "settings", pathname, slug };
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
