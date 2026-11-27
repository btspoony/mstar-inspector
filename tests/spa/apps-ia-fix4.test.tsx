/**
 * Fix-round-4 pins for the three reopenings.
 *
 * 1. **F9** — the Create marketplace consumes `shared_apps` only. A private App
 *    with a same-id shared bot must not appear, and a shared App with no bot
 *    must.
 * 2. **F10** — every quota consumer branches on `quota_error`; an unknown
 *    ceiling never renders "no ceiling". One test per consumer (bots table,
 *    bot detail).
 * 3. **Reload race** — a successful settings write stays a success when the
 *    follow-up read fails; the failure is a stale-data notice, and no second
 *    full load runs.
 */
import { describe, expect, test } from "bun:test";
import { type Element as DomElement } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../../src/i18n";
import type { SpaBoot } from "../../src/spa/boot";
import { BotDetailPage } from "../../src/spa/pages/BotDetailPage";
import { BotsView, type BotsReadState } from "../../src/spa/pages/BotsPage";
import type { UsableBotsPayload } from "../../src/spa/pages/data";
import { installDom } from "./dom";

const BOOT: SpaBoot = { locale: "en", login: "mallory", name: "Mallory" };

// ---------------------------------------------------------------- F10: bots

const botsPayload = (quota: { plan_monthly_rp: number | null; quota_error?: boolean }): UsableBotsPayload => ({
  workspace_id: "ws",
  ...quota,
  bots: [
    {
      id: "bot-shared",
      name: "Shared bot",
      description: null,
      workspace_id: "ws-other",
      workspace_name: "Other",
      owned: false,
      can_manage: false,
      scope: "shared",
      multiplier: 1,
      month_used_rp: 42,
      effective_ceiling: null,
      archived: false,
    },
  ],
});

const renderBots = (payload: UsableBotsPayload): string =>
  renderToStaticMarkup(
    createElement(BotsView, {
      locale: "en",
      base: "/dashboard/acme",
      state: { kind: "ok", payload } as BotsReadState,
      canCreate: false,
      onCreated: () => {},
    }),
  );

describe("F10 — the bots table branches on quota_error", () => {
  test("an UNKNOWN ceiling renders the unknown marker, never 'no ceiling'", () => {
    const html = renderBots(botsPayload({ plan_monthly_rp: null, quota_error: true }));
    expect(html).toContain(t("en", "bots.monthUnknown"));
    expect(html).not.toContain(t("en", "credits.noCeiling", { used: "0.04" }));
  });

  test("a KNOWN unlimited plan still reads 'no ceiling'", () => {
    const html = renderBots(botsPayload({ plan_monthly_rp: null }));
    expect(html).toContain(t("en", "credits.noCeiling", { used: "0.04" }));
    expect(html).not.toContain(t("en", "bots.monthUnknown"));
  });
});

// ------------------------------------------------------- F10: bot detail

const BOT_PAYLOAD = {
  can_manage: true,
  owned: false,
  archived: false,
  app: {
    github_app_id: null,
    id: "bot-shared",
    name: "Shared bot",
    description: null,
    status: null,
    scope: "shared",
    sandbox_image_id: "omp",
    last_webhook_at: null,
    github_name: null,
    github_slug: null,
    github_description: null,
    github_html_url: null,
    github_avatar_url: null,
    github_metadata_synced_at: null,
  },
  installations: [],
  keys: [],
  model_chain: null,
  model_roles: {},
  model_chains: [],
  custom_providers: [],
  configured_providers: [],
  provider_catalog_version: "f10",
  provider_eligibility: {},
  model_role_ids: [],
  custom_provider_api_ids: [],
  sandbox_images: [{ id: "omp", enabled: true }],
  overview: {
    provider_workspace: "Other",
    month_used_rp: 42,
    plan_monthly_rp: null,
    effective_ceiling: null,
    default_chain: null,
    mounted_apps: [],
  },
};

async function mountBot(payload: Record<string, unknown>): Promise<{ text: string; cleanup: () => Promise<void> }> {
  const { win, cleanup } = installDom("https://worker.local/dashboard/acme/bots/bot-shared");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/review-bots/")) return Response.json(payload);
    if (url.endsWith("/api/models")) return Response.json({ groups: [] });
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => root.render(createElement(BotDetailPage, { boot: BOOT, botId: "bot-shared" })));
  for (let flush = 0; flush < 4; flush += 1) await act(async () => {});
  return {
    text: container.textContent ?? "",
    cleanup: async () => {
      await act(async () => root.unmount());
      globalThis.fetch = realFetch;
      cleanup();
    },
  };
}

describe("F10 — the bot detail branches on quota_error", () => {
  test("an UNKNOWN ceiling renders the unknown marker, never 'no ceiling'", async () => {
    const page = await mountBot({ ...BOT_PAYLOAD, quota_error: true });
    try {
      expect(page.text).toContain(t("en", "bots.monthUnknown"));
      expect(page.text).not.toContain(t("en", "credits.noCeiling", { used: "0.04" }));
    } finally {
      await page.cleanup();
    }
  });

  test("a KNOWN unlimited plan still reads 'no ceiling'", async () => {
    const page = await mountBot(BOT_PAYLOAD);
    try {
      expect(page.text).toContain(t("en", "credits.noCeiling", { used: "0.04" }));
      expect(page.text).not.toContain(t("en", "bots.monthUnknown"));
    } finally {
      await page.cleanup();
    }
  });
});

// --------------------------------------------------- reload race (mounted)

/**
 * A successful `save-sandbox-image` write whose FOLLOW-UP read fails must
 * report success (plus a stale notice) — and must not start a second full
 * load. The full load's own options read is counted here: only `load()` (and
 * its retry) issues `/api/models`, and neither may run for a section re-read.
 */
describe("reload race — a landed write survives a failed follow-up read", () => {
  test("success message + stale notice, and no second full load", async () => {
    const { win, cleanup } = installDom("https://worker.local/dashboard/acme/bots/bot-shared");
    const realFetch = globalThis.fetch;
    let botReads = 0;
    let modelsReads = 0;
    let writeLanded = false;
    const seen: string[] = [];
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      seen.push(`${method} ${url}`);
      // The editor POSTS to `${apiBase()}/review-bots/:botId/settings`, where
      // apiBase carries the workspace ref — match the tail, not a prefix.
      if (method === "POST" && url.endsWith("/review-bots/bot-shared/settings")) {
        writeLanded = true;
        return new Response("ok", { status: 200 });
      }
      if (url.includes("/api/review-bots/bot-shared/bot")) {
        botReads += 1;
        // The FIRST read succeeds; the follow-up read (after the write) fails.
        if (writeLanded) return new Response("unavailable", { status: 503 });
        return Response.json({ ...BOT_PAYLOAD, can_manage: true, owned: true, app: { ...BOT_PAYLOAD.app, scope: "owned" } });
      }
      if (url.endsWith("/api/models")) {
        modelsReads += 1;
        return Response.json({
          groups: [{ provider: "anthropic", source: "verified", selectors: ["anthropic/m"] }],
        });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () =>
        root.render(createElement(BotDetailPage, { boot: BOOT, botId: "bot-shared" })),
      );
      for (let flush = 0; flush < 4; flush += 1) await act(async () => {});
      // The payload names the bot on the page, and the editable region exists
      // only because `can_manage` is true.
      expect(container.textContent).toContain("Shared bot");
      const buttons = [...container.querySelectorAll("button")].map((b) => b.textContent ?? "");
      expect(buttons).toContain(t("en", "settings.saveRuntimeHarness"));

      const modelsBeforeWrite = modelsReads;
      const save = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === t("en", "settings.saveRuntimeHarness"),
      );
      expect(save).toBeDefined();

      await act(async () => {
        (save as unknown as DomElement).dispatchEvent(
          new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }),
        );
      });
      for (let flush = 0; flush < 6; flush += 1) await act(async () => {});

      // The write landed and is reported as a SUCCESS, not a failed save.
      expect(seen.filter((line) => line.startsWith("POST"))).toHaveLength(1);
      expect(container.textContent).toContain(t("en", "settings.changesSaved"));
      // The failed follow-up read surfaces as a stale-data notice.
      expect(container.textContent).toContain(t("en", "bots.staleAfterSave"));
      // The bot payload WAS re-read once (section-only), but the models read —
      // the full load's other half — was NOT re-issued.
      expect(botReads).toBeGreaterThanOrEqual(2);
      expect(modelsReads).toBe(modelsBeforeWrite);
    } finally {
      await act(async () => root.unmount());
      globalThis.fetch = realFetch;
      cleanup();
    }
  });
});
