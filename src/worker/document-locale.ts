/**
 * Server-side locale substitution on an HTML document. Both documents the
 * Worker serves from `ASSETS` (the workspace shell and the gated console)
 * declare `lang="en"` in the template and carry an English `<title>`; the
 * handler that serves one already holds its text and the resolved locale, so
 * this replaces `<html lang>` (BCP 47: `zh_CN` → `zh-CN`) and the title — no
 * second document route, no client-side attribute write.
 *
 * `title` is caller-supplied because the two documents name themselves
 * differently: the console has one fixed title, the workspace shell names the
 * page being served. It is escaped even though dictionary values are plain
 * text by contract.
 *
 * Both anchors must be present: a silent no-op would ship an English document
 * to a `zh_CN` reader, so template drift throws into the caller's error path
 * instead. Both match the tag, not a fixed attribute string — a document root
 * may carry attributes of its own (`data-surface="ops"` on the console), and
 * an exact-substring anchor made every locale throw once one appeared. Every
 * attribute the template declares survives the substitution.
 */
import type { Locale } from "../i18n";

export function localizeDocument(html: string, locale: Locale, title: string): string {
  const lang = locale === "zh_CN" ? "zh-CN" : "en";
  const escapedTitle = title.replaceAll("&", "&amp;").replaceAll("<", "&lt;");
  const langAnchor = /(<html[^>]*\slang=")en(")/;
  if (!langAnchor.test(html)) {
    throw new Error("document is missing the `<html lang=\"en\">` locale anchor");
  }
  const titleAnchor = /(<title[^>]*>)([^<]*)(<\/title>)/;
  if (!titleAnchor.test(html)) {
    throw new Error("document is missing the `<title>` locale anchor");
  }
  return html
    .replace(langAnchor, `$1${lang}$2`)
    .replace(titleAnchor, (_match, open: string, _previous: string, close: string) => `${open}${escapedTitle}${close}`);
}
