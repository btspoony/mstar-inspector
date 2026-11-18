/**
 * Unit tests: i18n dictionary parity, t() interpolation, the
 * resolveLocale decision matrix, and the shared navbar contract.
 *
 * The zh-CN type-level parity (missing key = compile error) is enforced by
 * `zhCN: Dictionary` in src/i18n/zh-CN.ts — this file adds the runtime
 * bidirectional keyof walk and the behavior tests.
 */
import { describe, expect, test } from "bun:test";
import { en, type Dictionary } from "../../src/i18n/en";
import { zhCN } from "../../src/i18n/zh-CN";
import { LOCALE_COOKIE, LOCALES, resolveLocale, serializeLocaleCookie, type Locale } from "../../src/i18n/resolve";
import { dictionaries, isDictionaryKey, t, type DictionaryKey } from "../../src/i18n/t";
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

describe("dictionary parity", () => {
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

describe("t() interpolation", () => {
  test("plain lookup returns the dictionary value", () => {
    expect(t("en", "nav.apps")).toBe("Apps");
    expect(t("zh_CN", "nav.apps")).toBe("应用");
  });

  test("{placeholder} params are substituted", () => {
    expect(t("en", "notice.success.invited", { login: "octocat" })).toBe(
      "Invited octocat — they can accept from this workspace now.",
    );
    expect(t("zh_CN", "notice.success.invited", { login: "octocat" })).toBe(
      "已邀请 octocat — 对方现在可以在本工作区接受邀请。",
    );
  });

  test("numeric params are stringified", () => {
    // Fixture re-pointed: the old fixture notice.error.keyTooLong
    // was an audit-dead key with no production consumer; common.time.minutesAgo
    // exercises the same number→string substitution on a live key.
    expect(t("en", "common.time.minutesAgo", { count: 200 })).toBe("200 minutes ago");
  });

  test("two {placeholder} params are substituted in one value", () => {
    // Two-param coverage restored: the numeric fixture
    // above was re-pointed to a one-param key (the old
    // notice.error.keyTooLong was audit-dead). notice.success.roleChanged is
    // a live two-param key — the MembersPage role-change notice.
    expect(t("en", "notice.success.roleChanged", { login: "octocat", role: "admin" })).toBe(
      "octocat is now admin.",
    );
    expect(t("zh_CN", "notice.success.roleChanged", { login: "octocat", role: "admin" })).toBe(
      "octocat 现在是admin。",
    );
  });

  test("a missing param leaves the {placeholder} literal in place", () => {
    expect(t("en", "notice.success.invited")).toBe("Invited {login} — they can accept from this workspace now.");
  });

  test("language toggle label pair: en shows 中文, zh_CN shows EN", () => {
    expect(t("en", "nav.language")).toBe("中文");
    expect(t("zh_CN", "nav.language")).toBe("EN");
  });
});

describe("resolveLocale decision matrix", () => {
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

describe("mstar_locale cookie serialization", () => {
  test("attribute set mirrors session.ts conventions with Path=/ (console shares the cookie)", () => {
    const value = serializeLocaleCookie("zh_CN");
    expect(value).toContain(`${LOCALE_COOKIE}=zh_CN`);
    expect(value).toContain("HttpOnly");
    expect(value).toContain("Secure");
    expect(value).toContain("SameSite=Lax");
    expect(value).toContain("Path=/");
    expect(value).toContain("Max-Age=");
  });
});

describe("shared navbar contract", () => {
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

describe("document title + login copy", () => {
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
    // Card heading form lock: the concise card heading — the brand name
    // moved to the wordmark echo above the card (nav.brand), so the title
    // no longer carries it.
    expect(t("zh_CN", "login.heading")).toBe("登录");
    expect(t("zh_CN", "login.signIn")).toBe("使用 GitHub 登录");
    expect(t("en", "login.heading")).toBe("Sign in");
    expect(t("en", "login.signIn")).toBe("Sign in with GitHub");
  });
});

describe("App detail IA copy", () => {
  test("the App detail's two tab labels exist atomically in both locales — 应用设置 / 已安装", () => {
    expect(t("en", "appDetail.tabSettings")).toBe("App settings");
    expect(t("zh_CN", "appDetail.tabSettings")).toBe("应用设置");
    expect(t("en", "appDetail.tabInstallations")).toBe("Installed");
    expect(t("zh_CN", "appDetail.tabInstallations")).toBe("已安装");
    // The zero-repository state is copy, not an error, so it must exist too.
    expect(t("en", "appDetail.noRepository").length).toBeGreaterThan(0);
    expect(t("zh_CN", "appDetail.noRepository").length).toBeGreaterThan(0);
  });

  test("the repository surface copy exists atomically in both locales", () => {
    // The nav label and every repository surface string — list, add dialog,
    // detail tabs — live under `targets.*`; nothing is inline.
    expect(t("en", "nav.targets")).toBe("Repositories");
    expect(t("zh_CN", "nav.targets")).toBe("仓库");
    expect(t("en", "targets.heading")).toBe("Repositories");
    expect(t("zh_CN", "targets.heading")).toBe("仓库");
    expect(t("en", "targets.emptyTitle")).toBe("No repositories yet");
    expect(t("en", "targets.allRepositories")).toBe("All repositories");
    expect(t("zh_CN", "targets.allRepositories")).toBe("所有仓库");
    expect(t("en", "targets.addDialog.noInstallationRepos")).toBe(
      "This App is not installed on any repository.",
    );
    expect(t("zh_CN", "targets.addDialog.duplicates").length).toBeGreaterThan(0);
    // The three detail tabs and the 评审配置 tab's own copy.
    expect(t("en", "targets.tabInsights")).toBe("Insights");
    expect(t("zh_CN", "targets.tabPullRequests")).toBe("拉取请求");
    expect(t("en", "targets.settings.heading")).toBe("Review settings");
    expect(t("zh_CN", "targets.settings.heading")).toBe("评审配置");
    expect(t("en", "targets.settings.follow")).toBe("Follow workspace defaults");
    expect(t("zh_CN", "targets.settings.following").length).toBeGreaterThan(0);
    // The App detail's data tabs left this page with the surfaces themselves.
    expect(isDictionaryKey("appDetail.tabInsights")).toBe(false);
    expect(isDictionaryKey("appDetail.tabPullRequests")).toBe(false);
  });

  test("the back-to-apps wayfinding key lives under appDetail atomically; the old settings key is removed, not aliased", () => {
    expect(t("en", "appDetail.backToApps")).toBe("Back to Apps");
    expect(t("zh_CN", "appDetail.backToApps")).toBe("返回应用");
    expect(isDictionaryKey("appDetail.backToApps")).toBe(true);
    expect(isDictionaryKey("settings.backToApps")).toBe(false);
  });

  test("the installations section keys exist atomically; the retired eyebrow and sentence keys are removed, not aliased", () => {
    for (const key of [
      "settings.installations",
      "settings.installationsAccount",
      "settings.installationsId",
      "settings.installationsLastSync",
      "settings.installationsCount",
      "settings.installationsCountOne",
      "settings.installationsState",
      "settings.installationsLive",
      "settings.noInstallations",
    ] as const) {
      expect(isDictionaryKey(key), key).toBe(true);
      expect(t("en", key).length, key).toBeGreaterThan(0);
      expect(t("zh_CN", key).length, key).toBeGreaterThan(0);
    }
    // The identifier column must not repeat the section title it sits under:
    // one word for both left the header indistinguishable from its heading.
    for (const locale of ["en", "zh_CN"] as const) {
      expect(t(locale, "settings.installationsId"), locale).not.toBe(
        t(locale, "settings.installations"),
      );
    }
    // The settings tab is a section flow now: the two tier-group eyebrow keys
    // and the per-row installation sentence (replaced by the table's account /
    // installation / last-sync columns) leave with it. The availability badge
    // and the allowlist copy leave with the allowlist surface.
    for (const key of [
      "settings.group.appInfo",
      "settings.group.configuration",
      "settings.installation",
      "settings.lastSeen",
      "settings.installationsAvailability",
      "settings.availabilityValid",
      "settings.availabilityInvalid",
      "settings.installationsNotVisible",
      "settings.allowlist",
      "settings.allowlistCopy",
      "settings.allowlistEnable",
      "settings.allowlistOwners",
      "settings.allowlistFailClosed",
      "settings.allowlistPrivateStillApplies",
      "settings.allowlistSave",
    ] as const) {
      expect(isDictionaryKey(key), key).toBe(false);
    }
  });

  test("the insights tab copy returns with the per-App view — window segments keep the 7/30/90 semantics", () => {
    // The records page's window/repo vocabulary is reused verbatim by the
    // per-App insights tab (the segments label the same day counts).
    expect(t("en", "insights.daysShort", { count: 7 })).toBe("7d");
    expect(t("zh_CN", "insights.daysShort", { count: 7 })).toBe("7 天");
    expect(t("en", "insights.filterRepoAll")).toBe("All");
    expect(t("zh_CN", "insights.filterRepoAll")).toBe("全部");
  });
});

describe("creation chooser copy", () => {
  /** Every key the chooser renders, both locales. */
  const KEYS = [
    "apps.createDialog.title",
    "apps.createDialog.description",
    "apps.createDialog.botTargets",
    "apps.createDialog.noSharedBots",
    "apps.createDialog.selfHostedSubmit",
  ] as const;

  test("every chooser key exists in both locales", () => {
    for (const key of KEYS) {
      expect(isDictionaryKey(key), key).toBe(true);
      expect(t("en", key).length, key).toBeGreaterThan(0);
      expect(t("zh_CN", key).length, key).toBeGreaterThan(0);
    }
  });

  test("the official-mode form's keys are removed, not aliased", () => {
    // They left with their only consumer — the deleted target-creating form.
    for (const key of [
      "apps.createDialog.modeOfficial",
      "apps.createDialog.modeSelfHosted",
      "apps.createDialog.botLabel",
      "apps.createDialog.botPlaceholder",
      "apps.createDialog.botTargetOne",
      "apps.createDialog.submit",
      "apps.createDialog.failed",
    ] as const) {
      expect(isDictionaryKey(key), key).toBe(false);
    }
  });

  test("the bot option carries its name and this workspace's target count", () => {
    expect(t("en", "apps.createDialog.botTargets", { name: "Platform", count: 3 })).toContain("3");
    expect(t("zh_CN", "apps.createDialog.botTargets", { name: "Platform", count: 3 })).toContain("3");
  });

  test("the existing Create label and its unavailable reasons are not reworded", () => {
    expect(t("en", "apps.create")).toBe("Create GitHub App");
    expect(t("zh_CN", "apps.create")).toBe("创建 GitHub App");
    expect(t("en", "apps.createUnavailable.role")).toContain("owner or admin");
  });
});
