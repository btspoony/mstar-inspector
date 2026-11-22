import type { DictionaryKey } from "../../i18n/t";

/** A console nav label — one of the `admin.nav.*` keys. */
export type AdminLabelKey = Extract<DictionaryKey, `admin.nav.${string}`>;

export const ADMIN_PAGES = [
  { id: "flags", labelKey: "admin.nav.flags" },
  { id: "runtime", labelKey: "admin.nav.runtime" },
  { id: "workspaces", labelKey: "admin.nav.workspaces" },
  { id: "bots", labelKey: "admin.nav.bots" },
  { id: "usage", labelKey: "admin.nav.usage" },
  { id: "quota-versions", labelKey: "admin.nav.quotaVersions" },
  { id: "users", labelKey: "admin.nav.users" },
  { id: "support-grants", labelKey: "admin.nav.supportGrants" },
  { id: "data-upgrades", labelKey: "admin.nav.dataUpgrades" },
] as const satisfies readonly { id: string; labelKey: AdminLabelKey }[];

export type AdminPageId = (typeof ADMIN_PAGES)[number]["id"];
