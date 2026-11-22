/** note: The bot page's share switch: the official workspace's manager marks its own
 * bot shared, or revokes the share — and every other caller sees nothing about
 * sharing at all.
 *
 * The visibility contract has no soft face: a non-official workspace and a
 * plain member get no section, no title, no disabled control and no copy, so
 * the absent cases are asserted on the rendered DOM, not on a prop. Both
 * directions confirm before the transition, and the request is the workspace
 * route the server owns.
 */
import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { t } from "../../src/i18n";
import { APP_ROUTES } from "../../src/dashboard/index";
import { BotSettingsView } from "../../src/spa/pages/BotSettingsPage";
import type { BotSettingsPayload } from "../../src/spa/pages/data";
import { installDom } from "./dom";

const locale = "en" as const;
const WORKSPACE_REF = "acme";

/** note: The path the page must PATCH, DERIVED from the worker's own route table: a
 * page that composes its own URL would otherwise keep passing its own test
 * while the request 404s against a route registered under another prefix.
 */
function registeredScopePath(appId: string): string {
  const route = APP_ROUTES.find((row) => row.method === "patch" && row.path.endsWith("/bot/scope"));
  if (route === undefined) throw new Error("no PATCH .../bot/scope route is registered");
  return `/dashboard/${WORKSPACE_REF}${route.path.replace(":appId", appId)}`;
}

function payload(overrides: Partial<BotSettingsPayload> = {}): BotSettingsPayload {
  return {
    can_manage: true,
    official_workspace: true,
    app: {
      github_app_id: 1,
      status: "active",
      last_webhook_at: null,
      scope: "owned",
      id: "app-test",
      sandbox_image_id: "omp",
      github_name: null,
      github_slug: null,
      github_description: null,
      github_html_url: null,
      github_avatar_url: null,
      github_metadata_synced_at: null,
    },
    keys: [],
    model_chain: null,
    model_roles: {},
    model_chains: [],
    custom_providers: [],
    configured_providers: [],
    provider_catalog_version: "fixture-catalog",
    provider_eligibility: {},
    model_role_ids: [],
    custom_provider_api_ids: ["openai-completions"],
    sandbox_images: [{ id: "omp", enabled: true }],
    installations: [],
    ...overrides,
  };
}

type Sent = { path: string; method: string; body: unknown };

async function mount(overrides: Partial<BotSettingsPayload> = {}, status = 200, body = "{}") {
  const { win, cleanup } = installDom("http://localhost/dashboard/acme/repos");
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  const sent: Sent[] = [];
  const reloads: number[] = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    sent.push({
      path: new URL(String(input), "http://localhost").pathname,
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return new Response(body, { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;
  try {
    await act(async () => {
      root.render(
        createElement(BotSettingsView, {
          locale,
          payload: payload(overrides),
          groups: [],
          notice: null,
          onReload: async () => {
            reloads.push(1);
            return true;
          },
        }),
      );
    });
    await act(async () => {});
  } catch (err) {
    globalThis.fetch = originalFetch;
    throw err;
  }

  const buttonWith = (label: string, scope?: HTMLElement) => {
    const host = (scope ?? win.document) as unknown as HTMLElement;
    const buttons = host.querySelectorAll("button") as unknown as HTMLButtonElement[];
    return [...buttons].find((button) => button.textContent === label) ?? null;
  };
  const dialog = () => win.document.querySelector('[role="dialog"]') as unknown as HTMLElement | null;
  const click = async (target: Element | null) => {
    await act(async () => {
      target?.dispatchEvent(
        new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }) as unknown as Event,
      );
    });
  };

  return {
    win,
    container,
    sent,
    reloads,
    buttonWith,
    dialog,
    click,
    scopeCalls: () => sent.filter((row) => row.path.endsWith("/bot/scope")),
    cleanup: async () => {
      await act(async () => root.unmount());
      globalThis.fetch = originalFetch;
      cleanup();
    },
  };
}

describe("the bot page's share switch", () => {
  test("sharing confirms first, then PATCHes the shared scope and reloads", async () => {
    const view = await mount();
    try {
      expect(view.container.textContent).toContain(t(locale, "botSettings.shareTitle"));
      await view.click(view.buttonWith(t(locale, "botSettings.shareAction")));
      expect(view.scopeCalls()).toEqual([]);
      expect(view.dialog()?.textContent).toContain(t(locale, "botSettings.confirmShareBody"));

      await view.click(view.buttonWith(t(locale, "botSettings.shareAction"), view.dialog() ?? undefined));

      expect(view.scopeCalls()).toEqual([
        { path: registeredScopePath("1"), method: "PATCH", body: { scope: "shared" } },
      ]);
      expect(view.reloads).toHaveLength(1);
      expect(view.container.textContent).toContain(t(locale, "botSettings.shareSaved"));
    } finally {
      await view.cleanup();
    }
  });

  test("a revoke carries the confirmation the store requires", async () => {
    const view = await mount({ app: { ...payload().app, scope: "shared" } });
    try {
      await view.click(view.buttonWith(t(locale, "botSettings.unshareAction")));
      expect(view.scopeCalls()).toEqual([]);
      expect(view.dialog()?.textContent).toContain(t(locale, "botSettings.confirmUnshareBody"));

      await view.click(view.buttonWith(t(locale, "botSettings.unshareAction"), view.dialog() ?? undefined));

      expect(view.scopeCalls()).toEqual([
        { path: registeredScopePath("1"), method: "PATCH", body: { scope: "owned", confirm: true } },
      ]);
      expect(view.reloads).toHaveLength(1);
    } finally {
      await view.cleanup();
    }
  });

  test("a non-official workspace renders no share concept at all", async () => {
    const view = await mount({ official_workspace: false });
    try {
      const rendered = String(view.container.textContent);
      for (const key of [
        "botSettings.shareTitle",
        "botSettings.shareCopy",
        "botSettings.shareAction",
        "botSettings.unshareAction",
      ] as const) {
        expect(rendered.includes(t(locale, key)), key).toBe(false);
        expect(view.buttonWith(t(locale, key))).toBeNull();
      }
    } finally {
      await view.cleanup();
    }
  });

  test("a plain member renders no share concept either", async () => {
    const view = await mount({ can_manage: false });
    try {
      const rendered = String(view.container.textContent);
      expect(rendered.includes(t(locale, "botSettings.shareTitle"))).toBe(false);
      expect(view.buttonWith(t(locale, "botSettings.shareAction"))).toBeNull();
      expect(rendered).toContain(t(locale, "botSettings.readOnly"));
    } finally {
      await view.cleanup();
    }
  });

  test("a stale share refusal names its cause and never claims a save", async () => {
    const view = await mount({}, 409, JSON.stringify({ error: "bot is outside the official workspace" }));
    try {
      await view.click(view.buttonWith(t(locale, "botSettings.shareAction")));
      await view.click(view.buttonWith(t(locale, "botSettings.shareAction"), view.dialog() ?? undefined));

      expect(view.reloads).toEqual([]);
      expect(view.container.textContent).toContain(t(locale, "botSettings.shareOutsideOfficial"));
      expect(view.container.textContent).not.toContain(t(locale, "botSettings.shareSaved"));
    } finally {
      await view.cleanup();
    }
  });
});
