/**
 * SF-1 — switching workspace must leave neither the previous workspace's
 * Apps nor its Create state on screen. The switcher navigates with
 * pushState + popstate (no new document), so the page must derive its API
 * base and its create eligibility from the URL + the boot's membership
 * list, not from the once-injected snapshot.
 *
 * Executed contract: the eligibility derivation, the pathname→base map and
 * the page's own list read are all driven here with a mocked `fetch`.
 *
 * Residual gap (no DOM runner in this suite, repo contract): the effect that
 * ties them together — `useEffect(load, [load])` with `load` keyed on
 * `[base]` — cannot be executed, so a regression that pins the base at mount
 * while keeping every helper correct would pass here. The same residual
 * applies to `tests/spa/app-detail.test.tsx`; both pages read their base per
 * render and the reads asserted below are the ones those effects issue.
 */
import { describe, expect, test } from "bun:test";
import type { SpaBoot } from "../../src/spa/boot";
import { canCreateAppFor, loadApps } from "../../src/spa/pages/AppsPage";
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

/** The page's own read under the base its render derived, recording the URL. */
async function readUnder(pathname: string): Promise<{ url: string; apps: string[] }> {
  const calls: string[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    calls.push(url);
    const workspace = url.split("/")[2];
    return new Response(
      JSON.stringify({
        viewer: { login: "octocat", role: "admin" },
        apps: [{ slug: `${workspace}-app` }],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  try {
    const payload = await loadApps(apiBase(pathname));
    expect(calls).toHaveLength(1);
    return { url: calls[0]!, apps: (payload?.apps ?? []).map((app) => app.slug) };
  } finally {
    globalThis.fetch = realFetch;
  }
}

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

  test("the read follows the addressed workspace after the switch", async () => {
    // The A→B switch: same page, different workspace segment — the read must
    // land on B's list, never the A data the previous render fetched.
    expect(await readUnder("/dashboard/acme/apps")).toEqual({
      url: "/dashboard/acme/api/apps",
      apps: ["acme-app"],
    });
    expect(await readUnder("/dashboard/beta/apps")).toEqual({
      url: "/dashboard/beta/api/apps",
      apps: ["beta-app"],
    });
  });
});
