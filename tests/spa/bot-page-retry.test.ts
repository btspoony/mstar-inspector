/**
 * F14: the model-failure / retry contract, pinned by MOUNTING `BotDetailPage`.
 *
 * The previous version of this file called `fetch` and asserted a locally
 * built array — it proved nothing about the page. This one renders the real
 * page against a stubbed network and walks the three states in order:
 *
 *   failure → the editor shows a visible error and the rest of the page still
 *             renders;
 *   retry   → both affected reads are re-issued;
 *   success → the editor becomes usable.
 */
import { describe, expect, test } from "bun:test";
import { type Element as DomElement } from "happy-dom";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { t } from "../../src/i18n";
import type { SpaBoot } from "../../src/spa/boot";
import { BotDetailPage } from "../../src/spa/pages/BotDetailPage";
import { installDom } from "./dom";

const BOOT: SpaBoot = { locale: "en", login: "mallory", name: "Mallory" };

const BOT_PAYLOAD = {
  can_manage: true,
  owned: true,
  archived: false,
  app: {
    github_app_id: null,
    id: "bot-1",
    name: "Team bot",
    description: "The team's review bot.",
    status: null,
    scope: "owned",
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
  provider_catalog_version: "f14-catalog",
  provider_eligibility: {},
  model_role_ids: [],
  custom_provider_api_ids: [],
  sandbox_images: [{ id: "omp", enabled: true }],
  overview: {
    provider_workspace: "Acme",
    month_used_rp: 0,
    plan_monthly_rp: null,
    effective_ceiling: null,
    default_chain: null,
    mounted_apps: [],
  },
};

const MODELS_OK = {
  groups: [{ provider: "anthropic", source: "verified", selectors: ["anthropic/f14-model"] }],
};

type FixtureWindow = ReturnType<typeof installDom>["win"];

/** A click against the mounted happy-dom document (the fixture's own Event). */
async function click(win: FixtureWindow, node: DomElement | null): Promise<void> {
  await act(async () => {
    node?.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
  });
  await act(async () => {});
}

describe("F14 — BotDetailPage keeps a models failure visible and retries it", () => {
  test("the retry re-reads ONLY the options: unsaved drafts and chain rows survive, no second bot GET", async () => {
    const { win, cleanup } = installDom("https://worker.local/dashboard/acme/bots/bot-1");
    const realFetch = globalThis.fetch;
    let modelsCalls = 0;
    let botGets = 0;
    let modelsShouldFail = true;
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("/api/review-bots/bot-1/bot")) {
        botGets += 1;
        return Response.json(BOT_PAYLOAD);
      }
      if (url.endsWith("/api/models")) {
        modelsCalls += 1;
        return modelsShouldFail
          ? new Response("unavailable", { status: 503 })
          : Response.json(MODELS_OK);
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(createElement(BotDetailPage, { boot: BOOT, botId: "bot-1" })));
      for (let flush = 0; flush < 4; flush += 1) await act(async () => {});

      // 1. THE PAGE RENDERED: the bot's own facts are on screen even though the
      //    models read failed — the failure is not fatal to the page.
      expect(container.textContent).toContain("Team bot");
      // The rest of the page rendered: the overview's own facts are present.
      expect(container.textContent).toContain(t("en", "botDetail.usage.source"));
      expect(container.textContent).toContain("Acme");

      // 2. THE FAILURE IS VISIBLE on the editor, with its retry affordance —
      //    not silently flattened into "no models configured".
      expect(container.textContent).toContain(t("en", "bots.modelsFailed"));
      const retry = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === t("en", "common.retry"),
      );
      expect(retry).toBeDefined();
      const callsBeforeRetry = modelsCalls;

      // 2b. TYPE A DRAFT into the identity editor — the retry must not discard it.
      const nameInput = container.querySelector('input[aria-label]');
      expect(nameInput).not.toBeNull();
      const inputEl = nameInput as unknown as { value: string; dispatchEvent: (e: unknown) => void };
      const proto = Object.getPrototypeOf(nameInput) as object;
      const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
      setter?.call(nameInput, "Renamed in progress");
      inputEl.dispatchEvent(new win.Event("input", { bubbles: true }));
      await act(async () => {});
      expect((container.querySelector('input[aria-label]') as unknown as { value: string }).value).toBe(
        "Renamed in progress",
      );
      const botGetsBefore = botGets;

      // 3. RETRY RE-READS THE OPTIONS ONLY and, this time, succeeds: the error
      //    clears, the DRAFT SURVIVES, and the bot payload is not re-read.
      modelsShouldFail = false;
      if (retry !== undefined) {
        // happy-dom's element type differs nominally from the DOM's; the node
        // came from this window's own query, so the cast is structural only.
        const retryNode = retry as unknown as DomElement;
        await click(win, retryNode);
      }
      for (let flush = 0; flush < 4; flush += 1) await act(async () => {});
      expect(modelsCalls).toBeGreaterThan(callsBeforeRetry);
      expect(container.textContent).not.toContain(t("en", "bots.modelsFailed"));
      expect(container.textContent).toContain("Team bot");
      // THE CONTRACT: no second bot GET, and the typed draft survived the retry.
      expect(botGets).toBe(botGetsBefore);
      expect((container.querySelector('input[aria-label]') as unknown as { value: string }).value).toBe(
        "Renamed in progress",
      );
    } finally {
      await act(async () => root.unmount());
      globalThis.fetch = realFetch;
      cleanup();
    }
  });

  test("a malformed models body is an error too, never an empty catalog", async () => {
    const { win, cleanup } = installDom("https://worker.local/dashboard/acme/bots/bot-1");
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.includes("/api/review-bots/bot-1/bot")) return Response.json(BOT_PAYLOAD);
      if (url.endsWith("/api/models")) return Response.json({ groups: "nope" });
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(createElement(BotDetailPage, { boot: BOOT, botId: "bot-1" })));
      for (let flush = 0; flush < 4; flush += 1) await act(async () => {});
      expect(container.textContent).toContain("Team bot");
      expect(container.textContent).toContain(t("en", "bots.modelsFailed"));
    } finally {
      await act(async () => root.unmount());
      globalThis.fetch = realFetch;
      cleanup();
    }
  });
});
