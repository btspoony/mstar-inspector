/**
 * Plan 31 T4+T6 + plan 35 T4: settings ops zone, unified providers, chains UI.
 * No DOM runner — source-scan pins over SettingsPage.tsx and its primitives
 * plus pure data helpers (the plan 30 home suite that shared this style is
 * retired). Plan 53: the AppInfoCard degradation face is additionally pinned
 * behaviorally through react-dom/server SSR of the exported card (no DOM
 * needed — static markup output).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../../src/i18n";
import { composeModelOptions } from "../../src/dashboard/model-membership";
import { APP_VERSION } from "../../src/version";
import { PROVIDER_IDS_COMMON } from "../../src/contracts/provider-catalog.generated";
import { parseModels, modelChainTabs, seatRoleValues, seatSelectValue, splitModelChain, type CatalogProvider, type SettingsAppMeta } from "../../src/spa/pages/data";
import {
  ProviderCombobox,
  ProviderComboboxPanel,
  filterCatalogProviders,
  groupCatalogProviders,
} from "../../src/spa/components/provider-combobox";
import { AppInfoCard, DraftChainPanel, draftChainTabLabel } from "../../src/spa/pages/SettingsPage";

describe("settings layout (plan 35 T4)", () => {
  test("SettingsPage folds ops + health into an authorized ops zone; providers and chains are shadcn", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    expect(source).toContain("settings.ops");
    expect(source).toContain("can_manage");
    expect(source).toContain("${action.kind}");
    expect(source).toContain('kind: "pause"');
    expect(source).toContain('kind: "disable"');
    expect(source).toContain('kind: "delete"');
    expect(source).toContain("settings.recentDeliveries");
    expect(source).toContain("settings.providers");
    expect(source).toContain("settings.customEntry");
    expect(source).toContain("add-template-provider");
    expect(source).toContain("add-chain");
    expect(source).toContain("settings.useDefaultChain");
    expect(source).toContain("settings.addChain");
    expect(source).not.toContain("settingsLayout");
    expect(source).not.toContain("settingsSidebar");
  });

  test("destructive removes (key / custom provider) route through confirm dialogs like pause/delete", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    expect(source).toContain('kind: "remove-key"');
    expect(source).toContain('kind: "remove-custom"');
    expect(source).toContain("settings.confirmRemoveKeyTitle");
    expect(source).toContain("settings.confirmRemoveCustomTitle");
    expect(source).toContain("onPending={onPending}");
    // No fire-and-forget destructive POSTs outside the dialog flow.
    expect(source).not.toContain('onClick={() => void onSettings({ op: "remove-custom-provider"');
    expect(t("en", "settings.confirmRemoveKeyTitle", { provider: "ark" })).toContain("ark");
    expect(t("zh_CN", "settings.confirmRemoveCustomTitle", { provider: "acme" })).toContain("acme");
  });
});

describe("settings dropdowns (plan 31 T4 / plan 35 T4)", () => {
  test("chain and role editors are dropdowns, not free-text; add-key posts the JSON verify route", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    expect(source).toContain("/keys/verify");
    expect(source).toContain("settings.addToChain");
    expect(source).toContain("settings.useDefaultChain");
    expect(source).toContain("settings.pickModel");
    expect(source).toContain("SelectGroup");
    expect(source).not.toContain('type="text" name="model_chain"');
    expect(source).not.toContain("<input type=\"text\" name={`role_${role}`}");
    expect(source).not.toContain("<select name={`role_${role}`}");
  });

  test("composeModelOptions prefixes the cache provider (including ark-plan) and custom ids", () => {
    const groups = composeModelOptions(
      [{ provider: "ark-plan", models: ["doubao"], fetched_at: "t" }],
      [{ provider_id: "acme", model_ids: ["fast"] }],
    );
    expect(groups.map((g) => g.selectors).flat()).toEqual(["ark-plan/doubao", "acme/fast"]);
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

describe("runtime image selector (plan 37)", () => {
  test("managers get a shadcn selector saved through op=save-sandbox-image; other members read-only", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    // The editor posts the plan-37 op with the selected registry id.
    expect(source).toContain('op: "save-sandbox-image"');
    expect(source).toContain("sandbox_image_id: selected");
    // The choices come from the manage payload's enabled registry rows.
    expect(source).toContain("payload.sandbox_images.map");
    // shadcn Select (no native select), like the chain/seat editors.
    expect(source).toContain("SelectTrigger");
    expect(source).toContain("SelectItem");
    // Read-only detail for non-managers, never the editor.
    expect(source).toContain("settings.runtimeImageValue");
    expect(source).toContain("payload.app.sandbox_image_id");
  });

  test("runtime image copy is dictionary-backed in both locales", () => {
    expect(t("en", "settings.runtimeImage")).toBe("Runtime image");
    expect(t("zh_CN", "settings.runtimeImage")).toBe("运行时镜像");
    expect(t("en", "settings.runtimeImageCopy")).toContain("run time");
    expect(t("zh_CN", "settings.runtimeImageCopy")).toContain("运行时");
    expect(t("en", "settings.runtimeImageValue", { id: "omp" })).toContain("omp");
    expect(t("zh_CN", "settings.runtimeImageValue", { id: "omp" })).toContain("omp");
    expect(t("en", "settings.saveRuntimeImage")).toBe("Save runtime image");
    expect(t("zh_CN", "settings.saveRuntimeImage")).toBe("保存运行时镜像");
  });
});

describe("settings copy is dictionary-backed (plan 31 T4+T6 / plan 35 T4)", () => {
  test("new keys exist in both locales", () => {
    expect(t("en", "settings.verify.invalid_key")).toContain("rejected");
    expect(t("zh_CN", "settings.verify.invalid_key")).toContain("拒绝");
    expect(t("en", "settings.verify.unreachable")).toContain("reached");
    expect(t("zh_CN", "settings.verify.unreachable")).toContain("连接");
    expect(t("en", "settings.verify.unexpected")).toContain("unexpected");
    expect(t("zh_CN", "settings.verify.unexpected")).toContain("意外");
    expect(t("en", "settings.verify.unsupported_provider")).toContain("can't be verified");
    expect(t("zh_CN", "settings.verify.unsupported_provider")).toContain("无法");
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

  test("SPA maps membership 400 code via t(), not English body prose", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    expect(source).toContain("settingsErrorMessage");
    expect(source).toContain("not_in_verified_models");
    expect(source).toContain("settings.membership.not_in_verified_models");
    expect(source).toContain("message: settingsErrorMessage(locale, body)");
  });

  test("SPA maps unsupported_provider via t() and shows the console-only hint", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    expect(source).toContain("settings.verify.unsupported_provider");
    expect(source).toContain("settings.consoleOnly");
    expect(source).toContain("unsupported_provider");
  });
});

describe("configured providers + catalog add flow (plan 38 T2)", () => {
  test("the providers card renders configured state only; the catalog is the Add Provider picker", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    // Primary list = configured state (kind rows), never the catalog dump.
    expect(source).toContain("payload.configured_providers.map");
    expect(source).not.toContain("payload.provider_catalog.map");
    // Empty configured state is a valid UI with Add Provider as the path.
    expect(source).toContain("settings.noConfiguredProviders");
    // Masked status rides the configured key row.
    expect(source).toContain("settings.keyEnding");
    expect(source).toContain("settings.keyTooShort");
  });

  test("Add Provider: catalog selection drives the configuration form; custom path preserved", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    // Header disclosure button (plan 42) → catalog select → selected provider's form.
    expect(source).toContain("settings.addProvider");
    expect(source).toContain("aria-expanded={addOpen}");
    expect(source).toContain("selectedCatalogProvider");
    expect(source).toContain("providerFormKind");
    expect(source).toContain("settings.configureProvider");
    // Built-in and template materialization paths, mutations unchanged.
    expect(source).toContain("/keys/verify");
    expect(source).toContain('op: "add-template-provider"');
    // CustomExpand stays for ids NOT in the catalog.
    expect(source).toContain("CustomExpand");
    expect(source).toContain('op: "add-custom-provider"');
  });

  test("a failed verify keeps the provider unconfigured and surfaces the structured reason", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    expect(source).toContain("verifyReasonMessage(locale, reason)");
    // Forms reset and close only on success — a rejected submit keeps the
    // typed input and the add selection while the background reload refreshes
    // data in place (plan 44 T3: the outcome literal replaces the old
    // boolean, and the success branch keys off the outcome kind).
    expect(source).toContain('if (outcome.kind === "success") {');
    expect(source).toContain("await onReload({ background: true })");
    expect(source).toContain("Promise<OpNotice>");
  });

  test("op-triggered reloads are background: the card tree stays mounted across a failed verify (QC fix wave 1 F-001)", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    // load() defaults to the foreground (loading-flash) behavior; only the
    // background variant skips the "loading" flip.
    expect(source).toContain("background = false");
    expect(source).toContain('if (!background) setState("loading")');
    // Initial mount loads in the foreground — genuine navigation keeps the
    // loading state.
    expect(source).toContain("void load()");
    // Every op-triggered refresh is a background reload: no unmount, so the
    // Add Provider panel (open + selection) and every form's typed input
    // survive a failed verify.
    expect(source).toContain("await onReload({ background: true })");
    expect(source).not.toContain("await onReload()");
    // A failed background refresh surfaces through the notice channel instead
    // of the page-level error state — it must never unmount the tree either.
    expect(source).toContain('message: t(locale, "common.loadFailed")');
    // Success closes/resets deliberately: the onDone closure runs against the
    // mounted instance.
    expect(source).toContain("onDone();");
    expect(source).toContain("setSelectedId(undefined)");
    expect(source).toContain("onOpenChange(false)");
    expect(source).toContain('setKey("")');
  });

  test("plan 38 add-flow copy is dictionary-backed in both locales", () => {
    expect(t("en", "settings.addProvider")).toBe("Add provider");
    // Plan 54: the zh label unifies on 模型提供方 (supersedes the plan-42
    // settled "添加 Provider" — no bare "Provider" left on the picker
    // surface); en keeps "Add provider".
    expect(t("zh_CN", "settings.addProvider")).toBe("添加模型提供方");
    expect(t("en", "settings.providersCopy")).toContain("Add Provider");
    expect(t("zh_CN", "settings.providersCopy")).toContain("添加模型提供方");
    expect(t("en", "settings.noConfiguredProviders")).toContain("No providers configured yet");
    expect(t("zh_CN", "settings.noConfiguredProviders")).toContain("尚未配置");
    // Plan 54: the 常用提供方 common tier replaces 内置提供方 as the group
    // name (supersedes the plan-38 "Built-in"/"内置" pins).
    expect(t("en", "settings.catalogBuiltin")).toBe("Common providers");
    expect(t("zh_CN", "settings.catalogBuiltin")).toBe("常用提供方");
    expect(t("en", "settings.catalogTemplate")).toContain("templates");
    expect(t("zh_CN", "settings.catalogTemplate")).toContain("模板");
    expect(t("en", "settings.configureProvider", { label: "Anthropic" })).toContain("Anthropic");
    expect(t("zh_CN", "settings.configureProvider", { label: "Anthropic" })).toContain("Anthropic");
  });
});

describe("catalog provenance + eligibility messaging (plan 38 T3)", () => {
  test("Add Provider discloses provenance and per-entry eligibility vs the selected runtime image", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    // Provenance: the catalog is generated, pinned metadata — not a live query.
    expect(source).toContain("settings.catalogProvenance");
    // Eligibility is judged against the App's SELECTED image id, never inferred.
    expect(source).toContain("payload.app.sandbox_image_id");
    expect(source).toContain("settings.eligibilityBuiltin");
    expect(source).toContain("settings.eligibilityTemplate");
    expect(source).toContain("settings.eligibilityUnavailable");
    // Unavailable rows keep their picker entry (marked), never hidden
    // silently — plan 54: the short suffix moved into the combobox file with
    // the picker rows (supersedes the in-page pin).
    const combobox = readFileSync(join(import.meta.dir, "../../src/spa/components/provider-combobox.tsx"), "utf8");
    expect(combobox).toContain("settings.eligibilityUnavailableShort");
  });

  test("an unavailable entry gets an explanation instead of a form — nothing can save it silently", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    // The gate sits above ProviderConfigForm: unavailable → copy only, no submit path.
    expect(source).toContain('selected.eligibility === "unavailable"');
  });

  test("the catalog picker uses the aria-labelledby precedent; custom configured rows show the catalog label", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    // MembersPage precedent: visible label span naming the picker — no
    // wrapping <label>. Plan 54: the span names the combobox input through
    // the labelledby prop (the aria-labelledby attribute itself moved into
    // provider-combobox.tsx, superseding the old attribute pin).
    expect(source).toContain('id="settings-catalog-provider-label"');
    expect(source).toContain('labelledby="settings-catalog-provider-label"');
    // Template-materialized configured rows resolve the human label via the
    // catalog map (same pattern as key rows), keeping the raw id in the detail.
    expect(source).toContain("catalogById[row.provider_id]?.label");
  });

  test("plan 38 T3 copy is dictionary-backed in both locales", () => {
    // Provenance names the count + committed-snapshot source (plan 42 breadth).
    expect(t("en", "settings.catalogProvenance", { count: 214 })).toContain("214");
    expect(t("en", "settings.catalogProvenance", { count: 214 })).toContain("models.dev");
    expect(t("zh_CN", "settings.catalogProvenance", { count: 214 })).toContain("214");
    expect(t("zh_CN", "settings.catalogProvenance", { count: 214 })).toContain("models.dev");
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

describe("provider combobox (plan 54 T3)", () => {
  const commonEntry = (id: string, label: string, overrides: Partial<CatalogProvider> = {}): CatalogProvider => ({
    id,
    label,
    tier: "builtin",
    base_url: null,
    api: null,
    models: ["m1"],
    verifiable: true,
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
    eligibility: "builtin",
    display_group: "catalog",
    ...overrides,
  });

  // Common tier = the 5 frozen ids; the catalog group = everything else
  // (two template rows + one fabricated unavailable builtin whose label
  // matches the "gem" probe, so the filtered-face marking is observable).
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
    // "gem" keeps both the common Gemini and the unavailable catalog row —
    // filtering never drops unavailable entries (they stay listed + marked).
    expect(filterCatalogProviders(catalog, "gem").map((p) => p.id)).toEqual(["gemini", "gemini-image"]);
    expect(filterCatalogProviders(catalog, "GEM").map((p) => p.id)).toEqual(["gemini", "gemini-image"]);
    expect(filterCatalogProviders(catalog, "copilot").map((p) => p.id)).toEqual(["copilot"]);
    expect(filterCatalogProviders(catalog, "github").map((p) => p.id)).toEqual(["copilot"]); // label match
    // Empty / whitespace query → the full catalog in payload order.
    expect(filterCatalogProviders(catalog, "")).toHaveLength(catalog.length);
    expect(filterCatalogProviders(catalog, "   ").map((p) => p.id)).toEqual(catalog.map((p) => p.id));
    expect(filterCatalogProviders(catalog, "zzz-no-match")).toEqual([]);
  });

  test("the pure grouping puts the frozen common 5 first; catalog holds the rest", () => {
    expect([...PROVIDER_IDS_COMMON]).toEqual(["anthropic", "openai", "gemini", "copilot", "xai"]);
    const groups = groupCatalogProviders(catalog);
    expect(groups.common.map((p) => p.id)).toEqual([...PROVIDER_IDS_COMMON]);
    expect(groups.common.every((p) => p.display_group === "common")).toBe(true);
    // Within-group payload order is preserved; the unavailable row stays.
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
    // Common providers group renders before Catalog templates.
    expect(full.indexOf("Common providers")).toBeGreaterThan(-1);
    expect(full.indexOf("Catalog templates")).toBeGreaterThan(full.indexOf("Common providers"));
    // The selected row carries aria-selected.
    expect(full).toContain('aria-selected="true"');
    // The unavailable catalog row stays listed and marked, with the suffix.
    expect(full).toContain('aria-disabled="true"');
    expect(full).toContain("unavailable on omp");
    const narrowed = panel("gem", "gemini");
    // Narrowed to matching entries only — the common group keeps just Gemini
    // (one of the frozen 5), the catalog group only the unavailable marked
    // row; every other entry is gone.
    expect(narrowed).toContain("Google Gemini");
    expect(narrowed).toContain('aria-selected="true"');
    expect(narrowed).toContain("Gemini Image");
    expect(narrowed).toContain('aria-disabled="true"');
    expect(narrowed).toContain("unavailable on omp");
    expect(narrowed).not.toContain("Anthropic");
    expect(narrowed).not.toContain("OpenAI");
    expect(narrowed).not.toContain("Copilot");
    expect(narrowed).not.toContain("Mistral");
    expect(narrowed).not.toContain("Workers AI");
    // An empty match renders the honest empty state, never a bare box.
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
    expect(out).toContain('aria-disabled="true"');
    expect(out).toContain("unavailable on omp");
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
    // Closed → no listbox anywhere in the markup.
    expect(out).not.toContain('role="listbox"');
  });

  test("Esc and outside-click dismiss; focus/typing opens (source pins at the QA minimum bar)", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/components/provider-combobox.tsx"), "utf8");
    // Esc closes.
    expect(source).toContain('if (event.key === "Escape") setOpen(false);');
    // An outside pointerdown closes (contains check on the root ref).
    expect(source).toContain('document.addEventListener("pointerdown", onPointerDown);');
    expect(source).toContain("!rootRef.current.contains(event.target as Node)");
    // Focus/typing opens, and every keystroke re-narrows the panel.
    expect(source).toContain("onFocus={() => setOpen(true)}");
    expect(source).toContain("setQuery(event.target.value);");
    // Selection is inert for unavailable rows — the UI side of the red line
    // (the server-side eligibility pre-check stays the last line of defense
    // and is untouched).
    expect(source).toContain("if (!unavailable) onSelect(provider.id);");
  });

  test("keyboard selection: arrows walk the filtered list, Enter selects, highlight follows the filter, click re-opens after Esc (source pins, task-3 review fix)", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/components/provider-combobox.tsx"), "utf8");
    // The highlight walks the SAME order the panel renders: the shell derives
    // it from the same pure filter/group helpers (common block, then catalog).
    expect(source).toContain("groupCatalogProviders(filterCatalogProviders(providers, query))");
    expect(source).toContain("const visible = [...groups.common, ...groups.catalog];");
    // ArrowDown/ArrowUp move the active-descendant highlight; arrows also
    // open the list standalone (the replaced Radix Select was keyboard-
    // operable — the plan's 可选 minimum bar).
    expect(source).toContain('if (event.key === "ArrowDown" || event.key === "ArrowUp")');
    expect(source).toContain("Math.min(index + 1, visible.length - 1)");
    expect(source).toContain("Math.max(index - 1, 0)");
    // Enter selects the highlighted row — and the unavailable red line holds
    // on the keyboard path exactly as on the pointer path.
    expect(source).toContain('event.key === "Enter" && open');
    expect(source).toContain('if (active && active.eligibility !== "unavailable") select(active.id);');
    // The input advertises the highlighted option while the list is open.
    expect(source).toContain("aria-activedescendant={open && active ? optionId(listboxId, active.id) : undefined}");
    // The highlight follows filter changes: every keystroke (and a selection)
    // resets it to the first match.
    expect(source).toContain("setActiveIndex(0);");
    // Pointer/keyboard stay in sync: hovering a row moves the highlight.
    expect(source).toContain("onMouseMove={() => onHoverOption?.(provider.id)}");
    // After an Esc the input keeps focus, so focus alone never re-fires —
    // click re-opens the (filtered) list.
    expect(source).toContain("onClick={() => setOpen(true)}");
  });

  test("QC fix round: the keyboard highlight scrolls into view and Tab closes the list (source pins)", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/components/provider-combobox.tsx"), "utf8");
    // F1: while open, a highlight change scrolls the active row into view
    // inside the max-h-72 scroll container — arrowing past the fold must not
    // let Enter commit an unseen row (the replaced Radix Select auto-scrolled
    // its active item).
    expect(source).toContain('scrollIntoView({ block: "nearest" })');
    // The effect is gated: it runs only for the open list with a highlighted
    // row (no scroll work while closed or in the zero-match state).
    expect(source).toContain("if (!open || !active) return;");
    // …and it lives in the stateful SHELL, never in the SSR-pure panel (the
    // panel's static-markup testability depends on being effect-free).
    const panelBody = source.slice(
      source.indexOf("export function ProviderComboboxPanel"),
      source.indexOf("export function ProviderCombobox({"),
    );
    const shellBody = source.slice(source.indexOf("export function ProviderCombobox({"));
    expect(panelBody).not.toContain("scrollIntoView");
    expect(panelBody).not.toContain("useEffect");
    expect(shellBody).toContain("scrollIntoView");
    // F2: Tab closes the open list in the keydown handler — no stale overlay
    // floating over the page with aria-expanded="true" after focus moves on.
    expect(source).toContain('if (event.key === "Tab") setOpen(false);');
    // Deliberately keydown, not onBlur: a blur-close would fire before a
    // row's click lands (the qc3 F-002 disposition).
    expect(source).not.toContain("onBlur");
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
    // Every option row carries its deterministic bridge id — the shape the
    // input's aria-activedescendant points at.
    expect(full).toContain('id="lb-option-anthropic"');
    expect(full).toContain('id="lb-option-gemini"');
    expect(full).toContain('id="lb-option-gemini-image"');
    // The highlighted row renders the standalone bg-accent token; every row
    // always carries the hover: variant (8 rows → 8 substring occurrences,
    // +1 only when a row is active).
    expect(full.split("bg-accent").length - 1).toBe(8);
    const openaiAt = panel({ activeId: "lb-option-openai" });
    expect(openaiAt.split("bg-accent").length - 1).toBe(9);
    // …and the standalone token sits on the ACTIVE row, not its neighbours.
    const openaiRow = openaiAt.slice(
      openaiAt.indexOf('id="lb-option-openai"'),
      openaiAt.indexOf("</div>", openaiAt.indexOf('id="lb-option-openai"')),
    );
    expect(openaiRow).toContain(" bg-accent");
    // Zero-match state: the honest empty <p> carries the listbox id, so the
    // open input's aria-controls never dangles.
    const empty = panel({ query: "zzz-no-match" });
    expect(empty).toContain('id="lb"');
    expect(empty).toContain("No providers match");
  });

  test("plan 54 picker copy is dictionary-backed; zh picker copy carries no bare Provider (AC1 sweep)", () => {
    expect(t("en", "settings.provider")).toBe("Model provider");
    expect(t("zh_CN", "settings.provider")).toBe("模型提供方");
    expect(t("en", "settings.providers")).toBe("Providers"); // en keeps the section title
    expect(t("zh_CN", "settings.providers")).toBe("模型提供方");
    expect(t("en", "settings.selectProvider")).toBe("Search model providers…");
    expect(t("zh_CN", "settings.selectProvider")).toBe("搜索模型提供方…");
    expect(t("en", "settings.noProviderMatch", { query: "zzz" })).toContain("zzz");
    expect(t("zh_CN", "settings.noProviderMatch", { query: "zzz" })).toContain("模型提供方");
    // Picker-adjacent zh strings stay 模型提供方-consistent: zero bare
    // "Provider" (the grep-verifiable AC1 closure, pinned per key;
    // en "Providers"/"Add provider" section/button titles are intentionally
    // unchanged).
    for (const key of [
      "settings.provider",
      "settings.providers",
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

describe("add-entry visibility + picker usability at breadth (plan 42 T2)", () => {
  test("the Add Provider entry is a labeled, bordered control in the Providers card header", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    // The entry lives in the card HEADER (CardAction slot) — visible without
    // scrolling; icon-only is not acceptable, the localized label rides the
    // button beside a plus glyph.
    const body = source.slice(
      source.indexOf("function ProvidersCard"),
      source.indexOf("function AddProviderSection"),
    );
    expect(body).toContain("<CardAction>");
    expect(body).toContain('variant="outline"');
    expect(body).toContain("aria-expanded={addOpen}");
    expect(body).toContain('{t(locale, "settings.addProvider")}');
    expect(body).toContain("<Plus");
    expect(body).toContain("onClick={() => setAddOpen(!addOpen)}");
    // The open panel is the card content's FIRST row — inside CardContent,
    // above the configured rows.
    const contentPos = body.indexOf("<CardContent");
    const panelPos = body.indexOf("<AddProviderSection");
    const rowsPos = body.indexOf("payload.configured_providers.length === 0");
    expect(contentPos).toBeGreaterThan(-1);
    expect(panelPos).toBeGreaterThan(contentPos);
    expect(rowsPos).toBeGreaterThan(panelPos);
    // The panel is driven by the header button; success still closes it via
    // the shared onOpenChange channel.
    expect(body).toContain("open={addOpen}");
    expect(body).toContain("onOpenChange={setAddOpen}");
  });

  test("the catalog picker is the plan-54 combobox: common group first, then catalog, height-capped to an internal scroll", () => {
    // Supersedes the plan-42 "builtin SelectGroup precedes template
    // SelectGroup + <SelectContent className=\"max-h-72\">" pin — the Radix
    // Select left the add panel (AD-542); the chain/seat editors keep theirs.
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    expect(source).toContain("<ProviderCombobox");
    expect(source).not.toContain('<SelectContent className="max-h-72">');
    // AD-547 separation: grouping reads display_group inside the combobox
    // only — the page (forms/config branching) never mentions it.
    expect(source).not.toContain("display_group");
    const combobox = readFileSync(join(import.meta.dir, "../../src/spa/components/provider-combobox.tsx"), "utf8");
    // 常用提供方 (catalogBuiltin) heads the panel before 目录模板.
    const commonPos = combobox.indexOf("settings.catalogBuiltin");
    const templatePos = combobox.indexOf("settings.catalogTemplate");
    expect(commonPos).toBeGreaterThan(-1);
    expect(templatePos).toBeGreaterThan(commonPos);
    // Breadth usability: the panel is height-capped (internal scroll).
    expect(combobox).toContain("max-h-72");
  });

  test("the template form carries an editable prefilled base URL and a {account_id}-conditional account-id field", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    // The override field is prefilled from the catalog entry and posts the
    // optional base_url override (empty string = use the catalog prefill).
    expect(source).toContain("useState(provider.base_url ?? \"\")");
    expect(source).toContain("base_url: baseUrl");
    // Required only when the entry's catalog base URL is null — a prefilled
    // entry may be saved as-is or overridden.
    expect(source).toContain("required={provider.base_url === null}");
    // The account-id demand tracks the EFFECTIVE base URL's {account_id}
    // placeholder (typed override ?? catalog prefill), mirroring the save flow.
    expect(source).toContain('effectiveBaseUrl.includes("{account_id}")');
    expect(source).toContain("needsAccountId ? (");
    // Success resets the typed base URL along with key/account id.
    expect(source).toContain('setBaseUrl("")');
  });

  test("plan 42 copy is dictionary-backed in both locales; account id is no longer Cloudflare-worded", () => {
    expect(t("en", "settings.accountId")).toBe("Account id");
    expect(t("zh_CN", "settings.accountId")).toBe("账户 id");
    expect(t("en", "settings.accountId")).not.toContain("Cloudflare");
    expect(t("zh_CN", "settings.accountId")).not.toContain("Cloudflare");
    // The provenance/count line interpolates the payload catalog length.
    expect(t("en", "settings.catalogProvenance", { count: 214 })).toContain("214 providers");
    expect(t("zh_CN", "settings.catalogProvenance", { count: 214 })).toContain("214 个提供方");
  });
});

describe("model chain tabs (plan 39 T1)", () => {
  test("Default and named chains are peer shadcn tabs with a coherent selected state", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    // The chain card is an accessible Radix tablist (roles + arrow-key nav via
    // the existing shadcn Tabs primitives), not a stacked list.
    expect(source).toContain("TabsList");
    expect(source).toContain("TabsTrigger");
    expect(source).toContain("TabsContent");
    // Tab ids come from the pure plan-39 tab model; the selection coerces to a
    // tab that exists so deletes/reloads land on Default.
    expect(source).toContain("modelChainTabs(payload.model_chains)");
    expect(source).toContain("activeChainTabId(tabs, selectedTab)");
    // The Default tab saves through op=save-chain; named tabs update in place
    // through op=add-chain — no rename op anywhere.
    expect(source).toContain('op: "save-chain"');
    expect(source).toContain('op: "add-chain", name: tab.id, chain: value');
    // Only the named tabs' content offers remove, via the existing
    // confirm-dialog flow (pendingConfirmCopy → op=remove-chain).
    expect(source).toContain("onRemoveChain(tab.id)");
    // Plan 44 T2: a successful create closes the draft and selects the real
    // (stored-name) tab after the reload lands — the draft flow's success
    // branch lives in the ChainsCard onCreated callback.
    expect(source).toContain("setSelectedTab(created);");
    // Chain mutation ops stay as-is.
    expect(source).toContain('op: "remove-chain"');
    expect(source).toContain("settings.confirmRemoveChainTitle");
  });

  test("the Default tab never offers remove; add/create copy is dictionary-backed in both locales", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    const defaultContent = source.slice(
      source.indexOf("<TabsContent forceMount value={DEFAULT_CHAIN_NAME}>"),
      source.indexOf("{namedTabs.map((tab) => ("),
    );
    expect(defaultContent).toContain("op: \"save-chain\"");
    expect(defaultContent).not.toContain("onRemoveChain");
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
    // With forceMount, Radix pins every panel to present and never applies
    // its own hidden attribute — the local TabsContent wrapper's
    // data-[state=inactive]:hidden class is what hides inactive editors
    // while keeping them mounted for edit-state preservation.
    const tabsSource = readFileSync(join(import.meta.dir, "../../src/spa/components/ui/tabs.tsx"), "utf8");
    const contentWrapper = tabsSource.slice(tabsSource.indexOf("function TabsContent"));
    expect(contentWrapper).toContain("data-[state=inactive]:hidden");
    // The ChainsCard panels mount through that exact wrapper (forceMount on
    // every TabsContent), so exactly one editor is visible per selected
    // trigger.
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    expect(source).toContain('import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";');
    const chainsBody = source.slice(source.indexOf("function ChainsCard"), source.indexOf("function SeatsCard"));
    expect(chainsBody).toContain("<TabsContent forceMount value={DEFAULT_CHAIN_NAME}>");
    expect(chainsBody).toContain('<TabsContent key={tab.id} forceMount value={tab.id}>');
  });
});

describe("chain draft peer tab (plan 44 T2)", () => {
  test("+ 新建链 opens a draft peer tab: after the named tabs, auto-selected, never two drafts", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    const chainsBody = source.slice(source.indexOf("function ChainsCard"), source.indexOf("function SeatsCard"));
    // The entry mirrors the plan-43 strip placement: outline button, plus
    // glyph, localized label (icon-only is not acceptable) — a TabsList
    // SIBLING in the strip row, never a trigger inside the role=tablist.
    expect(chainsBody).toContain('variant="outline"');
    expect(chainsBody).toContain("<Plus");
    expect(chainsBody).toContain('{t(locale, "settings.addChain")}');
    expect(chainsBody).toContain("onClick={openDraft}");
    // Single-draft rule: one boolean of draft state, and the click only ever
    // OPENS it (a second draft can never exist — clicking again re-selects
    // the existing draft tab).
    expect(chainsBody).toContain("const [draftOpen, setDraftOpen] = useState(false);");
    const openDraftBody = chainsBody.slice(chainsBody.indexOf("function openDraft"), chainsBody.indexOf("return ("));
    expect(openDraftBody).toContain("setDraftOpen(true);");
    expect(openDraftBody).toContain("setSelectedTab(DRAFT_CHAIN_TAB_ID);");
    // Non-reset equivalence (qc F2): open/re-focus never touches the lifted
    // draft name — the only resets are the explicit close-time ones (discard
    // + created), so re-clicking + 新建链 keeps whatever the user typed.
    expect(openDraftBody).not.toContain("setDraftName");
    // Appended AFTER the last named tab (never before Default): the draft
    // joins the coercion list by spreading after the stored tabs, and its
    // trigger renders after the stored-tabs map inside the TabsList. The
    // trigger's label is the live AD-551 mirror (plan 55), not the static
    // 新链 copy.
    expect(chainsBody).toContain("const tabs = draft ? [...storedTabs, draft] : storedTabs;");
    const storedMapPos = chainsBody.indexOf("{storedTabs.map((tab) => (");
    const draftTriggerPos = chainsBody.indexOf("{draftChainTabLabel(draftName, locale)}");
    expect(storedMapPos).toBeGreaterThan(-1);
    expect(draftTriggerPos).toBeGreaterThan(storedMapPos);
    // The old plan-43 disclosure between strip and Default panel is gone —
    // Default's area never shows creation UI.
    expect(chainsBody).not.toContain("createOpen");
    expect(chainsBody).not.toContain("NamedChainCreate");
    expect(chainsBody).not.toContain("settings.namedChains");
    expect(chainsBody).not.toContain("settings.noNamedChains");
  });

  test("the add-chain control is a TabsList sibling: its source sits after the tablist close", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    const chainsBody = source.slice(source.indexOf("function ChainsCard"), source.indexOf("function SeatsCard"));
    // Plan-43 strip-level contract, structurally pinned (plan 46 T6, audit
    // F-10): the labels/props pins above cannot see WHERE the control sits —
    // a regression nesting the add-chain button inside the role=tablist would
    // still carry its outline variant, plus glyph, label and click handler
    // (WAI-ARIA tablist children must be tabs, so a button inside breaks the
    // tab semantics). Source-ordering pin: the control's onClick anchor must
    // appear AFTER the `</TabsList>` close, so moving it inside the tablist
    // flips the order and fails here.
    const tabsListClosePos = chainsBody.indexOf("</TabsList>");
    const addChainControlPos = chainsBody.indexOf("onClick={openDraft}");
    expect(tabsListClosePos).toBeGreaterThan(-1);
    expect(addChainControlPos).toBeGreaterThan(tabsListClosePos);
  });

  test("the draft panel is the editor: name field first, model builder, save/discard, inline failure", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    const panelBody = source.slice(source.indexOf("function DraftChainPanel"), source.indexOf("function ChainEditor"));
    // The name field lives INSIDE the draft panel (first), reusing the
    // chainName keys — Default's panel never shows creation UI.
    expect(panelBody).toContain('t(locale, "settings.chainName")');
    expect(panelBody).toContain('t(locale, "settings.chainNamePlaceholder")');
    // The name input is capped at 64 (qc F4): the server's
    // MODEL_CHAIN_NAME_PATTERN admits stored ids of at most 64 chars, so the
    // input cannot type past it and the live tab-strip label stays bounded.
    expect(panelBody).toContain("maxLength={64}");
    const namePos = panelBody.indexOf("settings.chainName");
    const editorPos = panelBody.indexOf("<ChainEditor");
    expect(editorPos).toBeGreaterThan(namePos);
    // Save posts the frozen op=add-chain (entered name + built chain, one
    // call) with the shared 保存模型链 label semantics.
    expect(panelBody).toContain('op: "add-chain", name, chain: value');
    expect(panelBody).toContain('saveLabel={t(locale, "settings.saveChain")}');
    // Plan 44 T3 unification: a rejected create renders INLINE through
    // ChainEditor's own region (inside this panel) and keeps the draft +
    // typed input; success forwards the saved outcome to the card's region
    // (the panel unmounts) and hands the trimmed stored name back so the
    // real tab is selected.
    expect(panelBody).toContain('outcome.kind === "success"');
    expect(panelBody).toContain("onOutcome(outcome)");
    expect(panelBody).toContain("onCreated(name.trim())");
    // 放弃 discards without confirmation — plan 55 (AD-552) supersedes the
    // old hover-only ghost row: the button is injected through ChainEditor's
    // actions prop into the save row, styled to be visible without hover
    // (outline + sm + fixed small width). It stays bound to this panel's
    // busy closure — the same window as the save, so a discard can never
    // race a resolving create into selecting the created tab.
    const actionsPos = panelBody.indexOf("actions={");
    expect(actionsPos).toBeGreaterThan(-1);
    const actionsNode = panelBody.slice(actionsPos, panelBody.indexOf("/>", actionsPos));
    expect(actionsNode).toContain('variant="outline"');
    expect(actionsNode).toContain('size="sm"');
    expect(actionsNode).toContain('className="w-20"');
    expect(actionsNode).toContain("disabled={busy}");
    expect(actionsNode).toContain('t(locale, "settings.discardChain")}');
    // The draft panel mounts inside its own forceMount TabsContent; the
    // discard closes the draft — the selection then coerces through
    // activeChainTabId (plan-39 pin) back to Default — and, plan 55
    // (AD-551), resets the lifted draft name so a reopened draft starts
    // blank (the old unmount-clears-name semantics, now explicit).
    const chainsBody = source.slice(source.indexOf("function ChainsCard"), source.indexOf("function SeatsCard"));
    expect(chainsBody).toContain("<TabsContent forceMount value={DRAFT_CHAIN_TAB_ID}>");
    const discardPos = chainsBody.indexOf("onDiscard={() => {");
    expect(discardPos).toBeGreaterThan(-1);
    const discardHandler = chainsBody.slice(discardPos, chainsBody.indexOf("onCreated={(created) => {"));
    expect(discardHandler).toContain("setDraftOpen(false);");
    expect(discardHandler).toContain('setDraftName("");');
    expect(chainsBody).toContain("setSelectedTab(created);");
  });

  test("a failed post-create reload keeps the draft open: the create resolves the load-failed error, not success", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    // Bugbot fix (plan 44): POST success alone is not completion — the chain
    // is only usable once the awaited background reload lands it in the
    // payload. createDraftChain demotes a POST success whose reload failed to
    // the load-failed copy, so the panel's success branch (onOutcome +
    // onCreated → draft closed, tab selected) is unreachable in that case and
    // the typed content survives for a retry (op=add-chain is
    // create-or-update-in-place, so re-saving the same name converges).
    const wrapper = source.slice(
      source.indexOf("async function createDraftChain"),
      source.indexOf("async function submitVerify"),
    );
    expect(wrapper).toContain('outcome.kind === "success" && !outcome.reloaded');
    expect(wrapper).toContain('return { kind: "error", message: t(locale, "common.loadFailed") };');
    // The panel's onCreate is the reload-checked wrapper, not the raw shared
    // POST — and the reload signal itself comes from load()'s resolved flag,
    // carried through submitSettings' awaited background refresh.
    const chainsBody = source.slice(source.indexOf("function ChainsCard"), source.indexOf("function SeatsCard"));
    expect(chainsBody).toContain("onCreate={onCreateDraft}");
    expect(source).toContain("const reloaded = await onReload({ background: true });");
    expect(source).toContain("Promise<OpNotice & { reloaded: boolean }>");
  });

  test("draft copy is dictionary-backed in both locales; the retired disclosure label is gone", () => {
    expect(t("en", "settings.addChain")).toBe("Add chain");
    expect(t("zh_CN", "settings.addChain")).toBe("新建链");
    expect(t("en", "settings.draftChain")).toBe("New chain");
    expect(t("zh_CN", "settings.draftChain")).toBe("新链");
    expect(t("en", "settings.discardChain")).toBe("Discard");
    expect(t("zh_CN", "settings.discardChain")).toBe("放弃");
    // The name-field keys survive the move into the panel.
    expect(t("en", "settings.chainName")).toBe("Chain name");
    expect(t("zh_CN", "settings.chainName")).toBe("链名称");
  });
});

describe("draft tab label live-sync (plan 55 A2/A3 / AD-551)", () => {
  /**
   * The label faces are pure (the exported draftChainTabLabel mirror), so
   * they are pinned directly. The controlled panel is pinned behaviorally
   * through SSR of the exported DraftChainPanel: a typed name must reach the
   * markup — an internal useState("") would ignore the prop and render
   * value="" instead. The lifted state + wiring + the two close-time resets
   * are pinned over the source. createElement keeps this .ts file JSX-free.
   */
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
    // The typed value is locale-independent — the fallback copy is what
    // localizes.
    expect(draftChainTabLabel("my-chain", "zh_CN")).toBe("my-chain");
    // The raw input is the label (trim only gates the fallback) — no data
    // loss while typing.
    expect(draftChainTabLabel(" my-chain ", "en")).toBe(" my-chain ");
    expect(draftChainTabLabel("", "en")).toBe("New chain");
    expect(draftChainTabLabel("", "zh_CN")).toBe("新链");
    // Whitespace-only counts as empty (the create would trim to "" anyway).
    expect(draftChainTabLabel("   ", "zh_CN")).toBe("新链");
  });

  test("the draft panel is controlled by the lifted name (SSR: the typed value reaches the input)", () => {
    expect(panelHtml("my-chain")).toContain('value="my-chain"');
    expect(panelHtml("")).toContain('value=""');
  });

  test("the lifted state, wiring and both close-time resets live in ChainsCard (AD-551)", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    const chainsBody = source.slice(source.indexOf("function ChainsCard"), source.indexOf("function SeatsCard"));
    // The name state lives in the card (the panel no longer owns it).
    expect(chainsBody).toContain('const [draftName, setDraftName] = useState("");');
    // Controlled wiring: the panel edits the card's state, the trigger
    // renders the live mirror of the same state.
    expect(chainsBody).toContain("name={draftName}");
    expect(chainsBody).toContain("onNameChange={setDraftName}");
    const triggerPos = chainsBody.indexOf("<TabsTrigger value={DRAFT_CHAIN_TAB_ID}>");
    expect(triggerPos).toBeGreaterThan(-1);
    expect(chainsBody.slice(triggerPos, chainsBody.indexOf("</TabsTrigger>", triggerPos))).toContain(
      "{draftChainTabLabel(draftName, locale)}",
    );
    // Success path: the reset accompanies the close + the real (stored-name)
    // tab selection — the reopened draft starts blank, today's semantics.
    const createdHandler = chainsBody.slice(
      chainsBody.indexOf("onCreated={(created) => {"),
      chainsBody.indexOf("setSelectedTab(created);"),
    );
    expect(createdHandler).toContain('setDraftName("");');
    // The panel body itself keeps no name state (controlled, not lifted back).
    // Exact useState inventory (qc F3, closes ledger T2-S1): the busy gate is
    // the panel's ONLY state — an internal useState(name) shadow-init would
    // ignore the controlled prop and slip past a bare negative `useState("")`
    // pin, so the inventory itself is pinned instead.
    const panelBody = source.slice(source.indexOf("function DraftChainPanel"), source.indexOf("function ChainEditor"));
    expect(panelBody.match(/useState\([^)]*\)/g) ?? []).toEqual(["useState(false)"]);
    expect(panelBody).toContain("value={name}");
    expect(panelBody).toContain("onNameChange(event.target.value)");
  });
});

describe("discard inline with the save row (plan 55 A4/A5 / AD-552)", () => {
  /**
   * The discard is a pure render insertion through ChainEditor's optional
   * actions prop: the save-row wrapper exists only when actions are passed
   * (absent = byte-equivalent tree for the Default / named-chain editors,
   * whose pins elsewhere stay untouched), and the injected button keeps its
   * disabled={busy} bound to DraftChainPanel's own busy closure. Structure
   * is pinned over the source; the visible styling over SSR of the exported
   * DraftChainPanel. createElement keeps this .ts file JSX-free.
   */
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

  test("the save row renders save primary with actions right of it, only when actions exist", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    const editorBody = source.slice(source.indexOf("function ChainEditor"));
    // Conditional wrapper: with no actions the save button renders bare —
    // the AD-552 byte-equivalence guard for every other caller.
    expect(editorBody).toContain("{actions ? (");
    // Inside the row: save first (primary/leftmost), the actions node right
    // after it.
    const rowPos = editorBody.indexOf('<div className="flex items-center gap-2">');
    const savePos = editorBody.indexOf("{saveButton}");
    const actionsPos = editorBody.indexOf("{actions}");
    expect(rowPos).toBeGreaterThan(-1);
    expect(savePos).toBeGreaterThan(rowPos);
    expect(actionsPos).toBeGreaterThan(savePos);
    // DraftChainPanel is the injecting caller; the Default editor's call
    // stays bare (named-tab editors pass no actions either — the conditional
    // above already renders them byte-equivalent).
    const chainsBody = source.slice(source.indexOf("function ChainsCard"), source.indexOf("function SeatsCard"));
    const firstEditorPos = chainsBody.indexOf("<ChainEditor");
    const defaultCall = chainsBody.slice(firstEditorPos, chainsBody.indexOf("/>", firstEditorPos));
    expect(defaultCall).not.toContain("actions={");
    const panelBody = source.slice(source.indexOf("function DraftChainPanel"), source.indexOf("function ChainEditor"));
    expect(panelBody).toContain("actions={");
    // Whole-file count (qc F1): `actions={` occurs exactly once in the page —
    // the draft panel's discard injection. The Default AND named-chain
    // ChainEditor callers both stay bare (the conditional above renders them
    // byte-equivalent); a second actions-passing caller fails this count.
    expect(source.match(/actions=\{/g)?.length).toBe(1);
  });

  test("the discard is visibly styled without hover and sits in the save row (SSR)", () => {
    const html = panelHtml();
    // Outline + sm + the fixed width land on the real button; the label is
    // the untouched discardChain key. No confirmation dialog anywhere.
    expect(html).toContain('data-variant="outline"');
    expect(html).toContain('data-size="sm"');
    expect(html).toContain("w-20");
    expect(html).toContain(">Discard</button>");
    expect(html).not.toContain("dialog");
    // Same row: the flex container wraps both buttons — the save (primary,
    // default variant) opens the row, the outline discard follows it.
    const rowPos = html.indexOf("flex items-center gap-2");
    const savePos = html.indexOf('data-variant="default"');
    const discardPos = html.indexOf('data-variant="outline"');
    expect(rowPos).toBeGreaterThan(-1);
    expect(savePos).toBeGreaterThan(rowPos);
    expect(discardPos).toBeGreaterThan(savePos);
  });
});

describe("seat assignment section (plan 39 T2)", () => {
  test("seats are an independent titled card below chain management, not a section of the chains card", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    // SeatsCard is its own card component, rendered after ChainsCard for
    // managers only (same authorization surface as chain editing).
    expect(source).toContain("function SeatsCard");
    expect(source.indexOf("function ChainsCard")).toBeLessThan(source.indexOf("function SeatsCard"));
    expect(source.indexOf("<ChainsCard")).toBeLessThan(source.indexOf("<SeatsCard"));
    // The chains card no longer carries any seat control or seat save.
    const chainsBody = source.slice(source.indexOf("function ChainsCard"), source.indexOf("function SeatsCard"));
    expect(chainsBody).not.toContain("settings.seats");
    expect(chainsBody).not.toContain('op: "save-roles"');
    // The seats card is titled and described through the dictionary.
    const seatsBody = source.slice(source.indexOf("function SeatsCard"));
    expect(seatsBody).toContain('t(locale, "settings.seats")');
    expect(seatsBody).toContain('t(locale, "settings.seatsCopy")');
  });

  test("seat selects offer Default first, then current named tabs; values coerce before render and save", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    // Options derive from the same plan-39 tab model as the chain tabs.
    expect(source).toContain("modelChainTabs(payload.model_chains)");
    // Default is an explicit option (the reserved name, never a free-text
    // value), and every rendered value passes seatSelectValue so a stale or
    // deleted name renders as safe Default pending refresh.
    expect(source).toContain("<SelectItem value={DEFAULT_CHAIN_NAME}>");
    expect(source).toContain("value={seatSelectValue(tabs, seats[role])}");
    // Full-map save semantics unchanged: op=save-roles with one role_<role>
    // field per audit seat, each coerced so an invalid reference can never
    // be submitted (the route 400s on unknown chain names).
    expect(source).toContain('op: "save-roles"');
    expect(source).toContain("fields[`role_${role}`] = seatSelectValue(tabs, seats[role])");
    // The seat state re-derives from the payload ONLY when the offered
    // chain-tab set changes (review fix): the SeatsCard effect dep is the
    // tab-id-set key, not the raw payload identities — unrelated-op
    // background reloads keep unsaved seat picks.
    const seatsBody = source.slice(source.indexOf("function SeatsCard"));
    expect(seatsBody).toContain("const tabIdSetKey = tabs.map((tab) => tab.id).join();");
    expect(seatsBody).toContain("seatRoleValues(payload.model_role_ids, payload.model_roles, tabs)");
    expect(seatsBody).toContain("}, [tabIdSetKey]);");
    expect(seatsBody).not.toContain("[payload.model_role_ids, payload.model_roles, payload.model_chains]");
  });

  test("seat values resolve against the current tab model: Default, named, and the delete cascade", () => {
    const tabs = modelChainTabs([
      { name: "deep", chain: "ark/deep", is_default: false, created_at: "t", updated_at: "t" },
    ]);
    // Absent mapping, empty, and the reserved name all resolve to Default.
    expect(seatSelectValue(tabs, null)).toBe("default");
    expect(seatSelectValue(tabs, undefined)).toBe("default");
    expect(seatSelectValue(tabs, "")).toBe("default");
    expect(seatSelectValue(tabs, "default")).toBe("default");
    // A current named chain keeps its stored name.
    expect(seatSelectValue(tabs, "deep")).toBe("deep");
    // Deletion cascade: a stored name no tab offers falls back to Default —
    // after the delete the refreshed tab model no longer lists it, so the
    // form submits "default", never the invalid reference.
    expect(seatSelectValue(modelChainTabs([]), "deep")).toBe("default");
    // The role map derivation shared by the state seed and post-reload
    // re-derivation coerces every seat through the same rule.
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

describe("operational action hierarchy (plan 39 T3)", () => {
  test("Disable is destructive-outline with reversible wording; Delete stays filled destructive behind its confirmation", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    // The ops zone renders Disable through the destructive-outline family —
    // the red-outline variant is pinned to the disable action itself.
    expect(source).toContain(
      '<Button type="button" variant="destructive-outline" onClick={() => onPending({ kind: "disable" })}>',
    );
    // Delete remains the stronger filled destructive action, still routed
    // through the pendingConfirmCopy dialog with its destructive confirm
    // button.
    expect(source).toContain(
      '<Button type="button" variant="destructive" onClick={() => onPending({ kind: "delete" })}>',
    );
    expect(source).toContain('confirmCopy.destructive ? "destructive" : "default"');
    // Pause and Enable keep the non-destructive secondary family (resume keeps
    // the primary default) — nothing else in the ops zone went red.
    expect(source).toContain('<Button type="button" variant="secondary" onClick={() => onPending({ kind: "pause" })}>');
    expect(source).toContain('<Button type="button" variant="secondary" onClick={() => onPending({ kind: "enable" })}>');
    // Resume stays on the cva default variant — exact-pinned as a Button with
    // no variant attribute, so a regression to a destructive resume fails here.
    expect(source).toContain('<Button type="button" onClick={() => onPending({ kind: "resume" })}>');
    const opsBody = source.slice(source.indexOf("function OpsCard"), source.indexOf("function ProvidersCard"));
    expect(opsBody).toContain('variant="destructive-outline"');
    // The Disable confirm dialog's action button carries the plain verb; the
    // "(reversible)" parenthetical stays on the ops trigger copy only.
    expect(source).toContain('action: t(locale, "settings.confirmDisableAction")');
    // Busy/disabled guards and the post-op background state refresh are
    // unchanged on the dialog and op paths.
    expect(source).toContain("if (!pending || busy) return;");
    expect(source).toContain("disabled={busy}");
    expect(source).toContain("await onReload({ background: true })");
  });

  test("the destructive-outline variant is tokenized on the shadcn Button: red border, no raw hex fork", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/components/ui/button.tsx"), "utf8");
    expect(source).toContain('"destructive-outline":');
    // Border, label, and hover tint come from the destructive token (the
    // DESIGN.md red scale via the shadcn theme bridge); the shared cva base
    // supplies the 3px focus-visible ring — the variant only pins its color.
    const variantBlock = source.slice(source.indexOf('"destructive-outline":'), source.indexOf("secondary:"));
    expect(variantBlock).toContain("border-destructive");
    expect(variantBlock).toContain("text-destructive");
    // Dark-mode focus-ring parity with the filled destructive variant.
    expect(variantBlock).toContain("dark:focus-visible:ring-destructive/40");
    expect(variantBlock).not.toContain("#");
  });

  test("disable copy identifies reversibility in both locales; delete copy stays irreversible", () => {
    expect(t("en", "apps.actions.disable")).toContain("reversible");
    expect(t("zh_CN", "apps.actions.disable")).toContain("可恢复");
    // The reversibility wording belongs to the ops trigger only — the confirm
    // dialog's action button carries the plain verb in both locales.
    expect(t("en", "settings.confirmDisableAction")).toBe("Disable");
    expect(t("zh_CN", "settings.confirmDisableAction")).toBe("停用");
    expect(t("en", "settings.confirmDisableAction")).not.toContain("reversible");
    expect(t("zh_CN", "settings.confirmDisableAction")).not.toContain("可恢复");
    expect(t("en", "settings.confirmDisableBody")).toContain("until you enable it again");
    expect(t("zh_CN", "settings.confirmDisableBody")).toContain("再次启用");
    // Delete keeps the explicit irreversible confirmation copy.
    expect(t("en", "settings.confirmDeleteBody")).toContain("soft-delete");
    expect(t("zh_CN", "settings.confirmDeleteBody")).toContain("软删除");
    expect(t("en", "settings.confirmDeleteButton")).toBe("Delete App");
    expect(t("zh_CN", "settings.confirmDeleteButton")).toBe("删除应用");
  });
});

describe("App workflow boundaries (plan 40 T2)", () => {
  test("App settings reads as one workflow with the Apps list: a visible path back", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    // The back link targets the enumerated Apps route (the /dashboard surface).
    expect(source).toContain('href="/dashboard/apps"');
    expect(source).toContain('t(locale, "settings.backToApps")');
    expect(t("en", "settings.backToApps")).toBe("Back to Apps");
    expect(t("zh_CN", "settings.backToApps")).toBe("返回应用");
  });

  test("successful configuration saves surface success feedback; failures keep the structured error", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    // Success is no longer silent — and since plan 44 T3 it is section-scoped:
    // handlers resolve the saved outcome to the card that caused it.
    expect(source).toContain('successMessage ?? t(locale, "settings.changesSaved")');
    expect(t("en", "settings.changesSaved")).toBe("Changes saved.");
    expect(t("zh_CN", "settings.changesSaved")).toBe("更改已保存。");
    // Failure feedback is unchanged: structured API errors resolve in-section.
    expect(source).toContain("message: settingsErrorMessage(locale, body)");
  });

  test("configuration section headings are described and unlabeled selects are named", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    // Every section heading carries a description — install health included.
    expect(source).toContain('t(locale, "settings.installHealthCopy")');
    expect(t("en", "settings.installHealthCopy")).toContain("deliveries");
    expect(t("zh_CN", "settings.installHealthCopy")).toContain("投递");
    // Selects without a visible label get an accessible name (DESIGN.md L2
    // label audit) — the runtime-image selector and the chain model picker.
    expect(source).toContain('aria-label={t(locale, "settings.runtimeImage")}');
    expect(source).toContain('aria-label={t(locale, "settings.modelChainField")}');
  });

  test("empty states stay honest: unconfigured provider", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    expect(source).toContain("settings.noConfiguredProviders");
    expect(t("en", "settings.noConfiguredProviders")).toContain("No providers configured yet");
    expect(t("zh_CN", "settings.noConfiguredProviders")).toContain("尚未配置");
  });
});

describe("notice channel (plan 40 T3 reviewer handoffs)", () => {
  test("success and warn notices are announced via role=status; errors keep role=alert", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/PageNotice.tsx"), "utf8");
    // WCAG 4.1.3: the "Changes saved." success notice must not be silent to
    // assistive tech — non-error notices are polite live-region status, and
    // errors keep the assertive alert.
    expect(source).toContain('role={kind === "error" ? "alert" : "status"}');
  });

  test("a deleted App reports its own irreversible outcome, not the generic saved notice", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    // The delete branch pins the dedicated copy and skips the background
    // reload — the soft-deleted App's settings GET is a guaranteed 404, so
    // the generic path would overwrite the outcome with "Load failed."
    const deleteBranch = source.slice(
      source.indexOf('action.kind === "delete"'),
      source.indexOf("const confirmCopy"),
    );
    expect(deleteBranch).toContain('t(locale, "settings.deleteSuccess")');
    expect(deleteBranch).toContain("reload: false");
    // Source pin (qc2 F-001): the property-form `reload: false` call site is
    // the delete branch's alone — any other op copied onto it would silently
    // lose its background reload and fail this count. (Two prose mentions of
    // the flag — the runPinnedWithBody JSDoc and the branch comment — have
    // prose tails, so only a real `reload: false }`/`reload: false,` object
    // property matches.)
    expect(source.match(/reload: false\s*[},]/g)?.length).toBe(1);
    expect(t("en", "settings.deleteSuccess")).toContain("deleted");
    expect(t("zh_CN", "settings.deleteSuccess")).toContain("已删除");
    // Configuration saves keep the generic saved notice.
    expect(source).toContain('successMessage ?? t(locale, "settings.changesSaved")');
  });
});

describe("section-scoped op feedback (plan 44 T3)", () => {
  const settingsSource = () => readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");

  test("op outcomes resolve to the originating card; the top notice is page-level reload failure only", () => {
    const source = settingsSource();
    // Handlers RESOLVE the outcome (OpNotice) instead of pushing to the page
    // channel — nothing outside load() writes the top notice anymore.
    expect(source).not.toContain("onNotice");
    expect(source).toContain("type OpNotice =");
    expect(source).toContain("Promise<OpNotice>");
    // The only top-notice writes left are load()'s two background-failure
    // paths (parse failure + request failure) — the plan-38 page-level
    // channel for background reloads. Ops never land there.
    expect(source.match(/setNotice\(\{/g)?.length).toBe(2);
    // Bugbot fix (plan 44): a successful load() — foreground or background —
    // clears the page banner, so a recovered reload never leaves a stale
    // "load failed" up. New shape: failure writes 2 + success clear 1, and
    // the clear is pinned INSIDE load()'s success path (between the payload
    // commit and its success return), not anywhere in the file.
    expect(source.match(/setNotice\(null\)/g)?.length).toBe(1);
    const loadSuccessPath = source.slice(
      source.indexOf("setPayload(parsed);"),
      source.indexOf("return true;"),
    );
    expect(loadSuccessPath).toContain("setNotice(null);");
    // Carry-over (Task 2 review), refined by plan 45 T3 (audit F-09): a
    // network-level POST failure (postForm throws before an outcome exists)
    // resolves the dedicated save-failed copy so the op's card still reports
    // — no silent failure surface, and a failed save no longer claims the
    // page couldn't load. Exactly the three transport catches use it.
    expect(source).toContain('message: t(locale, "common.saveFailed")');
    expect(source.match(/t\(locale, "common\.saveFailed"\)/g)?.length).toBe(3);
    // Page-level reload failures keep the load-failed copy: load()'s two
    // background-failure paths and the draft create's reload-failure return.
    expect(source).toContain('message: t(locale, "common.loadFailed")');
    // The in-card copy is dictionary-backed in both locales.
    expect(t("en", "common.saveFailed")).toContain("save");
    expect(t("zh_CN", "common.saveFailed")).toContain("保存");
    expect(t("en", "common.loadFailed")).toContain("load");
    expect(t("zh_CN", "common.loadFailed")).toContain("无法加载");
  });

  test("each card owns an inline notice region: runtime image, providers, chains, seats, ops", () => {
    const source = settingsSource();
    // The shared local region component wraps PageNotice, so every region
    // inherits the banner's alert/status roles and notice tokens (WCAG
    // 4.1.3 — pinned on PageNotice.tsx itself in the plan-40 describe).
    expect(source).toContain("function NoticeRegion");
    expect(source).toContain("return <PageNotice kind={notice.kind} message={notice.message} />;");
    // Runtime image: region inside the editor, next to the save trigger.
    const runtimeBody = source.slice(
      source.indexOf("function RuntimeImageEditor"),
      source.indexOf("function OpsCard"),
    );
    expect(runtimeBody).toContain("<NoticeRegion notice={notice} />");
    // Ops zone: region directly under the pause/disable/delete button row.
    const opsBody = source.slice(source.indexOf("function OpsCard"), source.indexOf("function ProvidersCard"));
    expect(opsBody).toContain("<NoticeRegion notice={notice} />");
    // Providers: card region directly under the add panel serves the verify /
    // template forms only — plan 45 T6 moved the dialog-confirmed removes to
    // a row-local region (pinned in the F-08 test below).
    const providersBody = source.slice(
      source.indexOf("function ProvidersCard"),
      source.indexOf("function ConfiguredKeyRow"),
    );
    expect(providersBody).toContain("<NoticeRegion notice={notice} />");
    // Chains: card region below every tabpanel (dialog removes + draft
    // success) — the editors' own regions are pinned in the regression test.
    const chainsBody = source.slice(source.indexOf("function ChainsCard"), source.indexOf("function SeatsCard"));
    expect(chainsBody).toContain("<NoticeRegion notice={notice} />");
    // Seats: region inside the seat form, under its save button.
    const seatsBody = source.slice(source.indexOf("function SeatsCard"), source.indexOf("function DraftChainPanel"));
    expect(seatsBody).toContain("<NoticeRegion notice={notice} />");
  });

  test("the chains 400 renders inside the chains card (user-reported regression pin)", () => {
    const source = settingsSource();
    // ChainEditor is shared by the Default tab, every named tab and the draft
    // panel — each instance resolves its save outcome into its OWN region,
    // inside the tabpanel, inside the chains card. A rejected save-chain /
    // add-chain (e.g. the not_in_verified_models 400) can no longer surface
    // on the page top.
    const editorBody = source.slice(source.indexOf("function ChainEditor"));
    expect(editorBody).toContain("setNotice(await onSave(chain.join(\", \")))");
    expect(editorBody).toContain("<NoticeRegion notice={notice} />");
    // The region renders after the save trigger — the feedback sits where the
    // user is looking when the outcome lands.
    const buttonPos = editorBody.indexOf('saveLabel ?? t(locale, "settings.saveChain")');
    const regionPos = editorBody.indexOf("<NoticeRegion notice={notice} />");
    expect(buttonPos).toBeGreaterThan(-1);
    expect(regionPos).toBeGreaterThan(buttonPos);
    // Every chain panel mounts through ChainEditor (Default shown here; the
    // named-tab map and the draft panel reuse it in the same card).
    const chainsBody = source.slice(source.indexOf("function ChainsCard"), source.indexOf("function SeatsCard"));
    expect(chainsBody).toContain("<ChainEditor");
    expect(chainsBody).toContain('onSave={(chain) => onSettings({ op: "save-chain", model_chain: chain })}');
  });

  test("dialog-confirmed ops report into the card that owns the action", () => {
    const source = settingsSource();
    // remove-chain → chains card; remove-key / remove-custom → the providers
    // card's row-local outcome (plan 45 T6); pause/resume/disable/enable/
    // delete (delete with its own copy) → ops zone. Each card renders its own
    // notice state.
    const confirmBody = source.slice(source.indexOf("async function onConfirm"), source.indexOf("const confirmCopy"));
    expect(confirmBody).toContain('setChainsNotice(await submitSettings({ op: "remove-chain", name: action.name }))');
    expect(confirmBody).toContain("setProvidersRemoveOutcome({");
    expect(confirmBody).toContain("setOpsNotice(");
    expect(source).toContain("notice={opsNotice}");
    expect(source).toContain("notice={providersNotice}");
    expect(source).toContain("notice={chainsNotice}");
    // Plan 45 T6: the removes no longer write the card-level providers state —
    // that region keeps only the add-flow (verify / template) outcomes.
    expect(confirmBody).not.toContain("setProvidersNotice(");
    // The add-flow forms forward their outcome into the providers card's
    // region; the draft panel forwards its SUCCESS into the chains card's
    // region (its own panel unmounts on success).
    expect(source).toContain("onOutcome={setProvidersNotice}");
    expect(source).toContain("onOutcome={setChainsNotice}");
  });

  test("provider remove outcomes render row-locally at the removed row's position (plan 45 T6, audit UI-45-05)", () => {
    const source = settingsSource();
    // The outcome state carries the removed row's slot, captured in onConfirm
    // from the PRE-POST payload: the awaited background reload (plan 38)
    // drops the row from the payload before the outcome resolves, so the
    // position must be remembered — the row unmounts with the fresh payload
    // while the card (and the region it renders) stay mounted.
    const confirmBody = source.slice(source.indexOf("async function onConfirm"), source.indexOf("const confirmCopy"));
    expect(confirmBody).toContain("const configured = payload.can_manage ? payload.configured_providers : [];");
    expect(confirmBody).toContain("configured.findIndex(");
    expect(confirmBody).toContain("slot: slot >= 0 ? slot : configured.length");
    // The card renders the outcome inside the rows list at that position —
    // through the shared NoticeRegion, so the row-local region inherits the
    // plan-44 roles (alert/status) and notice tokens.
    const providersBody = source.slice(
      source.indexOf("function ProvidersCard"),
      source.indexOf("function ConfiguredKeyRow"),
    );
    expect(providersBody).toContain("removeOutcome: { notice: OpNotice; slot: number } | null");
    expect(providersBody).toContain(
      "{index === removeSlot && removeOutcome ? <NoticeRegion notice={removeOutcome.notice} /> : null}",
    );
    // Success takes the row's former slot; a failure leaves the row in place,
    // so the region renders directly below it (the field-error position).
    expect(providersBody).toContain(
      'removeOutcome.notice.kind === "error" ? removeOutcome.slot + 1 : removeOutcome.slot',
    );
    // A removed last row's slot equals the list length — the trailing clamp
    // keeps the outcome visible at the list's end instead of dropping it.
    expect(providersBody).toContain("removeSlot >= payload.configured_providers.length");
  });

  test("save triggers carry a busy guard; every op replaces its region (stale-error rule)", () => {
    const source = settingsSource();
    // One guard per form: the trigger disables while its own POST is in
    // flight (the confirm dialog's pre-existing disabled={busy} guard stays).
    const runtimeBody = source.slice(
      source.indexOf("function RuntimeImageEditor"),
      source.indexOf("function OpsCard"),
    );
    expect(runtimeBody).toContain("disabled={busy}");
    const providerFormBody = source.slice(
      source.indexOf("function ProviderConfigForm"),
      source.indexOf("function CustomExpand"),
    );
    expect(providerFormBody).toContain("disabled={busy}");
    const customBody = source.slice(
      source.indexOf("function CustomExpand"),
      source.indexOf("const DRAFT_CHAIN_TAB_ID"),
    );
    expect(customBody).toContain("disabled={busy}");
    const editorBody = source.slice(source.indexOf("function ChainEditor"));
    expect(editorBody).toContain("disabled={busy}");
    const seatsBody = source.slice(source.indexOf("function SeatsCard"), source.indexOf("function DraftChainPanel"));
    expect(seatsBody).toContain("disabled={busy}");
    // Stale-error rule (pinned): a region's content is replaced wholesale by
    // the next op targeting that same region — setters always receive the
    // fresh outcome, no manual clears, no cross-card resets.
    expect(source).toContain("setNotice(await onSettings({ op: \"save-sandbox-image\", sandbox_image_id: selected }))");
    expect(source).toContain("setNotice(await onSave(chain.join(\", \")))");
    expect(source).toContain("setNotice(await onSettings(fields))");
  });
});

describe("settings header typography (plan 45 T7)", () => {
  test("app-slug heading renders at the heading-20 scale step, not the off-scale 18px (audit UI-45-08)", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    // The slug is the selected-App panel title sitting under the page-level
    // h1. DESIGN.md's heading scale is 32/24/20/16 only, and heading-20 is
    // the panel-title tier — heading-16 would demote the slug below the
    // cards it titles. SUPERSEDE (plan 59 T1): the plan-45 T7 named-scale
    // carrier (text-xl) is replaced by the heading-20 token utilities — the
    // plan-58 QC heading-idiom convergence applied to this page; the scale
    // step itself is unchanged.
    expect(source).toContain(
      '<h2 className="font-semibold text-(length:--typo-heading-20-size) leading-(--typo-heading-20-line) tracking-(--typo-heading-20-tracking)">{app.slug}</h2>',
    );
    // The off-scale 18px class no longer appears anywhere on the page.
    expect(source).not.toContain("text-lg");
  });
});

describe("version footer (plan 51 T3)", () => {
  test("the settings page footer renders the generated version surface via the dictionary", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    // The display reads the generated single-writer surface (src/version.ts) —
    // never a second hardcoded version string in the SPA.
    expect(source).toContain('import { APP_VERSION } from "../../version";');
    // Rendered value is the v-prefixed form, same shape as the /healthz field
    // and release tags, interpolated through the bilingual footer key.
    expect(source).toContain('{t(locale, "settings.footer.version", { version: `v${APP_VERSION}` })}');
    // Footer slot reuses the page's muted small-print classes (existing token
    // utilities — no new DESIGN.md tokens, no CSS changes).
    expect(source).toContain('<p className="text-sm text-muted-foreground">');
  });

  test("the footer copy is dictionary-backed in both locales and carries the deployed version", () => {
    const shown = `v${APP_VERSION}`;
    expect(t("en", "settings.footer.version", { version: shown })).toBe(`Version ${shown}`);
    expect(t("zh_CN", "settings.footer.version", { version: shown })).toBe(`版本 ${shown}`);
    expect(t("en", "settings.footer.version", { version: shown })).toContain(shown);
    expect(t("zh_CN", "settings.footer.version", { version: shown })).toContain(shown);
  });
});

describe("custom-provider disclosure state (plan 49 T3)", () => {
  test("the CustomExpand toggle exposes aria-expanded wired to the disclosure state (audit F-15-03)", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    // Structural pin mirroring the AddProviderSection header-disclosure
    // precedent (plan 42): the toggle carries aria-expanded bound to the
    // component's open-state prop — same element, exact-string pinned, so a
    // regression dropping the attribute (or binding it anywhere other than
    // the disclosure toggle) fails here. Single-state disclosure semantics
    // unchanged; the open/closed state is only made perceivable (WCAG 4.1.2).
    const customBody = source.slice(
      source.indexOf("function CustomExpand"),
      source.indexOf("const DRAFT_CHAIN_TAB_ID"),
    );
    expect(customBody).toContain("onClick={onToggle} aria-expanded={expanded}");
    // The attribute stays live end to end: ProvidersCard owns the customOpen
    // disclosure state and hands it down as `expanded` / onToggle, so the
    // attribute flips with the disclosure (mirrors the addOpen wiring pin).
    const providersBody = source.slice(
      source.indexOf("function ProvidersCard"),
      source.indexOf("function ConfiguredKeyRow"),
    );
    expect(providersBody).toContain("expanded={customOpen}");
    expect(providersBody).toContain("onToggle={() => setCustomOpen(!customOpen)}");
  });
});

describe("GitHub App identity card (plan 53 A5/A6/A7)", () => {
  /**
   * The card is a pure presentational component (no hooks, no browser API),
   * so its degradation face — the load-bearing plan-53 contract — is pinned
   * behaviorally: static SSR markup of the exported card, no DOM runner.
   * createElement keeps this .ts file free of JSX.
   */
  const html = (app: SettingsAppMeta): string =>
    renderToStaticMarkup(createElement(AppInfoCard, { locale: "en", app }));

  function meta(overrides: Partial<SettingsAppMeta> = {}): SettingsAppMeta {
    return {
      slug: "acme",
      github_app_id: 123456,
      status: "active",
      review_enabled: true,
      created_by: "alice",
      last_webhook_at: null,
      sandbox_image_id: "omp",
      github_name: null,
      github_description: null,
      github_html_url: null,
      github_avatar_url: null,
      github_metadata_synced_at: null,
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

  test("synced profile renders avatar img, hyperlinked name (new tab, noopener), description, AppID", () => {
    const out = html(meta(synced));
    // (a) the avatar is the synced GitHub URL, rendered as a plain <img>
    // (an external image — no CSP is configured in this repo, so nothing
    // blocks the direct avatar origin; there is no image proxy either).
    expect(out).toContain('<img src="https://avatars.githubusercontent.com/in/1234?v=4"');
    // (b) the name is the link: href = github_html_url, NEW tab, noopener.
    expect(out).toContain('href="https://github.com/settings/apps/acme-reviewer"');
    expect(out).toContain('target="_blank"');
    expect(out).toContain('rel="noopener noreferrer"');
    expect(out).toContain("Acme Reviewer");
    expect(out).toContain('aria-label="View Acme Reviewer on GitHub"');
    // (c) the description renders when present.
    expect(out).toContain("Reviews pull requests for Acme.");
    // (d) the numeric App id renders in plaintext (B1 pin allows the id).
    expect(out).toContain("App ID: 123456");
    // The optional synced-at hint localizes through the dictionary.
    expect(out).toContain("Synced ");
  });

  test("never-synced App degrades to local fields: card renders, no link, no crash", () => {
    // (e) all metadata null — the card still renders (title + local App id),
    // the placeholder mark stands in for the avatar, and nothing pretends a
    // synced profile exists: no anchor, no img, no GitHub URL anywhere.
    const out = html(meta());
    expect(out).toContain("GitHub App");
    expect(out).toContain("App ID: 123456");
    expect(out).toContain('viewBox="0 0 24 24"'); // the octocat placeholder mark
    expect(out).not.toContain("<a ");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("http");
  });

  test("mixed-null metadata renders only the present fields, per-field degradation", () => {
    // (f) name + url synced, everything else null: the link renders, the
    // absent fields render nothing — no placeholder text, no layout collapse.
    const out = html(
      meta({
        github_name: synced.github_name,
        github_html_url: synced.github_html_url,
      }),
    );
    expect(out).toContain('href="https://github.com/settings/apps/acme-reviewer"');
    expect(out).toContain("Acme Reviewer");
    expect(out).not.toContain("<img");
    expect(out).not.toContain("Reviews pull requests");
    expect(out).not.toContain("Synced ");
    expect(out).toContain("App ID: 123456");
    // A synced name whose html_url is missing degrades to plain text — never
    // a link with an empty href.
    const urlless = html(meta({ github_name: synced.github_name }));
    expect(urlless).not.toContain("<a ");
    expect(urlless).toContain("Acme Reviewer");
    // The fourth matrix cell — a synced URL whose name is absent: the name
    // gate makes a stray <a> structurally impossible, so the URL renders
    // nowhere (no href, no text).
    const nameless = html(meta({ github_html_url: synced.github_html_url }));
    expect(nameless).not.toContain("<a ");
    expect(nameless).not.toContain(synced.github_html_url);
  });

  test("the card sits between the slug row and the manage conditional — both faces see it", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    // Plan 59 T1 supersede: the slug row anchor moved onto the heading-20
    // token utilities (same carrier change as the typography pin above).
    const slugRowPos = source.indexOf(
      '<h2 className="font-semibold text-(length:--typo-heading-20-size) leading-(--typo-heading-20-line) tracking-(--typo-heading-20-tracking)">{app.slug}</h2>',
    );
    const cardPos = source.indexOf("<AppInfoCard");
    const managePos = source.indexOf("{payload.can_manage ? (");
    expect(slugRowPos).toBeGreaterThan(-1);
    expect(cardPos).toBeGreaterThan(slugRowPos);
    expect(managePos).toBeGreaterThan(cardPos);
    // Per-field degradation is structural: every synced field is gated by its
    // own null check inside the card body, and the link pins the new-tab +
    // noopener contract.
    const cardBody = source.slice(
      source.indexOf("export function AppInfoCard"),
      source.indexOf("function HealthBody"),
    );
    expect(cardBody).toContain("app.github_avatar_url ? (");
    expect(cardBody).toContain("app.github_name ? (");
    expect(cardBody).toContain("app.github_html_url ? (");
    expect(cardBody).toContain("app.github_description ?");
    expect(cardBody).toContain("app.github_metadata_synced_at ? (");
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
    expect(t("en", "settings.appInfoViewOnGithub", { name: "Acme" })).toBe("View Acme on GitHub");
    expect(t("zh_CN", "settings.appInfoViewOnGithub", { name: "Acme" })).toBe("在 GitHub 上查看 Acme");
    expect(t("en", "settings.appInfoSynced", { time: "5 minutes ago" })).toBe("Synced 5 minutes ago");
    expect(t("zh_CN", "settings.appInfoSynced", { time: "5 分钟前" })).toBe("同步于 5 分钟前");
  });
});

describe("runtime image row tightness (plan 55 A1)", () => {
  test("select shell is content-adaptive; save button sits in the same flex-wrap row", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    // User-reported regression: the wrapper reserved min-w-64 (256px) while the
    // trigger only rendered short option content — a perceived gap between the
    // select and its save button. The shell must stay content-adaptive.
    const runtimeBody = source.slice(
      source.indexOf("function RuntimeImageEditor"),
      source.indexOf("function OpsCard"),
    );
    expect(runtimeBody).toContain('<div className="w-fit max-w-xs">');
    expect(runtimeBody).not.toContain("min-w-64");
    // Same-row adjacency: the save trigger follows the select inside the
    // flex-wrap row (narrow screens still wrap the button below cleanly).
    const row = runtimeBody.slice(
      runtimeBody.indexOf('className="flex flex-wrap items-center gap-2"'),
      runtimeBody.indexOf("<NoticeRegion"),
    );
    expect(row).toContain("SelectTrigger");
    expect(row).toContain("settings.saveRuntimeImage");
  });
});
