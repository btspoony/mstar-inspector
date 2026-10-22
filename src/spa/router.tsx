/**
 * Hash-free client router. Enumerated routes only — unknown
 * paths render the unknown stub; the Worker never history-fallbacks them.
 */
import { useEffect, useState, type ReactNode } from "react";
import { matchSpaRoute, type SpaRoute } from "./routes";

export type ClientRoute = SpaRoute | { page: "unknown"; pathname: string };

export function matchRoute(pathname: string): ClientRoute {
  return matchSpaRoute(pathname) ?? { page: "unknown", pathname };
}

/**
 * Push (or, with `replace`, overwrite) one in-app location and notify the
 * router. `replace` is for a navigation that leaves a DEAD history entry
 * behind — a workspace slug rename retires the old ref (it answers 404), so
 * Back must not return to it.
 */
export function navigate(href: string, options: { replace?: boolean } = {}): void {
  if (window.location.pathname === href && window.location.search === "") return;
  if (options.replace) window.history.replaceState(null, "", href);
  else window.history.pushState(null, "", href);
  window.dispatchEvent(new PopStateEvent("popstate"));
}

export function usePathname(): string {
  const [path, setPath] = useState(() => window.location.pathname);
  useEffect(() => {
    const onPop = () => setPath(window.location.pathname);
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
  return path;
}

export function Router(props: { children: (route: ClientRoute) => ReactNode }) {
  const path = usePathname();
  return props.children(matchRoute(path));
}
