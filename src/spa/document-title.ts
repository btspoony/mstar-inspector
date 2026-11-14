/**
 * The document title for one SPA page, shared by the Worker (which writes it
 * into the shell document) and the router effect (which writes it on a
 * client-side navigation) — one mapping, so the two faces can never disagree
 * about what a page is called.
 *
 * `common.pageTitle` supplies the `{page} — {brand}` frame; a page id with no
 * label of its own falls back to the brand alone rather than an empty segment.
 */
import { t, type DictionaryKey, type Locale } from "../i18n";
import type { SpaPageId } from "./routes";

const PAGE_LABELS: Record<SpaPageId, DictionaryKey> = {
  apps: "nav.apps",
  members: "nav.members",
  settings: "nav.settings",
  login: "login.heading",
  "app-detail": "appDetail.documentPage",
};

export function pageDocumentTitle(locale: Locale, page: SpaPageId | null): string {
  const brand = t(locale, "nav.brand");
  if (page === null) return brand;
  return t(locale, "common.pageTitle", { page: t(locale, PAGE_LABELS[page]), brand });
}
