/**
 * Plan 33 T2: shell models per role/locale (no DOM runner in this stack).
 */
import { describe, expect, test } from "bun:test";
import {
  accountDisplay,
  buildNavbarModel,
  buildSidebarModel,
  isNavCurrent,
  otherLocale,
  visibleNavItems,
} from "../../src/spa/shell";
import { NAV_ITEMS, t } from "../../src/i18n";
import { injectSpaBoot, SPA_BOOT_MARKER, type SpaBoot } from "../../src/spa/boot";

const member: SpaBoot = { locale: "en", login: "mallory", name: "Mallory", role: "member" };
const admin: SpaBoot = { locale: "zh_CN", login: "octocat", name: "The Octocat", role: "admin" };

describe("shell models (plan 33 T2)", () => {
  test("nav order is Apps → Insights → Members", () => {
    expect(NAV_ITEMS.map((item) => item.href)).toEqual([
      "/dashboard/apps",
      "/dashboard/insights",
      "/dashboard/members",
    ]);
  });

  test("member does not see Members in the sidebar", () => {
    expect(visibleNavItems("member").map((item) => item.href)).toEqual([
      "/dashboard/apps",
      "/dashboard/insights",
    ]);
    const sidebar = buildSidebarModel(member, "/dashboard/insights");
    expect(sidebar.items.map((item) => item.label)).toEqual(["Apps", "Insights"]);
    expect(sidebar.items.some((item) => item.href === "/dashboard/members")).toBe(false);
  });

  test("admin sees Members in the sidebar", () => {
    const sidebar = buildSidebarModel(admin, "/dashboard/members");
    expect(sidebar.items.map((item) => item.href)).toEqual([
      "/dashboard/apps",
      "/dashboard/insights",
      "/dashboard/members",
    ]);
    expect(sidebar.items.map((item) => item.label)).toEqual(["应用", "洞察", "成员"]);
  });

  test("navbar is slim: Lang + account + logout only", () => {
    const navbar = buildNavbarModel(admin);
    expect(navbar.languageLabel).toBe("EN");
    expect(navbar.languageTarget).toBe("en");
    expect(navbar.accountLabel).toBe("The Octocat (octocat)");
    expect(navbar.logoutLabel).toBe("退出登录");
    expect(Object.keys(navbar)).toEqual(["languageLabel", "languageTarget", "accountLabel", "logoutLabel"]);
  });

  test("brand lives in the sidebar model", () => {
    expect(buildSidebarModel(member, "/dashboard/apps").brand).toBe(t("en", "nav.brand"));
    expect(buildSidebarModel(admin, "/dashboard/members").brand).toBe(t("zh_CN", "nav.brand"));
  });

  test("language toggle targets the other locale", () => {
    expect(otherLocale("en")).toBe("zh_CN");
    expect(otherLocale("zh_CN")).toBe("en");
    const navbar = buildNavbarModel({ ...member, locale: "en" });
    expect(navbar.languageLabel).toBe("中文");
    expect(navbar.languageTarget).toBe("zh_CN");
  });

  test("account chrome is {name (login)}", () => {
    expect(accountDisplay(admin)).toBe("The Octocat (octocat)");
    expect(accountDisplay({ login: "mallory", name: "mallory" })).toBe("mallory");
    expect(accountDisplay({ login: null, name: null })).toBeNull();
  });

  test("logged-out navbar has no account label", () => {
    const navbar = buildNavbarModel({ locale: "en", login: null, name: null, role: null });
    expect(navbar.accountLabel).toBeNull();
  });

  test("Apps current is /dashboard, /dashboard/apps and settings, not insights (plan 40)", () => {
    expect(isNavCurrent("/dashboard/apps", "/dashboard")).toBe(true);
    expect(isNavCurrent("/dashboard/apps", "/dashboard/apps")).toBe(true);
    expect(isNavCurrent("/dashboard/apps", "/dashboard/apps/acme/settings")).toBe(true);
    expect(isNavCurrent("/dashboard/apps", "/dashboard/insights")).toBe(false);
    const apps = buildSidebarModel(member, "/dashboard/apps");
    expect(apps.items.find((item) => item.href === "/dashboard/apps")?.current).toBe(true);
    expect(apps.items.find((item) => item.href === "/dashboard/insights")?.current).toBe(false);
  });

  test("root highlights Apps; Insights current is only /dashboard/insights (plan 40)", () => {
    expect(isNavCurrent("/dashboard/insights", "/dashboard")).toBe(false);
    expect(isNavCurrent("/dashboard/insights", "/dashboard/insights")).toBe(true);
    const root = buildSidebarModel(member, "/dashboard");
    expect(root.items.find((item) => item.href === "/dashboard/apps")?.current).toBe(true);
    expect(root.items.find((item) => item.href === "/dashboard/insights")?.current).toBe(false);
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
