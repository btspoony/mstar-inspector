/**
 * Plan 29 T2 tests: i18n dictionary parity, t() interpolation, the
 * resolveLocale decision matrix, and the shared navbar contract.
 *
 * The zh-CN type-level parity (missing key = compile error) is enforced by
 * `zhCN: Dictionary` in src/i18n/zh-CN.ts — this file adds the runtime
 * bidirectional keyof walk and the behavior tests.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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

  test("every en leaf exists in zh-CN (runtime keyof walk)", () => {
    const zhKeys = new Set(collectKeys(zhCN));
    for (const key of collectKeys(en)) {
      expect(zhKeys.has(key), `zh-CN missing ${key}`).toBe(true);
    }
  });

  test("every zh-CN leaf exists in en (runtime keyof walk)", () => {
    const enKeys = new Set(collectKeys(en));
    for (const key of collectKeys(zhCN)) {
      expect(enKeys.has(key), `en missing ${key}`).toBe(true);
    }
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
    // first-tag-only, no q-value parsing: a later zh tag must NOT override an en primary
    { name: "no cookie + AL en-first with later zh → en", acceptLanguage: "en-US,en;q=0.9,zh-CN;q=0.8", expected: "en" },
    // Inverse: a low-q zh first tag still wins — q-values are ignored.
    { name: "no cookie + AL low-q zh first still wins (no q-value parsing)", acceptLanguage: "zh-CN;q=0.1,en;q=1.0", expected: "zh_CN" },
    // bare / underscore tags resolve the same as scripted zh-CN
    { name: "no cookie + AL bare zh → zh_CN", acceptLanguage: "zh", expected: "zh_CN" },
    { name: "no cookie + AL zh_CN underscore → zh_CN", acceptLanguage: "zh_CN", expected: "zh_CN" },
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

  test("first-tag-only: q-values are not parsed (zh;q=0.1 beats later en;q=1.0)", () => {
    // Rationale lives on resolveLocale: browsers already order tags by
    // preference, so honoring a later high-q tag would mis-locale an
    // en-primary bilingual browser. The first listed tag wins even when
    // its q-value is lower than a later tag's.
    expect(
      resolveLocale(requestWith({ "Accept-Language": "zh-CN;q=0.1,en;q=1.0" })),
    ).toBe("zh_CN");
    expect(
      resolveLocale(requestWith({ "Accept-Language": "en-US,en;q=0.9,zh-CN;q=0.8" })),
    ).toBe("en");
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

describe("document title + login copy (plan 29 T7)", () => {
  test("common.pageTitle interpolates nav.brand, never the mstar-inspector slug", () => {
    expect(t("en", "nav.brand")).toBe("Morning Star Inspector");
    expect(t("zh_CN", "nav.brand")).toBe("Morning Star Inspector");
    expect(t("en", "common.pageTitle", { page: "Dashboard", brand: t("en", "nav.brand") })).toBe(
      "Dashboard — Morning Star Inspector",
    );
    expect(t("zh_CN", "common.pageTitle", { page: "Dashboard", brand: t("zh_CN", "nav.brand") })).toBe(
      "Dashboard — Morning Star Inspector",
    );
    expect(t("en", "common.pageTitle", { page: "Dashboard", brand: t("en", "nav.brand") })).not.toContain(
      "mstar-inspector",
    );
  });

  test("login-page zh copy is the dictionary source for the SPA", () => {
    expect(t("zh_CN", "login.heading")).toBe("登录 Morning Star Inspector");
    expect(t("zh_CN", "login.signIn")).toBe("使用 GitHub 登录");
    expect(t("en", "login.heading")).toBe("Sign in to Morning Star Inspector");
    expect(t("en", "login.signIn")).toBe("Sign in with GitHub");
  });
});

describe("REVIEW_ENABLED user copy is absent on restyled surfaces (plan 29 T7)", () => {
  test("no dictionary leaf contains REVIEW_ENABLED", () => {
    for (const locale of LOCALES) {
      for (const key of collectKeys(dictionaries[locale])) {
        const value = t(locale, key as DictionaryKey);
        expect(value, `${locale} ${key}`).not.toContain("REVIEW_ENABLED");
      }
    }
  });

  test("SPA tsx/ts sources on the restyled surface do not contain REVIEW_ENABLED", () => {
    const spaRoot = join(import.meta.dir, "../../src/spa");
    const hits: string[] = [];
    for (const file of new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: spaRoot })) {
      const text = readFileSync(join(spaRoot, file), "utf8");
      if (text.includes("REVIEW_ENABLED")) hits.push(file);
    }
    expect(hits).toEqual([]);
  });
});
