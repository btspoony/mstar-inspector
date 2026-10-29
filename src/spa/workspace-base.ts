import { workspaceRefOf } from "./routes";

/**
 * The URL prefix a page's data reads and in-page links hang off:
 * `/dashboard/<workspaceRef>` on a workspace-scoped page, otherwise the
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
  const ref = workspaceRefOf(pathname);
  return ref === null ? "/dashboard" : `/dashboard/${ref}`;
}

/** No `location` outside a document (static render, tests) → the legacy base. */
function currentPathname(): string {
  // The bundle runs in a document, where `location` exists; this narrow read
  // keeps the module type-safe for the DOM-less programs that import it too.
  const scope = globalThis as { location?: { pathname?: string } };
  return scope.location?.pathname ?? "/dashboard";
}

/**
 * The current origin — the one operator-facing URL the SPA prints in absolute
 * form is the App's webhook delivery URL, and GitHub needs the host, not a
 * path. Same narrow read as currentPathname: outside a document it returns "",
 * so a static render degrades to root-relative `/webhook/...`, never throws.
 */
export function currentOrigin(): string {
  const scope = globalThis as { location?: { origin?: string } };
  return scope.location?.origin ?? "";
}
