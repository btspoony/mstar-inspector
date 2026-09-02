/**
 * Pure navbar model (plan 29 T3). Layout renders this; tests cover role
 * and locale without a DOM runner.
 */
import { NAV_ITEMS, t, type Locale } from "../i18n";
import type { SpaBoot } from "./boot";

export type NavbarItem = { href: string; label: string; current: boolean };

export type NavbarModel = {
  brand: string;
  items: NavbarItem[];
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

export function buildNavbarModel(boot: SpaBoot, pathname: string): NavbarModel {
  return {
    brand: t(boot.locale, "nav.brand"),
    items: visibleNavItems(boot.role).map((item) => ({
      href: item.href,
      label: t(boot.locale, item.labelKey),
      current: pathname === item.href || pathname.startsWith(`${item.href}/`),
    })),
    languageLabel: t(boot.locale, "nav.language"),
    languageTarget: otherLocale(boot.locale),
    accountLabel: accountDisplay(boot),
    logoutLabel: t(boot.locale, "nav.logout"),
  };
}
