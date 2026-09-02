/**
 * Plan 29 T3: navbar model per role/locale (no DOM runner in this stack).
 */
import { describe, expect, test } from "bun:test";
import { accountDisplay, buildNavbarModel, isNavCurrent, otherLocale, visibleNavItems } from "../../src/spa/navbar";
import { NAV_ITEMS, t } from "../../src/i18n";
import { injectSpaBoot, SPA_BOOT_MARKER, type SpaBoot } from "../../src/spa/boot";

const member: SpaBoot = { locale: "en", login: "mallory", name: "Mallory", role: "member" };
const admin: SpaBoot = { locale: "zh_CN", login: "octocat", name: "The Octocat", role: "admin" };

describe("navbar model (plan 29 T3)", () => {
  test("nav order is Apps → Insights → Members", () => {
    expect(NAV_ITEMS.map((item) => item.href)).toEqual([
      "/dashboard",
      "/dashboard/insights",
      "/dashboard/members",
    ]);
  });

  test("member does not see Members", () => {
    expect(visibleNavItems("member").map((item) => item.href)).toEqual([
      "/dashboard",
      "/dashboard/insights",
    ]);
    const model = buildNavbarModel(member, "/dashboard/insights");
    expect(model.items.map((item) => item.label)).toEqual(["Apps", "Insights"]);
    expect(model.items.some((item) => item.href === "/dashboard/members")).toBe(false);
  });

  test("admin sees Members between Insights and the language toggle", () => {
    const model = buildNavbarModel(admin, "/dashboard/members");
    expect(model.items.map((item) => item.href)).toEqual([
      "/dashboard",
      "/dashboard/insights",
      "/dashboard/members",
    ]);
    expect(model.items.map((item) => item.label)).toEqual(["应用", "洞察", "成员"]);
    expect(model.languageLabel).toBe("EN");
    expect(model.languageTarget).toBe("en");
  });

  test("brand is t(locale, nav.brand)", () => {
    expect(buildNavbarModel(member, "/dashboard/apps").brand).toBe(t("en", "nav.brand"));
    expect(buildNavbarModel(admin, "/dashboard/members").brand).toBe(t("zh_CN", "nav.brand"));
    expect(buildNavbarModel(member, "/dashboard/apps").brand).toBe("Morning Star Inspector");
  });

  test("language toggle targets the other locale", () => {
    expect(otherLocale("en")).toBe("zh_CN");
    expect(otherLocale("zh_CN")).toBe("en");
    const en = buildNavbarModel({ ...member, locale: "en" }, "/dashboard/apps");
    expect(en.languageLabel).toBe("中文");
    expect(en.languageTarget).toBe("zh_CN");
  });

  test("account chrome is {name (login)}", () => {
    expect(accountDisplay(admin)).toBe("The Octocat (octocat)");
    expect(accountDisplay({ login: "mallory", name: "mallory" })).toBe("mallory");
    expect(accountDisplay({ login: null, name: null })).toBeNull();
  });

  test("logged-out chrome has no account label", () => {
    const model = buildNavbarModel(
      { locale: "en", login: null, name: null, role: null },
      "/dashboard/login",
    );
    expect(model.accountLabel).toBeNull();
    expect(model.items.map((item) => item.label)).toEqual(["Apps", "Insights"]);
  });

  test("Apps current is /dashboard and /dashboard/apps, not insights", () => {
    expect(isNavCurrent("/dashboard", "/dashboard")).toBe(true);
    expect(isNavCurrent("/dashboard", "/dashboard/apps")).toBe(true);
    expect(isNavCurrent("/dashboard", "/dashboard/apps/acme/settings")).toBe(true);
    expect(isNavCurrent("/dashboard", "/dashboard/insights")).toBe(false);
    expect(isNavCurrent("/dashboard", "/dashboard/members")).toBe(false);
    expect(isNavCurrent("/dashboard", "/dashboard/login")).toBe(false);
    const home = buildNavbarModel(member, "/dashboard");
    expect(home.items.find((item) => item.href === "/dashboard")?.current).toBe(true);
    expect(home.items.find((item) => item.href === "/dashboard/insights")?.current).toBe(false);
  });
});

describe("injectSpaBoot (plan 29 T3)", () => {
  test("replaces the marker with window.__BOOT__", () => {
    const html = `<head>${SPA_BOOT_MARKER}</head>`;
    const out = injectSpaBoot(html, member);
    expect(out).toContain("window.__BOOT__=");
    expect(out).toContain('"login":"mallory"');
    expect(out).not.toContain(SPA_BOOT_MARKER);
  });

  test("escapes < so a name cannot break out of the script tag", () => {
    const html = `<head>${SPA_BOOT_MARKER}</head>`;
    const out = injectSpaBoot(html, { ...member, name: "</script><b>xss</b>" });
    expect(out).not.toContain("</script><b>");
    expect(out).toContain("\\u003c/script>");
  });
});
