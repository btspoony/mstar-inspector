/**
 * QC F2-10: pending-bind rows state bindability, and orphans group by App.
 *
 * The list used to offer a Bind action on every pending row: a member got a
 * 403, an owned-unshared App a 404 (the bind route refuses a non-shared App
 * outright), and two installations of one orphan shared App rendered as two
 * App rows. The server now states `can_bind` — the same manager fact the bind
 * route checks first — and the row renders the action only when it says so.
 */
import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../../src/i18n";
import type { SpaBoot } from "../../src/spa/boot";
import { AppsPage, AppsView } from "../../src/spa/pages/AppsPage";
import type { AppsPayload, PendingBindRow } from "../../src/spa/pages/data";
import { withLocation } from "./browser-stub";
import { installDom, withMarkup } from "./dom";

const BOOT: SpaBoot = {
  locale: "en",
  login: "octocat",
  name: "The Octocat",
  workspaceRef: "acme",
  canCreateApp: true,
  memberships: [{ id: "ws_a", slug: "acme", name: "Acme", role: "owner", plan: "Free" }],
};

const payload = (extra: Partial<AppsPayload> = {}): AppsPayload => ({
  viewer: { login: "octocat", role: "admin" },
  apps: [],
  shared_bots: [],
  pending_installations: [],
  ...extra,
});

const pendingRow = (overrides: Partial<PendingBindRow> = {}): PendingBindRow => ({
  installation_id: 88001,
  account_login: "acme-org",
  seen_at: "2026-11-27T08:14:00Z",
  app_id: "app-shared",
  app_github_app_id: 4242,
  app_name: "Shared App",
  can_bind: true,
  ...overrides,
});

const render = (data: AppsPayload): string =>
  withLocation("/dashboard/acme/apps?tab=installed", () =>
    renderToStaticMarkup(
      createElement(AppsView, {
        locale: "en",
        state: "ok",
        payload: data,
        canCreate: true,
        unavailableReason: "",
        tab: "installed",
        onRetry: () => {},
      }),
    ),
  );

const bindActions = (html: string): number =>
  html.split(t("en", "settings.installPendingBind")).length - 1;

/** Mount the real page over a stubbed list read, so the flow itself is exercised. */
async function mountPage(data: AppsPayload) {
  const { win, cleanup } = installDom("http://localhost/dashboard/acme/apps?tab=installed");
  const realFetch = globalThis.fetch;
  const sent: Array<{ url: string; method: string }> = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    sent.push({ url: String(input), method: init?.method ?? "GET" });
    if ((init?.method ?? "GET") === "POST") return new Response('{"error":"unknown app"}', { status: 404 });
    return new Response(JSON.stringify(data), { status: 200, headers: { "Content-Type": "application/json" } });
  }) as unknown as typeof fetch;
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => root.render(createElement(AppsPage, { boot: BOOT })));
  await act(async () => {});
  const buttons = [...win.document.querySelectorAll("button")].filter(
    (node) => node.textContent === t("en", "settings.installPendingBind"),
  );
  return {
    sent,
    buttons,
    text: () => win.document.body.textContent ?? "",
    /** One click on the nth bind action, by index — the node type is the DOM's. */
    click: async (index: number) => {
      const button = buttons[index];
      await act(async () => {
        button?.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      });
      await act(async () => {});
    },
    async cleanup() {
      globalThis.fetch = realFetch;
      await act(async () => root.unmount());
      cleanup();
    },
  };
}

describe("F2-10 — only a row the server says may bind offers the action", () => {
  test("a member gets the pending state with no bind action", () => {
    const html = render(payload({ viewer: { login: "octocat", role: "member" }, pending_installations: [pendingRow({ can_bind: false })] }));
    expect(html).toContain("Shared App");
    expect(html).toContain(t("en", "settings.installPending"));
    expect(bindActions(html)).toBe(0);
  });

  test("a manager gets exactly one action for the same row", () => {
    const html = render(payload({ pending_installations: [pendingRow()] }));
    expect(bindActions(html)).toBe(1);
  });

  test("an owned-unshared App is never a pending row, so it offers nothing", () => {
    // The server excludes owned Apps from the pending list (the bind route
    // answers 404 for them); the surface has nothing to render either way.
    const html = render(payload({ pending_installations: [] }));
    expect(bindActions(html)).toBe(0);
    expect(html).not.toContain("Shared App");
  });

  test("two orphan installations of ONE shared App render as one App row with both installations", async () => {
    const html = render(
      payload({
        pending_installations: [
          pendingRow({ installation_id: 88001, account_login: "acme-org" }),
          pendingRow({ installation_id: 88002, account_login: "acme-labs" }),
        ],
      }),
    );
    await withMarkup(html, (container) => {
      const rows = [...container.querySelectorAll("tbody tr")];
      expect(rows).toHaveLength(1);
      expect(rows[0]?.textContent).toContain("Shared App");
      expect(rows[0]?.textContent).toContain("acme-org");
      expect(rows[0]?.textContent).toContain("acme-labs");
      // One action per installation, both inside the same row.
      expect(rows[0]?.querySelectorAll("button")).toHaveLength(2);
    });
  });

  test("the one bind flow posts to the registered route from the list", async () => {
    const page = await mountPage(payload({ pending_installations: [pendingRow()] }));
    try {
      expect(page.buttons).toHaveLength(1);
      await page.click(0);
      const posts = page.sent.filter((request) => request.method === "POST");
      expect(posts.map((post) => post.url)).toEqual(["/dashboard/acme/api/apps/4242/bind-installation"]);
      expect(page.text()).toContain(t("en", "settings.installBindFailed"));
    } finally {
      await page.cleanup();
    }
  });
});
