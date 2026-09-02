/**
 * Per-request SPA bootstrap (plan 29 T3).
 *
 * Channel: the Worker SPA dispatcher fetches `dist/spa/index.html` and
 * replaces `<!--SPA_BOOT-->` with `window.__BOOT__ = {…}` before returning
 * the document. The session cookie is HttpOnly, so the client cannot read
 * login/role itself — this injection is the only bootstrap path.
 *
 * Shape is intentionally small (locale + identity). Page data still comes
 * from legacy `/dashboard/api/*` (Task 4).
 */
import type { Locale } from "../i18n";

export type SpaBoot = {
  locale: Locale;
  login: string | null;
  name: string | null;
  role: "admin" | "member" | null;
};

export const EMPTY_BOOT: SpaBoot = { locale: "en", login: null, name: null, role: null };

export const SPA_BOOT_MARKER = "<!--SPA_BOOT-->";

export function readBoot(): SpaBoot {
  const boot = (globalThis as { window?: { __BOOT__?: SpaBoot } }).window?.__BOOT__;
  return boot ?? EMPTY_BOOT;
}

/**
 * Inject the boot script. `<` in JSON is escaped so a display name cannot
 * close the script tag.
 */
export function injectSpaBoot(html: string, boot: SpaBoot): string {
  const json = JSON.stringify(boot).replaceAll("<", "\\u003c");
  const tag = `<script>window.__BOOT__=${json};</script>`;
  if (html.includes(SPA_BOOT_MARKER)) return html.replace(SPA_BOOT_MARKER, tag);
  const headClose = html.indexOf("</head>");
  if (headClose !== -1) return `${html.slice(0, headClose)}${tag}${html.slice(headClose)}`;
  return `${tag}${html}`;
}
