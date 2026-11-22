import { describe, expect, test } from "bun:test";
import { type Element as DomElement } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { t } from "../../src/i18n";
import type { SpaBoot } from "../../src/spa/boot";
import { AppsPage, canCreateAppFor, loadApps } from "../../src/spa/pages/AppsPage";
import { parseApps } from "../../src/spa/pages/data";
import { workspaceRefOf } from "../../src/spa/routes";
import { apiBase } from "../../src/spa/workspace-base";
import { installDom } from "./dom";

const boot: SpaBoot = {
  locale: "en",
  login: "octocat",
  name: "The Octocat",
  workspaceRef: "acme",
  canCreateApp: true,
  memberships: [
    { id: "ws_a", slug: "acme", name: "Acme", role: "owner", plan: "Free" },
    { id: "ws_b", slug: "beta", name: "Beta", role: "member", plan: "Free" },
  ],
};

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
        apps: [{ github_app_id: 1, github_slug: `${workspace}-app` }],
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;
  try {
    const payload = await loadApps(apiBase(pathname));
    expect(calls).toHaveLength(1);
    return { url: calls[0]!, apps: (payload?.apps ?? []).map((app) => app.github_slug ?? "") };
  } finally {
    globalThis.fetch = realFetch;
  }
}

describe("AppsPage list face — split payload leaves list links on the numeric App id", () => {
  test("list rows stay keyed by github_app_id; the settings split adds no list key", () => {
    const payload = parseApps({
      viewer: { login: "octocat", role: "admin" },
      apps: [{ github_app_id: 1001, github_slug: "acme-app" }],
    });
    expect(payload?.apps[0]?.github_app_id).toBe(1001);
  });
});

describe("AppsPage create eligibility — addressed workspace", () => {
  test("navigating from workspace A (owner) to workspace B (member) flips Create off", () => {
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

describe("AppsPage create dialog", () => {
  const SHARED = { id: "bot-platform", github_slug: "platform-app", name: "Platform App", target_count: 1 };

  type Sent = { url: string; method: string; body: string };

  async function mountPage(pathname: string, sharedBots: unknown) {
    const { win, cleanup } = installDom(`http://localhost${pathname}`);
    const sent: Sent[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      sent.push({ url, method, body: String(init?.body ?? "") });
      if (method === "POST") return new Response("ok", { status: 200 });
      return new Response(
        JSON.stringify({
          viewer: { login: "octocat", role: "admin" },
          apps: [
            {
              github_app_id: 1001,
              github_slug: "acme-app",
              github_name: null,
              github_avatar_url: null,
              status: "active",
              review_enabled: 1,
              created_by: "octocat",
              health: { latest: null, rejected24h: 0 },
            },
          ],
          shared_bots: sharedBots,
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    }) as unknown as typeof fetch;

    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    await act(async () => root.render(createElement(AppsPage, { boot })));
    await act(async () => {});

    const drain = async (run: () => void): Promise<void> => {
      await act(async () => run());
      await act(async () => {});
    };
    const click = (node: DomElement | null) =>
      drain(() => {
        node?.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      });
    const dialog = (): DomElement | null => win.document.querySelector('[role="dialog"]');

    return {
      win,
      sent,
      dialog,
      async open() {
        const trigger =
          [...win.document.querySelectorAll("button")].find(
            (node) => node.textContent === t("en", "apps.create"),
          ) ?? null;
        await click(trigger);
      },
      addLink(): DomElement | null {
        const href = `${apiBase()}/repos`;
        return (
          [...(dialog()?.querySelectorAll("a") ?? [])].find(
            (node) => node.getAttribute("href") === href && node.textContent === t("en", "targets.add"),
          ) ?? null
        );
      },
      async cleanup() {
        globalThis.fetch = realFetch;
        await act(async () => root.unmount());
        cleanup();
      },
    };
  }

  test("the dialog links to the repository add flow and posts no target", async () => {
    const page = await mountPage("/dashboard/acme/apps", [SHARED]);
    try {
      await page.open();
      expect(page.dialog()).not.toBeNull();
      expect(page.addLink()?.getAttribute("href")).toBe("/dashboard/acme/repos");
      expect(page.dialog()?.querySelector('[data-slot="create-target-form"]')).toBeNull();
      expect(page.dialog()?.querySelector("form[action$='/api/targets']")).toBeNull();
      expect(page.dialog()?.querySelector('[data-slot="shared-bots"]')?.textContent).toContain("Platform App");
      expect(page.sent.filter((request) => request.method === "POST")).toHaveLength(0);
    } finally {
      await page.cleanup();
    }
  });

  test("the self-hosted manifest flow stays available beside it", async () => {
    const page = await mountPage("/dashboard/acme/apps", [{ id: 7, name: "Broken" }]);
    try {
      await page.open();
      expect(page.dialog()?.querySelector('form[action="/dashboard/acme/manifest/start"]')).not.toBeNull();
      expect(page.addLink()).not.toBeNull();
      expect(page.dialog()?.textContent).toContain(t("en", "apps.createDialog.noSharedBots"));
    } finally {
      await page.cleanup();
    }
  });
});
