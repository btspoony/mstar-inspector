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
