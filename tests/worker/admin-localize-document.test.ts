/**
 * Binds the server-side locale substitution to the real console document:
 * `localizeDocument` must throw when the template drifts, and must land
 * both substitutions on the actual `src/spa/admin.html` — not on a
 * hand-written mirror of the anchors. The document root declares attributes
 * of its own (`data-surface="ops"`), so each case asserts that the whole
 * `<html>` tag round-trips with only its `lang` value changed.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { t } from "../../src/i18n";
import { localizeDocument } from "../../src/worker/document-locale";

/** The title the console handler passes; the substitution itself is document-agnostic. */
const titleFor = (locale: "en" | "zh_CN") => t(locale, "admin.documentTitle");

const ADMIN_HTML = readFileSync(
  join(import.meta.dir, "../../src/spa/admin.html"),
  "utf8",
);

describe("localizeDocument against the real admin document", () => {
  test("zh_CN lands lang=zh-CN and the Chinese title", () => {
    const html = localizeDocument(ADMIN_HTML, "zh_CN", titleFor("zh_CN"));
    expect(html.match(/<html[^>]*>/)?.[0]).toBe('<html lang="zh-CN" data-surface="ops">');
    expect(html).toContain("<title>Morning Star — 平台运营</title>");
    expect(html).not.toContain('lang="en"');
  });

  test("en keeps lang=en and lands the English title", () => {
    const html = localizeDocument(ADMIN_HTML, "en", titleFor("en"));
    expect(html.match(/<html[^>]*>/)?.[0]).toBe('<html lang="en" data-surface="ops">');
    expect(html).toContain("<title>Morning Star — Platform operations</title>");
  });

  test("a missing lang anchor throws instead of silently serving English", () => {
    const drifted = ADMIN_HTML.replace(' lang="en"', "");
    expect(() => localizeDocument(drifted, "zh_CN", titleFor("zh_CN"))).toThrow(/lang="en"/);
  });

  test("a document with no html element throws", () => {
    expect(() => localizeDocument("<p>no root</p>", "zh_CN", titleFor("zh_CN"))).toThrow(/lang="en"/);
  });

  test("a missing title anchor throws instead of silently keeping the English title", () => {
    const drifted = ADMIN_HTML.replace(/<title>[^<]*<\/title>/, "");
    expect(() => localizeDocument(drifted, "zh_CN", titleFor("zh_CN"))).toThrow(/<title>/);
  });
});
