/**
 * Task 5 — the Apps list faces (ADR: two origins, two faces; prototype screen
 * 1): every detail link carries its origin, the ONE create action opens
 * 创建 GitHub App with the manifest POST as its primary path, an App this
 * workspace already installed is never offered for install again, a pending
 * installation renders inside its App's row, and spend reads 本月已用 in
 * Credits with no 24h rejection figure anywhere.
 */
import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../../src/i18n";
import type { SpaBoot } from "../../src/spa/boot";
import { AppsPage, AppsView } from "../../src/spa/pages/AppsPage";
import type { AppsPayload, SharedAppCard } from "../../src/spa/pages/data";
import { withLocation } from "./browser-stub";
import { installDom, withMarkup } from "./dom";

const app = (overrides: Partial<AppsPayload["apps"][number]> = {}): AppsPayload["apps"][number] => ({
  github_app_id: 101,
  owned: true,
  installed: true,
  month: null,
  github_slug: "demo",
  github_name: "Demo App",
  github_avatar_url: null,
  status: "active",
  review_enabled: 1,
  created_by: "mallory",
  health: { latest: null, rejected24h: 0 },
  ...overrides,
});

const payload = (apps: AppsPayload["apps"], extra: Partial<AppsPayload> = {}): AppsPayload => ({
  viewer: { login: "mallory", role: "admin" },
  apps,
  shared_bots: [],
  ...extra,
});

const render = (data: AppsPayload, tab: "installed" | "created"): string =>
  withLocation("/dashboard/acme/apps", () =>
    renderToStaticMarkup(
      createElement(AppsView, {
        locale: "en",
        state: "ok",
        payload: data,
        canCreate: true,
        unavailableReason: "",
        tab,
        onRetry: () => {},
      }),
    ),
  );

describe("origin on every detail link", () => {
  test("installed rows link with ?from=installed", () => {
    const html = render(payload([app()]), "installed");
    expect(html).toContain('href="/dashboard/acme/apps/101?from=installed"');
  });

  test("created rows link with ?from=created", () => {
    const html = render(payload([app()]), "created");
    expect(html).toContain('href="/dashboard/acme/apps/101?from=created"');
  });
});

const BOOT: SpaBoot = {
  locale: "en",
  login: "octocat",
  name: "The Octocat",
  workspaceRef: "acme",
  canCreateApp: true,
  memberships: [{ id: "ws_a", slug: "acme", name: "Acme", role: "owner", plan: "Free" }],
};

const SHARED_INSTALLED: SharedAppCard = {
  id: "app-shared-installed",
  github_slug: "shared-installed",
  name: "Installed Shared App",
  github_description: null,
  owner_workspace_id: "ws-platform",
  owner_workspace_name: "Platform",
  capability: null,
  target_count: 0,
};
const SHARED_FRESH: SharedAppCard = {
  ...SHARED_INSTALLED,
  id: "app-shared-fresh",
  github_slug: "shared-fresh",
  name: "Fresh Shared App",
};

/** Mount the real page with a stubbed list read and open the create dialog. */
async function mountWithDialog(appsPayload: Record<string, unknown>) {
  const { win, cleanup } = installDom("http://localhost/dashboard/acme/apps");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () =>
    new Response(JSON.stringify(appsPayload), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    })) as unknown as typeof fetch;
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => root.render(createElement(AppsPage, { boot: BOOT })));
  await act(async () => {});
  const trigger = [...win.document.querySelectorAll("button")].find(
    (node) => node.textContent === t("en", "apps.create"),
  );
  await act(async () => {
    trigger?.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  });
  await act(async () => {});
  return {
    triggerFound: trigger !== undefined,
    dialog: () => win.document.querySelector('[role="dialog"]'),
    async cleanup() {
      globalThis.fetch = realFetch;
      await act(async () => root.unmount());
      cleanup();
    },
  };
}

describe("the create action is a real create dialog", () => {
  test("titled 创建 GitHub App, the manifest POST primary, no repository-add path", async () => {
    const page = await mountWithDialog({
      viewer: { login: "octocat", role: "admin" },
      apps: [app({ installed: false })],
      shared_bots: [],
      shared_apps: [SHARED_FRESH],
    });
    try {
      expect(page.triggerFound).toBe(true);
      const dialog = page.dialog();
      expect(dialog).not.toBeNull();
      expect(dialog?.textContent).toContain(t("en", "apps.createDialog.githubTitle"));
      const form = dialog?.querySelector('form[action="/dashboard/acme/manifest/start"]');
      expect(form).not.toBeNull();
      expect(form?.querySelector('button[type="submit"]')).not.toBeNull();
      // The retired targets.add primary is gone.
      expect(dialog?.querySelector('a[href$="/repos"]')).toBeNull();
      // The secondary path is named.
      expect(dialog?.textContent).toContain(t("en", "apps.createDialog.shared"));
    } finally {
      await page.cleanup();
    }
  });

  test("the dialog renders even when the workspace created no App", async () => {
    const page = await mountWithDialog({
      viewer: { login: "octocat", role: "admin" },
      apps: [],
      shared_bots: [],
      shared_apps: [],
    });
    try {
      // Without a created App the header still carries the ONE create action.
      expect(page.triggerFound).toBe(true);
      const dialog = page.dialog();
      expect(dialog).not.toBeNull();
      expect(dialog?.textContent).toContain(t("en", "apps.createDialog.githubTitle"));
      expect(dialog?.querySelector('form[action="/dashboard/acme/manifest/start"]')).not.toBeNull();
    } finally {
      await page.cleanup();
    }
  });

  test("an App this workspace already installed is not offered for install again", async () => {
    const page = await mountWithDialog({
      viewer: { login: "octocat", role: "admin" },
      apps: [app({ bot_id: "app-shared-installed", github_slug: "shared-installed", installed: true })],
      shared_bots: [],
      shared_apps: [SHARED_INSTALLED, SHARED_FRESH],
    });
    try {
      const dialog = page.dialog();
      expect(dialog?.textContent).toContain("Fresh Shared App");
      // No card, no install action, no bind-after-install hint for the installed App.
      expect(dialog?.textContent).not.toContain("Installed Shared App");
      const installLinks = [...(dialog?.querySelectorAll('a[target="_blank"]') ?? [])];
      expect(installLinks).toHaveLength(1);
      expect(installLinks[0]?.textContent).toBe(t("en", "apps.cardInstall"));
    } finally {
      await page.cleanup();
    }
  });
});

describe("pending installations attach to their App's row", () => {
  const PENDING = {
    installation_id: 88123,
    account_login: "acme-org",
    seen_at: "2026-11-27T08:14:00Z",
    app_id: "app-local-1",
    app_github_app_id: 101,
    app_name: "Demo App",
  };

  /** Mount the page on the installed tab with a stubbed list read. */
  async function mountInstalled(appsPayload: Record<string, unknown>) {
    const { win, cleanup } = installDom("http://localhost/dashboard/acme/apps?tab=installed");
    const realFetch = globalThis.fetch;
    const sent: Array<{ url: string; method: string }> = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      sent.push({ url: String(input), method: init?.method ?? "GET" });
      if ((init?.method ?? "GET") === "POST") return new Response('{"error":"unknown installation"}', { status: 404 });
      return new Response(JSON.stringify(appsPayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    await act(async () => root.render(createElement(AppsPage, { boot: BOOT })));
    await act(async () => {});
    const button = [...win.document.querySelectorAll("button")].find(
      (node) => node.textContent === t("en", "settings.installPendingBind"),
    );
    return {
      win,
      sent,
      buttonFound: button !== undefined,
      click: async () => {
        await act(async () => {
          button?.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
        });
        await act(async () => {});
      },
      text: () => win.document.body.textContent ?? "",
      async cleanup() {
        globalThis.fetch = realFetch;
        await act(async () => root.unmount());
        cleanup();
      },
    };
  }

  test("account, state and bind action render inside the owning App's row", async () => {
    const html = render(payload([app()], { pending_installations: [PENDING] }), "installed");
    await withMarkup(html, (container) => {
      const appRow = [...container.querySelectorAll("tr")].find((row) =>
        row.textContent?.includes("Demo App"),
      );
      expect(appRow).toBeDefined();
      expect(appRow?.textContent).toContain("acme-org");
      expect(appRow?.textContent).toContain(t("en", "settings.installPending"));
      expect(appRow?.textContent).toContain(t("en", "settings.installPendingBind"));
      // Never a detached list under the table.
      expect(container.querySelector('[data-slot="pending-installations"]')).toBeNull();
    });
  });

  test("a pending installation whose App has no installed row still renders inside the same table", async () => {
    const html = render(
      payload([], { pending_installations: [{ ...PENDING, app_github_app_id: 4242, app_name: "Shared Pending App" }] }),
      "installed",
    );
    await withMarkup(html, (container) => {
      const table = container.querySelector("table");
      expect(table?.textContent).toContain("Shared Pending App");
      expect(table?.textContent).toContain("acme-org");
      expect(table?.textContent).toContain(t("en", "settings.installPendingBind"));
    });
  });

  test("one bind click posts to the registered API route and does not open the App detail", async () => {
    const page = await mountInstalled({
      viewer: { login: "octocat", role: "admin" },
      apps: [app({ installed: true, month: { used_rp: 0, owned: true, multiplier: 1 } })],
      shared_bots: [],
      pending_installations: [PENDING],
    });
    try {
      expect(page.buttonFound).toBe(true);
      await page.click();
      const posts = page.sent.filter((request) => request.method === "POST");
      expect(posts).toHaveLength(1);
      // The registered route carries `/api`; without it the bind never lands.
      expect(posts[0]?.url).toBe("/dashboard/acme/api/apps/101/bind-installation");
      // The row's own handler would have navigated to the detail page.
      expect(page.win.location.pathname).toBe("/dashboard/acme/apps");
      // A failed bind stays on screen instead of vanishing behind navigation.
      expect(page.text()).toContain(t("en", "settings.installBindFailed"));
    } finally {
      await page.cleanup();
    }
  });
});

describe("no 24h rejection figure", () => {
  test("neither the metric band nor any row renders a 24h figure", () => {
    const data = payload([app({ health: { latest: null, rejected24h: 5 } })]);
    expect(render(data, "installed")).not.toContain("24h");
    expect(render(data, "created")).not.toContain("24h");
  });
});

describe("spend reads 本月已用 in Credits", () => {
  test("the month cell is a Credits figure with its ceiling state, never RP", () => {
    const unlimited = render(
      payload([app({ month: { used_rp: 1240, owned: false, multiplier: 1 } })], { month_plan_rp: null }),
      "installed",
    );
    expect(unlimited).toContain(t("en", "credits.usedThisMonth"));
    expect(unlimited).toContain(t("en", "credits.noCeiling", { used: "1.24" }));
    const limited = render(
      payload([app({ month: { used_rp: 1240, owned: false, multiplier: 1 } })], { month_plan_rp: 5000 }),
      "installed",
    );
    expect(limited).toContain("1.24 Credits / 5.00 Credits");
    // No RP-denominated figure survives anywhere on the face.
    expect(unlimited).not.toMatch(/\d RP\b/);
    expect(limited).not.toMatch(/\d RP\b/);
  });

  test("a non-default profile rate divides both the spend and the ceiling", () => {
    const html = render(
      payload([app({ month: { used_rp: 1000, owned: false, multiplier: 1 } })], {
        month_plan_rp: 5000,
        rp_per_credit: 2000,
      }),
      "installed",
    );
    // 1,000 RP at 2,000 RP/Credit is 0.50 — never the 1,000-rate 1.00.
    expect(html).toContain("0.50 Credits / 2.50 Credits");
    expect(html).not.toContain("1.00 Credits / 5.00 Credits");
  });

  test("an absent rate (unreadable profile) keeps the documented 1,000 fallback", () => {
    const html = render(
      payload([app({ month: { used_rp: 1000, owned: false, multiplier: 1 } })], { month_plan_rp: 5000 }),
      "installed",
    );
    expect(html).toContain("1.00 Credits / 5.00 Credits");
  });

  test("an all-own chain reads its own-bot unlimited in Credits", () => {
    const html = render(payload([app({ month: { used_rp: 1240, owned: true, multiplier: 1 } })]), "installed");
    expect(html).toContain(t("en", "credits.unlimitedOwn", { used: "1.24" }));
  });
});

describe("the installed empty state renders ONE create control", () => {
  test("the header carries create; the empty state carries only browse-shared", () => {
    const html = render(payload([]), "installed");
    const createLabel = t("en", "apps.create");
    expect(html.split(createLabel).length - 1).toBe(1);
    expect(html).toContain(t("en", "apps.installed.browseShared"));
  });
});
