import { describe, expect, test } from "bun:test";
import { matchRoute } from "../../src/spa/router";
import {
  DASHBOARD_ROOT_PATHS,
  RESERVED_WORKSPACE_SLUGS,
  WORKSPACE_FAMILY_SEGMENTS,
  isSpaAssetPath,
  matchSpaRoute,
  replaceWorkspaceRef,
  reposHomePath,
  settingsTabRedirect,
  targetsFamilyRedirect,
  wantsHtml,
  workspaceRefOf,
} from "../../src/spa/routes";

function isWorkspaceRoute(pathname: string): boolean {
  const route = matchSpaRoute(pathname);
  return route !== null && "workspaceRef" in route;
}

describe("the dashboard default", () => {
  test("both roots are redirect spellings, never pages", () => {
    for (const root of ["/dashboard", "/dashboard/apps"]) {
      expect(matchSpaRoute(root), root).toBeNull();
      expect(matchRoute(root).page, root).toBe("unknown");
      expect(DASHBOARD_ROOT_PATHS.has(root), root).toBe(true);
    }
    expect(DASHBOARD_ROOT_PATHS.has("/dashboard/repos")).toBe(false);
  });

  test("the overview address is the workspace-scoped page the root resolves to", () => {
    expect(reposHomePath("acme")).toBe("/dashboard/acme/repos");
    expect(matchSpaRoute(reposHomePath("acme"))).toEqual({
      page: "repos",
      pathname: "/dashboard/acme/repos",
      workspaceRef: "acme",
    });
    expect(matchRoute("/dashboard/acme/repos").page).toBe("repos");
  });
});

describe("matchSpaRoute", () => {
  test("matches exact enumerated paths", () => {
    expect(matchSpaRoute("/dashboard/members")).toBeNull();
    expect(matchSpaRoute("/dashboard/acme/members")).toEqual({
      page: "members",
      pathname: "/dashboard/acme/members",
      workspaceRef: "acme",
    });
    expect(matchSpaRoute("/dashboard/settings")).toBeNull();
    expect(matchSpaRoute("/dashboard/acme/settings")).toEqual({
      page: "settings",
      pathname: "/dashboard/acme/settings",
      workspaceRef: "acme",
    });
    expect(workspaceRefOf("/dashboard/acme/settings")).toBe("acme");
    expect(matchSpaRoute("/dashboard/login")).toEqual({ page: "login", pathname: "/dashboard/login" });
  });

  test("/dashboard/apps/:appId is the detail page (default tab is query-derived, not route state)", () => {
    expect(matchSpaRoute("/dashboard/apps/12345")).toEqual({
      page: "app-detail",
      pathname: "/dashboard/apps/12345",
      appId: "12345",
    });
    expect(matchRoute("/dashboard/apps/12345")).toEqual({
      page: "app-detail",
      pathname: "/dashboard/apps/12345",
      appId: "12345",
    });
  });

  test("the retired settings-tab address is no page — it redirects once (legacy family is already a 404)", () => {
    expect(matchSpaRoute("/dashboard/apps/12345/settings")).toBeNull();
    expect(settingsTabRedirect("/dashboard/apps/12345/settings", "")).toBeNull();
    expect(matchSpaRoute("/dashboard/apps/12345")).toEqual({
      page: "app-detail",
      pathname: "/dashboard/apps/12345",
      appId: "12345",
    });
  });

  test("the retired bot page is a redirect to the App's settings tab, not a page", () => {
    expect(matchSpaRoute("/dashboard/apps/12345/bot")).toBeNull();
    expect(matchSpaRoute("/dashboard/acme/apps/12345/bot")).toBeNull();
    expect(settingsTabRedirect("/dashboard/acme/apps/12345/bot", "")).toBe(
      "/dashboard/acme/apps/12345?tab=settings",
    );
    expect(settingsTabRedirect("/dashboard/apps/12345/bot", "")).toBeNull();
    expect(matchSpaRoute("/dashboard/apps/12345")?.page).toBe("app-detail");
    expect(matchSpaRoute("/dashboard/apps/12345/settings")).toBeNull();
  });

  test("does not match nested extras beyond the detail paths", () => {
    expect(matchSpaRoute("/dashboard/apps/acme/settings/key/delete")).toBeNull();
    expect(matchSpaRoute("/dashboard/acme/repos/12345/onboarding")).toBeNull();
    expect(matchSpaRoute("/dashboard/api/insights/summary")).toBeNull();
    expect(matchSpaRoute("/dashboard/insights")).toBeNull();
    expect(matchSpaRoute("/apps")).toBeNull();
  });
});

describe("matchSpaRoute — workspace-scoped surfaces", () => {
  test("the four workspace surfaces carry their own paths", () => {
    expect(matchSpaRoute("/dashboard/acme/apps")).toEqual({
      page: "apps",
      pathname: "/dashboard/acme/apps",
      workspaceRef: "acme",
    });
    expect(matchSpaRoute("/dashboard/acme/repos")).toEqual({
      page: "repos",
      pathname: "/dashboard/acme/repos",
      workspaceRef: "acme",
    });
    expect(matchSpaRoute("/dashboard/acme/repos/12345")).toEqual({
      page: "repos",
      pathname: "/dashboard/acme/repos/12345",
      workspaceRef: "acme",
      targetId: "12345",
    });
    expect(matchSpaRoute("/dashboard/acme/repos/all")).toEqual({
      page: "repos",
      pathname: "/dashboard/acme/repos/all",
      workspaceRef: "acme",
      targetId: "all",
    });
    expect(matchSpaRoute("/dashboard/acme/members")?.page).toBe("members");
    expect(matchSpaRoute("/dashboard/acme/settings")?.page).toBe("settings");
    expect(matchSpaRoute("/dashboard/repos")).toBeNull();
    expect(matchSpaRoute("/dashboard/acme/targets")).toBeNull();
  });

  test("the app detail keeps its path; its retired settings path spelling redirects to the tab", () => {
    expect(matchSpaRoute("/dashboard/acme/apps/12345")).toEqual({
      page: "app-detail",
      pathname: "/dashboard/acme/apps/12345",
      appId: "12345",
      workspaceRef: "acme",
    });
    expect(matchSpaRoute("/dashboard/acme/apps/12345/settings")).toBeNull();
    expect(settingsTabRedirect("/dashboard/acme/apps/12345/settings", "")).toBe(
      "/dashboard/acme/apps/12345?tab=settings",
    );
    expect(settingsTabRedirect("/dashboard/acme/apps/12345", "?tab=settings")).toBeNull();
  });

  test("settingsTabRedirect leaves every other address alone", () => {
    for (const [path, search] of [
      ["/dashboard/acme/apps/12345", ""],
      ["/dashboard/acme/apps/12345", "?tab=insights"],
      ["/dashboard/acme/repos/12345", ""],
      ["/dashboard/acme/apps", ""],
      ["/dashboard/acme/api/review-bots/12345/settings", ""],
      ["/dashboard/acme/api/review-bots/12345/bot", ""],
      ["/dashboard/acme/api/targets", ""],
      ["/dashboard/apps/12345/settings", ""],
    ] as const) {
      expect(settingsTabRedirect(path, search), `${path}${search}`).toBeNull();
    }
    expect(matchSpaRoute("/dashboard/acme/api/apps/12345")).toBeNull();
    expect(matchSpaRoute("/dashboard/acme/api/review-bots/12345/settings")).toBeNull();
    expect(matchSpaRoute("/dashboard/acme/api/targets")).toBeNull();
  });

  test("repos is in the one workspace family (and not a reserved slug)", () => {
    expect(WORKSPACE_FAMILY_SEGMENTS).toContain("repos");
    expect(RESERVED_WORKSPACE_SLUGS.has("repos")).toBe(false);
    expect(workspaceRefOf("/dashboard/acme/repos/12345")).toBe("acme");
  });

  test("a reserved first segment is never a workspace", () => {
    for (const word of RESERVED_WORKSPACE_SLUGS) {
      for (const path of [`/dashboard/${word}/apps`, `/dashboard/${word}/apps/some-app`]) {
        expect(isWorkspaceRoute(path), path).toBe(false);
      }
    }
  });

  test("a workspace slugged settings keeps every workspace page (settings is not reserved)", () => {
    expect(matchSpaRoute("/dashboard/settings/apps")).toEqual({
      page: "apps",
      pathname: "/dashboard/settings/apps",
      workspaceRef: "settings",
    });
    expect(matchSpaRoute("/dashboard/settings/settings")).toEqual({
      page: "settings",
      pathname: "/dashboard/settings/settings",
      workspaceRef: "settings",
    });
    expect(workspaceRefOf("/dashboard/settings/members")).toBe("settings");
    expect(matchSpaRoute("/dashboard/settings")).toBeNull();
  });

  test("workspace pages stop at the enumerated shapes (onboarding and deeper paths are Worker routes)", () => {
    expect(matchSpaRoute("/dashboard/acme/apps/12345/onboarding")).toBeNull();
    expect(matchSpaRoute("/dashboard/acme/apps/12345/settings/key/delete")).toBeNull();
    expect(isWorkspaceRoute("/dashboard/acme/api/apps")).toBe(false);
    expect(isWorkspaceRoute("/dashboard/acme/members")).toBe(true);
    expect(matchSpaRoute("/dashboard/acme/members/hubot")).toBeNull();
  });

  test("legacy routes keep no workspace field (the prefix is the only signal)", () => {
    for (const path of [
      "/dashboard",
      "/dashboard/apps",
      "/dashboard/apps/12345",
      "/dashboard/apps/12345/settings",
      "/dashboard/login",
    ]) {
      expect(isWorkspaceRoute(path), path).toBe(false);
    }
  });
});

describe("the retired targets family", () => {
  test("both spellings redirect to the repository address that carries them now", () => {
    expect(targetsFamilyRedirect("/dashboard/acme/targets")).toBe("/dashboard/acme/repos");
    expect(targetsFamilyRedirect("/dashboard/acme/targets/12345")).toBe(
      "/dashboard/acme/repos/12345",
    );
    expect(targetsFamilyRedirect("/dashboard/acme/targets/all")).toBe("/dashboard/acme/repos/all");
    expect(targetsFamilyRedirect("/dashboard/acme/repos")).toBeNull();
    expect(targetsFamilyRedirect("/dashboard/acme/repos/12345")).toBeNull();
    expect(targetsFamilyRedirect("/dashboard/targets")).toBeNull();
    expect(targetsFamilyRedirect("/dashboard/acme/targets/12345/extra")).toBeNull();
  });

  test("a workspace switch from a retired bookmark lands on the live page, not a 404 stub", () => {
    expect(replaceWorkspaceRef("/dashboard/acme/targets", "beta")).toBe("/dashboard/beta/repos");
    expect(replaceWorkspaceRef("/dashboard/acme/targets/12345", "beta")).toBe(
      "/dashboard/beta/repos/12345",
    );
    expect(replaceWorkspaceRef("/dashboard/acme/repos/12345", "beta")).toBe(
      "/dashboard/beta/repos/12345",
    );
  });
});

describe("wantsHtml / asset paths", () => {
  test("only Accept: text/html* is an HTML navigation", () => {
    expect(wantsHtml("text/html")).toBe(true);
    expect(wantsHtml("text/html,application/xhtml+xml")).toBe(true);
    expect(wantsHtml("application/json")).toBe(false);
    expect(wantsHtml("*/*")).toBe(false);
    expect(wantsHtml(null)).toBe(false);
  });

  test("Vite hashed assets live under /app-assets/", () => {
    expect(isSpaAssetPath("/app-assets/index-abc.js")).toBe(true);
    expect(isSpaAssetPath("/index.html")).toBe(false);
    expect(isSpaAssetPath("/assets/index-abc.js")).toBe(false);
    expect(isSpaAssetPath("/dashboard/insights")).toBe(false);
  });
});
