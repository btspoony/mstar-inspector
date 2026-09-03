/**
 * Shared navigation contract (plan 29 T2, plan 33 T2 sidebar IA).
 *
 * Order is LOCKED (spec §1.1): Apps → Insights → Members. `labelKey` is a
 * dictionary key (type-checked against en.ts), `adminOnly` gates the
 * Members entry. Apps href is `/dashboard/apps` (plan 33). The language
 * toggle is NOT a nav item — it renders from `t(locale, "nav.language")`
 * (the label of the OTHER locale: en shows 中文, zh_CN shows EN) and POSTs
 * to /dashboard/locale.
 */
import type { DictionaryKey } from "./t";

export type NavItem = { labelKey: DictionaryKey; href: string; adminOnly?: boolean };

export const NAV_ITEMS: NavItem[] = [
  { labelKey: "nav.apps", href: "/dashboard/apps" },
  { labelKey: "nav.insights", href: "/dashboard/insights" },
  { labelKey: "nav.members", href: "/dashboard/members", adminOnly: true },
];
