import type { MouseEvent } from "react";
import { matchSpaRoute } from "./routes";
import { navigate } from "./router";

/**
 * Client-side navigation for in-app links: plain modifier- or
 * middle-clicks keep the browser default (new tab / download); a matching
 * SPA route is pushed through the hash-free router instead. Single shared
 * handler for the sidebar, Apps list and App settings surfaces.
 */
export function spaClick(href: string, event: MouseEvent): void {
  if (event.defaultPrevented) return;
  if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  if (!matchSpaRoute(href)) return;
  event.preventDefault();
  navigate(href);
}
