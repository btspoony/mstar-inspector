import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { t, type Locale } from "../../src/i18n";
import { LoadedProvidersSection as ProvidersSection } from "../../src/spa/pages/settings-providers";
import type {
  CatalogProvider,
  ProviderKeyRow,
  SettingsManagePayload, ProviderManagementPayload,
} from "../../src/spa/pages/data";
import { installDom } from "./dom";

const catalogEntry = (id: string, tier: "builtin" | "template", extra: Partial<CatalogProvider> = {}): CatalogProvider => ({
  id,
  label: `${id} label`,
  tier,
  base_url: null,
  api: null,
  models: [],
  verifiable: true,
  usage_probe: false,
  eligibility: "builtin",
  display_group: "catalog",
  ...extra,
});

const keyRow = (provider: string, keyId: string, overrides: Partial<ProviderKeyRow> = {}): ProviderKeyRow => ({
  provider,
  keyId,
  last4: `tail-${keyId}`,
  updatedAt: null,
  verifiedAt: null,
  verifiedStatus: null,
  ...overrides,
});

function managePayload(overrides: Partial<SettingsManagePayload & ProviderManagementPayload> = {}): SettingsManagePayload & ProviderManagementPayload {
  return {
    can_manage: true,
    can_edit_chain: false,
    viewer_relation: "created",
    installation: null,
    pending_installations: [],
    workspace_id: "ws_test",
    target_id: "rt-501",
    blocked: false as const,
    blocked_reason: null,
    app: {
      github_app_id: 1,
      status: "active",
      review_enabled: true,
      created_by: "mallory",
      last_webhook_at: null,
      scope: "owned" as const,
      id: "app-test",
      sandbox_image_id: "omp",
      review_trigger_mode: "every_push",
      review_level: null,
      default_review_level: "default",
      github_name: null,
      github_slug: null,
      github_description: null,
      github_html_url: null,
      github_avatar_url: null,
      github_metadata_synced_at: null,
      github_visibility: "unknown",
    },
    check_gate: { min_score: 80, pass_verdicts: ["ship it"] },
    keys: [],
    model_chain: null,
    model_limits_snapshot: "2026-01-01",
    model_roles: {},
    model_chains: [],
    custom_providers: [],
    configured_providers: [],
    provider_catalog: [],
    provider_catalog_version: "fixture-catalog",
    provider_eligibility: {},
    model_role_ids: [],
    custom_provider_api_ids: ["openai-completions"],
    sandbox_images: [{ id: "omp", enabled: true }],
    installations: [],
    ...overrides,
  };
}

function render(payload: SettingsManagePayload & ProviderManagementPayload, locale: Locale = "en"): string {
  return renderToStaticMarkup(
    createElement(ProvidersSection, {
      locale,
      payload,
      onVerify: async () => ({ kind: "success" as const, message: "" }),
      onSettings: async () => ({ kind: "success" as const, message: "" }),
      onPending: () => {},
      notice: null,
      removeOutcome: null,
      onOutcome: () => {},
      onReload: async () => {},
    }),
  );
}

const rowsOf = (html: string): string[] => html.split('data-slot="list-row"').slice(1);

const rowOf = (html: string, last4: string): string => {
  const row = rowsOf(html).find((candidate) => candidate.includes(last4));
  expect(row, `row for ${last4}`).toBeDefined();
  return row as string;
};

const groupOf = (html: string, label: string): string => {
  const at = html.indexOf(`>${label}<`);
  expect(at, `group ${label}`).toBeGreaterThan(-1);
  const start = html.lastIndexOf('data-slot="group-card"', at);
  const next = html.indexOf('data-slot="group-card"', at);
  return html.slice(start, next === -1 ? html.length : next);
};

const groupHeaderOf = (html: string, label: string): string => {
  const group = groupOf(html, label);
  const body = group.indexOf('data-slot="card-content"');
  expect(body, `body of ${label}`).toBeGreaterThan(-1);
  return group.slice(0, body);
};

describe("grouping (AC-1)", () => {
  test("three keys of one provider render one group, the title once, three key rows", () => {
    const html = render(
      managePayload({
        provider_catalog: [catalogEntry("commandcode", "builtin")],
        keys: [keyRow("commandcode", "a"), keyRow("commandcode", "b"), keyRow("commandcode", "c")],
      }),
    );
    expect(html.split('data-slot="group-card"').length - 1).toBe(1);
    expect(html.split("commandcode label").length - 1).toBe(1);
    expect(rowsOf(html)).toHaveLength(3);
  });

  test("a catalog entry with neither a key nor a declaration renders no group", () => {
    const html = render(managePayload({ provider_catalog: [catalogEntry("anthropic", "builtin")] }));
    expect(html).not.toContain('data-slot="group-card"');
    expect(html).toContain(t("en", "settings.noConfiguredProviders"));
  });
});

describe("status label and timestamp (AC-10, AC-11)", () => {
  const cases = [
    { status: "ok", verifiedAt: "2026-10-30T09:00:00.000Z", updatedAt: "2026-10-30T09:00:00.000Z" },
    { status: "reachable", verifiedAt: "2026-10-30T09:00:00.000Z", updatedAt: "2026-10-30T09:00:00.000Z" },
    { status: "failed", verifiedAt: null, updatedAt: "2026-10-30T09:00:00.000Z" },
    { status: null, verifiedAt: null, updatedAt: "2026-10-30T09:00:00.000Z" },
  ] as const;

  for (const locale of ["en", "zh_CN"] as const) {
    test(`each row carries exactly one locale status label (${locale})`, () => {
      for (const { status, verifiedAt, updatedAt } of cases) {
        const html = render(
          managePayload({
            keys: [
              keyRow("p", "1", {
                verifiedStatus: status,
                verifiedAt,
                updatedAt,
              }),
            ],
          }),
          locale,
        );
        const row = rowOf(html, "tail-1");
        const label = t(locale, `settings.providers.status.${status ?? "unverified"}`);
        expect(row.split('data-tone="').length - 1).toBe(1);
        expect(row).toContain(`>${label}</span>`);
        for (const other of cases) {
          if ((other.status ?? "unverified") === (status ?? "unverified")) continue;
          expect(row).not.toContain(`>${t(locale, `settings.providers.status.${other.status ?? "unverified"}`)}</span>`);
        }
        const metaAt = row.indexOf('data-slot="list-row-meta"');
        expect(metaAt).toBeGreaterThan(row.indexOf('data-slot="list-row-status"'));
        expect(row.slice(metaAt)).toContain(
          status === "ok" ? t(locale, "settings.providers.verifiedAt", { time: "" }) : t(locale, "settings.updated", { time: "" }),
        );
      }
    });
  }
});

describe("tier badge", () => {
  test("builtin and custom are neutral, template is the warning surface", () => {
    const html = render(
      managePayload({
        provider_catalog: [catalogEntry("anthropic", "builtin"), catalogEntry("workers-ai", "template")],
        keys: [keyRow("anthropic", "a"), keyRow("workers-ai", "b")],
        custom_providers: [{ provider_id: "my-gateway", base_url: "https://gw.test/v1", api: "openai-completions", model_ids: [] }],
      }),
    );
    expect(html.split('data-tone="warn"').length - 1).toBe(1);
    const badgeIn = (label: string) => groupHeaderOf(html, label).match(/data-tone="([a-z]+)"/g);
    expect(badgeIn("workers-ai label"), "template tier").toEqual(['data-tone="warn"']);
    expect(badgeIn("anthropic label"), "builtin tier").toEqual(['data-tone="neutral"']);
    expect(badgeIn("my-gateway"), "custom tier").toEqual(['data-tone="neutral"']);

    expect(groupOf(html, "workers-ai label")).toContain(t("en", "settings.providers.tier.template"));
    expect(groupOf(html, "anthropic label")).toContain(t("en", "settings.providers.tier.builtin"));
    expect(groupOf(html, "my-gateway")).toContain(t("en", "settings.providers.tier.custom"));
  });
});

describe("declaration group with no key", () => {
  test("renders the empty state instead of an empty row container", () => {
    const html = render(
      managePayload({
        custom_providers: [{ provider_id: "my-gateway", base_url: "https://gw.test/v1", api: "openai-completions", model_ids: [] }],
      }),
    );
    expect(html).toContain(t("en", "settings.providers.empty"));
    expect(html).not.toContain('data-slot="list-row-group"');
    expect(rowsOf(html)).toHaveLength(0);
  });
});

describe("endpoint meta-line disclosure (AC-20 / I-000208)", () => {
  test("template and custom groups state api · base_url · models; builtin groups do not", () => {
    const html = render(
      managePayload({
        provider_catalog: [
          catalogEntry("anthropic", "builtin", { base_url: "https://api.anthropic.com", api: "anthropic" }),
          catalogEntry("workers-ai", "template", { base_url: "https://api.test", api: "openai-completions", models: ["a", "b"] }),
        ],
        keys: [keyRow("anthropic", "a"), keyRow("workers-ai", "b")],
      }),
    );
    expect(groupOf(html, "anthropic label")).not.toContain("settings.providers.expand");
    const templateGroup = groupOf(html, "workers-ai label");
    expect(templateGroup).toContain(">openai-completions</span>");
    expect(templateGroup).toContain(">https://api.test</span>");
    expect(templateGroup).toContain(t("en", "settings.providers.modelCount", { count: 2 }));
  });

  test("a one-key group and a one-model list read singular in en", () => {
    const html = render(
      managePayload({
        provider_catalog: [catalogEntry("workers-ai", "template", { base_url: "https://api.test", api: "openai-completions", models: ["only"] })],
        keys: [keyRow("workers-ai", "solo")],
      }),
    );
    const group = groupOf(html, "workers-ai label");
    expect(group).toContain("1 key ·");
    expect(group).not.toContain("1 keys");
    expect(group).toContain("1 model");
    expect(group).not.toContain("1 models");
  });

  test("the expand control names the model-id region it toggles", () => {
    const html = render(
      managePayload({
        keys: [keyRow("p", "a")],
        custom_providers: [{ provider_id: "my-gateway", base_url: "https://gw.test/v1", api: "openai-completions", model_ids: ["m1", "m2"] }],
      }),
    );
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("aria-controls");
    expect(html).not.toContain('id="provider-models-my-gateway"');
    expect(html).toContain(`>${t("en", "settings.providers.expand")}</button>`);
  });

  test("expanding states aria-expanded and names the model-id region it mounts", async () => {
    const { win, cleanup } = installDom("http://localhost/dashboard/ws/settings");
    try {
      const container = win.document.createElement("div");
      win.document.body.appendChild(container);
      const root = createRoot(container as unknown as Element);
      await act(async () => {
        root.render(
          createElement(ProvidersSection, {
            locale: "en" as const,
            payload: managePayload({
              custom_providers: [
                { provider_id: "my-gateway", base_url: "https://gw.test/v1", api: "openai-completions", model_ids: ["m1", "m2"] },
              ],
            }),
            onVerify: async () => ({ kind: "success" as const, message: "" }),
            onSettings: async () => ({ kind: "success" as const, message: "" }),
            onPending: () => {},
            notice: null,
            removeOutcome: null,
            onOutcome: () => {},
            onReload: async () => {},
          }),
        );
      });

      const toggle = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === t("en", "settings.providers.expand"),
      );
      if (!(toggle instanceof win.HTMLElement)) throw new Error("expand control is missing");
      expect(toggle.getAttribute("aria-expanded")).toBe("false");

      await act(async () => {
        toggle.click();
      });

      const expanded = container.querySelector(`[aria-expanded="true"]`);
      if (!(expanded instanceof win.HTMLElement)) throw new Error("the control did not expand");
      const regionId = expanded.getAttribute("aria-controls");
      expect(regionId).toBe("provider-models-my-gateway");
      const region = regionId === null ? null : container.querySelector(`#${regionId}`);
      if (!(region instanceof win.HTMLElement)) throw new Error("the named region is missing");
      expect(region.textContent).toContain("m1");
      expect(region.textContent).toContain("m2");
      expect(expanded.textContent).toBe(t("en", "settings.providers.collapse"));

      await act(async () => {
        root.unmount();
      });
    } finally {
      cleanup();
    }
  });

  test("a large catalog vocabulary renders fully but the disclosure list carries the scroll bound", async () => {
    const modelIds = Array.from({ length: 594 }, (_, i) => `model-${i}`);
    const { win, cleanup } = installDom("http://localhost/dashboard/ws/settings");
    try {
      const container = win.document.createElement("div");
      win.document.body.appendChild(container);
      const root = createRoot(container as unknown as Element);
      await act(async () => {
        root.render(
          createElement(ProvidersSection, {
            locale: "en" as const,
            payload: managePayload({
              provider_catalog: [
                catalogEntry("workers-ai", "template", {
                  base_url: "https://api.test",
                  api: "openai-completions",
                  models: modelIds,
                }),
              ],
              keys: [keyRow("workers-ai", "solo")],
            }),
            onVerify: async () => ({ kind: "success" as const, message: "" }),
            onSettings: async () => ({ kind: "success" as const, message: "" }),
            onPending: () => {},
            notice: null,
            removeOutcome: null,
            onOutcome: () => {},
            onReload: async () => {},
          }),
        );
      });

      const toggle = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === t("en", "settings.providers.expand"),
      );
      if (!(toggle instanceof win.HTMLElement)) throw new Error("expand control is missing");
      await act(async () => {
        toggle.click();
      });

      const region = container.querySelector("#provider-models-workers-ai");
      if (!(region instanceof win.HTMLElement)) throw new Error("the model-id region is missing");
      expect(region.classList.contains("max-h-72")).toBe(true);
      expect(region.classList.contains("overflow-y-auto")).toBe(true);
      expect(region.children.length).toBe(modelIds.length);

      await act(async () => {
        root.unmount();
      });
    } finally {
      cleanup();
    }
  });

  test("the declaration is the authority for both the count and the disclosure list (I-000644)", async () => {
    const stored = ["decl-a", "decl-b", "decl-c", "decl-d", "decl-e"];
    const { win, cleanup } = installDom("http://localhost/dashboard/ws/settings");
    try {
      const container = win.document.createElement("div");
      win.document.body.appendChild(container);
      const root = createRoot(container as unknown as Element);
      await act(async () => {
        root.render(
          createElement(ProvidersSection, {
            locale: "en" as const,
            payload: managePayload({
              provider_catalog: [
                catalogEntry("workers-ai", "template", {
                  base_url: "https://api.test",
                  api: "openai-completions",
                  models: ["catalog-a", "catalog-b"],
                }),
              ],
              keys: [keyRow("workers-ai", "solo")],
              custom_providers: [
                {
                  provider_id: "workers-ai",
                  base_url: "https://api.test",
                  api: "openai-completions",
                  model_ids: stored,
                },
              ],
            }),
            onVerify: async () => ({ kind: "success" as const, message: "" }),
            onSettings: async () => ({ kind: "success" as const, message: "" }),
            onPending: () => {},
            notice: null,
            removeOutcome: null,
            onOutcome: () => {},
            onReload: async () => {},
          }),
        );
      });

      expect(container.textContent).toContain(t("en", "settings.providers.modelCount", { count: stored.length }));
      expect(container.textContent).not.toContain(t("en", "settings.providers.modelCount", { count: 2 }));

      const toggle = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === t("en", "settings.providers.expand"),
      );
      if (!(toggle instanceof win.HTMLElement)) throw new Error("expand control is missing");
      await act(async () => {
        toggle.click();
      });

      const region = container.querySelector("#provider-models-workers-ai");
      if (!(region instanceof win.HTMLElement)) throw new Error("the model-id region is missing");
      expect([...region.querySelectorAll("li")].map((li) => li.textContent)).toEqual(stored);

      await act(async () => {
        root.unmount();
      });
    } finally {
      cleanup();
    }
  });

  test("a provider with no declaration reports the catalog's vocabulary AS the catalog's", async () => {
    const html = render(
      managePayload({
        provider_catalog: [
          catalogEntry("workers-ai", "template", {
            base_url: "https://api.test",
            api: "openai-completions",
            models: ["catalog-a", "catalog-b"],
          }),
        ],
        keys: [keyRow("workers-ai", "solo")],
      }),
    );
    const group = groupOf(html, "workers-ai label");
    expect(group).toContain(t("en", "settings.providers.modelCount", { count: 2 }));
    expect(group).toContain(t("en", "settings.providers.catalogVocabulary"));
  });
});

describe("model picker trigger", () => {
  test("a declaration group renders the edit trigger in its meta line; a key-only template group renders none", () => {
    const html = render(
      managePayload({
        provider_catalog: [
          catalogEntry("workers-ai", "template", { base_url: "https://api.test", api: "openai-completions", models: ["a"] }),
        ],
        keys: [keyRow("workers-ai", "b")],
        custom_providers: [{ provider_id: "my-gateway", base_url: "https://gw.test/v1", api: "openai-completions", model_ids: ["m1"] }],
      }),
    );
    const trigger = `>${t("en", "settings.providers.models.trigger")}</button>`;
    expect(groupOf(html, "workers-ai label")).not.toContain(trigger);
    expect(groupOf(html, "my-gateway")).toContain(trigger);
  });
});

describe("remove routes stay intact", () => {
  test("a key row keeps its per-key remove control and a declaration keeps its card-level one", () => {
    const html = render(
      managePayload({
        keys: [keyRow("p", "a")],
        custom_providers: [{ provider_id: "p", base_url: "https://gw.test/v1", api: "openai-completions", model_ids: [] }],
      }),
    );
    const row = rowOf(html, "tail-a");
    expect(row).toContain(`>${t("en", "settings.remove")}</button>`);
    const header = groupHeaderOf(html, "p");
    expect(header.split(`>${t("en", "settings.remove")}</button>`).length - 1).toBe(1);
  });
});

const mergedRow = (): CatalogProvider =>
  catalogEntry("merged-vendor", "template", {
    label: "Merged Vendor",
    base_url: "https://api.merged.test/v1",
    api: "openai-completions",
    models: ["default-a"],
    model_limits: { "anthropic-a": { contextWindow: 4242, maxTokens: 424 } },
    protocols: [
      { api: "openai-completions", base_url: "https://api.merged.test/v1", models: ["default-a"] },
      { api: "anthropic-messages", base_url: "https://api.merged.test/anthropic", models: ["anthropic-a"] },
    ],
  });

const legacyPayload = (baseUrl: string): SettingsManagePayload & ProviderManagementPayload =>
  managePayload({
    provider_catalog: [mergedRow()],
    keys: [keyRow("merged-vendor-anthropic", "k1")],
    custom_providers: [
      {
        provider_id: "merged-vendor-anthropic",
        base_url: baseUrl,
        api: "anthropic-messages",
        model_ids: ["anthropic-a"],
        legacy_of: "merged-vendor",
      },
    ],
  });

async function mountSection(payload: SettingsManagePayload & ProviderManagementPayload) {
  const { win, cleanup } = installDom("http://localhost/dashboard/ws/settings");
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => {
    root.render(
      createElement(ProvidersSection, {
        locale: "en" as const,
        payload,
        onVerify: async () => ({ kind: "success" as const, message: "" }),
        onSettings: async () => ({ kind: "success" as const, message: "" }),
        onPending: () => {},
        notice: null,
        removeOutcome: null,
        onOutcome: () => {},
        onReload: async () => {},
      }),
    );
  });
  await act(async () => {});
  const clickText = async (text: string) => {
    const button = [...win.document.querySelectorAll("button")].find((node) => node.textContent === text);
    if (!(button instanceof win.HTMLElement)) throw new Error(`no button labelled ${text}`);
    await act(async () => {
      button.click();
    });
    await act(async () => {});
  };
  return {
    win,
    container,
    clickText,
    cleanup: async () => {
      await act(async () => root.unmount());
      cleanup();
    },
  };
}

describe("a declaration stored under a collapsed per-protocol id", () => {
  test("the card takes the provider's label, not the stored id, and states the stored endpoint", () => {
    const html = render(legacyPayload("https://api.merged.test/anthropic"));
    const group = groupOf(html, "Merged Vendor");
    expect(group).toContain("anthropic-messages");
    expect(group).toContain("https://api.merged.test/anthropic");
    expect(html).not.toContain("merged-vendor-anthropic");
  });

  test("the disclosure lists the matching protocol's vocabulary, not the row's default", async () => {
    const view = await mountSection(legacyPayload("https://api.merged.test/anthropic"));
    try {
      await view.clickText(t("en", "settings.providers.expand"));
      const region = [...view.container.querySelectorAll("li")].map((li) => li.textContent);
      expect(region).toEqual(["anthropic-a"]);
    } finally {
      await view.cleanup();
    }
  });

  test("the model dialog pre-fills the catalog size for the stored declaration", async () => {
    const view = await mountSection(legacyPayload("https://api.merged.test/anthropic"));
    try {
      await view.clickText(t("en", "settings.providers.models.trigger"));
      await view.clickText(t("en", "settings.providers.models.detailsToggle"));
      const field = view.win.document.querySelector(
        `input[aria-label="${t("en", "settings.providers.models.fields.contextWindow", { model: "anthropic-a" })}"]`,
      ) as HTMLInputElement | null;
      expect(field?.value).toBe("4242");
    } finally {
      await view.cleanup();
    }
  });

  test("a private endpoint reusing the stored id still pre-fills the row's size — the id is the key", async () => {
    const view = await mountSection(legacyPayload("https://private.example.com/v1"));
    try {
      await view.clickText(t("en", "settings.providers.models.trigger"));
      await view.clickText(t("en", "settings.providers.models.detailsToggle"));
      const field = view.win.document.querySelector(
        `input[aria-label="${t("en", "settings.providers.models.fields.contextWindow", { model: "anthropic-a" })}"]`,
      ) as HTMLInputElement | null;
      expect(field?.value).toBe("4242");
    } finally {
      await view.cleanup();
    }
  });
});

describe("sync trigger (I-000644)", () => {
  test("a declaration group offers 同步模型 beside 编辑模型; a provider with no declaration offers neither", () => {
    const html = render(
      managePayload({
        provider_catalog: [
          catalogEntry("workers-ai", "template", { base_url: "https://api.test", api: "openai-completions", models: ["a"] }),
        ],
        keys: [keyRow("workers-ai", "solo")],
        custom_providers: [{ provider_id: "my-gateway", base_url: "https://gw.test/v1", api: "openai-completions", model_ids: ["m1"] }],
      }),
    );
    const sync = `>${t("en", "settings.providers.sync.trigger")}</button>`;
    expect(groupOf(html, "my-gateway")).toContain(sync);
    expect(groupOf(html, "workers-ai label")).not.toContain(sync);
  });
});
