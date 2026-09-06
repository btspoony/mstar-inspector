/**
 * Plan 45 T4: the SPA resolves server-emitted 400 message keys in the
 * operator's locale with a fail-visible fallback. Pins the shared key
 * validator, both-locale dictionary faces for the `settings.error.*`
 * family, and the source contract on both SettingsPage render paths
 * (settingsErrorMessage key-first branch; runPinnedWithBody routed through
 * the same resolver; the verify path preferring the mapped key).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDictionaryKey, t } from "../../src/i18n";

const settingsPage = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");

describe("isDictionaryKey (plan 45 T4)", () => {
  test("known dictionary paths validate; unknown paths (newer server, stale client) do not", () => {
    expect(isDictionaryKey("settings.error.providerUnknown")).toBe(true);
    expect(isDictionaryKey("settings.membership.not_in_verified_models")).toBe(true);
    expect(isDictionaryKey("settings.error.not_a_real_key")).toBe(false);
    expect(isDictionaryKey("settings.error")).toBe(false); // non-leaf node
    expect(isDictionaryKey("totally.unrelated")).toBe(false);
  });

  test("t() on an unknown key returns the key itself — the fail-visible premise the resolver guards", () => {
    expect(t("en", "settings.error.not_a_real_key" as never)).toBe("settings.error.not_a_real_key");
  });
});

describe("settings.error dictionary faces (plan 45 T4)", () => {
  test("interpolated faces resolve with params in both locales", () => {
    expect(t("en", "settings.error.providerUnknown", { provider: "acme" })).toBe(
      "acme is not a supported provider — pick one from the list.",
    );
    expect(t("zh_CN", "settings.error.providerUnknown", { provider: "acme" })).toBe(
      "acme 不是受支持的 provider — 请从列表中选择。",
    );
    expect(t("en", "settings.error.apiKeyTooLong", { count: 5000, limit: 4096 })).toContain("5000");
    expect(t("zh_CN", "settings.error.apiKeyTooLong", { count: 5000, limit: 4096 })).toContain("5000");
    expect(t("en", "settings.error.roleFieldsMissing", { roles: "a, b" })).toContain("role fields are missing");
    expect(t("zh_CN", "settings.error.roleFieldsMissing", { roles: "a, b" })).toContain("席位字段缺失");
  });

  test("the plan-42 Cloudflare slot and the CARRY-2 runtime-image copy exist in both locales", () => {
    expect(t("en", "settings.error.accountIdRequired")).toContain("Cloudflare account id");
    expect(t("zh_CN", "settings.error.accountIdRequired")).toContain("Cloudflare 账户 id");
    const image = "omp";
    expect(t("en", "settings.error.providerUnavailableOnImage", { provider: "ark", image })).toContain(
      "not available under this App's selected runtime image (omp)",
    );
    expect(t("zh_CN", "settings.error.providerUnavailableOnImage", { provider: "ark", image })).toContain(
      "运行时镜像（omp）上不可用",
    );
  });
});

describe("SPA 400-body resolution contract (plan 45 T4)", () => {
  test("settingsErrorMessage resolves a known key first; unknown keys fall through to the English face", () => {
    // The key-first branch (the audit's UI-45-03 fix).
    expect(settingsPage).toContain("isDictionaryKey(parsed.key)");
    // English face fallback for an unknown key, then the raw never-blank floor.
    expect(settingsPage).toContain("parsed.message.trim()");
    expect(settingsPage).toContain('body.trim() || t(locale, "common.loadFailed")');
  });

  test("both 400 render paths route through the same resolver (settings POST + pinned ops)", () => {
    // submitSettings AND runPinnedWithBody — the second was the raw
    // body.trim() path the audit called out.
    expect(settingsPage.match(/settingsErrorMessage\(locale, body\)/g)?.length).toBe(2);
    expect(settingsPage).not.toContain("message: body.trim()");
  });

  test("the verify path prefers the mapped key when present; reason-only 400s keep verifyReasonMessage", () => {
    expect(settingsPage).toContain(
      "keyed !== undefined ? t(locale, keyed, keyedParams) : verifyReasonMessage(locale, reason)",
    );
  });

  test("zh noConfiguredProviders copy drift (audit rejected-list note): zh references the Add Provider button like en", () => {
    expect(t("en", "settings.noConfiguredProviders")).toContain("use Add Provider");
    expect(t("zh_CN", "settings.noConfiguredProviders")).toContain("「添加 Provider」");
    expect(t("zh_CN", "settings.noConfiguredProviders")).toContain("尚未配置");
  });
});
