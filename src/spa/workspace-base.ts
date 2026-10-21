import { workspaceSlugOf } from "./routes";

/**
 * The URL prefix a page's data reads and in-page links hang off:
 * `/dashboard/<workspaceSlug>` on a workspace-scoped page, otherwise the
 * legacy `/dashboard` mount. Reads `location.pathname` (the same path the
 * Worker's tenant gate classified), so the SPA keeps no second workspace
 * identity in boot state — a boot-injected base would go stale on the first
 * `pushState` navigation.
 *
 * The optional pathname keeps the derivation pure for tests and static
 * renders; the argument is inert in the bundle, where the current location is
 * always available.
 */
export function apiBase(pathname: string = currentPathname()): string {
  const slug = workspaceSlugOf(pathname);
  return slug === null ? "/dashboard" : `/dashboard/${slug}`;
}

/** No `location` outside a document (static render, tests) → the legacy base. */
function currentPathname(): string {
  // The bundle runs in a document, where `location` exists; this narrow read
  // keeps the module type-safe for the DOM-less programs that import it too.
  const scope = globalThis as { location?: { pathname?: string } };
  return scope.location?.pathname ?? "/dashboard";
}
