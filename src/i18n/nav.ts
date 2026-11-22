import type { DictionaryKey } from "./t";

export type NavItem = { labelKey: DictionaryKey; href: string };

export const NAV_ITEMS: NavItem[] = [
  { labelKey: "nav.targets", href: "/dashboard/repos" },
  { labelKey: "nav.apps", href: "/dashboard/apps" },
  { labelKey: "nav.members", href: "/dashboard/members" },
  { labelKey: "nav.settings", href: "/dashboard/settings" },
];
