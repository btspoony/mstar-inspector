/**
 * i18n module public face (plan 29 T2).
 *
 * The single string table for the whole dashboard: en.ts is the source of
 * truth, zh-CN.ts is type-checked against it, resolve.ts owns the locale
 * decision chain + mstar_locale cookie, t.ts is the isomorphic lookup, and
 * nav.ts is the shared navbar contract for Task 3's Layout.
 */
export { en, type Dictionary } from "./en";
export { zhCN } from "./zh-CN";
export {
  LOCALE_COOKIE,
  LOCALE_MAX_AGE_SEC,
  LOCALES,
  isLocale,
  resolveLocale,
  serializeLocaleCookie,
  type Locale,
} from "./resolve";
export { dictionaries, t, type DictionaryKey } from "./t";
export { NAV_ITEMS, type NavItem } from "./nav";
