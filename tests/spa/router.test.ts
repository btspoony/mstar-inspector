/**
 * Enumerated client router (pathname + params). App detail IA:
 * ONE page id (`app-detail`) serves both `/dashboard/apps/:appId` (default
 * tab 应用设置) and the legacy `/dashboard/apps/:appId/settings` permanent
 * settings-tab deep link.
 */
import { describe, expect, test } from "bun:test";
import { matchRoute } from "../../src/spa/router";
import { RESERVED_WORKSPACE_SLUGS, isSpaAssetPath, matchSpaRoute, wantsHtml, workspaceRefOf } from "../../src/spa/routes";

/** True when the matched route is workspace-scoped (legacy variants carry no field). */
function isWorkspaceRoute(pathname: string): boolean {
  const route = matchSpaRoute(pathname);
  return route !== null && "workspaceRef" in route;
}

describe("matchSpaRoute", () => {
  test("matches exact enumerated paths", () => {
    expect(matchSpaRoute("/dashboard")).toEqual({ page: "apps", pathname: "/dashboard" });
    expect(matchSpaRoute("/dashboard/apps")).toEqual({ page: "apps", pathname: "/dashboard/apps" });
    // Members is workspace-scoped: the root path is retired.
    expect(matchSpaRoute("/dashboard/members")).toBeNull();
    expect(matchSpaRoute("/dashboard/acme/members")).toEqual({
      page: "members",
      pathname: "/dashboard/acme/members",
      workspaceRef: "acme",
    });
    // Settings is workspace-scoped for the same reason: the workspace controls
    // read the role of the path's own workspace.
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

  test("the legacy /dashboard/apps/:appId/settings path lands on the SAME detail page id (permanent settings-tab deep link)", () => {
    expect(matchSpaRoute("/dashboard/apps/12345/settings")).toEqual({
      page: "app-detail",
      pathname: "/dashboard/apps/12345/settings",
      appId: "12345",
    });
  });

  test("/dashboard and /dashboard/apps resolve to the same Apps page", () => {
    expect(matchSpaRoute("/dashboard")?.page).toBe("apps");
    expect(matchSpaRoute("/dashboard/apps")?.page).toBe("apps");
    expect(matchRoute("/dashboard")).toEqual({ page: "apps", pathname: "/dashboard" });
  });

  test("does not match nested extras beyond the detail paths", () => {
    expect(matchSpaRoute("/dashboard/apps/acme/settings/key/delete")).toBeNull();
    expect(matchSpaRoute("/dashboard/api/insights/summary")).toBeNull();
    // The global insights page is retired: its path is no longer a SPA page.
    expect(matchSpaRoute("/dashboard/insights")).toBeNull();
    expect(matchSpaRoute("/apps")).toBeNull();
  });
});

describe("matchSpaRoute — workspace-scoped App pages", () => {
  test("the workspace Apps page and its App detail routes carry the appId", () => {
    expect(matchSpaRoute("/dashboard/acme/apps")).toEqual({
      page: "apps",
      pathname: "/dashboard/acme/apps",
      workspaceRef: "acme",
    });
    expect(matchSpaRoute("/dashboard/acme/apps/12345")).toEqual({
      page: "app-detail",
      pathname: "/dashboard/acme/apps/12345",
      appId: "12345",
      workspaceRef: "acme",
    });
    // The permanent settings-tab deep link exists on the workspace family too
    // (the settings POST family's HTML-nav 302 targets it under strict).
    expect(matchSpaRoute("/dashboard/acme/apps/12345/settings")).toEqual({
      page: "app-detail",
      pathname: "/dashboard/acme/apps/12345/settings",
      appId: "12345",
      workspaceRef: "acme",
    });
  });

  test("a reserved first segment is never a workspace", () => {
    for (const word of RESERVED_WORKSPACE_SLUGS) {
      for (const path of [`/dashboard/${word}/apps`, `/dashboard/${word}/apps/some-app`]) {
        // Whatever else such a path resolves to (e.g. the legacy app-detail
        // for an App literally named "apps"), it never carries a workspace.
        expect(isWorkspaceRoute(path), path).toBe(false);
      }
    }
  });

  test("a workspace slugged settings keeps every workspace page (settings is not reserved)", () => {
    // No unscoped `settings` route family exists, so the word needs no
    // reservation: it names the workspace like any other slug.
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
    // One segment after the mount matches nothing with or without the word.
    expect(matchSpaRoute("/dashboard/settings")).toBeNull();
  });

  test("workspace pages stop at the enumerated shapes (onboarding and deeper paths are Worker routes)", () => {
    expect(matchSpaRoute("/dashboard/acme/apps/12345/onboarding")).toBeNull();
    expect(matchSpaRoute("/dashboard/acme/apps/12345/settings/key/delete")).toBeNull();
    expect(isWorkspaceRoute("/dashboard/acme/api/apps")).toBe(false);
    // Members IS a workspace page now; deeper shapes are still Worker routes.
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

describe("wantsHtml / asset paths", () => {
  test("only Accept: text/html* is an HTML navigation", () => {
    expect(wantsHtml("text/html")).toBe(true);
    expect(wantsHtml("text/html,application/xhtml+xml")).toBe(true);
    expect(wantsHtml("application/json")).toBe(false);
    expect(wantsHtml("*/*")).toBe(false);
    expect(wantsHtml(null)).toBe(false);
  });

  test("Vite hashed assets live under /assets/", () => {
    expect(isSpaAssetPath("/assets/index-abc.js")).toBe(true);
    expect(isSpaAssetPath("/index.html")).toBe(true);
    expect(isSpaAssetPath("/dashboard/insights")).toBe(false);
  });
});
