/** note: Enumerated client router (pathname + params). The four workspace surfaces
 * (repos, apps, members, settings) plus the App detail and the login page.
 * A repository detail is a target id (`all` for the workspace default); the
 * app detail's retired `…/settings` path spelling answers one redirect to the
 * app's own settings tab.
 *
 * The repository overview is the dashboard default, so neither dashboard root
 * is a page: both are redirects whose target only the Worker can name.
 */
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

/** note: True when the matched route is workspace-scoped (legacy variants carry no field). */
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
    // note: Members is workspace-scoped: the root path is retired.
    expect(matchSpaRoute("/dashboard/members")).toBeNull();
    expect(matchSpaRoute("/dashboard/acme/members")).toEqual({
      page: "members",
      pathname: "/dashboard/acme/members",
      workspaceRef: "acme",
    });
    // note: Settings is workspace-scoped for the same reason: the workspace controls
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

  test("the retired settings-tab address is no page — it redirects once (legacy family is already a 404)", () => {
    // note: No page id serves the old tab address: `settingsTabRedirect` owns it.
    expect(matchSpaRoute("/dashboard/apps/12345/settings")).toBeNull();
    expect(settingsTabRedirect("/dashboard/apps/12345/settings", "")).toBeNull();
    expect(matchSpaRoute("/dashboard/apps/12345")).toEqual({
      page: "app-detail",
      pathname: "/dashboard/apps/12345",
      appId: "12345",
    });
  });

  test("the retired bot page is a redirect to the App's settings tab, not a page", () => {
    // note: The `/bot` sub-path answers one 302 to the tab address: no page id
    // serves it, on either family.
    expect(matchSpaRoute("/dashboard/apps/12345/bot")).toBeNull();
    expect(matchSpaRoute("/dashboard/acme/apps/12345/bot")).toBeNull();
    expect(settingsTabRedirect("/dashboard/acme/apps/12345/bot", "")).toBe(
      "/dashboard/acme/apps/12345?tab=settings",
    );
    // note: A bare `/bot` with no workspace prefix belongs to the dead legacy family
    // (404 before SPA dispatch), so it redirects nowhere either.
    expect(settingsTabRedirect("/dashboard/apps/12345/bot", "")).toBeNull();
    // invariant: The detail stays on the detail page id; the retired settings address
    // matches no page at all.
    expect(matchSpaRoute("/dashboard/apps/12345")?.page).toBe("app-detail");
    expect(matchSpaRoute("/dashboard/apps/12345/settings")).toBeNull();
  });

  test("does not match nested extras beyond the detail paths", () => {
    expect(matchSpaRoute("/dashboard/apps/acme/settings/key/delete")).toBeNull();
    expect(matchSpaRoute("/dashboard/acme/repos/12345/onboarding")).toBeNull();
    expect(matchSpaRoute("/dashboard/api/insights/summary")).toBeNull();
    // note: The global insights page is retired: its path is no longer a SPA page.
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
    // note: `all` is the reserved default detail, not a workspace word.
    expect(matchSpaRoute("/dashboard/acme/repos/all")).toEqual({
      page: "repos",
      pathname: "/dashboard/acme/repos/all",
      workspaceRef: "acme",
      targetId: "all",
    });
    expect(matchSpaRoute("/dashboard/acme/members")?.page).toBe("members");
    expect(matchSpaRoute("/dashboard/acme/settings")?.page).toBe("settings");
    // invariant: The repository surface is workspace-scoped only: no root spelling exists.
    expect(matchSpaRoute("/dashboard/repos")).toBeNull();
    // note: …and the retired `targets` segment resolves to no page anywhere.
    expect(matchSpaRoute("/dashboard/acme/targets")).toBeNull();
  });

  test("the app detail keeps its path; its retired settings path spelling redirects to the tab", () => {
    expect(matchSpaRoute("/dashboard/acme/apps/12345")).toEqual({
      page: "app-detail",
      pathname: "/dashboard/acme/apps/12345",
      appId: "12345",
      workspaceRef: "acme",
    });
    // note: The path spelling is dead: it answers one redirect to the canonical tab
    // address, which is a page (the app detail) rather than a redirect.
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
      ["/dashboard/acme/api/apps/12345/settings", ""],
      ["/dashboard/acme/api/apps/12345/bot", ""],
      ["/dashboard/acme/api/targets", ""],
      ["/dashboard/apps/12345/settings", ""],
    ] as const) {
      expect(settingsTabRedirect(path, search), `${path}${search}`).toBeNull();
    }
    // invariant: The API read the target page consumes is not a page and never matches:
    // widening either WORKSPACE_APP_PATH or WORKSPACE_APP_SETTINGS_PATH would
    // 302 the settings JSON read to an HTML page.
    expect(matchSpaRoute("/dashboard/acme/api/apps/12345")).toBeNull();
    expect(matchSpaRoute("/dashboard/acme/api/apps/12345/settings")).toBeNull();
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
        // note: Whatever else such a path resolves to (e.g. the legacy app-detail
        // for an App literally named "apps"), it never carries a workspace.
        expect(isWorkspaceRoute(path), path).toBe(false);
      }
    }
  });

  test("a workspace slugged settings keeps every workspace page (settings is not reserved)", () => {
    // why: No unscoped `settings` route family exists, so the word needs no
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
    // invariant: One segment after the mount matches nothing with or without the word.
    expect(matchSpaRoute("/dashboard/settings")).toBeNull();
  });

  test("workspace pages stop at the enumerated shapes (onboarding and deeper paths are Worker routes)", () => {
    expect(matchSpaRoute("/dashboard/acme/apps/12345/onboarding")).toBeNull();
    expect(matchSpaRoute("/dashboard/acme/apps/12345/settings/key/delete")).toBeNull();
    expect(isWorkspaceRoute("/dashboard/acme/api/apps")).toBe(false);
    // note: Members IS a workspace page now; deeper shapes are still Worker routes.
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
    // invariant: A bookmark from before the rename must reach the SAME page: the list
    // becomes the overview, the detail keeps its target segment.
    expect(targetsFamilyRedirect("/dashboard/acme/targets")).toBe("/dashboard/acme/repos");
    expect(targetsFamilyRedirect("/dashboard/acme/targets/12345")).toBe(
      "/dashboard/acme/repos/12345",
    );
    expect(targetsFamilyRedirect("/dashboard/acme/targets/all")).toBe("/dashboard/acme/repos/all");
    // note: The live spelling and every other path are left alone.
    expect(targetsFamilyRedirect("/dashboard/acme/repos")).toBeNull();
    expect(targetsFamilyRedirect("/dashboard/acme/repos/12345")).toBeNull();
    expect(targetsFamilyRedirect("/dashboard/targets")).toBeNull();
    expect(targetsFamilyRedirect("/dashboard/acme/targets/12345/extra")).toBeNull();
  });

  test("a workspace switch from a retired bookmark lands on the live page, not a 404 stub", () => {
    // note: `replaceWorkspaceRef` rewrites the segment of the page the path NAMES, so
    // a retired path is translated first and keeps its target segment.
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
    // note: The marketing Worker owns `/index.html` and `/assets/*` on this hostname.
    expect(isSpaAssetPath("/index.html")).toBe(false);
    expect(isSpaAssetPath("/assets/index-abc.js")).toBe(false);
    expect(isSpaAssetPath("/dashboard/insights")).toBe(false);
  });
});
