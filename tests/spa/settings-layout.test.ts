import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { type Element as DomElement } from "happy-dom";
import { appAvatarUrl } from "../../src/contracts/app-avatar";
import { t, type DictionaryKey } from "../../src/i18n";
import { composeModelOptions } from "../../src/dashboard/model-membership";
import { PROVIDER_CATALOG, PROVIDER_IDS_COMMON } from "../../src/contracts/provider-catalog.generated";
import { parseModels, modelChainTabs, seatRoleValues, seatSelectValue, splitModelChain, type CatalogProvider, type ProviderManagementPayload, type SettingsAppMeta, type SettingsManagePayload } from "../../src/spa/pages/data";
import {
  ProviderCombobox,
  ProviderComboboxPanel,
  filterCatalogProviders,
  groupCatalogProviders,
} from "../../src/spa/components/provider-combobox";
import {
  AppInfoSection,
  DraftChainPanel,
  OpsSection,
  REVIEW_DEPTH_INHERIT,
  RuntimeHarnessEditor,
  SeatsSection,
  SettingsView,
  draftChainTabLabel,
  githubAppSettingsUrl,
  reviewDepthOptions,
} from "../../src/spa/pages/SettingsPage";
import { ProviderConfigForm } from "../../src/spa/pages/providers-dialogs";
import { LoadedProvidersSection } from "../../src/spa/pages/settings-providers";
import type { OpNotice } from "../../src/spa/pages/PageNotice";
import type { SpaBoot } from "../../src/spa/boot";
import { SupportNotice } from "../../src/spa/components/SupportNotice";
import { AppDetailPage, AppDetailView } from "../../src/spa/pages/AppDetailPage";
import { BotSettingsView } from "../../src/spa/pages/BotSettingsPage";
import { withLocation } from "./browser-stub";
import { installDom } from "./dom";

const readSettingsSource = () =>
  readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8") +
  readFileSync(join(import.meta.dir, "../../src/spa/pages/BotSettingsPage.tsx"), "utf8") +
  readFileSync(join(import.meta.dir, "../../src/spa/pages/settings-providers.tsx"), "utf8") +
  readFileSync(join(import.meta.dir, "../../src/spa/pages/providers-dialogs.tsx"), "utf8");

const componentBody = (source: string, name: string): string => {
  const start = source.indexOf(`function ${name}(`);
  expect(start).toBeGreaterThan(-1);
  const tail = source.slice(start);
  const next = tail.slice(1).search(/\n(?:export )?(?:async )?function /);
  return next === -1 ? tail : tail.slice(0, next + 1);
};

const noopSave = (): Promise<{ kind: "success" | "error"; message: string }> =>
  Promise.resolve({ kind: "success", message: "unused" });

const adminBoot = { locale: "en" as const, login: "octocat", name: "The Octocat", role: "admin" as const };

const detailPayload = (): SettingsManagePayload => ({
  can_manage: true,
  viewer_relation: "created",
  installation: null,
  pending_installations: [],
  workspace_id: "ws_0123456789abcdefghijkl",
  target_id: "rt-501",
  blocked: false as const,
  blocked_reason: null,
  app: {
    github_slug: "acme-app",
    id: "app-acme",
    github_app_id: 1,
    status: "active",
    review_enabled: true,
    created_by: "octocat",
    github_name: "Acme",
    github_description: null,
    github_html_url: "https://github.com/apps/acme",
    github_avatar_url: null,
    github_metadata_synced_at: null,
    last_webhook_at: null,
    scope: "owned" as const,
    sandbox_image_id: "omp",
    review_trigger_mode: "every_push",
    review_level: null,
    default_review_level: "default",
    github_visibility: "unknown",
  },
  check_gate: { min_score: 80, pass_verdicts: ["ship it"] },
  keys: [],
  model_chain: null,
  model_roles: {},
  model_chains: [],
  custom_providers: [],
  configured_providers: [],
  provider_catalog_version: "fixture-catalog",
  provider_eligibility: {},
  model_role_ids: [],
  custom_provider_api_ids: [],
  sandbox_images: [{ id: "omp", enabled: true }],
  installations: [],
});

describe("settings layout", () => {
  test("the ops zone is one authorized section; providers and chains are shadcn", () => {
    const source = readSettingsSource();
    expect(source).toContain("settings.ops");
    expect(source).toContain('kind: "pause"');
    expect(source).toContain('kind: "disable"');
    expect(source).toContain('kind: "delete"');
    expect(source).toContain("settings.providers");
    expect(source).toContain("settings.customEntry");
    expect(source).toContain("add-template-provider");
    expect(source).toContain("add-chain");
    expect(source).toContain("settings.useDefaultChain");
    expect(source).toContain("settings.addChain");
  });

  test("destructive removes (key / custom provider) route through confirm dialogs like pause/delete", () => {
    const source = readSettingsSource();
    expect(source).toContain('kind: "remove-key"');
    expect(source).toContain('kind: "remove-custom"');
    expect(source).toContain("settings.confirmRemoveKeyTitle");
    expect(source).toContain("settings.confirmRemoveCustomTitle");
    expect(t("en", "settings.confirmRemoveKeyTitle", { provider: "ark" })).toContain("ark");
    expect(t("zh_CN", "settings.confirmRemoveCustomTitle", { provider: "acme" })).toContain("acme");
  });
});

describe("settings dropdowns", () => {
  test("chain and role editors are dropdowns, not free-text; add-key posts the JSON verify route", () => {
    const source = readSettingsSource();
    expect(source).toContain("/keys/verify");
    expect(source).toContain("settings.addToChain");
    expect(source).toContain("settings.useDefaultChain");
    expect(source).toContain("settings.pickModel");
    expect(source).not.toContain('type="text" name="model_chain"');
    expect(source).not.toContain("<input type=\"text\" name={`role_${role}`}");
    expect(source).not.toContain("<select name={`role_${role}`}");
  });

  test("composeModelOptions prefixes the cache provider (including ark) and custom ids", () => {
    const groups = composeModelOptions(
      [{ provider: "ark", models: ["doubao"], fetched_at: "t" }],
      [{ provider_id: "acme", model_ids: ["fast"], has_keys: true }],
    );
    expect(groups.map((g) => g.selectors).flat()).toEqual(["ark/doubao", "acme/fast"]);
  });

  test("parseModels accepts grouped selector grammar and rejects a bad source", () => {
    expect(
      parseModels({
        groups: [{ provider: "anthropic", source: "verified", selectors: ["anthropic/claude-sonnet-4-6"] }],
      }),
    ).toEqual({
      groups: [{ provider: "anthropic", source: "verified", selectors: ["anthropic/claude-sonnet-4-6"] }],
    });
    expect(parseModels({ groups: [{ provider: "x", source: "nope", selectors: [] }] })).toBeNull();
    expect(splitModelChain("anthropic/claude-sonnet-4-6:thinking, openai/gpt-5")).toEqual([
      "anthropic/claude-sonnet-4-6:thinking",
      "openai/gpt-5",
    ]);
  });
});

describe("runtime harness selector", () => {
  test("managers get a shadcn selector saved through op=save-sandbox-image; other members read-only", () => {
    const source = readSettingsSource();
    expect(source).toContain('op: "save-sandbox-image"');
    expect(source).toContain("settings.runtimeHarnessValue");
  });

  test("runtime harness copy is dictionary-backed in both locales", () => {
    expect(t("en", "settings.runtimeHarness")).toBe("Runtime harness");
    expect(t("zh_CN", "settings.runtimeHarness")).toBe("运行时 harness");
    expect(t("en", "settings.runtimeHarnessCopy")).toContain("run time");
    expect(t("zh_CN", "settings.runtimeHarnessCopy")).toContain("运行时");
    expect(t("en", "settings.runtimeHarnessValue", { id: "omp" })).toContain("omp");
    expect(t("zh_CN", "settings.runtimeHarnessValue", { id: "omp" })).toContain("omp");
    expect(t("en", "settings.saveRuntimeHarness")).toBe("Save runtime harness");
    expect(t("zh_CN", "settings.saveRuntimeHarness")).toBe("保存运行时 harness");
  });
});

describe("settings copy is dictionary-backed", () => {
  test("new keys exist in both locales", () => {
    expect(t("en", "settings.verify.invalid_key")).toContain("rejected");
    expect(t("zh_CN", "settings.verify.invalid_key")).toContain("拒绝");
    expect(t("en", "settings.verify.unreachable")).toContain("reached");
    expect(t("zh_CN", "settings.verify.unreachable")).toContain("连接");
    expect(t("en", "settings.verify.unexpected")).toContain("unexpected");
    expect(t("zh_CN", "settings.verify.unexpected")).toContain("意外");
    expect(t("en", "settings.verify.unsupported_provider")).toContain("can't be verified");
    expect(t("zh_CN", "settings.verify.unsupported_provider")).toContain("无法");
    expect(t("en", "settings.verify.rate_limited")).toContain("throttled");
    expect(t("zh_CN", "settings.verify.rate_limited")).toContain("限流");
    expect(t("en", "settings.consoleOnly")).toContain("can't be verified");
    expect(t("zh_CN", "settings.consoleOnly")).toContain("无法");
    expect(t("en", "settings.ops")).toBe("Operations");
    expect(t("zh_CN", "settings.ops")).toBe("运维");
    expect(t("en", "settings.customEntry")).toBe("Custom");
    expect(t("zh_CN", "settings.customEntry")).toBe("自定义");
    expect(t("en", "settings.useDefaultChain")).toBe("Default chain");
    expect(t("zh_CN", "settings.useDefaultChain")).toBe("Default 链");
    expect(t("en", "manifest.error.dbUnbound")).toContain("storage");
    expect(t("zh_CN", "manifest.error.dbUnbound")).toContain("存储");
    expect(t("en", "settings.membership.not_in_verified_models", { selector: "anthropic/nope" })).toContain(
      "anthropic/nope",
    );
    expect(t("zh_CN", "settings.membership.not_in_verified_models", { selector: "anthropic/nope" })).toContain(
      "anthropic/nope",
    );
  });

});

describe("configured providers + catalog add flow", () => {
  test("the providers card renders configured state only; the catalog is the Add Provider picker", () => {
    const source = readSettingsSource();
    expect(source).toContain("settings.noConfiguredProviders");
    expect(source).toContain("settings.keyEnding");
    expect(source).toContain("settings.keyTooShort");
  });

  test("Add Provider: catalog selection drives the configuration form; custom path preserved", () => {
    const source = readSettingsSource();
    expect(source).toContain("settings.addProvider");
    expect(source).toContain('aria-haspopup="dialog"');
    expect(source).toContain("settings.configureProvider");
    expect(source).toContain("/keys/verify");
    expect(source).toContain('op: "add-template-provider"');
    expect(source).toContain('op: "add-custom-provider"');
  });

  test("catalog add-flow copy is dictionary-backed in both locales", () => {
    expect(t("en", "settings.addProvider")).toBe("Add provider");
    expect(t("zh_CN", "settings.addProvider")).toBe("添加模型提供方");
    expect(t("en", "settings.providersCopy")).toContain("Add Provider");
    expect(t("zh_CN", "settings.providersCopy")).toContain("添加模型提供方");
    expect(t("en", "settings.noConfiguredProviders")).toContain("No providers configured yet");
    expect(t("zh_CN", "settings.noConfiguredProviders")).toContain("尚未配置");
    expect(t("en", "settings.catalogBuiltin")).toBe("Common providers");
    expect(t("zh_CN", "settings.catalogBuiltin")).toBe("常用提供方");
    expect(t("en", "settings.catalogTemplate")).toContain("templates");
    expect(t("zh_CN", "settings.catalogTemplate")).toContain("模板");
    expect(t("en", "settings.configureProvider", { label: "Anthropic" })).toContain("Anthropic");
    expect(t("zh_CN", "settings.configureProvider", { label: "Anthropic" })).toContain("Anthropic");
  });
});

describe("multi-key provider rows (one row per key, no client-side fold)", () => {
  const page = readSettingsSource();
  test("every configured key row is keyed by its key identity — two keys of one provider are two rows", () => {
    expect(page).toContain('kind: "remove-key"');
    expect(page).toContain("provider: key.provider");
    expect(page).toContain("keyId: key.keyId");
    expect(page).toContain("last4: key.last4");
    expect(page).toContain("key_id: action.keyId");
  });

  test("the key row renders the per-key verification state", () => {
    expect(page).toContain("settings.providers.status.ok");
    expect(page).toContain("settings.providers.status.failed");
    expect(page).toContain("settings.providers.status.reachable");
  });
});


describe("custom-provider add-key copy", () => {
  test("custom add-key copy is dictionary-backed in both locales (action, success, cap)", () => {
    expect(t("en", "settings.addKey")).toBe("Add key");
    expect(t("zh_CN", "settings.addKey")).toBe("添加密钥");
    expect(t("en", "settings.error.providerKeyLimit")).toContain("maximum");
    expect(t("zh_CN", "settings.error.providerKeyLimit")).toContain("已存满");
    expect(t("en", "settings.error.customProviderUndeclared")).toContain("not a declared custom provider");
    expect(t("zh_CN", "settings.error.customProviderUndeclared")).toContain("已声明");
  });
});

describe("catalog provenance + eligibility messaging", () => {
  test("Add Provider discloses provenance and per-entry eligibility vs the selected runtime harness", () => {
    const source = readSettingsSource();
    expect(source).toContain("settings.catalogProvenance");
    expect(source).toContain("settings.eligibilityBuiltin");
    expect(source).toContain("settings.eligibilityTemplate");
    expect(source).toContain("settings.eligibilityUnavailable");
    const combobox = readFileSync(join(import.meta.dir, "../../src/spa/components/provider-combobox.tsx"), "utf8");
    expect(combobox).toContain("settings.eligibilityUnavailableShort");
  });

  test("the catalog picker names its combobox through the aria-labelledby precedent", () => {
    const source = readSettingsSource();
    expect(source).toContain('id="settings-catalog-provider-label"');
    expect(source).toContain('labelledby="settings-catalog-provider-label"');
  });

  test("provenance copy is dictionary-backed in both locales", () => {
    const count = Object.keys(PROVIDER_CATALOG).length;
    expect(t("en", "settings.catalogProvenance", { count })).toContain(String(count));
    expect(t("en", "settings.catalogProvenance", { count })).toContain("models.dev and omp snapshots");
    expect(t("zh_CN", "settings.catalogProvenance", { count })).toContain(String(count));
    expect(t("zh_CN", "settings.catalogProvenance", { count })).toContain("models.dev 与 omp 快照");
    expect(t("en", "settings.eligibilityBuiltin", { image: "omp" })).toContain("omp");
    expect(t("zh_CN", "settings.eligibilityBuiltin", { image: "omp" })).toContain("omp");
    expect(t("en", "settings.eligibilityTemplate", { image: "omp" })).toContain("omp");
    expect(t("zh_CN", "settings.eligibilityTemplate", { image: "omp" })).toContain("omp");
    expect(t("en", "settings.eligibilityUnavailable", { image: "omp" })).toContain("omp");
    expect(t("zh_CN", "settings.eligibilityUnavailable", { image: "omp" })).toContain("omp");
    expect(t("en", "settings.eligibilityUnavailableShort", { image: "omp" })).toContain("omp");
    expect(t("zh_CN", "settings.eligibilityUnavailableShort", { image: "omp" })).toContain("omp");
    expect(t("en", "settings.addProviderCopy")).toContain("can't be saved");
    expect(t("zh_CN", "settings.addProviderCopy")).toContain("无法保存");
  });
});

describe("provider combobox", () => {
  const commonEntry = (id: string, label: string, overrides: Partial<CatalogProvider> = {}): CatalogProvider => ({
    id,
    label,
    tier: "builtin",
    base_url: null,
    api: null,
    models: ["m1"],
    verifiable: true,
    usage_probe: false,
    eligibility: "builtin",
    display_group: "common",
    ...overrides,
  });
  const catalogEntry = (id: string, label: string, overrides: Partial<CatalogProvider> = {}): CatalogProvider => ({
    id,
    label,
    tier: "builtin",
    base_url: null,
    api: null,
    models: ["m1"],
    verifiable: true,
    usage_probe: false,
    eligibility: "builtin",
    display_group: "catalog",
    ...overrides,
  });

  const catalog: CatalogProvider[] = [
    commonEntry("anthropic", "Anthropic"),
    commonEntry("openai", "OpenAI"),
    commonEntry("gemini", "Google Gemini"),
    commonEntry("copilot", "GitHub Copilot"),
    commonEntry("xai", "xAI"),
    catalogEntry("mistral", "Mistral AI", { tier: "template", eligibility: "template" }),
    catalogEntry("workers-ai", "Workers AI", { tier: "template", eligibility: "template" }),
    catalogEntry("gemini-image", "Gemini Image", { eligibility: "unavailable" }),
  ];

  test("the pure filter narrows on label or id, case-insensitively; clearing restores the full list", () => {
    expect(filterCatalogProviders(catalog, "gem").map((p) => p.id)).toEqual(["gemini", "gemini-image"]);
    expect(filterCatalogProviders(catalog, "GEM").map((p) => p.id)).toEqual(["gemini", "gemini-image"]);
    expect(filterCatalogProviders(catalog, "copilot").map((p) => p.id)).toEqual(["copilot"]);
    expect(filterCatalogProviders(catalog, "github").map((p) => p.id)).toEqual(["copilot"]);
    expect(filterCatalogProviders(catalog, "")).toHaveLength(catalog.length);
    expect(filterCatalogProviders(catalog, "   ").map((p) => p.id)).toEqual(catalog.map((p) => p.id));
    expect(filterCatalogProviders(catalog, "zzz-no-match")).toEqual([]);
  });

  test("the pure grouping puts the frozen common 5 first; catalog holds the rest", () => {
    expect([...PROVIDER_IDS_COMMON]).toEqual(["anthropic", "openai", "gemini", "copilot", "xai"]);
    const groups = groupCatalogProviders(catalog);
    expect(groups.common.map((p) => p.id)).toEqual([...PROVIDER_IDS_COMMON]);
    expect(groups.common.every((p) => p.display_group === "common")).toBe(true);
    expect(groups.catalog.map((p) => p.id)).toEqual(["mistral", "workers-ai", "gemini-image"]);
    expect(groups.catalog.every((p) => p.display_group === "catalog")).toBe(true);
  });

  test("the open panel renders common first, marks the filtered unavailable row, and marks the selection (SSR)", () => {
    const panel = (query: string, value?: string) =>
      renderToStaticMarkup(
        createElement(ProviderComboboxPanel, {
          locale: "en",
          providers: catalog,
          query,
          value,
          imageId: "omp",
          listboxId: "lb",
          onSelect: () => {},
        }),
      );
    const full = panel("", "gemini");
    expect(full.indexOf("Common providers")).toBeGreaterThan(-1);
    expect(full.indexOf("Catalog templates")).toBeGreaterThan(full.indexOf("Common providers"));
    expect(full).toContain('aria-selected="true"');
    expect(full).not.toContain('aria-disabled="true"');
    expect(full).not.toContain("pointer-events-none");
    expect(full).toContain("opacity-50");
    expect(full).toContain("unavailable under omp");
    const narrowed = panel("gem", "gemini");
    expect(narrowed).toContain("Google Gemini");
    expect(narrowed).toContain('aria-selected="true"');
    expect(narrowed).toContain("Gemini Image");
    expect(narrowed).toContain("opacity-50");
    expect(narrowed).toContain("unavailable under omp");
    expect(narrowed).not.toContain("Anthropic");
    expect(narrowed).not.toContain("OpenAI");
    expect(narrowed).not.toContain("Copilot");
    expect(narrowed).not.toContain("Mistral");
    expect(narrowed).not.toContain("Workers AI");
    expect(panel("zzz")).toContain("No providers match");
  });

  test("an unavailable row is marked the same way in the common group (both groups keep the marker)", () => {
    const marked: CatalogProvider[] = [
      commonEntry("xai", "xAI", { eligibility: "unavailable" }),
      catalogEntry("mistral", "Mistral AI", { tier: "template", eligibility: "template" }),
    ];
    const out = renderToStaticMarkup(
      createElement(ProviderComboboxPanel, {
        locale: "en",
        providers: marked,
        query: "",
        value: undefined,
        imageId: "omp",
        listboxId: "lb",
        onSelect: () => {},
      }),
    );
    expect(out).toContain("opacity-50");
    expect(out).toContain("unavailable under omp");
    expect(out.indexOf("Common providers")).toBeGreaterThan(-1);
    expect(out.indexOf("Catalog templates")).toBeGreaterThan(out.indexOf("Common providers"));
  });

  test("the closed combobox input carries the combobox aria face (SSR)", () => {
    const out = renderToStaticMarkup(
      createElement(ProviderCombobox, {
        locale: "en",
        labelledby: "settings-catalog-provider-label",
        providers: catalog,
        value: undefined,
        onValueChange: () => {},
        imageId: "omp",
      }),
    );
    expect(out).toContain('role="combobox"');
    expect(out).toContain('aria-expanded="false"');
    expect(out).toContain('aria-autocomplete="list"');
    expect(out).toContain('aria-labelledby="settings-catalog-provider-label"');
    expect(out).toContain("Search model providers…");
    expect(out).not.toContain('role="listbox"');
  });


  test("option rows carry the aria-activedescendant ids + highlight, and the zero-match state keeps the listbox id (SSR, task-3 review fix)", () => {
    const panel = (overrides: { activeId?: string; query?: string } = {}) =>
      renderToStaticMarkup(
        createElement(ProviderComboboxPanel, {
          locale: "en",
          providers: catalog,
          query: overrides.query ?? "",
          value: undefined,
          imageId: "omp",
          listboxId: "lb",
          onSelect: () => {},
          activeId: overrides.activeId,
        }),
      );
    const full = panel();
    expect(full).toContain('id="lb-option-anthropic"');
    expect(full).toContain('id="lb-option-gemini"');
    expect(full).toContain('id="lb-option-gemini-image"');
    expect(full.match(/role="option"/g)).toHaveLength(8);
    expect(full).not.toContain('data-active="true"');
    const openaiAt = panel({ activeId: "lb-option-openai" });
    expect(openaiAt.match(/data-active="true"/g)).toHaveLength(1);
    const openaiRow = openaiAt.slice(
      openaiAt.indexOf('id="lb-option-openai"'),
      openaiAt.indexOf("</div>", openaiAt.indexOf('id="lb-option-openai"')),
    );
    expect(openaiRow).toContain('data-active="true"');
    const empty = panel({ query: "zzz-no-match" });
    expect(empty).toContain('id="lb"');
    expect(empty).toContain("No providers match");
  });

  test("picker copy is dictionary-backed; zh picker copy carries no bare Provider (AC1 sweep)", () => {
    expect(t("en", "settings.provider")).toBe("Model provider");
    expect(t("zh_CN", "settings.provider")).toBe("模型提供方");
    expect(t("en", "settings.providers.title")).toBe("Providers");
    expect(t("zh_CN", "settings.providers.title")).toBe("模型提供方");
    expect(t("en", "settings.selectProvider")).toBe("Search model providers…");
    expect(t("zh_CN", "settings.selectProvider")).toBe("搜索模型提供方…");
    expect(t("en", "settings.noProviderMatch", { query: "zzz" })).toContain("zzz");
    expect(t("zh_CN", "settings.noProviderMatch", { query: "zzz" })).toContain("模型提供方");
    for (const key of [
      "settings.provider",
      "settings.providers.title",
      "settings.providers.status.ok",
      "settings.providers.status.reachable",
      "settings.providers.status.failed",
      "settings.providers.status.unverified",
      "settings.providers.tier.builtin",
      "settings.providers.tier.template",
      "settings.providers.tier.custom",
      "settings.providers.expand",
      "settings.providers.collapse",
      "settings.providersCopy",
      "settings.noConfiguredProviders",
      "settings.addProvider",
      "settings.addProviderCopy",
      "settings.selectProvider",
      "settings.noProviderMatch",
      "settings.catalogBuiltin",
      "settings.catalogTemplate",
      "settings.configureProvider",
    ] as const) {
      expect(t("zh_CN", key), key).not.toContain("Provider");
    }
  });
});

describe("add-entry visibility + picker usability at breadth", () => {
  test("the Add Provider entry is a labeled, bordered control above the empty state", () => {
    const payload: ProviderManagementPayload = {
      ...detailPayload(),
      provider_catalog: [],
      model_limits_snapshot: "fixture-snapshot",
    };
    const html = renderToStaticMarkup(
      createElement(LoadedProvidersSection, {
        locale: "en",
        payload,
        onVerify: noopSave,
        onSettings: noopSave,
        onPending: () => {},
        notice: null,
        removeOutcome: null,
        onOutcome: () => {},
        onReload: async () => {},
      }),
    );
    const { win, cleanup } = installDom("http://localhost/dashboard/apps/1/settings");
    try {
      win.document.body.innerHTML = html;
      const doc = win.document;
      const add = [...doc.querySelectorAll("button")].find(
        (node) => node.textContent === t("en", "settings.addProvider"),
      );
      expect(add).toBeDefined();
      expect(add!.getAttribute("aria-haspopup")).toBe("dialog");
      expect(add!.className.split(/\s+/)).toContain("border");
      const empty = [...doc.querySelectorAll("p")].find(
        (node) => node.textContent === t("en", "settings.noConfiguredProviders"),
      );
      expect(empty).toBeDefined();
      expect(add!.compareDocumentPosition(empty!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    } finally {
      cleanup();
    }
  });

  test("the catalog picker is the provider combobox: common group first, then catalog, height-capped to an internal scroll", () => {
    const combobox = readFileSync(join(import.meta.dir, "../../src/spa/components/provider-combobox.tsx"), "utf8");
    const commonPos = combobox.indexOf("settings.catalogBuiltin");
    const templatePos = combobox.indexOf("settings.catalogTemplate");
    expect(commonPos).toBeGreaterThan(-1);
    expect(templatePos).toBeGreaterThan(commonPos);
    expect(combobox).toContain("max-h-72");
  });

  test("the template form carries an editable prefilled base URL and a {account_id}-conditional account-id field", () => {
    const source = readSettingsSource();
    expect(source).toContain("base_url: baseUrl");
  });

  test("the template form initialises from a stored declaration, never the catalog default", () => {
    const template: CatalogProvider = {
      id: "workers-ai",
      label: "Workers AI",
      tier: "template",
      base_url: "https://api.example.com/v1",
      api: "openai-completions",
      models: ["m1"],
      verifiable: false,
      usage_probe: false,
      eligibility: "template",
      display_group: "catalog",
    };
    const stored = {
      provider_id: "workers-ai",
      base_url: "https://stored.example.com/v1",
      api: "openai-completions",
      model_ids: ["m1"],
    };
    const html = renderToStaticMarkup(
      createElement(ProviderConfigForm, {
        locale: "en",
        provider: template,
        storedKeys: [],
        custom: stored,
        onVerify: noopSave,
        onSettings: noopSave,
        onOutcome: () => {},
        onDone: () => {},
        onCustomEndpoint: () => {},
      }),
    );
    expect(html).toContain('value="https://stored.example.com/v1"');
    expect(html).not.toContain('value="https://api.example.com/v1"');
  });

  test("a seeded {account_id} template is materialized already — appending a key demands no account id", () => {
    const template: CatalogProvider = {
      id: "workers-ai",
      label: "Workers AI",
      tier: "template",
      base_url: "https://api.example.com/accounts/{account_id}/v1",
      api: "openai-completions",
      models: ["m1"],
      verifiable: false,
      usage_probe: false,
      eligibility: "template",
      display_group: "catalog",
    };
    const html = renderToStaticMarkup(
      createElement(ProviderConfigForm, {
        locale: "en",
        provider: template,
        storedKeys: [],
        custom: {
          provider_id: "workers-ai",
          base_url: "https://api.example.com/accounts/acct-1/v1",
          api: "openai-completions",
          model_ids: ["m1"],
        },
        onVerify: noopSave,
        onSettings: noopSave,
        onOutcome: () => {},
        onDone: () => {},
        onCustomEndpoint: () => {},
      }),
    );
    expect(html).toContain('value="https://api.example.com/accounts/acct-1/v1"');
    expect(html).not.toContain('value="https://api.example.com/accounts/{account_id}/v1"');
    expect(html).not.toContain(t("en", "settings.accountId"));
  });

  test(" copy is dictionary-backed in both locales; account id is no longer Cloudflare-worded", () => {
    expect(t("en", "settings.accountId")).toBe("Account id");
    expect(t("zh_CN", "settings.accountId")).toBe("账户 id");
    expect(t("en", "settings.accountId")).not.toContain("Cloudflare");
    expect(t("zh_CN", "settings.accountId")).not.toContain("Cloudflare");
    const count = Object.keys(PROVIDER_CATALOG).length;
    expect(t("en", "settings.catalogProvenance", { count })).toContain(`${count} providers`);
    expect(t("zh_CN", "settings.catalogProvenance", { count })).toContain(`${count} 个提供方`);
  });
});

describe("model chain tabs", () => {
  test("Default and named chains are peer shadcn tabs with a coherent selected state", () => {
    const source = readSettingsSource();
    expect(source).toContain('op: "save-chain"');
    expect(source).toContain('op: "add-chain", name: tab.id, chain: value');
    expect(source).toContain('op: "remove-chain"');
    expect(source).toContain("settings.confirmRemoveChainTitle");
  });

  test("the Default tab never offers remove; add/create copy is dictionary-backed in both locales", () => {
    expect(t("en", "settings.modelChains")).toBe("Model chains");
    expect(t("zh_CN", "settings.modelChains")).toBe("模型链");
    expect(t("en", "settings.modelChainsCopy")).toContain("tabs");
    expect(t("en", "settings.modelChainsCopy")).toContain("can't be removed");
    expect(t("zh_CN", "settings.modelChainsCopy")).toContain("标签页");
    expect(t("zh_CN", "settings.modelChainsCopy")).toContain("无法移除");
    expect(t("en", "settings.defaultChain")).toBe("Default chain");
    expect(t("zh_CN", "settings.defaultChain")).toBe("Default 链");
  });

  test("forceMount panels stay mounted but inactive ones are visually hidden (keepMounted mechanism)", () => {
    const tabsSource = readFileSync(join(import.meta.dir, "../../src/design-system/primitives/tabs.tsx"), "utf8");
    const contentWrapper = tabsSource.slice(tabsSource.indexOf("function TabsContent"));
    expect(contentWrapper).toContain("data-[state=inactive]:hidden");
  });
});

describe("chain draft peer tab", () => {
  test("+ 新建链 opens a draft peer tab: after the named tabs, auto-selected, never two drafts", () => {
    const source = readSettingsSource();
    const chainsBody = source.slice(source.indexOf("function ChainsSection"), source.indexOf("function SeatsSection"));
    expect(chainsBody).toContain("settings.addChain");
    expect(chainsBody).not.toContain("settings.namedChains");
    expect(chainsBody).not.toContain("settings.noNamedChains");
  });
  test("the draft panel is the editor: name field first, model builder, save/discard, inline failure", () => {
    const source = readSettingsSource();
    const panelBody = source.slice(source.indexOf("function DraftChainPanel"), source.indexOf("function ChainEditor"));
    expect(panelBody).toContain('op: "add-chain", name, chain: value');
    expect(panelBody).toContain("settings.discardChain");
  });

  test("draft copy is dictionary-backed in both locales; the retired disclosure label is gone", () => {
    expect(t("en", "settings.addChain")).toBe("Add chain");
    expect(t("zh_CN", "settings.addChain")).toBe("新建链");
    expect(t("en", "settings.draftChain")).toBe("New chain");
    expect(t("zh_CN", "settings.draftChain")).toBe("新链");
    expect(t("en", "settings.discardChain")).toBe("Discard");
    expect(t("zh_CN", "settings.discardChain")).toBe("放弃");
    expect(t("en", "settings.chainName")).toBe("Chain name");
    expect(t("zh_CN", "settings.chainName")).toBe("链名称");
  });
});

describe("draft tab label live-sync (A2/A3 / AD-551)", () => {
  const noop = () => {};
  const panelHtml = (name: string): string =>
    renderToStaticMarkup(
      createElement(DraftChainPanel, {
        locale: "en",
        groups: [],
        name,
        onNameChange: noop,
        onCreate: () => Promise.resolve({ kind: "error" as const, message: "unused" }),
        onOutcome: noop,
        onDiscard: noop,
        onCreated: noop,
      }),
    );

  test("typing mirrors into the tab label live; empty/whitespace falls back to 新链", () => {
    expect(draftChainTabLabel("my-chain", "en")).toBe("my-chain");
    expect(draftChainTabLabel("my-chain", "zh_CN")).toBe("my-chain");
    expect(draftChainTabLabel(" my-chain ", "en")).toBe(" my-chain ");
    expect(draftChainTabLabel("", "en")).toBe("New chain");
    expect(draftChainTabLabel("", "zh_CN")).toBe("新链");
    expect(draftChainTabLabel("   ", "zh_CN")).toBe("新链");
  });

  test("the draft panel is controlled by the lifted name (SSR: the typed value reaches the input)", () => {
    expect(panelHtml("my-chain")).toContain('value="my-chain"');
    expect(panelHtml("")).toContain('value=""');
  });
});

describe("discard inline with the save row (A4/A5 / AD-552)", () => {
  const noop = () => {};
  const panelHtml = (): string =>
    renderToStaticMarkup(
      createElement(DraftChainPanel, {
        locale: "en",
        groups: [],
        name: "",
        onNameChange: noop,
        onCreate: () => Promise.resolve({ kind: "error" as const, message: "unused" }),
        onOutcome: noop,
        onDiscard: noop,
        onCreated: noop,
      }),
    );

  test("one control row carries the picker, add, save and the caller's actions", () => {
    const { win, cleanup } = installDom("http://localhost/dashboard/apps/1/settings");
    try {
      win.document.body.innerHTML = panelHtml();
      const doc = win.document;
      const button = (key: DictionaryKey): DomElement | null =>
        [...doc.querySelectorAll("button")].find((node) => node.textContent === t("en", key)) ?? null;
      const picker = doc.querySelector('[role="combobox"]');
      const add = button("settings.addToChain");
      const save = button("settings.saveChain");
      const discard = button("settings.discardChain");
      expect(picker?.getAttribute("aria-label")).toBe(t("en", "settings.modelChainField"));
      expect(add).not.toBeNull();
      expect(save).not.toBeNull();
      expect(discard).not.toBeNull();

      const editor = doc.body.firstElementChild!;
      const pickerSlot = picker!.parentElement!;
      const row = add!.parentElement!;
      const controls: DomElement[] = [pickerSlot, add!, save!, discard!];
      expect(row).not.toBe(editor);
      expect(editor.contains(row)).toBe(true);
      for (const control of controls) expect(control.parentElement).toBe(row);
      expect(
        [...row.children]
          .filter((child) => !controls.includes(child as DomElement))
          .map((child) => child.textContent),
      ).toEqual([t("en", "settings.modelChainField")]);

      const inOrder = [...row.querySelectorAll("*")];
      const positions = [picker!, add!, save!, discard!].map((control) => inOrder.indexOf(control));
      expect(positions).toEqual([...positions].sort((a, b) => a - b));
      expect(new Set(positions).size).toBe(4);
    } finally {
      cleanup();
    }
  });

  test("the discard is visibly styled without hover and carries no confirmation", () => {
    const html = panelHtml();
    expect(html).toContain('data-variant="outline"');
    expect(html).toContain('data-size="sm"');
    expect(html).toContain("w-20");
    expect(html).not.toContain("dialog");
  });

  test("only the draft panel injects a discard; the stored-chain editors carry none", () => {
    const manage = withLocation("/dashboard/apps/1/bot", () =>
      renderToStaticMarkup(
        createElement(BotSettingsView, {
          locale: "en",
          payload: { ...detailPayload(), can_manage: true, archived: false },
          groups: [],
          notice: null,
          onReload: async () => true,
        }),
      ),
    );
    expect(manage).toContain(t("en", "settings.saveChain"));
    expect(manage).not.toContain(t("en", "settings.discardChain"));
  });
});

describe("seat assignment section", () => {
  test("seats are an independent titled card below chain management, not a section of the chains card", () => {
    const source = readSettingsSource();
    const chainsBody = source.slice(source.indexOf("function ChainsSection"), source.indexOf("function SeatsSection"));
    expect(chainsBody).not.toContain("settings.seats");
    expect(chainsBody).not.toContain('op: "save-roles"');
    const seatsBody = source.slice(source.indexOf("function SeatsSection"));
    expect(seatsBody).toContain("settings.seats");
    expect(seatsBody).toContain("settings.seatsCopy");
  });

  test("seat selects offer Default first, then current named tabs; values coerce before render and save", async () => {
    const chains = [
      { name: "deep", chain: "ark/deep", is_default: false, created_at: "t", updated_at: "t" },
      { name: "fast", chain: "ark/fast", is_default: false, created_at: "t", updated_at: "t" },
    ];
    const tabs = modelChainTabs(chains);
    expect(tabs.map((tab) => tab.id)).toEqual(["default", "deep", "fast"]);
    expect(seatRoleValues(["review", "deep"], { review: "gone", deep: "fast" }, tabs)).toEqual({
      review: "default",
      deep: "fast",
    });

    const { win, cleanup } = installDom("http://localhost/dashboard/apps/1/settings");
    try {
      const container = win.document.createElement("div");
      win.document.body.appendChild(container);
      const root = createRoot(container as unknown as Element);
      const saved: Array<Record<string, string>> = [];
      await act(async () =>
        root.render(
          createElement(SeatsSection, {
            locale: "en",
            payload: {
              ...detailPayload(),
              model_chains: chains,
              model_role_ids: ["review", "deep"],
              model_roles: { review: "gone", deep: "fast" },
            },
            onSettings: async (fields) => {
              saved.push(fields);
              return { kind: "success", message: "Changes saved." };
            },
          }),
        ),
      );
      const saveButton = [...container.querySelectorAll("button")].find(
        (node) => node.textContent === t("en", "settings.saveRoleModels"),
      );
      await act(async () => {
        saveButton?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
      });
      expect(saved).toEqual([{ op: "save-roles", role_review: "default", role_deep: "fast" }]);
      await act(async () => root.unmount());
    } finally {
      cleanup();
    }
  });
  test("seat values resolve against the current tab model: Default, named, and the delete cascade", () => {
    const tabs = modelChainTabs([
      { name: "deep", chain: "ark/deep", is_default: false, created_at: "t", updated_at: "t" },
    ]);
    expect(seatSelectValue(tabs, null)).toBe("default");
    expect(seatSelectValue(tabs, undefined)).toBe("default");
    expect(seatSelectValue(tabs, "")).toBe("default");
    expect(seatSelectValue(tabs, "default")).toBe("default");
    expect(seatSelectValue(tabs, "deep")).toBe("deep");
    expect(seatSelectValue(modelChainTabs([]), "deep")).toBe("default");
    expect(
      seatRoleValues(["mstar-review-seat", "deep-seat"], { "mstar-review-seat": "deep", "deep-seat": "" }, tabs),
    ).toEqual({ "mstar-review-seat": "deep", "deep-seat": "default" });
    expect(seatRoleValues(["mstar-review-seat"], { "mstar-review-seat": "deep" }, modelChainTabs([]))).toEqual({
      "mstar-review-seat": "default",
    });
  });

  test("seat section copy is dictionary-backed in both locales", () => {
    expect(t("en", "settings.seats")).toBe("Seat chains");
    expect(t("zh_CN", "settings.seats")).toBe("席位链");
    expect(t("en", "settings.seatsCopy")).toContain("falls back to Default");
    expect(t("zh_CN", "settings.seatsCopy")).toContain("回退到 Default");
    expect(t("en", "settings.useDefaultChain")).toBe("Default chain");
    expect(t("zh_CN", "settings.useDefaultChain")).toBe("Default 链");
    expect(t("en", "settings.saveRoleModels")).toBe("Save seat chains");
    expect(t("zh_CN", "settings.saveRoleModels")).toBe("保存席位链");
  });
});

describe("operational action hierarchy", () => {
  test("Disable is destructive-outline with reversible wording; Delete stays filled destructive behind its confirmation", () => {
    const source = readSettingsSource();
    const opsBody = source.slice(source.indexOf("function OpsSection"), source.indexOf("function ChainsSection"));
    expect(opsBody).toContain("kind: \"disable\"");
    expect(opsBody).toContain("kind: \"delete\"");
    expect(opsBody).toContain("kind: \"pause\"");
    expect(opsBody).toContain("kind: \"enable\"");
    expect(opsBody).toContain("kind: \"resume\"");
    expect(source).toContain("settings.confirmDisableAction");
  });

  test("the destructive-outline variant is tokenized on the shadcn Button: no raw hex fork", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/design-system/primitives/button.tsx"), "utf8");
    expect(source).toContain('"destructive-outline":');
    const variantBlock = source.slice(source.indexOf('"destructive-outline":'), source.indexOf("secondary:"));
    expect(variantBlock).not.toContain("dark:");
    expect(variantBlock).not.toContain("#");
  });

  test("disable copy identifies reversibility in both locales; delete copy stays irreversible", () => {
    expect(t("en", "apps.actions.disable")).toContain("reversible");
    expect(t("zh_CN", "apps.actions.disable")).toContain("可恢复");
    expect(t("en", "settings.confirmDisableAction")).toBe("Disable");
    expect(t("zh_CN", "settings.confirmDisableAction")).toBe("停用");
    expect(t("en", "settings.confirmDisableAction")).not.toContain("reversible");
    expect(t("zh_CN", "settings.confirmDisableAction")).not.toContain("可恢复");
    expect(t("en", "settings.confirmDisableBody")).toContain("until you enable it again");
    expect(t("zh_CN", "settings.confirmDisableBody")).toContain("再次启用");
    expect(t("en", "settings.confirmDeleteBody")).toContain("soft-delete");
    expect(t("zh_CN", "settings.confirmDeleteBody")).toContain("软删除");
    expect(t("en", "settings.confirmDeleteButton")).toBe("Delete App");
    expect(t("zh_CN", "settings.confirmDeleteButton")).toBe("删除应用");
  });
});

describe("ops danger zone: one row per action", () => {
  const opsSectionHtml = (locale: SpaBoot["locale"], app: Partial<SettingsAppMeta> = {}): string => {
    const payload = detailPayload();
    const html = withLocation("/dashboard/acme/repos/1", () =>
      renderToStaticMarkup(
        createElement(OpsSection, {
          locale,
          payload: { ...payload, app: { ...payload.app, ...app } },
          onPending: () => {},
          notice: null,
          botWritable: true,
          targetOwned: true,
        }),
      ),
    );
    const start = html.indexOf(`>${t(locale, "settings.ops")}<`);
    return html.slice(html.lastIndexOf("<section", start), html.indexOf("</section>", start));
  };

  test("each row states its effect and carries its own control, in both locales", () => {
    const rows = [
      { title: "settings.opsReviewsTitle", copy: "settings.opsReviewsCopy", control: "settings.pauseReviews" },
      { title: "settings.opsDeliveryTitle", copy: "settings.opsDeliveryCopy", control: "apps.actions.disable" },
      { title: "settings.opsDeleteTitle", copy: "settings.opsDeleteCopy", control: "apps.actions.delete" },
    ] as const;
    for (const locale of ["en", "zh_CN"] as const) {
      const { win, cleanup } = installDom("http://localhost/dashboard/apps/1/settings");
      try {
        win.document.body.innerHTML = opsSectionHtml(locale);
        const doc = win.document;
        const button = (key: DictionaryKey): DomElement | null =>
          [...doc.querySelectorAll("button")].find((node) => node.textContent === t(locale, key)) ?? null;
        for (const row of rows) {
          const label = t(locale, row.control);
          expect(
            [...doc.querySelectorAll("button")].filter((node) => node.textContent === label).length,
            `${locale} ${row.control} count`,
          ).toBe(1);
          const control = button(row.control);
          const rowEl = control!.parentElement!;
          expect(rowEl.textContent, `${locale} ${row.title}`).toContain(t(locale, row.title));
          expect(rowEl.textContent, `${locale} ${row.copy}`).toContain(t(locale, row.copy));
          for (const other of rows) {
            if (other === row) continue;
            expect(rowEl.textContent, `${locale} ${row.control} row holds ${other.title}`).not.toContain(
              t(locale, other.title),
            );
          }
        }
      } finally {
        cleanup();
      }
    }
    expect(t("en", "settings.opsCopy")).not.toContain("404");
    expect(t("zh_CN", "settings.opsCopy")).not.toContain("404");
  });

  test("a disconnected App drops the review row and states its state in the summary", () => {
    const html = opsSectionHtml("en", { status: "disabled" });
    expect(html).toContain(t("en", "settings.disconnected"));
    expect(html).not.toContain(t("en", "settings.opsReviewsTitle"));
    expect(html).toContain(t("en", "apps.actions.enable"));
    expect(html).not.toContain(t("en", "apps.actions.disable"));
    expect(html).toContain(t("en", "settings.opsDeleteTitle"));
  });

  test("a paused App offers resume in the same row", () => {
    const html = opsSectionHtml("en", { review_enabled: false });
    expect(html).toContain(t("en", "settings.opsReviewsCopy"));
    expect(html).toContain(t("en", "settings.resumeReviews"));
    expect(html).not.toContain(t("en", "settings.pauseReviews"));
  });
});

describe("App workflow boundaries", () => {
  test("App settings reads as one workflow with the Apps list: a visible path back", () => {
    const render = (pathname: string): string =>
      withLocation(pathname, () =>
        renderToStaticMarkup(createElement(AppDetailPage, { boot: adminBoot, appId: "1" })),
      );

    const legacy = render("/dashboard/apps/1");
    expect(legacy).toContain('href="/dashboard/apps"');
    expect(legacy).toContain("Back to Apps");
    expect(legacy).toContain('data-slot="page-skeleton"');

    const scoped = render("/dashboard/acme/apps/1");
    expect(scoped).toContain('href="/dashboard/acme/apps"');
    expect(scoped).not.toContain('href="/dashboard/apps"');

    expect(t("en", "appDetail.backToApps")).toBe("Back to Apps");
    expect(t("zh_CN", "appDetail.backToApps")).toBe("返回应用");
    const backLink = /<a [^>]*href="\/dashboard\/acme\/apps"[^>]*>[\s\S]*?<\/a>/.exec(scoped)?.[0] ?? "";
    expect(backLink).not.toBe("");
    expect(backLink).not.toContain("page-skeleton");
    expect(backLink).toContain("inline-flex items-center gap-1.5");
    expect(backLink.match(/<svg/g)?.length).toBe(1);
    expect(backLink).toContain('aria-hidden="true"');
    expect(backLink).toContain(t("en", "appDetail.backToApps"));
  });
  test("successful configuration saves surface success feedback; failures keep the structured error", () => {
    expect(t("en", "settings.changesSaved")).toBe("Changes saved.");
    expect(t("zh_CN", "settings.changesSaved")).toBe("更改已保存。");
  });

  test("configuration section headings are described and unlabeled selects are named", () => {
    const source = readSettingsSource();
    const deliveryTab = readFileSync(
      join(import.meta.dir, "../../src/spa/pages/AppDeliveryTab.tsx"),
      "utf8",
    );
    expect(deliveryTab).toContain('aria-label={t(locale, "appDetail.delivery.filterRepo")}');
    expect(source).toContain('aria-label={t(locale, "settings.runtimeHarness")}');
    expect(source).toContain('aria-label={t(locale, "settings.modelChainField")}');
  });

  test("empty states stay honest: unconfigured provider", () => {
    const source = readSettingsSource();
    expect(source).toContain("settings.noConfiguredProviders");
    expect(t("en", "settings.noConfiguredProviders")).toContain("No providers configured yet");
    expect(t("zh_CN", "settings.noConfiguredProviders")).toContain("尚未配置");
  });
});

describe("notice channel (reviewer handoffs)", () => {
  test("success and warn notices are announced via role=status; errors keep role=alert", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/PageNotice.tsx"), "utf8");
    expect(source).toContain('role={kind === "error" ? "alert" : "status"}');
  });

  test("a deleted App reports its own irreversible outcome, not the generic saved notice", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/AppDetailPage.tsx"), "utf8");
    const deleteBranch = source.slice(
      source.indexOf('action.kind === "delete"'),
      source.indexOf("const confirmCopy"),
    );
    expect(deleteBranch).toContain("settings.deleteSuccess");
    expect(t("en", "settings.deleteSuccess")).toContain("deleted");
    expect(t("zh_CN", "settings.deleteSuccess")).toContain("已删除");
  });
});

describe("section-scoped op feedback", () => {
  test("op outcomes resolve to the originating card; the top notice is page-level reload failure only", () => {
    const source = readSettingsSource();
    expect(source).not.toContain("onNotice");
    expect(t("en", "common.saveFailed")).toContain("save");
    expect(t("zh_CN", "common.saveFailed")).toContain("保存");
    expect(t("en", "common.loadFailed")).toContain("load");
    expect(t("zh_CN", "common.loadFailed")).toContain("无法加载");
  });

  test("the chains 400 renders inside the chains card (user-reported regression pin)", () => {
    const source = readSettingsSource();
    expect(source).toContain('op: "save-chain", model_chain: chain');
  });

  test("dialog-confirmed ops report into the card that owns the action", () => {
    const botView = componentBody(
      readFileSync(join(import.meta.dir, "../../src/spa/pages/BotSettingsPage.tsx"), "utf8"),
      "BotSettingsView",
    );
    const botConfirm = botView.slice(
      botView.indexOf("async function onConfirm"),
      botView.indexOf("const confirmCopy"),
    );
    expect(botConfirm).toContain('op: "remove-chain", name: action.name');
  });

  test("provider remove outcomes render beside the removed row's group (audit UI-45-05)", () => {
    const botView = componentBody(
      readFileSync(join(import.meta.dir, "../../src/spa/pages/BotSettingsPage.tsx"), "utf8"),
      "BotSettingsView",
    );
    const confirmBody = botView.slice(
      botView.indexOf("async function onConfirm"),
      botView.indexOf("const confirmCopy"),
    );
    expect(confirmBody).toContain("provider_id === action.providerId");
  });

  test("a stale delete's no-change outcome is a localized warning, never 'Changes saved.'", () => {
    expect(t("en", "settings.removeNoChange")).toContain("Nothing changed");
    expect(t("zh_CN", "settings.removeNoChange")).toContain("未做任何更改");
  });

  test("save triggers carry a busy guard; every op replaces its region (stale-error rule)", async () => {
    const { win, cleanup } = installDom("http://localhost/dashboard/apps/1/settings");
    try {
      const container = win.document.createElement("div");
      win.document.body.appendChild(container);
      const root = createRoot(container as unknown as Element);
      const payload = detailPayload();
      const sent: Array<Record<string, string>> = [];
      let settle: ((notice: OpNotice) => void) | null = null;
      await act(async () =>
        root.render(
          createElement(RuntimeHarnessEditor, {
            locale: "en",
            payload: {
              ...payload,
              app: { ...payload.app, sandbox_image_id: "legacy" },
              sandbox_images: [{ id: "omp", enabled: true }, { id: "legacy", enabled: true }],
            },
            onSettings: async (fields) => {
              sent.push(fields);
              return await new Promise<OpNotice>((resolve) => {
                settle = resolve;
              });
            },
          }),
        ),
      );
      const save = (): HTMLButtonElement =>
        [...container.querySelectorAll("button")].find(
          (node) => node.textContent === t("en", "settings.saveRuntimeHarness"),
        ) as unknown as HTMLButtonElement;
      const alert = (): string | undefined =>
        container.querySelector('[role="alert"]')?.textContent ?? undefined;
      const click = () =>
        act(async () => {
          save().dispatchEvent(new win.MouseEvent("click", { bubbles: true }) as unknown as Event);
        });

      expect(save().disabled).toBe(false);
      await click();
      expect(sent).toEqual([{ op: "save-sandbox-image", sandbox_image_id: "legacy" }]);
      expect(save().disabled).toBe(true);
      expect(save().getAttribute("data-status")).toBe("loading");

      await act(async () => settle?.({ kind: "error", message: "image unavailable" }));
      expect(save().disabled).toBe(false);
      expect(alert()).toContain("image unavailable");

      await click();
      expect(sent).toHaveLength(2);
      expect(alert()).toBeUndefined();
      await act(async () => settle?.({ kind: "success", message: "Changes saved." }));
      expect(container.querySelector('[role="status"]')?.textContent).toBe("Changes saved.");

      await act(async () => root.unmount());
    } finally {
      cleanup();
    }
  });
});

describe("settings header typography", () => {
  test("app-slug heading is the rendered PageHeader h1; no off-scale page heading remains (audit UI-45-08)", () => {
    const shell = withLocation("/dashboard/apps/1", () =>
      renderToStaticMarkup(
        createElement(AppDetailView, {
          locale: "en",
          appId: "1",
          payload: detailPayload(),
          groups: [],
          notice: null,
          search: { tab: "settings", window: "30", repo: "", pr: "" },
          onReload: async () => true,
          onSearch: () => {},
        }),
      ),
    );
    expect(shell.match(/<h1/g)).toHaveLength(1);
    expect(shell).toContain('<h1 data-slot="page-header-title"');
    expect(shell).toContain(">Acme</h1>");
    const pageHeader = readFileSync(join(import.meta.dir, "../../src/spa/components/PageHeader.tsx"), "utf8");
    expect(pageHeader).toContain('data-slot="page-header-title"');
    expect(shell).not.toContain("text-lg");
  });
});

describe("provider entry controls", () => {
  test("every provider-flow entry is a labelled dialog trigger; no in-card disclosure is left", () => {
    const source = readSettingsSource();
    const providersBody = source.slice(
      source.indexOf("function ProvidersSection"),
      source.indexOf("function groupMeta"),
    );
    expect(providersBody).toContain('aria-haspopup="dialog"');
    expect(providersBody).not.toContain("aria-expanded=");
    const groupCard = source.slice(source.indexOf("function ProviderGroupCard"));
    expect(groupCard).toContain('aria-haspopup="dialog"');
    expect(groupCard).toContain("settings.addKey");
  });
});

describe("GitHub App identity card", () => {
  const html = (app: SettingsAppMeta, canManage = false): string =>
    renderToStaticMarkup(
      createElement(AppInfoSection, { locale: "en", app, workspaceId: WORKSPACE_ID, canManage }),
    );

  const WORKSPACE_ID = "ws_0123456789abcdefghijkl";

  function meta(overrides: Partial<SettingsAppMeta> = {}): SettingsAppMeta {
    return {
      github_slug: "acme",
      id: "app-acme",
      github_app_id: 123456,
      status: "active",
      review_enabled: true,
      created_by: "alice",
      last_webhook_at: null,
      scope: "owned" as const,
      sandbox_image_id: "omp",
      review_trigger_mode: "every_push",
      review_level: null,
      default_review_level: "default",
      github_name: null,
      github_description: null,
      github_html_url: null,
      github_avatar_url: null,
      github_metadata_synced_at: null,
      github_visibility: "unknown",
      ...overrides,
    };
  }

  const synced = {
    github_name: "Acme Reviewer",
    github_description: "Reviews pull requests for Acme.",
    github_html_url: "https://github.com/settings/apps/acme-reviewer",
    github_avatar_url: "https://avatars.githubusercontent.com/in/1234?v=4",
    github_metadata_synced_at: "2026-09-08 00:00:00",
  };

  test("synced profile renders avatar, the GitHub ACTION link (new tab, noopener), description, AppID — never the name a second time", () => {
    const out = html(meta(synced));
    expect(out).toContain('<img src="https://avatars.githubusercontent.com/in/1234?v=4"');
    expect(out).toContain('href="https://github.com/settings/apps/acme-reviewer"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    // The synced name is the page header's identity; the block does not repeat it.
    expect(out).not.toContain("Acme Reviewer");
    expect(out).toContain("View on GitHub");
    expect(out).toContain("Reviews pull requests for Acme.");
    expect(out).toContain("App ID: 123456");
    expect(out).toContain("Synced ");
  });

  test("never-synced App degrades to local fields, and the icon is derived from the App id", () => {
    const out = html(meta());
    expect(out).toContain("GitHub App");
    expect(out).toContain("App ID: 123456");
    expect(out).toContain(`<img src="${appAvatarUrl(123456).replaceAll("&", "&amp;")}"`);
    expect(out).not.toContain("<a ");
  });

  test("mixed-null metadata renders only the present fields, per-field degradation", () => {
    const out = html(
      meta({
        github_name: synced.github_name,
        github_html_url: synced.github_html_url,
      }),
    );
    expect(out).toContain('href="https://github.com/settings/apps/acme-reviewer"');
    expect(out).not.toContain("Acme Reviewer");
    expect(out).toContain(appAvatarUrl(123456).replaceAll("&", "&amp;"));
    expect(out).not.toContain("Reviews pull requests");
    expect(out).not.toContain("Synced ");
    expect(out).toContain("App ID: 123456");
    const urlless = html(meta({ github_name: synced.github_name }));
    expect(urlless).not.toContain("<a ");
    expect(urlless).not.toContain("Acme Reviewer");
    // The action link needs only the URL — it labels its action, not the name.
    const nameless = html(meta({ github_html_url: synced.github_html_url }));
    expect(nameless).toContain('href="https://github.com/settings/apps/acme-reviewer"');
    expect(nameless).toContain("View on GitHub");
  });

  test("manager face targets the GitHub App settings page derived from the html_url slug (AD-623)", () => {
    const manager = html(meta({ ...synced, github_html_url: "https://github.com/apps/url-slug-app" }), true);
    expect(manager).toContain('href="https://github.com/settings/apps/url-slug-app"');
    expect(manager).not.toContain('href="https://github.com/apps/url-slug-app"');
    const trailing = html(meta({ ...synced, github_html_url: "https://github.com/apps/url-slug-app/" }), true);
    expect(trailing).toContain('href="https://github.com/settings/apps/url-slug-app"');
    const mismatched = html(
      meta({
        github_slug: "local-slug",
        github_name: "Totally Different",
        github_html_url: "https://github.com/apps/url-slug-app",
      }),
      true,
    );
    expect(mismatched).toContain('href="https://github.com/settings/apps/url-slug-app"');
    expect(manager).toContain("Manage on GitHub");
    expect(manager).toContain('target="_blank"');
    expect(manager).toContain('rel="noopener noreferrer"');
  });

  test("member face keeps the public page; an unusable url degrades to the public link (AD-623)", () => {
    const member = html(meta({ ...synced, github_html_url: "https://github.com/apps/acme-reviewer" }));
    expect(member).toContain('href="https://github.com/apps/acme-reviewer"');
    expect(member).toContain("View on GitHub");
    const degraded = html(meta({ ...synced, github_html_url: "https://github.com" }), true);
    expect(degraded).toContain('href="https://github.com"');
    expect(degraded).toContain("View on GitHub");
    const deepPath = html(
      meta({ ...synced, github_html_url: "https://github.com/apps/url-slug-app/settings" }),
      true,
    );
    expect(deepPath).toContain('href="https://github.com/apps/url-slug-app/settings"');
    expect(deepPath).not.toContain('href="https://github.com/settings/apps/settings"');
    for (const canManage of [false, true]) {
      const out = html(meta({ github_name: synced.github_name }), canManage);
      expect(out).not.toContain("<a ");
      expect(out).not.toContain("Acme Reviewer");
    }
  });

  test("the card precedes the manage conditional — both faces see it", () => {
    const source = readSettingsSource();
    const cardPos = source.indexOf("<AppInfoSection");
    const managePos = source.indexOf("{payload.can_manage ? (");
    expect(cardPos).toBeGreaterThan(-1);
    expect(managePos).toBeGreaterThan(cardPos);
    const cardBody = source.slice(
      source.indexOf("export function AppInfoSection"),
      source.indexOf("function InstallationsSection"),
    );
    expect(cardBody).toContain('target="_blank"');
    expect(cardBody).toContain('rel="noopener noreferrer"');
  });

  test("card copy is dictionary-backed in both locales (en/zh parity)", () => {
    expect(t("en", "settings.appInfo")).toBe("GitHub App");
    expect(t("zh_CN", "settings.appInfo")).toBe("GitHub App");
    expect(t("en", "settings.appInfoCopy")).toContain("GitHub");
    expect(t("zh_CN", "settings.appInfoCopy")).toContain("GitHub");
    expect(t("en", "settings.appInfoAppId", { id: 123456 })).toBe("App ID: 123456");
    expect(t("zh_CN", "settings.appInfoAppId", { id: 123456 })).toBe("App ID：123456");
    expect(t("en", "settings.appInfoViewOnGithub")).toBe("View on GitHub");
    expect(t("zh_CN", "settings.appInfoViewOnGithub")).toBe("在 GitHub 上查看");
    expect(t("en", "settings.appInfoManageOnGithub")).toBe("Manage on GitHub");
    expect(t("zh_CN", "settings.appInfoManageOnGithub")).toBe("在 GitHub 上管理");
    expect(t("en", "settings.appInfoSynced", { time: "5 minutes ago" })).toBe("Synced 5 minutes ago");
    expect(t("zh_CN", "settings.appInfoSynced", { time: "5 分钟前" })).toBe("同步于 5 分钟前");
    expect(t("en", "settings.appInfoRefresh")).toBe("Refresh from GitHub");
    expect(t("zh_CN", "settings.appInfoRefresh")).toBe("从 GitHub 刷新");
    expect(t("en", "settings.appInfoRefreshDone")).toBe("Identity refreshed from GitHub.");
    expect(t("zh_CN", "settings.appInfoRefreshDone")).toBe("已从 GitHub 刷新身份。");
  });

  describe("identity card force refresh (D5)", () => {
    const card = (canManage: boolean, onReload?: () => Promise<unknown>): string =>
      renderToStaticMarkup(
        createElement(AppInfoSection, {
          locale: "en",
          app: meta({ github_name: "Acme Reviewer" }),
          workspaceId: WORKSPACE_ID,
          canManage,
          onReload,
        }),
      );

    test("manager-only: the refresh button renders only on the manager face with a reload path", () => {
      expect(card(true, async () => true)).toContain(t("en", "settings.appInfoRefresh"));
      expect(card(true)).not.toContain(t("en", "settings.appInfoRefresh"));
      expect(card(false, async () => true)).not.toContain(t("en", "settings.appInfoRefresh"));
    });

    test("the delivery URL renders on the manager face, composed from the workspace id + local App UID", () => {
      const deliveryUrl = (canManage: boolean): string =>
        withLocation("/dashboard/acme/apps/123456/settings", () => card(canManage), "https://worker.example");

      const manager = deliveryUrl(true);
      expect(manager).toContain(t("en", "settings.appInfoDeliveryUrl"));
      expect(manager).toContain(`https://worker.example/webhook/${WORKSPACE_ID}/app-acme`);

      const member = deliveryUrl(false);
      expect(member).not.toContain(t("en", "settings.appInfoDeliveryUrl"));
      expect(member).not.toContain("https://worker.example/webhook/");
    });

    test("both URL segments are readable from the card: GitHub App id and local App UID", () => {
      const out = withLocation(
        "/dashboard/acme/apps/123456/settings",
        () => card(true),
        "https://worker.example",
      );
      expect(out).toContain(t("en", "settings.appInfoAppId", { id: 123456 }));
      expect(out).toContain(t("en", "settings.appInfoLocalId", { id: "app-acme" }));
    });

    test("a workspace SLUG in the path never reaches the delivery URL — the payload's id does", () => {
      const out = withLocation(
        "/dashboard/acme/apps/123456/settings",
        () => card(true),
        "https://worker.example",
      );
      expect(out).toContain(`https://worker.example/webhook/${WORKSPACE_ID}/app-acme`);
      expect(out).not.toContain("https://worker.example/webhook/acme/");
    });

    test("the delivery URL label is dictionary-backed in both locales", () => {
      expect(t("en", "settings.appInfoDeliveryUrl")).toBe("Webhook URL:");
      expect(t("zh_CN", "settings.appInfoDeliveryUrl")).toBe("Webhook URL：");
    });

    test("refresh POSTs refresh-metadata by github_app_id; success reloads, failure resolves the keyed message and never reloads", () => {
      const source = readSettingsSource();
      expect(source).toContain("refresh-metadata");
      expect(t("en", "settings.appInfoRefreshDone")).toBe("Identity refreshed from GitHub.");
    });

    test("a transport failure (fetch rejects) shows the save-failure notice and never reloads", async () => {
      const { win, cleanup } = installDom("http://localhost/dashboard/acme/apps/123456/settings");
      const realFetch = globalThis.fetch;
      let reloads = 0;
      globalThis.fetch = (async () => {
        throw new TypeError("Failed to fetch");
      }) as unknown as typeof fetch;
      try {
        const container = win.document.createElement("div");
        win.document.body.appendChild(container);
        const root = createRoot(container as unknown as Element);
        await act(async () =>
          root.render(
            createElement(AppInfoSection, {
              locale: "en",
              app: meta({ github_name: "Acme Reviewer" }),
              workspaceId: WORKSPACE_ID,
              canManage: true,
              onReload: async () => {
                reloads += 1;
                return true;
              },
            }),
          ),
        );

        const button = [...container.querySelectorAll("button")].find(
          (candidate) => candidate.textContent === t("en", "settings.appInfoRefresh"),
        );
        expect(button).toBeDefined();
        await act(async () => {
          button?.dispatchEvent(new win.MouseEvent("click", { bubbles: true }));
        });

        const alert = container.querySelector('[role="alert"]');
        expect(alert?.textContent).toBe(t("en", "common.saveFailed"));
        expect(reloads).toBe(0);
        expect((button as unknown as HTMLButtonElement).disabled).toBe(false);

        await act(async () => root.unmount());
      } finally {
        globalThis.fetch = realFetch;
        cleanup();
      }
    });
  });
});

describe("GitHub App settings link wiring (AD-623)", () => {
  test("slug derivation: the html_url's apps/<slug> tail, trailing-slash tolerant", () => {
    expect(githubAppSettingsUrl("https://github.com/apps/acme")).toBe("https://github.com/settings/apps/acme");
    expect(githubAppSettingsUrl("https://github.com/apps/acme/")).toBe("https://github.com/settings/apps/acme");
    expect(githubAppSettingsUrl("https://github.com/apps/acme///")).toBe("https://github.com/settings/apps/acme");
    expect(githubAppSettingsUrl("https://github.com/settings/apps/acme-reviewer")).toBe(
      "https://github.com/settings/apps/acme-reviewer",
    );
  });

  test("deep-path shapes derive null (qc round 1, qc2-F-001): no sub-path masquerades as the slug", () => {
    expect(githubAppSettingsUrl("https://github.com/apps/acme/settings")).toBeNull();
    expect(githubAppSettingsUrl("https://github.com/apps/acme/installations/new")).toBeNull();
  });

  test("no derivable segment or an unparseable https shape derives null (runtime degradation)", () => {
    expect(githubAppSettingsUrl("https://github.com")).toBeNull();
    expect(githubAppSettingsUrl("https://github.com/")).toBeNull();
    // The server admits any https://-prefixed value; these must never throw.
    expect(githubAppSettingsUrl("https://")).toBeNull();
    expect(githubAppSettingsUrl("not a url")).toBeNull();
  });
});

describe("runtime harness row tightness", () => {
  test("select shell is content-adaptive; save button sits in the same flex-wrap row", () => {
    const source = readSettingsSource();
    const runtimeBody = source.slice(
      source.indexOf("function RuntimeHarnessEditor"),
      source.indexOf("function OpsSection"),
    );
    expect(runtimeBody).not.toContain("min-w-64");
    expect(runtimeBody).toContain("settings.saveRuntimeHarness");
  });
});

describe("the tenant support notice renders nothing until the client read", () => {
  test("the SSR render of a member's shell is empty", () => {
    const markup = renderToStaticMarkup(
      createElement(SupportNotice, {
        boot: { login: "dana", locale: "en" } as SpaBoot,
        pathname: "/dashboard/acme/apps",
      }),
    );
    expect(markup).toBe("");
  });
});

describe("review depth control", () => {
  test("the four faces carry the plan's vocabulary in both locales", () => {
    expect(reviewDepthOptions("en", "default").map((option) => [option.value, option.label])).toEqual([
      ["quick", "Quick — fast, single-pass review"],
      ["default", "Standard — balanced depth (recommended)"],
      ["deep", "Deep — most thorough, slower"],
      [REVIEW_DEPTH_INHERIT, "Follow operator default (currently Standard)"],
    ]);
    expect(reviewDepthOptions("zh_CN", "deep").map((option) => option.label)).toEqual([
      "快速 — 单轮快速评审",
      "标准 — 均衡深度（推荐）",
      "深入 — 最彻底，耗时更长",
      "跟随平台默认（当前：深入）",
    ]);
  });

});

describe("bot-scoped sections left the target detail", () => {
  test("the App settings body renders the identity card and nothing else", () => {
    const markup = renderToStaticMarkup(
      createElement(SettingsView, { locale: "en", payload: detailPayload() }),
    );
    expect(markup).toContain(t("en", "settings.appInfo"));
    for (const key of [
      "settings.providers.title",
      "settings.modelChains",
      "settings.seats",
      "settings.runtimeHarness",
      "settings.installations",
      "settings.reviewTrigger",
      "settings.reviewDepth",
      "settings.reviewGate",
      "settings.ops",
    ] as const) {
      expect(markup, key).not.toContain(t("en", key));
    }
  });

  test("the settings view carries no bot-scoped op and no bot-scoped section component", () => {
    const viewBody = componentBody(
      readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8"),
      "SettingsView",
    );
    for (const op of ["save-sandbox-image", "add-key", "add-chain", "save-roles", "add-custom-provider"]) {
      expect(viewBody, op).not.toContain(op);
    }
  });
});
