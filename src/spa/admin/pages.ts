/**
 * The admin console's screens.
 *
 * ONE list for both sides of the bundle boundary: the Worker registers the
 * console document at each page path (`src/admin/index.ts`) and the admin entry
 * routes client-side over the same ids (`src/spa/admin/main.tsx`). Kept free of
 * imports — the Worker and the browser both load it.
 */
export const ADMIN_PAGES = [
  { id: "flags", label: "Server flags" },
  { id: "workspaces", label: "Workspaces" },
  { id: "users", label: "Users" },
  { id: "support-grants", label: "Support access" },
] as const;

export type AdminPageId = (typeof ADMIN_PAGES)[number]["id"];
