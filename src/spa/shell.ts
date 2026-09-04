/**
 * Pure shell models (plan 33 T2): sidebar carries page nav; navbar is slim
 * (Lang + username + logout). Tested without a DOM runner.
 */
import { NAV_ITEMS, t, type Locale } from "../i18n";
import type { SpaBoot } from "./boot";

export type ShellNavItem = { href: string; label: string; current: boolean };

export type SidebarModel = {
  brand: string;
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
 * Apps → `/dashboard/apps` (+ settings under `/dashboard/apps/:slug`).
 * Insights → `/dashboard/insights` and `/dashboard` (insights home, plan 33).
 */
export function isNavCurrent(href: string, pathname: string): boolean {
  if (href === "/dashboard/apps") {
    return pathname === "/dashboard/apps" || pathname.startsWith("/dashboard/apps/");
  }
  if (href === "/dashboard/insights") {
    return (
      pathname === "/dashboard/insights" ||
      pathname.startsWith("/dashboard/insights/") ||
      pathname === "/dashboard"
    );
  }
  return pathname === href || pathname.startsWith(`${href}/`);
}

export function buildSidebarModel(boot: SpaBoot, pathname: string): SidebarModel {
  return {
    brand: t(boot.locale, "nav.brand"),
    navLabel: t(boot.locale, "nav.primary"),
    items: visibleNavItems(boot.role).map((item) => ({
      href: item.href,
      label: t(boot.locale, item.labelKey),
      current: isNavCurrent(item.href, pathname),
    })),
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
