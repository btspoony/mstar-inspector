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
