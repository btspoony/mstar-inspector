/**
 * Binds the server-side locale substitution to the real console document
 * (plan 122, QC seat 3): `localizeDocument` must throw when the template
 * drifts, and must land both substitutions on the actual
 * `src/spa/admin.html` — not on a hand-written mirror of the anchors.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { localizeDocument } from "../../src/admin/index";

const ADMIN_HTML = readFileSync(
  join(import.meta.dir, "../../src/spa/admin.html"),
  "utf8",
);

describe("localizeDocument against the real admin document", () => {
  test("zh_CN lands lang=zh-CN and the Chinese title", () => {
    const html = localizeDocument(ADMIN_HTML, "zh_CN");
    expect(html).toContain('<html lang="zh-CN">');
    expect(html).toContain("<title>Morning Star — 平台运营</title>");
    expect(html).not.toContain('<html lang="en">');
  });

  test("en keeps lang=en and lands the English title", () => {
    const html = localizeDocument(ADMIN_HTML, "en");
    expect(html).toContain('<html lang="en">');
    expect(html).toContain("<title>Morning Star — Platform operations</title>");
  });

  test("a missing lang anchor throws instead of silently serving English", () => {
    const drifted = ADMIN_HTML.replace('<html lang="en">', '<html data-theme="dark">');
    expect(() => localizeDocument(drifted, "zh_CN")).toThrow(/lang="en"/);
  });

  test("a missing title anchor throws instead of silently keeping the English title", () => {
    const drifted = ADMIN_HTML.replace(/<title>[^<]*<\/title>/, "");
    expect(() => localizeDocument(drifted, "zh_CN")).toThrow(/<title>/);
  });
});
