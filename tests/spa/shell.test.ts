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
  test("nav order is Repositories → Apps → Members → Settings (insights retired)", () => {
    expect(NAV_ITEMS.map((item) => item.href)).toEqual([
      "/dashboard/repos",
      "/dashboard/apps",
      "/dashboard/members",
      "/dashboard/settings",
    ]);
    expect(NAV_ITEMS.map((item) => item.labelKey)).toEqual([
      "nav.targets",
      "nav.apps",
      "nav.members",
      "nav.settings",
    ]);
  });

  test("a plain member sees Members too (nav is not role-gated)", () => {
    const sidebar = buildSidebarModel(member, "/dashboard/apps");
    expect(sidebar.items.map((item) => item.label)).toEqual([
      "Repositories",
      "Apps",
      "Members",
      "Settings",
    ]);
    const scoped = buildSidebarModel(member, "/dashboard/acme/apps");
    expect(scoped.items.map((item) => item.href)).toEqual([
      "/dashboard/acme/repos",
      "/dashboard/acme/apps",
      "/dashboard/acme/members",
      "/dashboard/acme/settings",
    ]);
    expect(sidebar.items.some((item) => item.href === "/dashboard/insights")).toBe(false);
  });

  test("the admin sees the same entries", () => {
    const sidebar = buildSidebarModel(admin, "/dashboard/acme/members");
    expect(sidebar.items.map((item) => item.href)).toEqual([
      "/dashboard/acme/repos",
      "/dashboard/acme/apps",
      "/dashboard/acme/members",
      "/dashboard/acme/settings",
    ]);
    expect(sidebar.items.map((item) => item.label)).toEqual(["仓库", "应用", "成员", "设置"]);
  });

  test("navbar is slim: theme + Lang + account + logout only", () => {
    const navbar = buildNavbarModel(admin);
    expect(navbar.languageLabel).toBe("EN");
    expect(navbar.languageTarget).toBe("en");
    expect(navbar.accountLabel).toBe("The Octocat (octocat)");
    expect(navbar.logoutLabel).toBe("退出登录");
    expect(Object.keys(navbar)).toEqual(["languageLabel", "languageTarget", "accountLabel", "logoutLabel"]);
  });

  test("brand lives in the sidebar model", () => {
    expect(buildSidebarModel(member, "/dashboard/apps").brand).toBe(t("en", "nav.brand"));
    expect(buildSidebarModel(admin, "/dashboard/acme/members").brand).toBe(t("zh_CN", "nav.brand"));
  });

  test("the wordmark follows the workspace repository overview", () => {
    expect(buildSidebarModel(member, "/dashboard/apps").brandHref).toBe("/dashboard");
    expect(buildSidebarModel(admin, "/dashboard/acme/repos").brandHref).toBe("/dashboard/acme/repos");
    expect(
      buildSidebarModel(admin, "/dashboard/acme/apps/acme-app/settings").brandHref,
    ).toBe("/dashboard/acme/repos");
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

  test("Repositories is current on the overview and both dashboard roots", () => {
    expect(isNavCurrent("/dashboard/repos", "/dashboard/repos")).toBe(true);
    expect(isNavCurrent("/dashboard/repos", "/dashboard/repos/12345")).toBe(true);
    expect(isNavCurrent("/dashboard/repos", "/dashboard")).toBe(true);
    expect(isNavCurrent("/dashboard/repos", "/dashboard/apps")).toBe(true);
    expect(isNavCurrent("/dashboard/apps", "/dashboard/acme/apps")).toBe(false);
  });

  test("root highlights Repositories", () => {
    const root = buildSidebarModel(member, "/dashboard");
    expect(root.items.find((item) => item.href === "/dashboard/repos")?.current).toBe(true);
    expect(root.items.find((item) => item.href === "/dashboard/apps")?.current).toBe(false);
  });

  test("each surface lights exactly one entry — its own", () => {
    const cases: Array<[string, string]> = [
      ["/dashboard/acme/apps", "/dashboard/acme/apps"],
      ["/dashboard/acme/apps/12345", "/dashboard/acme/apps"],
      ["/dashboard/acme/repos", "/dashboard/acme/repos"],
      ["/dashboard/acme/repos/12345", "/dashboard/acme/repos"],
      ["/dashboard/acme/members", "/dashboard/acme/members"],
      ["/dashboard/acme/settings", "/dashboard/acme/settings"],
    ];
    for (const [pathname, current] of cases) {
      const sidebar = buildSidebarModel(admin, pathname);
      const active = sidebar.items.filter((item) => item.current).map((item) => item.href);
      expect(active, pathname).toEqual([current]);
    }
  });

  test("a workspace page keeps BOTH nav entries inside its workspace", () => {
    const sidebar = buildSidebarModel(admin, "/dashboard/acme/apps");
    expect(sidebar.items.map((item) => item.href)).toEqual([
      "/dashboard/acme/repos",
      "/dashboard/acme/apps",
      "/dashboard/acme/members",
      "/dashboard/acme/settings",
    ]);
    expect(sidebar.items.find((item) => item.href === "/dashboard/acme/apps")?.current).toBe(true);
    const detail = buildSidebarModel(admin, "/dashboard/acme/apps/acme-app/settings");
    expect(detail.items.find((item) => item.href === "/dashboard/acme/apps")?.current).toBe(true);
    expect(detail.items.find((item) => item.href === "/dashboard/acme/members")?.current).toBe(false);
  });

  test("a workspace-active Members page names its own workspace from the pathname", () => {
    const sidebar = buildSidebarModel({ ...admin, workspaceRef: "other" }, "/dashboard/acme/members");
    expect(sidebar.brandHref).toBe("/dashboard/acme/repos");
    expect(sidebar.items.map((item) => item.href)).toEqual([
      "/dashboard/acme/repos",
      "/dashboard/acme/apps",
      "/dashboard/acme/members",
      "/dashboard/acme/settings",
    ]);
    expect(sidebar.items.find((item) => item.href === "/dashboard/acme/members")?.current).toBe(true);
  });

  test("the page's own workspace wins over the boot ref (one workspace identity per page)", () => {
    const sidebar = buildSidebarModel({ ...admin, workspaceRef: "other" }, "/dashboard/acme/apps");
    expect(sidebar.items.map((item) => item.href)).toEqual([
      "/dashboard/acme/repos",
      "/dashboard/acme/apps",
      "/dashboard/acme/members",
      "/dashboard/acme/settings",
    ]);
    expect(sidebar.brandHref).toBe("/dashboard/acme/repos");
  });

  test("the boot ref still scopes a pathname that names no workspace", () => {
    const sidebar = buildSidebarModel({ ...admin, workspaceRef: "acme" }, "/dashboard/apps");
    expect(sidebar.brandHref).toBe("/dashboard/acme/repos");
    expect(sidebar.items.map((item) => item.href)).toEqual([
      "/dashboard/acme/repos",
      "/dashboard/acme/apps",
      "/dashboard/acme/members",
      "/dashboard/acme/settings",
    ]);
  });

  test("with no boot ref the login's first membership supplies the id, not its slug", () => {
    const sidebar = buildSidebarModel(
      {
        ...admin,
        memberships: [{ id: "ws_acme", slug: "acme", name: "Acme", role: "owner", plan: "Free" }],
      },
      "/dashboard/apps",
    );
    expect(sidebar.items.map((item) => item.href)).toEqual([
      "/dashboard/ws_acme/repos",
      "/dashboard/ws_acme/apps",
      "/dashboard/ws_acme/members",
      "/dashboard/ws_acme/settings",
    ]);
  });

  test("no boot ref → the legacy paths are unchanged", () => {
    const sidebar = buildSidebarModel(admin, "/dashboard/apps");
    expect(sidebar.brandHref).toBe("/dashboard");
    expect(sidebar.items.map((item) => item.href)).toEqual([
      "/dashboard/repos",
      "/dashboard/apps",
      "/dashboard/members",
      "/dashboard/settings",
    ]);
  });

  test("workspaceMembershipForRef resolves by id or slug and carries the role", () => {
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
    expect(source).not.toContain("reload");
  });

  test("theme toggle is icon-only: current-mode lucide icon, no visible text label", () => {
    const source = layoutSource();
    expect(source).toContain('import { Moon, Sun } from "lucide-react"');
    expect(source).toContain('{theme === "dark" ? <Moon aria-hidden="true" /> : <Sun aria-hidden="true" />}');
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
    const definitionsElsewhere: string[] = [];
    for (const file of new Bun.Glob("**/*.{ts,tsx}").scanSync({ cwd: spaRoot })) {
      if (file === "spa-click.ts") continue;
      const text = readFileSync(join(spaRoot, file), "utf8");
      if (/function spaClick\b|const spaClick\s*=/.test(text)) definitionsElsewhere.push(file);
    }
    expect(definitionsElsewhere).toEqual([]);
  });

  test("the three surfaces import the shared handler from the spa-click module", () => {
    for (const rel of ["pages/AppsPage.tsx", "pages/AppDetailPage.tsx", "components/AppSidebar.tsx"]) {
      const source = readFileSync(join(spaRoot, rel), "utf8");
      expect(source, rel).toContain('import { spaClick } from "../spa-click"');
    }
  });
});
