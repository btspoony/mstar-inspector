import type { MouseEvent } from "react";
import { matchSpaRoute } from "./routes";
import { navigate } from "./router";

/**
 * Client-side navigation for in-app links (plan 40 T2): plain modifier- or
 * middle-clicks keep the browser default (new tab / download); a matching
 * SPA route is pushed through the hash-free router instead. Single shared
 * handler for the sidebar, Apps list and App settings surfaces (plan 46 T2).
 */
export function spaClick(href: string, event: MouseEvent): void {
  if (event.defaultPrevented) return;
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (!matchSpaRoute(href)) return;
  event.preventDefault();
  navigate(href);
}
