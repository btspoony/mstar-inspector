/**
 * shell models per role/locale (no DOM runner in this stack).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  accountDisplay,
  buildNavbarModel,
  buildSidebarModel,
  isNavCurrent,
  otherLocale,
  workspaceMembershipForRef,
} from "../../src/spa/shell";
import { NAV_ITEMS, t } from "../../src/i18n";
import { injectSpaBoot, SPA_BOOT_MARKER, type SpaBoot } from "../../src/spa/boot";

const member: SpaBoot = { locale: "en", login: "mallory", name: "Mallory" };
const admin: SpaBoot = { locale: "zh_CN", login: "octocat", name: "The Octocat" };

describe("shell models", () => {
  test("nav order is Apps → Members → Settings (insights retired)", () => {
    expect(NAV_ITEMS.map((item) => item.href)).toEqual([
      "/dashboard/apps",
      "/dashboard/members",
      "/dashboard/settings",
    ]);
  });

  test("a plain member sees Members too (nav is not role-gated)", () => {
    // The Members page is readable by every workspace member; its in-page
    // actions carry the role gate. Nav visibility must not hide the entry.
    const sidebar = buildSidebarModel(member, "/dashboard/apps");
    expect(sidebar.items.map((item) => item.label)).toEqual(["Apps", "Members", "Settings"]);
    const scoped = buildSidebarModel(member, "/dashboard/acme/apps");
    expect(scoped.items.map((item) => item.href)).toEqual([
      "/dashboard/acme/apps",
      "/dashboard/acme/members",
      "/dashboard/acme/settings",
    ]);
    // The global insights page is retired: no sidebar entry renders for it.
    expect(sidebar.items.some((item) => item.href === "/dashboard/insights")).toBe(false);
  });

  test("the admin sees the same entries", () => {
    const sidebar = buildSidebarModel(admin, "/dashboard/acme/members");
    expect(sidebar.items.map((item) => item.href)).toEqual([
      "/dashboard/acme/apps",
      "/dashboard/acme/members",
      "/dashboard/acme/settings",
    ]);
    expect(sidebar.items.map((item) => item.label)).toEqual(["应用", "成员", "设置"]);
  });

  test("navbar is slim: theme + Lang + account + logout only", () => {
    const navbar = buildNavbarModel(admin);
    expect(navbar.languageLabel).toBe("EN");
    expect(navbar.languageTarget).toBe("en");
    expect(navbar.accountLabel).toBe("The Octocat (octocat)");
    expect(navbar.logoutLabel).toBe("退出登录");
    // the theme toggle is pure client state rendered directly in
    // Layout's header — the boot-derived navbar model gains no key.
    expect(Object.keys(navbar)).toEqual(["languageLabel", "languageTarget", "accountLabel", "logoutLabel"]);
  });

  test("brand lives in the sidebar model", () => {
    expect(buildSidebarModel(member, "/dashboard/apps").brand).toBe(t("en", "nav.brand"));
    expect(buildSidebarModel(admin, "/dashboard/acme/members").brand).toBe(t("zh_CN", "nav.brand"));
  });

  test("the wordmark follows the workspace, like the Apps entry", () => {
    // Legacy pages keep the root; a workspace page names its own Apps list,
    // so the brand link never lands on the strict-mode dead end.
    expect(buildSidebarModel(member, "/dashboard/apps").brandHref).toBe("/dashboard");
    expect(buildSidebarModel(admin, "/dashboard/acme/apps").brandHref).toBe("/dashboard/acme/apps");
    expect(
      buildSidebarModel(admin, "/dashboard/acme/apps/acme-app/settings").brandHref,
    ).toBe("/dashboard/acme/apps");
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
    const navbar = buildNavbarModel({ locale: "en", login: null, name: null });
    expect(navbar.accountLabel).toBeNull();
  });

  test("Apps current is /dashboard, /dashboard/apps and settings", () => {
    expect(isNavCurrent("/dashboard/apps", "/dashboard")).toBe(true);
    expect(isNavCurrent("/dashboard/apps", "/dashboard/apps")).toBe(true);
    expect(isNavCurrent("/dashboard/apps", "/dashboard/apps/acme/settings")).toBe(true);
    const apps = buildSidebarModel(member, "/dashboard/apps");
    expect(apps.items.find((item) => item.href === "/dashboard/apps")?.current).toBe(true);
  });

  test("root highlights Apps", () => {
    const root = buildSidebarModel(member, "/dashboard");
    expect(root.items.find((item) => item.href === "/dashboard/apps")?.current).toBe(true);
  });

  test("a workspace page keeps BOTH nav entries inside its workspace", () => {
    const sidebar = buildSidebarModel(admin, "/dashboard/acme/apps");
    expect(sidebar.items.map((item) => item.href)).toEqual([
      "/dashboard/acme/apps",
      "/dashboard/acme/members",
      "/dashboard/acme/settings",
    ]);
    expect(sidebar.items.find((item) => item.href === "/dashboard/acme/apps")?.current).toBe(true);
    // The App detail page under the same workspace keeps the entry current.
    const detail = buildSidebarModel(admin, "/dashboard/acme/apps/acme-app/settings");
    expect(detail.items.find((item) => item.href === "/dashboard/acme/apps")?.current).toBe(true);
    expect(detail.items.find((item) => item.href === "/dashboard/acme/members")?.current).toBe(false);
  });

  test("a workspace-active Members page names its own workspace from the pathname", () => {
    // Members is workspace-routed, so the pathname itself names
    // the workspace; every nav target stays inside it.
    const sidebar = buildSidebarModel({ ...admin, workspaceRef: "other" }, "/dashboard/acme/members");
    expect(sidebar.brandHref).toBe("/dashboard/acme/apps");
    expect(sidebar.items.map((item) => item.href)).toEqual([
      "/dashboard/acme/apps",
      "/dashboard/acme/members",
      "/dashboard/acme/settings",
    ]);
    expect(sidebar.items.find((item) => item.href === "/dashboard/acme/members")?.current).toBe(true);
  });

  test("the page's own workspace wins over the boot ref (one workspace identity per page)", () => {
    const sidebar = buildSidebarModel({ ...admin, workspaceRef: "other" }, "/dashboard/acme/apps");
    expect(sidebar.items.map((item) => item.href)).toEqual([
      "/dashboard/acme/apps",
      "/dashboard/acme/members",
      "/dashboard/acme/settings",
    ]);
    expect(sidebar.brandHref).toBe("/dashboard/acme/apps");
  });

  test("the boot ref still scopes a pathname that names no workspace", () => {
    // `/dashboard/apps` is the legacy page; on a strict deployment the boot's
    // server-resolved slug carries the workspace into both nav targets.
    const sidebar = buildSidebarModel({ ...admin, workspaceRef: "acme" }, "/dashboard/apps");
    expect(sidebar.brandHref).toBe("/dashboard/acme/apps");
    expect(sidebar.items.map((item) => item.href)).toEqual([
      "/dashboard/acme/apps",
      "/dashboard/acme/members",
      "/dashboard/acme/settings",
    ]);
  });

  test("no boot ref → the legacy targets are unchanged", () => {
    const sidebar = buildSidebarModel(admin, "/dashboard/apps");
    expect(sidebar.brandHref).toBe("/dashboard");
    expect(sidebar.items.map((item) => item.href)).toEqual([
      "/dashboard/apps",
      "/dashboard/members",
      "/dashboard/settings",
    ]);
  });

  test("workspaceMembershipForRef resolves by id or slug and carries the role", () => {
    // The settings page gates the slug editor on this row's role, so the
    // lookup must survive both addressing forms the URL may carry.
    const boot: SpaBoot = {
      ...member,
      memberships: [{ id: "ws-1", slug: "acme", name: "Acme", role: "member", plan: "Free" }],
    };
    expect(workspaceMembershipForRef(boot, "ws-1")?.slug).toBe("acme");
    expect(workspaceMembershipForRef(boot, "acme")?.role).toBe("member");
    expect(workspaceMembershipForRef(boot, "ghost")).toBeNull();
    expect(workspaceMembershipForRef(boot, null)).toBeNull();
  });
});

describe("navbar theme toggle", () => {
  const layoutSource = () => readFileSync(join(import.meta.dir, "../../src/spa/Layout.tsx"), "utf8");
  const shellSource = () => readFileSync(join(import.meta.dir, "../../src/spa/index.html"), "utf8");

  test("slim navbar gains one theme toggle beside the locale form (client state only)", () => {
    const source = layoutSource();
    expect(source).toContain("THEME_STORAGE_KEY");
    expect(source).toContain('aria-label={t(boot.locale, "nav.themeToggleAria"');
    expect(source).toContain('variant="ghost"');
    expect(source).toContain("document.documentElement.dataset.theme");
    // No reload — the flip is attribute + state only.
    expect(source).not.toContain("reload");
  });

  test("theme toggle is icon-only: current-mode lucide icon, no visible text label", () => {
    const source = layoutSource();
    expect(source).toContain('import { Moon, Sun } from "lucide-react"');
    // The icon depicts the CURRENT mode: Moon in dark, Sun in light.
    expect(source).toContain('{theme === "dark" ? <Moon aria-hidden="true" /> : <Sun aria-hidden="true" />}');
    // The visible text label is gone — the aria-label carries the full semantics.
    expect(source).not.toContain('{t(boot.locale, "nav.themeToggle")}');
  });

  test("toggle and pre-paint bootstrap agree on the storage key", () => {
    const bootstrapKey = shellSource().match(/localStorage\.getItem\("([^"]+)"\)/)?.[1];
    expect(bootstrapKey).toBe("mstar.dashboard.theme");
    expect(layoutSource()).toContain(`"${bootstrapKey}"`);
  });

  test("toggle copy is complete in both locales (aria + toggled-state semantics; the visible label key is retired)", () => {
    expect(t("en", "nav.themeToggleAria", { mode: "dark", target: "light" })).toBe(
      "Display theme: dark. Activate to switch to light.",
    );
    expect(t("zh_CN", "nav.themeToggleAria", { mode: "深色", target: "浅色" })).toBe(
      "当前显示模式：深色，点击切换为浅色",
    );
    expect(t("en", "nav.themeDark")).toBe("dark");
    expect(t("en", "nav.themeLight")).toBe("light");
    expect(t("zh_CN", "nav.themeDark")).toBe("深色");
    expect(t("zh_CN", "nav.themeLight")).toBe("浅色");
  });
});

describe("injectSpaBoot", () => {
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

describe("spaClick single-implementation source contract", () => {
  const spaRoot = join(import.meta.dir, "../../src/spa");

  test("spaClick is defined exactly once — in src/spa/spa-click.ts", () => {
    const moduleSource = readFileSync(join(spaRoot, "spa-click.ts"), "utf8");
    expect(moduleSource).toContain("export function spaClick(");
    // No other SPA file carries a spaClick definition.
    // consolidation — per-surface copies were replaced by the shared module).
    const definitionsElsewhere: string[] = [];
    for (const file of new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: spaRoot })) {
      if (file === "spa-click.ts") continue;
      const text = readFileSync(join(spaRoot, file), "utf8");
      if (/function spaClick\b|const spaClick\s*=/.test(text)) definitionsElsewhere.push(file);
    }
    expect(definitionsElsewhere).toEqual([]);
  });

  test("the three surfaces import the shared handler from the spa-click module", () => {
    // Specifier as the surfaces actually use it: pages/ and components/ are
    // one level under src/spa/, so all three import `../spa-click`.
    // The wayfinding back link moved from SettingsView into the
    // AppDetailPage shell, so AppDetailPage replaces SettingsPage here —
    // SettingsPage renders no spa-nav links of its own any more.
    for (const rel of ["pages/AppsPage.tsx", "pages/AppDetailPage.tsx", "components/AppSidebar.tsx"]) {
      const source = readFileSync(join(spaRoot, rel), "utf8");
      expect(source, rel).toContain('import { spaClick } from "../spa-click"');
    }
  });
});
