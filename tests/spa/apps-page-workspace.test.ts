/**
 * SF-1 — switching workspace must leave neither the previous workspace's
 * Apps nor its Create state on screen. The switcher navigates with
 * pushState + popstate (no new document), so the page must derive its API
 * base and its create eligibility from the URL + the boot's membership
 * list, not from the once-injected snapshot.
 *
 * No DOM runner in this suite (repo contract): the eligibility derivation
 * is pinned as an executable helper, and the fetch target is pinned through
 * the same `apiBase` the page reads (`tests/spa/workspace-base.test.ts`
 * owns the pathname→base map).
 */
import { describe, expect, test } from "bun:test";
import type { SpaBoot } from "../../src/spa/boot";
import { canCreateAppFor } from "../../src/spa/pages/AppsPage";
import { workspaceRefOf } from "../../src/spa/routes";
import { apiBase } from "../../src/spa/workspace-base";

const boot: SpaBoot = {
  locale: "en",
  login: "octocat",
  name: "The Octocat",
  workspaceRef: "acme",
  canCreateApp: true,
  memberships: [
    { id: "ws_a", slug: "acme", name: "Acme", role: "owner" },
    { id: "ws_b", slug: "beta", name: "Beta", role: "member" },
  ],
};

describe("AppsPage create eligibility — addressed workspace", () => {
  test("navigating from workspace A (owner) to workspace B (member) flips Create off", () => {
    // The A→B switch the finding describes: the eligibility follows the
    // addressed ref, not the boot's once-injected `canCreateApp: true`.
    const refA = workspaceRefOf("/dashboard/acme/apps");
    const refB = workspaceRefOf("/dashboard/beta/apps");
    expect(canCreateAppFor(boot, refA)).toBe(true);
    expect(canCreateAppFor(boot, refB)).toBe(false);
  });

  test("a membership matches the addressed ref on either identifier (id or slug)", () => {
    expect(canCreateAppFor(boot, "ws_a")).toBe(true);
    expect(canCreateAppFor(boot, "acme")).toBe(true);
    expect(canCreateAppFor(boot, "ws_b")).toBe(false);
  });

  test("a ref no membership names keeps the boot snapshot (nothing better is known)", () => {
    expect(canCreateAppFor(boot, "unknown")).toBe(true);
    expect(canCreateAppFor({ ...boot, canCreateApp: false }, "unknown")).toBe(false);
  });

  test("no addressed workspace (the legacy mount) keeps the boot snapshot", () => {
    expect(canCreateAppFor(boot, null)).toBe(true);
    expect(canCreateAppFor({ ...boot, canCreateApp: false }, null)).toBe(false);
  });

  test("workspaceRequired disables creation regardless of role", () => {
    expect(canCreateAppFor({ ...boot, workspaceRequired: true }, "acme")).toBe(false);
    expect(canCreateAppFor({ ...boot, workspaceRequired: true }, null)).toBe(false);
  });

  test("the page fetch targets the addressed workspace's base after the switch", () => {
    // Same `apiBase` the page's `load` reads: on the B path the fetch URL
    // is B's base — the refetch-on-base-change wiring (`useCallback([base])`)
    // lives beside it in AppsPage.
    expect(apiBase("/dashboard/acme/apps")).toBe("/dashboard/acme");
    expect(apiBase("/dashboard/beta/apps")).toBe("/dashboard/beta");
  });
});
