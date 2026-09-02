/**
 * Plan 29 T2 tests: i18n dictionary parity, t() interpolation, the
 * resolveLocale decision matrix, and the shared navbar contract.
 *
 * The zh-CN type-level parity (missing key = compile error) is enforced by
 * `zhCN: Dictionary` in src/i18n/zh-CN.ts — this file adds the runtime
 * key-set equality check and the behavior tests.
 */
import { describe, expect, test } from "bun:test";
import { en, type Dictionary } from "../../src/i18n/en";
import { zhCN } from "../../src/i18n/zh-CN";
import { LOCALE_COOKIE, LOCALES, resolveLocale, serializeLocaleCookie, type Locale } from "../../src/i18n/resolve";
import { dictionaries, t, type DictionaryKey } from "../../src/i18n/t";
import { NAV_ITEMS } from "../../src/i18n/nav";

/** All leaf values as dotted paths — the runtime parity key set. */
function collectKeys(node: Record<string, unknown>, prefix = ""): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(node)) {
    const path = prefix ? `${prefix}.${k}` : k;
    if (typeof v === "string") out.push(path);
    else out.push(...collectKeys(v as Record<string, unknown>, path));
  }
  return out;
}

function requestWith(headers: Record<string, string>): Request {
  return new Request("https://worker.local/dashboard", { headers });
}

describe("dictionary parity (plan 29 T2)", () => {
  test("zh-CN satisfies the Dictionary type at compile time (missing key = error)", () => {
    // The type assertion lives in src/i18n/zh-CN.ts (`zhCN: Dictionary`);
    // this runtime check pins the same contract for the test runner.
    const zh: Dictionary = zhCN;
    expect(zh).toBeDefined();
  });

  test("en and zh-CN have identical runtime key sets", () => {
    expect(collectKeys(zhCN).sort()).toEqual(collectKeys(en).sort());
  });

  test("every dictionary value is a plain string (no nested non-leaf values)", () => {
    for (const [locale, dict] of Object.entries(dictionaries) as Array<[Locale, Dictionary]>) {
      for (const key of collectKeys(dict)) {
        // Keys come from the dictionary itself, so they are valid DictionaryKeys.
        expect(typeof t(locale, key as DictionaryKey), `${locale} ${key}`).toBe("string");
      }
    }
  });

  test("dictionaries record covers exactly the two locales", () => {
    expect(Object.keys(dictionaries).sort()).toEqual([...LOCALES].sort());
  });
});

describe("t() interpolation (plan 29 T2)", () => {
  test("plain lookup returns the dictionary value", () => {
    expect(t("en", "nav.apps")).toBe("Apps");
    expect(t("zh_CN", "nav.apps")).toBe("应用");
  });

  test("{placeholder} params are substituted", () => {
    expect(t("en", "notice.success.invited", { login: "octocat" })).toBe(
      "Invited octocat — they can sign in with GitHub now.",
    );
    expect(t("zh_CN", "notice.success.invited", { login: "octocat" })).toBe(
      "已邀请 octocat — 现在可以使用 GitHub 登录了。",
    );
  });

  test("numeric params are stringified", () => {
    expect(t("en", "notice.error.keyTooLong", { length: 200, max: 128 })).toBe(
      "That API key is too long (200 characters) — keys are limited to 128 characters. Nothing was stored.",
    );
  });

  test("a missing param leaves the {placeholder} literal in place", () => {
    expect(t("en", "notice.success.invited")).toBe("Invited {login} — they can sign in with GitHub now.");
  });

  test("language toggle label pair: en shows 中文, zh_CN shows EN", () => {
    expect(t("en", "nav.language")).toBe("中文");
    expect(t("zh_CN", "nav.language")).toBe("EN");
  });
});

describe("resolveLocale decision matrix (plan 29 T2)", () => {
  const cases: Array<{
    name: string;
    cookie?: string;
    acceptLanguage?: string;
    expected: Locale;
  }> = [
    // cookie wins over Accept-Language
    { name: "cookie en + AL zh → en", cookie: "en", acceptLanguage: "zh-CN,zh;q=0.9", expected: "en" },
    { name: "cookie en + AL en → en", cookie: "en", acceptLanguage: "en-US,en;q=0.9", expected: "en" },
    { name: "cookie en + AL neither → en", cookie: "en", acceptLanguage: "fr-FR,fr;q=0.9", expected: "en" },
    { name: "cookie zh_CN + AL zh → zh_CN", cookie: "zh_CN", acceptLanguage: "zh-CN,zh;q=0.9", expected: "zh_CN" },
    { name: "cookie zh_CN + AL en → zh_CN", cookie: "zh_CN", acceptLanguage: "en-US,en;q=0.9", expected: "zh_CN" },
    { name: "cookie zh_CN + AL neither → zh_CN", cookie: "zh_CN", acceptLanguage: "fr-FR,fr;q=0.9", expected: "zh_CN" },
    // invalid cookie is ignored → Accept-Language decides
    { name: "cookie invalid + AL zh → zh_CN", cookie: "fr", acceptLanguage: "zh-TW,zh;q=0.9", expected: "zh_CN" },
    { name: "cookie invalid + AL en → en", cookie: "fr", acceptLanguage: "en-US,en;q=0.9", expected: "en" },
    { name: "cookie invalid + AL neither → en", cookie: "fr", acceptLanguage: "fr-FR,fr;q=0.9", expected: "en" },
    // absent cookie → Accept-Language decides
    { name: "no cookie + AL zh → zh_CN", acceptLanguage: "zh-Hans-CN,zh;q=0.9,en;q=0.8", expected: "zh_CN" },
    { name: "no cookie + AL en → en", acceptLanguage: "en-US,en;q=0.9", expected: "en" },
    { name: "no cookie + AL neither → en", acceptLanguage: "fr-FR,fr;q=0.9", expected: "en" },
    // no headers at all → en
    { name: "no cookie + no AL → en", expected: "en" },
    // case-insensitive zh prefix
    { name: "no cookie + AL ZH-CN uppercase → zh_CN", acceptLanguage: "ZH-CN,zh;q=0.9", expected: "zh_CN" },
  ];

  for (const c of cases) {
    test(c.name, () => {
      const headers: Record<string, string> = {};
      if (c.cookie !== undefined) headers.Cookie = `${LOCALE_COOKIE}=${c.cookie}`;
      if (c.acceptLanguage !== undefined) headers["Accept-Language"] = c.acceptLanguage;
      expect(resolveLocale(requestWith(headers))).toBe(c.expected);
    });
  }

  test("cookie wins even when other cookies are present", () => {
    const req = requestWith({
      Cookie: `__Host-mstar-session=abc; ${LOCALE_COOKIE}=zh_CN; other=1`,
      "Accept-Language": "en-US,en;q=0.9",
    });
    expect(resolveLocale(req)).toBe("zh_CN");
  });
});

describe("mstar_locale cookie serialization (plan 29 T2)", () => {
  test("attribute set mirrors session.ts conventions with Path=/dashboard", () => {
    const value = serializeLocaleCookie("zh_CN");
    expect(value).toContain(`${LOCALE_COOKIE}=zh_CN`);
    expect(value).toContain("HttpOnly");
    expect(value).toContain("Secure");
    expect(value).toContain("SameSite=Lax");
    expect(value).toContain("Path=/dashboard");
    expect(value).toContain("Max-Age=");
  });
});

describe("shared navbar contract (plan 29 T2)", () => {
  test("order is locked: Apps → Insights → Members", () => {
    expect(NAV_ITEMS.map((item) => item.labelKey)).toEqual(["nav.apps", "nav.insights", "nav.members"]);
  });

  test("Members is the only admin-only item", () => {
    expect(NAV_ITEMS.map((item) => item.adminOnly ?? false)).toEqual([false, false, true]);
  });

  test("every labelKey resolves to a real dictionary string in both locales", () => {
    for (const item of NAV_ITEMS) {
      for (const locale of LOCALES) {
        const label = t(locale, item.labelKey);
        expect(label, `${locale} ${item.labelKey}`).not.toBe(item.labelKey);
        expect(label.length).toBeGreaterThan(0);
      }
    }
  });
});
