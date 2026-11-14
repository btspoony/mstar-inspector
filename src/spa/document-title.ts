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

/**
 * A page the shell renders INSTEAD of the route's own page. Two early returns
 * in `pages.tsx` do this: a workspace-less sign-in sees the setup page, and a
 * support-grant operator sees the read-only support page, whatever the URL
 * names. The title has to follow what is on screen, not the path.
 */
export type DocumentFace = "workspace-setup" | "support";

const FACE_LABELS: Record<DocumentFace, DictionaryKey> = {
  "workspace-setup": "workspace.setupHeading",
  support: "support.heading",
};

/** The boot's face flags, resolved in the same order `pages.tsx` renders them. */
export function documentFaceOf(boot: {
  needsWorkspace?: boolean | undefined;
  supportOnly?: boolean | undefined;
}): DocumentFace | null {
  if (boot.needsWorkspace === true) return "workspace-setup";
  if (boot.supportOnly === true) return "support";
  return null;
}

const PAGE_LABELS: Record<SpaPageId, DictionaryKey> = {
  apps: "nav.apps",
  members: "nav.members",
  settings: "nav.settings",
  login: "login.heading",
  "app-detail": "appDetail.documentPage",
};

export function pageDocumentTitle(
  locale: Locale,
  page: SpaPageId | null,
  face: DocumentFace | null = null,
): string {
  const brand = t(locale, "nav.brand");
  const label = face !== null ? FACE_LABELS[face] : page === null ? null : PAGE_LABELS[page];
  if (label === null) return brand;
  return t(locale, "common.pageTitle", { page: t(locale, label), brand });
}
