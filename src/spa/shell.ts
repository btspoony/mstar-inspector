/**
 * Pure shell models: sidebar carries page nav; navbar is slim
 * (Lang + username + logout). Tested without a DOM runner.
 */
import { NAV_ITEMS, t, type Locale } from "../i18n";
import type { SpaBoot } from "./boot";
import { workspaceSlugOf } from "./routes";

export type ShellNavItem = { href: string; label: string; current: boolean };

export type SidebarModel = {
  brand: string;
  /** Same target as the Apps entry: the root is a dead end under `strict`. */
  brandHref: string;
  navLabel: string;
  items: ShellNavItem[];
};

export type NavbarModel = {
  languageLabel: string;
  languageTarget: Locale;
  accountLabel: string | null;
  logoutLabel: string;
};

export function otherLocale(locale: Locale): Locale {
  return locale === "en" ? "zh_CN" : "en";
}

export function visibleNavItems(role: SpaBoot["role"]): typeof NAV_ITEMS {
  return NAV_ITEMS.filter((item) => !item.adminOnly || role === "admin");
}

/** Locked chrome copy: `{name (login)}` when both differ, else login. */
export function accountDisplay(boot: Pick<SpaBoot, "login" | "name">): string | null {
  if (!boot.login) return null;
  if (boot.name && boot.name !== boot.login) return `${boot.name} (${boot.login})`;
  return boot.login;
}

/**
 * Apps → `/dashboard`, `/dashboard/apps` (+ settings under
 * `/dashboard/apps/:slug`) — the root lands on Apps, so the brand href and
 * `/dashboard/apps` highlight the same entry. Remaining entries follow the
 * generic rule below.
 *
 * On a workspace-scoped page BOTH entries follow that workspace: Apps becomes
 * `/dashboard/<ref>/apps` and Members `/dashboard/<ref>/members`, because both
 * route families are workspace-scoped after plan 97. The workspace comes from
 * the pathname, else from the boot (`SpaBoot.workspaceSlug`, the server-resolved
 * sole workspace under `strict`). The generic prefix rule then also marks the
 * scoped Apps entry current on its own detail pages.
 */
export function isNavCurrent(href: string, pathname: string): boolean {
  if (href === "/dashboard/apps") {
    return (
      pathname === "/dashboard" ||
      pathname === "/dashboard/apps" ||
      pathname.startsWith("/dashboard/apps/")
    );
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

/** One nav entry's href under a resolved workspace ref (null = legacy). */
function navHref(baseHref: string, workspaceSlug: string | null): string {
  return workspaceSlug === null ? baseHref : `/dashboard/${workspaceSlug}${baseHref.slice("/dashboard".length)}`;
}

export function buildSidebarModel(boot: SpaBoot, pathname: string): SidebarModel {
  // The page's own prefix wins (it is the route the request was matched
  // against); the boot slug covers the mode-independent pages, whose pathname
  // names no workspace. Both absent → the legacy targets.
  const workspaceSlug = workspaceSlugOf(pathname) ?? boot.workspaceSlug ?? null;
  // No workspace yet → every nav target would 404; the shell keeps its
  // wordmark and drops the entries (plan 97 T3 creation surface).
  const items = boot.needsWorkspace === true ? [] : visibleNavItems(boot.role);
  return {
    brand: t(boot.locale, "nav.brand"),
    // The root workbench 404s its data reads under `strict`, so the wordmark
    // follows the same workspace Apps target as the nav entry there.
    brandHref: workspaceSlug === null ? "/dashboard" : `/dashboard/${workspaceSlug}/apps`,
    navLabel: t(boot.locale, "nav.primary"),
    items: items.map((item) => {
      const href = navHref(item.href, workspaceSlug);
      return {
        href,
        label: t(boot.locale, item.labelKey),
        current: isNavCurrent(href, pathname),
      };
    }),
  };
}

export function buildNavbarModel(boot: SpaBoot): NavbarModel {
  return {
    languageLabel: t(boot.locale, "nav.language"),
    languageTarget: otherLocale(boot.locale),
    accountLabel: accountDisplay(boot),
    logoutLabel: t(boot.locale, "nav.logout"),
  };
}
