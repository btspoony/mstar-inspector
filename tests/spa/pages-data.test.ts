/**
 * Plan 29 T4: pure page-data parsers and client guards (no DOM runner).
 */
import { describe, expect, test } from "bun:test";
import { t } from "../../src/i18n";
import {
  canManageApp,
  canViewMembers,
  insightsRepoFromSelect,
  insightsRepoOptions,
  insightsRepoSelectValue,
  INSIGHTS_REPO_ALL,
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

  test("summary URL requests the repos aggregation only when opted in (plan 36 QC F-001)", () => {
    // Home surface: no include param.
    expect(insightsSummaryUrl({ window: "7", repo: "" })).toBe("/dashboard/api/insights/summary?window=7");
    // Records surface: include=repos appended.
    expect(insightsSummaryUrl({ window: "7", repo: "acme/web" }, true)).toBe(
      "/dashboard/api/insights/summary?window=7&repo=acme%2Fweb&include=repos",
    );
    expect(insightsSummaryUrl({ window: "30", repo: "" }, true)).toBe(
      "/dashboard/api/insights/summary?include=repos",
    );
  });

  test("repo Select maps 全部 ↔ empty filter and keeps out-of-set current values", () => {
    expect(INSIGHTS_REPO_ALL).toBe("all");
    expect(insightsRepoSelectValue("")).toBe("all");
    expect(insightsRepoSelectValue("acme/web")).toBe("acme/web");
    expect(insightsRepoFromSelect("all")).toBe("");
    expect(insightsRepoFromSelect("acme/web")).toBe("acme/web");
    expect(insightsRepoOptions([], "")).toEqual([]);
    expect(insightsRepoOptions(["zeta/app", "acme/web"], "")).toEqual(["acme/web", "zeta/app"]);
    expect(insightsRepoOptions(["acme/web"], "other/lib")).toEqual(["acme/web", "other/lib"]);
    expect(insightsRepoOptions(["acme/web", "acme/web"], "acme/web")).toEqual(["acme/web"]);
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
      repos: [],
    };
    expect(parseInsights(body)?.reviews_total).toBe(0);
    expect(parseInsights({ ...body, repos: ["acme/web"] })?.repos).toEqual(["acme/web"]);
    expect(parseInsights({ reviews_total: 0 })).toBeNull();
    // repos is opt-in (plan 36 QC F-001): missing is tolerated (defaults
    // to undefined on the parsed shape), malformed is rejected.
    expect(parseInsights({ ...body, repos: undefined })?.repos).toBeUndefined();
    expect(parseInsights({ ...body, repos: "acme/web" })).toBeNull();
    expect(parseInsights({ ...body, repos: [1, 2] })).toBeNull();
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
        sandbox_image_id: "omp",
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
      sandbox_images: [{ id: "omp", enabled: true }],
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

  test("parseSettings requires the sandbox image selection + selector choices (plan 37)", () => {
    const manageBase = {
      can_manage: true,
      app: {
        slug: "demo",
        github_app_id: 1,
        status: "active",
        review_enabled: true,
        created_by: "mallory",
        last_webhook_at: null,
        sandbox_image_id: "omp",
      },
      keys: [],
      model_chain: null,
      model_roles: {},
      model_chains: [],
      custom_providers: [],
      installations: [],
      deliveries: [],
      providers: [],
      model_role_ids: [],
      custom_provider_api_ids: [],
      sandbox_images: [{ id: "omp", enabled: true }],
    };
    // Missing sandbox_image_id (either face) is a contract breach.
    const { sandbox_image_id: _dropped, ...appWithoutImage } = manageBase.app;
    expect(parseSettings({ ...manageBase, app: appWithoutImage })).toBeNull();
    // The manage face needs the enabled-entries selector list.
    const { sandbox_images: _omitted, ...withoutImages } = manageBase;
    expect(parseSettings(withoutImages)).toBeNull();
    // Malformed rows (non-string id / non-boolean enabled) are rejected.
    expect(parseSettings({ ...manageBase, sandbox_images: [{ id: 7, enabled: true }] })).toBeNull();
    expect(parseSettings({ ...manageBase, sandbox_images: [{ id: "omp", enabled: "yes" }] })).toBeNull();
    expect(parseSettings({ ...manageBase, sandbox_images: "omp" })).toBeNull();
    // A well-formed list parses and keeps the rows verbatim.
    const ok = parseSettings(manageBase);
    expect(ok && ok.can_manage && ok.sandbox_images).toEqual([{ id: "omp", enabled: true }]);
  });

  test("parseSettings accepts the non-manager base+health shape (no settings zones)", () => {
    // Plan 35 T4 review: can_manage=false payloads carry only app meta + health.
    // Plan 37: the read-only face still carries the selected image id.
    const readOnly = parseSettings({
      can_manage: false,
      app: {
        slug: "demo",
        github_app_id: 1,
        status: "active",
        review_enabled: true,
        created_by: "mallory",
        last_webhook_at: null,
        sandbox_image_id: "omp",
      },
      installations: [],
      deliveries: [],
    });
    expect(readOnly?.can_manage).toBe(false);
    expect(readOnly?.app.sandbox_image_id).toBe("omp");
    expect(readOnly && "keys" in readOnly).toBe(false);
    expect(readOnly && "sandbox_images" in readOnly).toBe(false);
    // Missing health fields is a contract breach even for the slim shape.
    expect(
      parseSettings({
        can_manage: false,
        app: {
          slug: "demo",
          github_app_id: 1,
          status: "active",
          review_enabled: true,
          created_by: "mallory",
          last_webhook_at: null,
          sandbox_image_id: "omp",
        },
      }),
    ).toBeNull();
    // can_manage=true without the settings zones is also a breach.
    expect(
      parseSettings({
        can_manage: true,
        app: {
          slug: "demo",
          github_app_id: 1,
          status: "active",
          review_enabled: true,
          created_by: "mallory",
          last_webhook_at: null,
          sandbox_image_id: "omp",
        },
        installations: [],
        deliveries: [],
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
      "insights.recordsHeading",
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
