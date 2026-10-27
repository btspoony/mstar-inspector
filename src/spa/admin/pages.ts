/**
 * The admin console's screens.
 *
 * ONE list for both sides of the bundle boundary: the Worker registers the
 * console document at each page path (`src/admin/index.ts`) and the admin entry
 * routes client-side over the same ids (`src/spa/admin/main.tsx`). Kept free of
 * runtime imports — the Worker and the browser both load it (the `DictionaryKey`
 * import below is type-only and erased at compile time).
 *
 * `labelKey` is a dictionary key resolved with `t(locale, …)` by the admin
 * entry; the Worker reads only `id` for routing.
 */
import type { DictionaryKey } from "../../i18n/t";

/** A console nav label — one of the `admin.nav.*` keys. */
export type AdminLabelKey = Extract<DictionaryKey, `admin.nav.${string}`>;

export const ADMIN_PAGES = [
  { id: "flags", labelKey: "admin.nav.flags" },
  { id: "workspaces", labelKey: "admin.nav.workspaces" },
  { id: "users", labelKey: "admin.nav.users" },
  { id: "support-grants", labelKey: "admin.nav.supportGrants" },
] as const satisfies readonly { id: string; labelKey: AdminLabelKey }[];

export type AdminPageId = (typeof ADMIN_PAGES)[number]["id"];
