/**
 * Plan 31 T4+T6 + plan 35 T4: settings ops zone, unified providers, chains UI.
 * No DOM runner — source-scan pins over SettingsPage.tsx and its primitives
 * plus pure data helpers (the plan 30 home suite that shared this style is
 * retired).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { t } from "../../src/i18n";
import { composeModelOptions } from "../../src/dashboard/model-membership";
import { parseModels, modelChainTabs, seatRoleValues, seatSelectValue, splitModelChain } from "../../src/spa/pages/data";

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
    // Plan 42: the zh label keeps the English word "Provider" — the settled
    // label the header button and every referencing copy line share.
    expect(t("zh_CN", "settings.addProvider")).toBe("添加 Provider");
    expect(t("en", "settings.providersCopy")).toContain("Add Provider");
    expect(t("zh_CN", "settings.providersCopy")).toContain("添加 Provider");
    expect(t("en", "settings.noConfiguredProviders")).toContain("No providers configured yet");
    expect(t("zh_CN", "settings.noConfiguredProviders")).toContain("尚未配置");
    expect(t("en", "settings.catalogBuiltin")).toContain("Built-in");
    expect(t("zh_CN", "settings.catalogBuiltin")).toContain("内置");
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
    // Unavailable rows keep their picker entry (marked), never hidden silently.
    expect(source).toContain("settings.eligibilityUnavailableShort");
  });

  test("an unavailable entry gets an explanation instead of a form — nothing can save it silently", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    // The gate sits above ProviderConfigForm: unavailable → copy only, no submit path.
    expect(source).toContain('selected.eligibility === "unavailable"');
  });

  test("the catalog picker uses the aria-labelledby precedent; custom configured rows show the catalog label", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    // MembersPage precedent: visible label span + aria-labelledby on the
    // trigger — no wrapping <label> around the Radix Select.
    expect(source).toContain('id="settings-catalog-provider-label"');
    expect(source).toContain('aria-labelledby="settings-catalog-provider-label"');
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

  test("the catalog picker groups builtin first, then template, height-capped to an internal scroll", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    // Grouping: the builtin SelectGroup precedes the template one.
    const builtinPos = source.indexOf("settings.catalogBuiltin");
    const templatePos = source.indexOf("settings.catalogTemplate");
    expect(builtinPos).toBeGreaterThan(-1);
    expect(templatePos).toBeGreaterThan(builtinPos);
    // Breadth usability: the list is height-capped (internal scroll) on the
    // existing Select primitive — no new component.
    expect(source).toContain('<SelectContent className="max-h-72">');
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
    // Appended AFTER the last named tab (never before Default): the draft
    // joins the coercion list by spreading after the stored tabs, and its
    // trigger renders after the stored-tabs map inside the TabsList.
    expect(chainsBody).toContain("const tabs = draft ? [...storedTabs, draft] : storedTabs;");
    const storedMapPos = chainsBody.indexOf("{storedTabs.map((tab) => (");
    const draftTriggerPos = chainsBody.indexOf('{t(locale, "settings.draftChain")}');
    expect(storedMapPos).toBeGreaterThan(-1);
    expect(draftTriggerPos).toBeGreaterThan(storedMapPos);
    // The old plan-43 disclosure between strip and Default panel is gone —
    // Default's area never shows creation UI.
    expect(chainsBody).not.toContain("createOpen");
    expect(chainsBody).not.toContain("NamedChainCreate");
    expect(chainsBody).not.toContain("settings.namedChains");
    expect(chainsBody).not.toContain("settings.noNamedChains");
  });

  test("the draft panel is the editor: name field first, model builder, save/discard, inline failure", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    const panelBody = source.slice(source.indexOf("function DraftChainPanel"), source.indexOf("function ChainEditor"));
    // The name field lives INSIDE the draft panel (first), reusing the
    // chainName keys — Default's panel never shows creation UI.
    expect(panelBody).toContain('t(locale, "settings.chainName")');
    expect(panelBody).toContain('t(locale, "settings.chainNamePlaceholder")');
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
    // 放弃 discards through a ghost button without confirmation — gated by
    // the same busy window as the save, so a discard can never race a
    // resolving create into selecting the created tab.
    expect(panelBody).toContain('t(locale, "settings.discardChain")}');
    expect(panelBody).toContain('variant="ghost"');
    expect(panelBody).toContain("disabled={busy}");
    // The draft panel mounts inside its own forceMount TabsContent; the
    // discard's only state effect is closing the draft — the selection then
    // coerces through activeChainTabId (plan-39 pin) back to Default.
    const chainsBody = source.slice(source.indexOf("function ChainsCard"), source.indexOf("function SeatsCard"));
    expect(chainsBody).toContain("<TabsContent forceMount value={DRAFT_CHAIN_TAB_ID}>");
    expect(chainsBody).toContain("onDiscard={() => setDraftOpen(false)}");
    expect(chainsBody).toContain("setDraftOpen(false);");
    expect(chainsBody).toContain("setSelectedTab(created);");
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
    // Carry-over (Task 2 review): a network-level POST failure (postForm
    // throws before an outcome exists) resolves the load-failed copy so the
    // op's card still reports — no silent failure surface.
    expect(source).toContain('return { kind: "error", message: t(locale, "common.loadFailed") };');
    // The in-card copy is dictionary-backed in both locales.
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
    // Providers: region directly under the add panel (serves the verify /
    // template forms and the dialog-confirmed removes), above the rows.
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
    // remove-chain → chains card; remove-key / remove-custom → providers
    // card; pause/resume/disable/enable/delete (delete with its own copy) →
    // ops zone. Each card renders its own notice state.
    const confirmBody = source.slice(source.indexOf("async function onConfirm"), source.indexOf("const confirmCopy"));
    expect(confirmBody).toContain('setChainsNotice(await submitSettings({ op: "remove-chain", name: action.name }))');
    expect(confirmBody).toContain("setProvidersNotice(");
    expect(confirmBody).toContain("setOpsNotice(");
    expect(source).toContain("notice={opsNotice}");
    expect(source).toContain("notice={providersNotice}");
    expect(source).toContain("notice={chainsNotice}");
    // The add-flow forms forward their outcome into the providers card's
    // region; the draft panel forwards its SUCCESS into the chains card's
    // region (its own panel unmounts on success).
    expect(source).toContain("onOutcome={setProvidersNotice}");
    expect(source).toContain("onOutcome={setChainsNotice}");
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
