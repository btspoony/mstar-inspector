/**
 * Hash-free client router (plan 29 T3). Enumerated routes only — unknown
 * paths render the unknown stub; the Worker never history-fallbacks them.
 */
import { useEffect, useState, type ReactNode } from "react";
import { matchSpaRoute, type SpaRoute } from "./routes";

export type ClientRoute = SpaRoute | { page: "unknown"; pathname: string };

export function matchRoute(pathname: string): ClientRoute {
  return matchSpaRoute(pathname) ?? { page: "unknown", pathname };
}

export function navigate(href: string): void {
  if (window.location.pathname === href && window.location.search === "") return;
  window.history.pushState(null, "", href);
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
