import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { isDictionaryKey, t } from "../../src/i18n";
import { settingsErrorMessage, settingsOpOutcome, verifyRefusalMessage } from "../../src/spa/pages/SettingsPage";

const settingsPage = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");

describe("settings operation status", () => {
  test.each([0, 199, 302, 400, 500])("status %i never reports success, including an empty opaque response", (status) => {
    expect(settingsOpOutcome("en", status, "")).toEqual({ kind: "error", message: t("en", "common.loadFailed") });
  });

  test.each([200, 201, 204, 299])("status %i reports a successful save", (status) => {
    expect(settingsOpOutcome("en", status, "")).toEqual({ kind: "success", message: t("en", "settings.changesSaved") });
  });

  test("2xx no-change stays a warning and 4xx retains its refusal message", () => {
    expect(settingsOpOutcome("en", 200, JSON.stringify({ changed: false })).kind).toBe("warn");
    expect(settingsOpOutcome("en", 403, JSON.stringify({ message: "Not allowed" })))
      .toEqual({ kind: "error", message: "Not allowed" });
  });
});

describe("isDictionaryKey", () => {
  test("known dictionary paths validate; unknown paths (newer server, stale client) do not", () => {
    expect(isDictionaryKey("settings.error.providerUnknown")).toBe(true);
    expect(isDictionaryKey("settings.membership.not_in_verified_models")).toBe(true);
    expect(isDictionaryKey("settings.error.not_a_real_key")).toBe(false);
    expect(isDictionaryKey("settings.error")).toBe(false);
    expect(isDictionaryKey("totally.unrelated")).toBe(false);
  });

  test("t() on an unknown key returns the key itself — the fail-visible premise the resolver guards", () => {
    expect(t("en", "settings.error.not_a_real_key" as never)).toBe("settings.error.not_a_real_key");
  });
});

describe("settings.error dictionary faces", () => {
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

  test("the Cloudflare slot and the CARRY-2 runtime-harness copy exist in both locales", () => {
    expect(t("en", "settings.error.accountIdRequired")).toContain("Cloudflare account id");
    expect(t("zh_CN", "settings.error.accountIdRequired")).toContain("Cloudflare 账户 id");
    const image = "omp";
    expect(t("en", "settings.error.providerUnavailableOnHarness", { provider: "ark", image })).toContain(
      "not available under this App's selected runtime harness (omp)",
    );
    expect(t("zh_CN", "settings.error.providerUnavailableOnHarness", { provider: "ark", image })).toContain(
      "运行时 harness（omp）上不可用",
    );
  });
});

describe("SPA 400-body resolution contract", () => {
  test("every op channel routes through the one shared outcome resolver (settings POST, pinned ops, workspace name)", () => {
    expect(settingsPage).not.toContain("message: body.trim()");
  });

  test("zh noConfiguredProviders copy drift (audit rejected-list note): zh references the Add Provider button like en", () => {
    expect(t("en", "settings.noConfiguredProviders")).toContain("use Add Provider");
    expect(t("zh_CN", "settings.noConfiguredProviders")).toContain("「添加模型提供方」");
    expect(t("zh_CN", "settings.noConfiguredProviders")).toContain("尚未配置");
  });
});
describe("malformed refusal params (both readers)", () => {
  const malformed: unknown[] = [{ provider: { id: "acme" } }, ["acme"]];

  test("settingsErrorMessage: an object/array param refuses the keyed face (site 1)", () => {
    for (const params of malformed) {
      const face = settingsErrorMessage(
        "en",
        JSON.stringify({ key: "settings.error.providerUnknown", params }),
      );
      expect(face).toBe(t("en", "common.loadFailed"));
      expect(face).not.toContain("[object Object]");
    }
  });

  test("verifyRefusalMessage: an object/array param renders the reason's copy (site 2)", () => {
    for (const params of malformed) {
      const face = verifyRefusalMessage(
        "en",
        400,
        JSON.stringify({
          reason: "unsupported_provider",
          key: "settings.error.providerUnknown",
          params,
        }),
      );
      expect(face).toBe(t("en", "settings.verify.unsupported_provider"));
      expect(face).not.toContain("[object Object]");
    }
  });

  test("a well-formed params map still interpolates at both sites", () => {
    const body = JSON.stringify({ key: "settings.error.providerUnknown", params: { provider: "acme" } });
    expect(settingsErrorMessage("en", body)).toBe(t("en", "settings.error.providerUnknown", { provider: "acme" }));
    expect(verifyRefusalMessage("en", 400, body)).toBe(t("en", "settings.error.providerUnknown", { provider: "acme" }));
  });
});

describe("add-key refusal: status first, body second", () => {
  const face = (status: number, body: string, locale: "en" | "zh_CN" = "en"): string =>
    verifyRefusalMessage(locale, status, body);
  const providers = (key: string): string => t("en", `settings.providers.${key}` as never);

  test("400 keeps the provider's own per-reason face (the body still decides inside the family)", () => {
    expect(face(400, JSON.stringify({ ok: false, reason: "invalid_key" }))).toBe(t("en", "settings.verify.invalid_key"));
    expect(face(400, JSON.stringify({ ok: false, reason: "quota_exhausted" }))).toBe(
      t("en", "settings.verify.quota_exhausted"),
    );
    expect(face(400, JSON.stringify({ key: "settings.error.providerKeyLimit", params: { provider: "acme", limit: 8 } }))).toBe(
      t("en", "settings.error.providerKeyLimit", { provider: "acme", limit: 8 }),
    );
  });

  test("400 with an unreadable body states the refusal instead of the provider's unexpected face", () => {
    for (const body of ["", "not json at all", "<html>nope</html>"]) {
      expect(face(400, body)).toBe(t("en", "settings.providers.addKeyRefused"));
    }
    expect(face(400, JSON.stringify({ reason: "brand_new_reason" }))).toBe(t("en", "settings.verify.unexpected"));
  });

  test("403 splits the shared bot (keyed) from the forbidden page", () => {
    expect(face(403, JSON.stringify({ key: "settings.error.botReadOnly" }))).toBe(
      t("en", "settings.error.botReadOnly"),
    );
    const page = face(403, "<!doctype html><title>Forbidden</title>");
    expect(page).toBe(t("en", "settings.providers.addKeyForbidden"));
    expect(page).not.toBe(t("en", "settings.error.botReadOnly"));
  });

  test("404, 409 and 429 each name their own cause and that nothing was stored", () => {
    const statuses: Array<[number, string]> = [
      [404, "settings.providers.addKeyUnknownApp"],
      [409, "settings.providers.addKeyConflict"],
      [429, "settings.providers.addKeyRateLimited"],
    ];
    const seen = new Set<string>();
    for (const [status, key] of statuses) {
      const message = face(status, "");
      expect(message).toBe(t("en", key as never));
      expect(message).toContain("Nothing was stored");
      seen.add(message);
    }
    expect(seen.size).toBe(statuses.length);
  });

  test("500 splits by body shape: plain text is the master key, JSON is the rejected write", () => {
    const noMasterKey = face(500, "the app settings need a configured DASHBOARD_ENCRYPTION_KEY");
    expect(noMasterKey).toBe(t("en", "settings.providers.addKeyNoMasterKey"));
    expect(noMasterKey).toContain("DASHBOARD_ENCRYPTION_KEY");
    const storage = face(500, JSON.stringify({ ok: false, reason: "unexpected" }));
    expect(storage).toBe(t("en", "settings.providers.addKeyStorageFailed"));
    expect(storage).not.toBe(noMasterKey);
  });

  test("a non-JSON body on an unclassified status is the unreadable face, never the generic sentence", () => {
    const unreadable = face(418, "<html>teapot</html>");
    expect(unreadable).toBe(t("en", "settings.providers.addKeyUnreadable"));
    expect(unreadable).toContain("Worker log");
    expect(unreadable).not.toBe(t("en", "settings.verify.unexpected"));
    expect(face(418, JSON.stringify({ ok: false, reason: "unexpected" }))).toBe(
      t("en", "settings.verify.unexpected"),
    );
  });

  test("no face echoes the submitted key, the body or the status code", () => {
    const secret = "sk-live-should-never-surface";
    const bodies = [
      "",
      JSON.stringify({ ok: false, reason: "invalid_key", key: secret, message: secret }),
      "<html>Forbidden</html>",
      JSON.stringify({ ok: false, reason: "unexpected", detail: secret }),
    ];
    for (const status of [400, 403, 404, 409, 429, 500, 418]) {
      for (const body of bodies) {
        for (const locale of ["en", "zh_CN"] as const) {
          const message = face(status, body, locale);
          expect(message).not.toContain(secret);
          expect(message).not.toContain("<html>");
          expect(message).not.toContain(` ${status} `);
        }
      }
    }
  });

  test("every new face exists in both locales and says what happened to the data", () => {
    const keys = [
      "addKeyRefused",
      "addKeyForbidden",
      "addKeyUnknownApp",
      "addKeyConflict",
      "addKeyRateLimited",
      "addKeyNoMasterKey",
      "addKeyStorageFailed",
      "addKeyUnreadable",
    ] as const;
    for (const key of keys) {
      expect(t("en", `settings.providers.${key}` as never).length).toBeGreaterThan(0);
      expect(t("zh_CN", `settings.providers.${key}` as never)).not.toBe(`settings.providers.${key}`);
      expect(providers(key)).not.toContain("unexpected response");
    }
    for (const key of keys.filter((candidate) => candidate !== "addKeyNoMasterKey")) {
      expect(t("en", `settings.providers.${key}` as never)).toMatch(
        /before anything was stored|nothing was stored|Nothing was stored|Nothing was saved/,
      );
    }
  });
});
