/**
 * Plan 29 T3 + plan 33 T2: enumerated client router (pathname + params).
 */
import { describe, expect, test } from "bun:test";
import { matchRoute } from "../../src/spa/router";
import { SPA_PAGES, isSpaAssetPath, matchSpaRoute, wantsHtml } from "../../src/spa/routes";

describe("SPA_PAGES enum (plan 33 T2 + plan 40)", () => {
  test("includes apps, insights, members, login, settings (home retired)", () => {
    expect([...SPA_PAGES]).toEqual(["apps", "insights", "members", "login", "settings"]);
  });
});

describe("matchSpaRoute (plan 29 T3 + plan 33 T2 + plan 40)", () => {
  test("matches exact enumerated paths", () => {
    expect(matchSpaRoute("/dashboard")).toEqual({ page: "apps", pathname: "/dashboard" });
    expect(matchSpaRoute("/dashboard/apps")).toEqual({ page: "apps", pathname: "/dashboard/apps" });
    expect(matchSpaRoute("/dashboard/insights")).toEqual({
      page: "insights",
      pathname: "/dashboard/insights",
    });
    expect(matchSpaRoute("/dashboard/members")).toEqual({
      page: "members",
      pathname: "/dashboard/members",
    });
    expect(matchSpaRoute("/dashboard/login")).toEqual({ page: "login", pathname: "/dashboard/login" });
  });

  test("captures /dashboard/apps/:slug/settings", () => {
    expect(matchSpaRoute("/dashboard/apps/acme/settings")).toEqual({
      page: "settings",
      pathname: "/dashboard/apps/acme/settings",
      slug: "acme",
    });
  });

  test("/dashboard and /dashboard/apps resolve to the same Apps page (plan 40)", () => {
    expect(matchSpaRoute("/dashboard")?.page).toBe("apps");
    expect(matchSpaRoute("/dashboard/apps")?.page).toBe("apps");
    expect(matchRoute("/dashboard")).toEqual({ page: "apps", pathname: "/dashboard" });
  });

  test("does not match nested extras beyond settings", () => {
    expect(matchSpaRoute("/dashboard/apps/acme")).toBeNull();
    expect(matchSpaRoute("/dashboard/apps/acme/settings/key/delete")).toBeNull();
    expect(matchSpaRoute("/dashboard/api/insights/summary")).toBeNull();
    expect(matchSpaRoute("/apps")).toBeNull();
  });
});

describe("wantsHtml / asset paths (plan 29 T3)", () => {
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
