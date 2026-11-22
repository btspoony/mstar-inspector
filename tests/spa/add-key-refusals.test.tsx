import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { t } from "../../src/i18n";
import type { BotSettingsPayload } from "../../src/spa/pages/data";
import { BotSettingsView } from "../../src/spa/pages/BotSettingsPage";
import { installDom } from "./dom";

const locale = "en" as const;

function payload(): BotSettingsPayload {
  return {
    can_manage: true,
    app: {
      github_app_id: 1,
      id: "app-demo",
      status: "active",
      scope: "owned",
      sandbox_image_id: "omp",
      last_webhook_at: null,
      github_name: "Demo",
      github_slug: "demo",
      github_description: null,
      github_html_url: null,
      github_avatar_url: null,
      github_metadata_synced_at: null,
    },
    keys: [
      {
        provider: "openai",
        keyId: "0123456789abcdef",
        last4: "wxyz",
        updatedAt: null,
        verifiedAt: null,
        verifiedStatus: null,
      },
    ],
    model_chain: "openai/gpt-5",
    model_roles: { "mstar-review-seat": "fast" },
    model_chains: [],
    custom_providers: [],
    configured_providers: [
      {
        kind: "key",
        provider: "openai",
        key_id: "0123456789abcdef",
        last4: "wxyz",
        updated_at: null,
        verified_at: null,
        verified_status: null,
      },
    ],
    provider_catalog_version: "fixture-catalog",
    provider_eligibility: {},
    model_role_ids: ["mstar-review-seat"],
    custom_provider_api_ids: [],
    sandbox_images: [{ id: "omp", enabled: true }],
    installations: [],
  };
}

async function refusalNotice(answer: { status: number; body: string } | "reject"): Promise<string> {
  const { win, cleanup } = installDom("http://localhost/dashboard/acme/apps/1/bot");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    if (String(input).includes("/api/provider-catalog")) {
      return Response.json({ provider_catalog: [], model_limits_snapshot: "fixture-snapshot" });
    }
    if (!String(input).includes("/keys/verify")) return new Response("ok", { status: 200 });
    if (answer === "reject") throw new TypeError("Failed to fetch");
    return new Response(answer.body, { status: answer.status });
  }) as unknown as typeof fetch;

  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  try {
    await act(async () =>
      root.render(
        createElement(BotSettingsView, {
          locale,
          payload: payload(),
          groups: [],
          notice: null,
          onReload: async () => true,
        }),
      ),
    );
    const byLabel = (label: string): HTMLElement | undefined =>
      [...container.querySelectorAll("button")].find((node) => node.textContent === label) as unknown as
        | HTMLElement
        | undefined;

    await act(async () => byLabel(t(locale, "settings.addKey"))?.click());
    const dialog = (): HTMLElement | null =>
      win.document.querySelector('[role="dialog"]') as unknown as HTMLElement | null;
    const field = dialog()?.querySelector('input[type="password"]') as HTMLInputElement | null;
    const setValue = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setValue?.call(field, "sk-third-key");
      field?.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
    });
    await act(async () => {
      dialog()
        ?.querySelector("form")
        ?.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
    });
    await act(async () => {});
    return dialog()?.querySelector('[role="alert"]')?.textContent ?? "";
  } finally {
    await act(async () => root.unmount());
    cleanup();
    globalThis.fetch = realFetch;
  }
}

describe("add-key dialog: one message per status", () => {
  test("400 with a keyed body keeps the server's own face", async () => {
    const notice = await refusalNotice({
      status: 400,
      body: JSON.stringify({
        key: "settings.error.providerKeyLimit",
        params: { provider: "openai", limit: 8 },
      }),
    });
    expect(notice).toBe(t(locale, "settings.error.providerKeyLimit", { provider: "openai", limit: 8 }));
  });

  test("400 the body cannot explain is the refusal face, not the provider's", async () => {
    const notice = await refusalNotice({ status: 400, body: "bad request" });
    expect(notice).toBe(t(locale, "settings.providers.addKeyRefused"));
    expect(notice).not.toContain(t(locale, "settings.verify.unexpected"));
  });

  test("403 splits the shared bot from the forbidden page", async () => {
    const shared = await refusalNotice({
      status: 403,
      body: JSON.stringify({ key: "settings.error.botReadOnly", message: "read-only" }),
    });
    expect(shared).toBe(t(locale, "settings.error.botReadOnly"));
    const forbidden = await refusalNotice({ status: 403, body: "<!doctype html><title>Forbidden</title>" });
    expect(forbidden).toBe(t(locale, "settings.providers.addKeyForbidden"));
  });

  test("404, 409 and 429 each render their own sentence", async () => {
    expect(await refusalNotice({ status: 404, body: "" })).toBe(
      t(locale, "settings.providers.addKeyUnknownApp"),
    );
    expect(await refusalNotice({ status: 409, body: "" })).toBe(
      t(locale, "settings.providers.addKeyConflict"),
    );
    expect(await refusalNotice({ status: 429, body: "" })).toBe(
      t(locale, "settings.providers.addKeyRateLimited"),
    );
  });

  test("500 splits by body shape", async () => {
    expect(await refusalNotice({ status: 500, body: "the app settings need a configured DASHBOARD_ENCRYPTION_KEY" })).toBe(
      t(locale, "settings.providers.addKeyNoMasterKey"),
    );
    expect(await refusalNotice({ status: 500, body: JSON.stringify({ ok: false, reason: "unexpected" }) })).toBe(
      t(locale, "settings.providers.addKeyStorageFailed"),
    );
  });

  test("a non-JSON body on an unclassified status is the unreadable face", async () => {
    expect(await refusalNotice({ status: 418, body: "<html>teapot</html>" })).toBe(
      t(locale, "settings.providers.addKeyUnreadable"),
    );
  });

  test("a network failure says the request never reached the server", async () => {
    expect(await refusalNotice("reject")).toBe(t(locale, "settings.providers.submitFailed"));
  });
});
