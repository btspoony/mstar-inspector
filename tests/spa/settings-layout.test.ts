/**
 * Plan 31 T4+T6: settings dropdowns, two-column layout, dictionary copy.
 * No DOM runner — same contract as plan 30 home tests.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { t } from "../../src/i18n";
import { composeModelOptions } from "../../src/dashboard/model-membership";
import { parseModels, splitModelChain } from "../../src/spa/pages/data";

describe("settings layout (plan 31 T6)", () => {
  test("SettingsPage is a two-column layout with health/deliveries in the sidebar", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    expect(source).toContain("settingsLayout");
    expect(source).toContain("settingsMain");
    expect(source).toContain("settingsSidebar");
    expect(source).toContain('aria-label={t(locale, "settings.installHealth")}');
    expect(source).toContain("/pause");
    expect(source).toContain("/resume");
    expect(source).toContain("settings.recentDeliveries");
    expect(source).toContain("apps.status.active");
    expect(source).toContain("apps.health.rejected24h");
  });

  test("desktop ≥900px is 2fr + 1fr; mobile stacks (DESIGN.md lg)", () => {
    const css = readFileSync(join(import.meta.dir, "../../src/spa/pages.module.css"), "utf8");
    expect(css).toContain(".settingsLayout");
    expect(css).toContain("flex-direction: column");
    expect(css).toContain("@media (min-width: 900px)");
    expect(css).toContain("grid-template-columns: 2fr 1fr");
    expect(css).not.toMatch(/\.home\s*\{/);
  });
});

describe("settings dropdowns (plan 31 T4)", () => {
  test("chain and role editors are dropdowns, not free-text; add-key posts the JSON verify route", () => {
    const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");
    expect(source).toContain("/keys/verify");
    expect(source).toContain("settings.addToChain");
    expect(source).toContain("settings.useAppChain");
    expect(source).toContain("settings.pickModel");
    expect(source).toContain("<optgroup");
    expect(source).not.toContain('type="text" name="model_chain"');
    expect(source).not.toContain("<input type=\"text\" name={`role_${role}`}");
    expect(source).toContain("<select name={`role_${role}`}");
    expect(source).toContain("/keys/verify");
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

describe("settings copy is dictionary-backed (plan 31 T4+T6)", () => {
  test("new keys exist in both locales", () => {
    expect(t("en", "settings.verify.invalid_key")).toContain("rejected");
    expect(t("zh_CN", "settings.verify.invalid_key")).toContain("拒绝");
    expect(t("en", "settings.verify.unreachable")).toContain("reached");
    expect(t("zh_CN", "settings.verify.unreachable")).toContain("连接");
    expect(t("en", "settings.verify.unexpected")).toContain("unexpected");
    expect(t("zh_CN", "settings.verify.unexpected")).toContain("意外");
    expect(t("en", "settings.useAppChain")).toBe("Use App model chain");
    expect(t("zh_CN", "settings.useAppChain")).toBe("使用 App 模型链");
    expect(t("en", "settings.noAutoDiscovery")).toContain("does not list models");
    expect(t("zh_CN", "settings.noVerifiedModels")).toContain("验证");
  });
});
