/**
 * Plan 31 T4+T6 + plan 35 T4: settings ops zone, unified providers, chains UI.
 * No DOM runner — same contract as plan 30 home tests.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { t } from "../../src/i18n";
import { composeModelOptions } from "../../src/dashboard/model-membership";
import { parseModels, splitModelChain } from "../../src/spa/pages/data";

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
