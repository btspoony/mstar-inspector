/**
 * Plan 31 T4+T6 + plan 35 T4: settings ops zone, unified providers, chains UI.
 * No DOM runner — same contract as plan 30 home tests.
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
    expect(source).toContain("settings.namedChains");
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
    // Accessible toggle → catalog select → selected provider's form.
    expect(source).toContain("settings.addProvider");
    expect(source).toContain("aria-expanded={open}");
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
    // data in place.
    expect(source).toContain("if (ok) {");
    expect(source).toContain("await onReload({ background: true })");
    expect(source).toContain("Promise<boolean>");
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
    expect(source).toContain("setOpen(false)");
    expect(source).toContain('setKey("")');
  });

  test("plan 38 add-flow copy is dictionary-backed in both locales", () => {
    expect(t("en", "settings.addProvider")).toBe("Add provider");
    expect(t("zh_CN", "settings.addProvider")).toBe("添加提供方");
    expect(t("en", "settings.providersCopy")).toContain("Add Provider");
    expect(t("zh_CN", "settings.providersCopy")).toContain("添加提供方");
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
    expect(t("en", "settings.catalogProvenance")).toContain("models.dev");
    expect(t("zh_CN", "settings.catalogProvenance")).toContain("models.dev");
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
    // A successful create selects the new tab after the reload lands.
    expect(source).toContain("onCreated={(created) => setSelectedTab(created)}");
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
    // The seat state re-derives from the payload after every reload.
    expect(source).toContain("seatRoleValues(payload.model_role_ids, payload.model_roles");
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
    // Success is no longer silent: the notice channel reports a saved change.
    expect(source).toContain('successMessage ?? t(locale, "settings.changesSaved")');
    expect(t("en", "settings.changesSaved")).toBe("Changes saved.");
    expect(t("zh_CN", "settings.changesSaved")).toBe("更改已保存。");
    // Failure feedback is unchanged: structured API errors through the notice.
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

  test("empty states stay honest: unconfigured provider and no named chains", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    expect(source).toContain("settings.noConfiguredProviders");
    expect(source).toContain("settings.noNamedChains");
    expect(t("en", "settings.noConfiguredProviders")).toContain("No providers configured yet");
    expect(t("zh_CN", "settings.noConfiguredProviders")).toContain("尚未配置");
    expect(t("en", "settings.noNamedChains")).toBe("No named chains yet.");
    expect(t("zh_CN", "settings.noNamedChains")).toBe("还没有命名链。");
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
    expect(t("en", "settings.deleteSuccess")).toContain("deleted");
    expect(t("zh_CN", "settings.deleteSuccess")).toContain("已删除");
    // Configuration saves keep the generic saved notice.
    expect(source).toContain('successMessage ?? t(locale, "settings.changesSaved")');
  });
});
