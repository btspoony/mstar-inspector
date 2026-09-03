/**
 * Plan 29 T4: pure page-data parsers and client guards (no DOM runner).
 */
import { describe, expect, test } from "bun:test";
import { t } from "../../src/i18n";
import {
  canManageApp,
  canViewMembers,
  insightsSummaryUrl,
  inviteLoginNoticeKey,
  isPaused,
  parseApps,
  parseInsights,
  parseInsightsSearch,
  parseMembers,
  parseSettings,
} from "../../src/spa/pages/data";

describe("admin guard (plan 29 T4)", () => {
  test("only admin can view members", () => {
    expect(canViewMembers("admin")).toBe(true);
    expect(canViewMembers("member")).toBe(false);
    expect(canViewMembers(null)).toBe(false);
  });

  test("manage = admin or creator (case-insensitive)", () => {
    expect(canManageApp({ login: "mallory", role: "member" }, { created_by: "Mallory" })).toBe(true);
    expect(canManageApp({ login: "hubot", role: "member" }, { created_by: "mallory" })).toBe(false);
    expect(canManageApp({ login: "hubot", role: "admin" }, { created_by: "mallory" })).toBe(true);
  });

  test("paused is active + review_enabled 0", () => {
    expect(isPaused({ status: "active", review_enabled: 0 })).toBe(true);
    expect(isPaused({ status: "active", review_enabled: 1 })).toBe(false);
    expect(isPaused({ status: "disabled", review_enabled: 0 })).toBe(false);
  });
});

describe("insights search wiring", () => {
  test("defaults window 30 and empty repo", () => {
    expect(parseInsightsSearch("")).toEqual({ window: "30", repo: "" });
    expect(parseInsightsSearch("?window=7&repo=acme/web")).toEqual({ window: "7", repo: "acme/web" });
  });

  test("summary URL omits the default 30-day window", () => {
    expect(insightsSummaryUrl({ window: "30", repo: "" })).toBe("/dashboard/api/insights/summary");
    expect(insightsSummaryUrl({ window: "7", repo: "acme/web" })).toBe(
      "/dashboard/api/insights/summary?window=7&repo=acme%2Fweb",
    );
  });

  test("parseInsights accepts the JSON API shape and rejects junk", () => {
    const body = {
      window_days: 30,
      reviews_total: 0,
      findings_by_severity: [],
      findings_by_category: [],
      verdict_distribution: [],
      weekly_trend: [],
      recurring_top: [],
    };
    expect(parseInsights(body)?.reviews_total).toBe(0);
    expect(parseInsights({ reviews_total: 0 })).toBeNull();
  });
});

describe("members/apps/settings parsers", () => {
  test("parseMembers requires id/login/role/created_at", () => {
    expect(
      parseMembers({
        members: [{ id: "u1", github_login: "octocat", role: "admin", created_at: "2026-01-01 00:00:00" }],
      }),
    ).toEqual([{ id: "u1", github_login: "octocat", role: "admin", created_at: "2026-01-01 00:00:00" }]);
    expect(parseMembers({ members: [{ github_login: "octocat" }] })).toBeNull();
  });

  test("parseApps requires viewer + apps", () => {
    const ok = parseApps({ viewer: { login: "mallory", role: "member" }, apps: [] });
    expect(ok?.viewer.login).toBe("mallory");
    expect(parseApps({ apps: [] })).toBeNull();
  });

  test("parseSettings requires can_manage, created_by, providers, and chains", () => {
    const ok = parseSettings({
      can_manage: true,
      app: {
        slug: "demo",
        github_app_id: 1,
        status: "active",
        review_enabled: true,
        created_by: "mallory",
        last_webhook_at: null,
      },
      keys: [],
      model_chain: null,
      model_roles: {},
      model_chains: [],
      custom_providers: [],
      installations: [],
      deliveries: [],
      providers: [],
      model_role_ids: ["mstar-review-seat"],
      custom_provider_api_ids: ["openai-completions"],
    });
    expect(ok?.app.slug).toBe("demo");
    expect(ok?.can_manage).toBe(true);
    expect(
      parseSettings({
        app: { slug: "demo", status: "active", review_enabled: 1, last_webhook_at: null },
        keys: [],
        providers: [],
        model_role_ids: [],
        custom_provider_api_ids: [],
      }),
    ).toBeNull();
  });
});

describe("invite grammar + page copy (plan 29 T4)", () => {
  test("invite login grammar matches the legacy route", () => {
    expect(inviteLoginNoticeKey("")).toBe("notice.error.enterLogin");
    expect(inviteLoginNoticeKey("   ")).toBe("notice.error.enterLogin");
    expect(inviteLoginNoticeKey("not a login")).toBe("notice.error.invalidLogin");
    expect(inviteLoginNoticeKey("octocat")).toBeNull();
  });

  test("resident pages interpolate bilingual keys in both dictionaries", () => {
    const keys = [
      "members.adminOnly",
      "members.roleAdmin",
      "insights.filterWindow",
      "insights.uncategorized",
      "apps.status.paused",
      "login.signIn",
      "settings.roleHintDeep",
      "common.loading",
      "notice.success.invited",
    ] as const;
    for (const key of keys) {
      const en = t("en", key);
      const zh = t("zh_CN", key);
      expect(en.length).toBeGreaterThan(0);
      expect(zh.length).toBeGreaterThan(0);
      expect(zh).not.toBe(en);
    }
  });
});
