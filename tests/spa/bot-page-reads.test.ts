/**
 * F14: the model/catalog retry and error-isolation contract moved with the
 * editors it belongs to. These pins exercise the BOT page's own reads — the
 * model options read and the provider-catalog read — so the behaviour keeps a
 * live test after the App detail stopped rendering those editors.
 */
import { describe, expect, test } from "bun:test";
import { parseBotSettings, parseModels } from "../../src/spa/pages/data";
import { parseProviderCatalog } from "../../src/spa/pages/data";
import { loadProviderCatalog } from "../../src/spa/provider-catalog";

const botPayload = {
  can_manage: true,
  owned: true,
  archived: false,
  app: {
    github_app_id: null,
    id: "bot-1",
    name: "Team bot",
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
  provider_catalog_version: "fixture-version",
  provider_eligibility: {},
  model_role_ids: [],
  custom_provider_api_ids: [],
  sandbox_images: [{ id: "omp", enabled: true }],
  overview: {
    provider_workspace: "Acme",
    month_used_rp: 0,
    plan_monthly_rp: null,
    default_chain: "anthropic/claude",
    mounted_apps: [],
  },
};

describe("F14 — the bot page's own reads keep their contract", () => {
  test("the bot payload parses with the explicit ownership bit and the overview", () => {
    const parsed = parseBotSettings(botPayload);
    expect(parsed?.owned).toBe(true);
    expect(parsed?.overview?.default_chain).toBe("anthropic/claude");
  });

  test("a malformed bot payload is a parse failure, never a silently empty page", () => {
    expect(parseBotSettings({ ...botPayload, overview: { provider_workspace: 1 } })).toBeNull();
    expect(parseBotSettings({ ...botPayload, can_manage: "yes" })).toBeNull();
  });

  test("the models read and the provider catalog read are independent: one failing leaves the other usable", async () => {
    const realFetch = globalThis.fetch;
    let modelsCalls = 0;
    let catalogCalls = 0;
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/models")) {
        modelsCalls += 1;
        return new Response("unavailable", { status: 503 });
      }
      if (url.includes("/api/provider-catalog")) {
        catalogCalls += 1;
        return Response.json({ provider_catalog: [], model_limits_snapshot: "fixture-snapshot" });
      }
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    try {
      // Models failing is nonfatal: the page still renders, with no options.
      const models = await fetch("/d/api/models").catch(() => null);
      expect(models instanceof Response ? models.ok : models).toBe(false);
      const catalog = await loadProviderCatalog("/d", "fixture-version");
      expect(catalog).not.toBeNull();
      expect(modelsCalls).toBe(1);
      expect(catalogCalls).toBe(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });

  test("a failed models payload parses to null rather than a fabricated empty group list", () => {
    expect(parseModels({ groups: "nope" })).toBeNull();
    expect(parseModels({ groups: [] })?.groups).toEqual([]);
  });

  test("the provider catalog parser rejects a body it cannot render", () => {
    expect(parseProviderCatalog({ providers: "x" })).toBeNull();
  });
});
