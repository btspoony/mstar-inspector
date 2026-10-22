/**
 * Shared navigation contract (the sidebar IA).
 *
 * Order is LOCKED (spec § IA, dashboard nav): Apps → Members (the global
 * insights entry is retired). `labelKey` is a dictionary key (type-checked
 * against en.ts). Every entry is visible to every workspace member; what a
 * page OFFERS is gated inside the page (the workspace-membership decision,
 * 2026-10). Apps href is `/dashboard/apps`. The language toggle is NOT a nav
 * item — it renders from
 * `t(locale, "nav.language")` (the label of the OTHER locale: en shows 中文,
 * zh_CN shows EN) and POSTs to /dashboard/locale.
 */
import type { DictionaryKey } from "./t";

export type NavItem = { labelKey: DictionaryKey; href: string };

export const NAV_ITEMS: NavItem[] = [
  { labelKey: "nav.apps", href: "/dashboard/apps" },
  { labelKey: "nav.members", href: "/dashboard/members" },
];
