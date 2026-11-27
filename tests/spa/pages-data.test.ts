import { describe, expect, test } from "bun:test";
import { t } from "../../src/i18n";
import {
  activeChainTabId,
  canInviteMembers,
  configuredKeySlot,
  DEFAULT_CHAIN_NAME,
  hasTargetFacts,
  insightsRepoFromSelect,
  insightsRepoOptions,
  insightsRepoSelectValue,
  INSIGHTS_REPO_ALL,
  inviteLoginNoticeKey,
  isPaused,
  modelChainTabs,
  modelsForProtocol,
  parseApps,
  parseInsights,
  parseInvites,
  parseInsightsSearch,
  parseMembers,
  parseReviewUsage,
  parseSettings,
  parseUsableBots,
  parseProviderCatalog,
  parseSharedBots,
  PR_VERDICTS as SPA_PR_VERDICTS,
  providerFormKind,
  providerKeyRows,
  removeChanged,
  REVIEW_LEVELS,
  REVIEW_TRIGGER_MODES,
  selectedCatalogProvider,
  type CatalogProvider,
  type ConfiguredProvider,
  type ModelChainEntry,
  type ProviderKeyRow,
} from "../../src/spa/pages/data";
import { DEFAULT_CHAIN_NAME as STORE_DEFAULT_CHAIN_NAME } from "../../src/dashboard/app-config-store";
import { PR_VERDICTS as ENGINE_PR_VERDICTS } from "@mstar-harness/engine";

describe("workspace role guard", () => {
  test("owner and admin manage members; a plain member only reads the list", () => {
    expect(canInviteMembers("owner")).toBe(true);
    expect(canInviteMembers("admin")).toBe(true);
    expect(canInviteMembers("member")).toBe(false);
    expect(canInviteMembers(null)).toBe(false);
  });

  test("paused is active + reviews disabled (both wire forms: integer and boolean)", () => {
    expect(isPaused({ status: "active", review_enabled: 0 })).toBe(true);
    expect(isPaused({ status: "active", review_enabled: 1 })).toBe(false);
    expect(isPaused({ status: "disabled", review_enabled: 0 })).toBe(false);
    expect(isPaused({ status: "active", review_enabled: false })).toBe(true);
    expect(isPaused({ status: "active", review_enabled: true })).toBe(false);
    expect(isPaused({ status: "disabled", review_enabled: false })).toBe(false);
  });
});

describe("insights search wiring", () => {
  test("defaults window 30 and empty repo", () => {
    expect(parseInsightsSearch("")).toEqual({ window: "30", repo: "" });
    expect(parseInsightsSearch("?window=7&repo=acme/web")).toEqual({ window: "7", repo: "acme/web" });
  });

  test("the global summary URL builder is retired with the page", async () => {
    expect("insightsSummaryUrl" in (await import("../../src/spa/pages/data"))).toBe(false);
    expect("searchHref" in (await import("../../src/spa/pages/data"))).toBe(false);
  });

  test("the App-addressed read builders are retired with their routes", async () => {
    const data = await import("../../src/spa/pages/data");
    for (const retired of [
      "appInsightsSummaryUrl",
      "appPullRequestsUrl",
      "appPullRequestDetailUrl",
      "appPullRequestRecordsUrl",
    ]) {
      expect(retired in data).toBe(false);
    }
    for (const kept of [
      "scopedInsightsSummaryUrl",
      "scopedPullRequestsUrl",
      "scopedPullRequestDetailUrl",
      "scopedPullRequestRecordsUrl",
      "readScopeKey",
    ]) {
      expect(kept in data).toBe(true);
    }
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
      verdict_distribution: [],
      weekly_trend: [],
      daily_trend: [],
      findings_distribution: [
        {
          bucket_start: "2026-08-17",
          granularity: "day",
          by_severity: { "must-fix": 2, "should-fix": 1, nit: 0 },
        },
      ],
      repos: [],
    };
    expect(parseInsights(body)?.reviews_total).toBe(0);
    expect(parseInsights(body)?.findings_distribution).toEqual([
      {
        bucket_start: "2026-08-17",
        granularity: "day",
        by_severity: { "must-fix": 2, "should-fix": 1, nit: 0 },
      },
    ]);
    expect(parseInsights({ ...body, repos: ["acme/web"] })?.repos).toEqual(["acme/web"]);
    expect(parseInsights({ reviews_total: 0 })).toBeNull();
    expect(parseInsights({ ...body, repos: undefined })?.repos).toBeUndefined();
    expect(parseInsights({ ...body, repos: "acme/web" })).toBeNull();
    expect(parseInsights({ ...body, repos: [1, 2] })).toBeNull();
    expect(parseInsights({ ...body, findings_distribution: undefined })).toBeNull();
    expect(parseInsights({ ...body, findings_distribution: "2026-08-17" })).toBeNull();
    expect(parseInsights({ ...body, findings_distribution: [{ bucket_start: "2026-08-17" }] })).toBeNull();
    expect(
      parseInsights({ ...body, findings_distribution: [{ bucket_start: "2026-08-17", granularity: "day" }] }),
    ).toBeNull();
    expect(
      parseInsights({
        ...body,
        findings_distribution: [{ bucket_start: "2026-08-17", granularity: "month", by_severity: {} }],
      }),
    ).toBeNull();
    expect(
      parseInsights({
        ...body,
        findings_distribution: [
          { bucket_start: "2026-08-17", granularity: "day", by_severity: { "must-fix": "2" } },
        ],
      }),
    ).toBeNull();
    expect(parseInsights({ ...body, daily_trend: undefined })).toBeNull();
    expect(parseInsights({ ...body, daily_trend: [{ day_start: 3, reviews: 0, findings: 0 }] })).toBeNull();
    expect(parseInsights({ ...body, daily_trend: [{ day_start: "2026-08-17" }] })).toBeNull();
  });
});

describe("members/apps/settings parsers", () => {
  test("parseMembers requires the viewer role, the workspace summary and id/login/role/created_at per row", () => {
    const row = { id: "u1", github_login: "octocat", role: "owner" as const, created_at: "2026-01-01 00:00:00" };
    const workspace = {
      plan: { id: "free", name: "Free" },
      memberLimit: 5,
      reviewAttemptsThisMonth: 2,
      pendingInvites: 1,
    };
    expect(parseMembers({ viewer: { role: "owner" }, workspace, members: [row] })).toEqual({
      viewer: { role: "owner" },
      workspace,
      members: [row],
    });
    expect(parseMembers({ viewer: { role: "owner" }, workspace, members: [{ ...row, role: "adminx" }] })).toBeNull();
    expect(parseMembers({ viewer: { role: "owner" }, workspace, members: [{ github_login: "octocat" }] })).toBeNull();
    expect(parseMembers({ members: [row] })).toBeNull();
    expect(parseMembers({ viewer: { role: "owner" }, members: [row] })).toBeNull();
    expect(
      parseMembers({ viewer: { role: "owner" }, workspace: { plan: { id: "free" }, memberLimit: 5 }, members: [row] }),
    ).toBeNull();
    expect(
      parseMembers({
        viewer: { role: "owner" },
        workspace: { plan: { id: "free", name: "Free" }, memberLimit: 5, reviewAttemptsThisMonth: 2 },
        members: [row],
      }),
    ).toBeNull();
  });

  test("parseMembers accepts a null memberLimit (no cap) and still rejects an absent one", () => {
    const row = { id: "u1", github_login: "octocat", role: "owner" as const, created_at: "2026-01-01 00:00:00" };
    const unlimited = {
      plan: { id: "unlimited", name: "Unlimited" },
      memberLimit: null,
      reviewAttemptsThisMonth: 0,
      pendingInvites: 0,
    };
    expect(parseMembers({ viewer: { role: "owner" }, workspace: unlimited, members: [row] })).toEqual({
      viewer: { role: "owner" },
      workspace: unlimited,
      members: [row],
    });
    const { memberLimit: _omitted, ...absent } = unlimited;
    expect(parseMembers({ viewer: { role: "owner" }, workspace: absent, members: [row] })).toBeNull();
  });

  test("parseInvites requires id/login/role/created_at/expires_at, role never owner", () => {
    const row = {
      id: "i1",
      github_login: "hubot",
      role: "admin" as const,
      created_at: "2026-01-01 00:00:00",
      expires_at: "2026-01-08 00:00:00",
    };
    expect(parseInvites({ invites: [row] })).toEqual([row]);
    expect(parseInvites({ invites: [{ ...row, role: "owner" }] })).toBeNull();
    expect(parseInvites({ invites: [{ ...row, expires_at: undefined }] })).toBeNull();
    expect(parseInvites({})).toBeNull();
  });

  test("parseApps requires viewer + apps", () => {
    const ok = parseApps({ viewer: { login: "mallory", role: "member" }, apps: [] });
    expect(ok?.viewer.login).toBe("mallory");
    expect(parseApps({ apps: [] })).toBeNull();
  });

  test("parseSharedBots is all-or-nothing, and a missing block is the empty list", () => {
    const row = { id: "bot-1", github_slug: "platform-app", name: "Platform", target_count: 2 };
    expect(parseSharedBots([row])).toEqual([row]);
    expect(parseSharedBots([row, { id: "", github_slug: null, name: "x", target_count: 0 }])).toEqual([]);
    expect(parseSharedBots([{ ...row, target_count: "2" }])).toEqual([]);
    expect(parseSharedBots(undefined)).toEqual([]);
    expect(parseSharedBots({ rows: [row] })).toEqual([]);
  });

  test("parseApps normalizes the shared-bot block: absent or malformed reads as none", () => {
    expect(parseApps({ viewer: { login: "mallory", role: "member" }, apps: [] })?.shared_bots).toEqual([]);
    const malformed = parseApps({
      viewer: { login: "mallory", role: "member" },
      apps: [],
      shared_bots: [{ id: 7 }],
    });
    expect(malformed?.shared_bots).toEqual([]);
    const ok = parseApps({
      viewer: { login: "mallory", role: "member" },
      apps: [],
      shared_bots: [{ id: "bot-1", github_slug: null, name: "Platform", target_count: 1 }],
    });
    expect(ok?.shared_bots).toEqual([{ id: "bot-1", github_slug: null, name: "Platform", target_count: 1 }]);
  });

  test("parseApps rows carry the D6 GitHub identity fields (github_name / github_slug / github_avatar_url)", () => {
    const ok = parseApps({
      viewer: { login: "mallory", role: "member" },
      apps: [
        {
          github_app_id: 1,
          github_name: "Demo",
          github_slug: "demo",
          github_avatar_url: "https://x.test/a.png",
          status: "active",
          review_enabled: 1,
          created_by: "mallory",
          health: { latest: null, rejected24h: 0 },
        },
      ],
    });
    expect(ok?.apps[0]).toMatchObject({
      github_name: "Demo",
      github_slug: "demo",
      github_avatar_url: "https://x.test/a.png",
    });
  });

  test("parseSettings requires can_manage, created_by, the collections, and chains", () => {
    const ok = parseSettings({
      can_manage: true,
      viewer_relation: "created",
      official_workspace: true,
      can_configure_bot: true,
      installation: null,
      pending_installations: [],
      workspace_id: "ws_0123456789abcdefghijkl",
      target_id: "rt-501",
      blocked: false as const,
      blocked_reason: null,
      app: {
        github_slug: "demo",
        id: "app-demo",
        github_app_id: 1,
        status: "active",
        review_enabled: true,
        created_by: "mallory",
        last_webhook_at: null,
        scope: "owned" as const,
        sandbox_image_id: "omp",
        review_trigger_mode: "every_push",
        review_level: null,
        default_review_level: "default",
        github_visibility: "unknown",
      },
      check_gate: { min_score: 80, pass_verdicts: ["ship it"] },
      keys: [],
      model_chain: null,
      model_roles: {},
      model_chains: [],
      custom_providers: [],
      installations: [],
      configured_providers: [],
      provider_catalog_version: "fixture-catalog",
      provider_eligibility: {},
      model_role_ids: ["mstar-review-seat"],
      custom_provider_api_ids: ["openai-completions"],
      sandbox_images: [{ id: "omp", enabled: true }],
    });
    expect(ok?.app.id).toBe("app-demo");
    expect(ok?.can_manage).toBe(true);
    expect(ok && ok.can_manage && !ok.blocked && ok.delivery_summary).toBeUndefined();
    expect(
      parseSettings({
        app: { github_slug: "demo", id: "app-demo", status: "active", review_enabled: 1, last_webhook_at: null },
        keys: [],
        configured_providers: [],
        provider_catalog_version: "fixture-catalog",
        provider_eligibility: {},
        model_role_ids: [],
        custom_provider_api_ids: [],
      }),
    ).toBeNull();
  });

  test("parseSettings requires the sandbox image selection + selector choices", () => {
    const manageBase = {
      can_manage: true,
      viewer_relation: "created",
      official_workspace: true,
      can_configure_bot: true,
      installation: null,
      pending_installations: [],
      workspace_id: "ws_0123456789abcdefghijkl",
      target_id: "rt-501",
      blocked: false as const,
      blocked_reason: null,
      app: {
        github_slug: "demo",
        id: "app-demo",
        github_app_id: 1,
        status: "active",
        review_enabled: true,
        created_by: "mallory",
        last_webhook_at: null,
        scope: "owned" as const,
        sandbox_image_id: "omp",
        review_trigger_mode: "every_push",
        review_level: null,
        default_review_level: "default",
        github_visibility: "unknown",
      },
      check_gate: { min_score: 80, pass_verdicts: ["ship it"] },
      keys: [],
      model_chain: null,
      model_roles: {},
      model_chains: [],
      custom_providers: [],
      installations: [],
      configured_providers: [],
      provider_catalog_version: "fixture-catalog",
      provider_eligibility: {},
      model_role_ids: [],
      custom_provider_api_ids: [],
      sandbox_images: [{ id: "omp", enabled: true }],
    };
    // F11: the sandbox image is BOT configuration. The App face no longer
    // serves it, so its absence is VALID on the App payload…
    const { sandbox_image_id: _dropped, ...appWithoutImage } = manageBase.app;
    expect(parseSettings({ ...manageBase, app: appWithoutImage })).not.toBeNull();
    // …while a malformed value is still rejected on either face.
    expect(parseSettings({ ...manageBase, app: { ...manageBase.app, sandbox_image_id: 7 } })).toBeNull();
    const { sandbox_images: _omitted, ...withoutImages } = manageBase;
    expect(parseSettings(withoutImages)).toBeNull();
    expect(parseSettings({ ...manageBase, sandbox_images: [{ id: 7, enabled: true }] })).toBeNull();
    expect(parseSettings({ ...manageBase, sandbox_images: [{ id: "omp", enabled: "yes" }] })).toBeNull();
    expect(parseSettings({ ...manageBase, sandbox_images: "omp" })).toBeNull();
    const ok = parseSettings(manageBase);
    expect(ok && ok.can_manage && !ok.blocked && ok.sandbox_images).toEqual([{ id: "omp", enabled: true }]);
  });

  test("parseSettings requires the review trigger mode and review depth on the manage face; off-vocabulary fails the parse", () => {
    const base = {
      can_manage: true,
      viewer_relation: "created",
      official_workspace: true,
      can_configure_bot: true,
      installation: null,
      pending_installations: [],
      workspace_id: "ws_0123456789abcdefghijkl",
      target_id: "rt-501",
      blocked: false as const,
      blocked_reason: null,
      app: {
        github_slug: "demo",
        id: "app-demo",
        github_app_id: 1,
        status: "active",
        review_enabled: true,
        created_by: "mallory",
        last_webhook_at: null,
        scope: "owned" as const,
        sandbox_image_id: "omp",
        review_trigger_mode: "every_push",
        review_level: null,
        default_review_level: "default",
        github_visibility: "unknown",
      },
      check_gate: { min_score: 80, pass_verdicts: ["ship it"] },
      keys: [],
      model_chain: null,
      model_roles: {},
      model_chains: [],
      custom_providers: [],
      configured_providers: [],
      provider_catalog_version: "fixture-catalog",
      provider_eligibility: {},
      model_role_ids: [],
      custom_provider_api_ids: [],
      sandbox_images: [{ id: "omp", enabled: true }],
      installations: [],
    };
    const { review_trigger_mode: _dropped, ...withoutMode } = base.app;
    expect(parseSettings({ ...base, app: withoutMode })).toBeNull();
    expect(parseSettings({ ...base, app: { ...base.app, review_trigger_mode: "whenever" } })).toBeNull();
    expect(parseSettings({ ...base, app: { ...base.app, review_trigger_mode: "EVERY_PUSH" } })).toBeNull();
    for (const mode of REVIEW_TRIGGER_MODES) {
      const manage = parseSettings({ ...base, app: { ...base.app, review_trigger_mode: mode } });
      expect(manage !== null && hasTargetFacts(manage) && manage.app.review_trigger_mode).toBe(mode);
    }
    const { review_level: _noLevel, ...withoutLevel } = base.app;
    expect(parseSettings({ ...base, app: withoutLevel })).toBeNull();
    expect(parseSettings({ ...base, app: { ...base.app, review_level: "turbo" } })).toBeNull();
    expect(parseSettings({ ...base, app: { ...base.app, default_review_level: "turbo" } })).toBeNull();
    expect(parseSettings({ ...base, app: { ...base.app, default_review_level: undefined } })).toBeNull();
    for (const level of REVIEW_LEVELS) {
      const manage = parseSettings({ ...base, app: { ...base.app, review_level: level } });
      expect(manage !== null && hasTargetFacts(manage) && manage.app.review_level).toBe(level);
    }
    const inherit = parseSettings(base);
    expect(inherit !== null && hasTargetFacts(inherit) && inherit.app.review_level).toBeNull();
  });

  test("parseSettings requires the review gate and visibility on the manage face; malformed values fail the parse", () => {
    const base = {
      can_manage: true,
      viewer_relation: "created",
      official_workspace: true,
      can_configure_bot: true,
      installation: null,
      pending_installations: [],
      workspace_id: "ws_0123456789abcdefghijkl",
      target_id: "rt-501",
      blocked: false as const,
      blocked_reason: null,
      app: {
        github_slug: "demo",
        id: "app-demo",
        github_app_id: 1,
        status: "active",
        review_enabled: true,
        created_by: "mallory",
        last_webhook_at: null,
        scope: "owned" as const,
        sandbox_image_id: "omp",
        review_trigger_mode: "every_push",
        review_level: null,
        default_review_level: "default",
        github_visibility: "public",
      },
      check_gate: { min_score: 90, pass_verdicts: ["ship it", "needs fixes"] },
      keys: [],
      model_chain: null,
      model_roles: {},
      model_chains: [],
      custom_providers: [],
      installations: [],
      configured_providers: [],
      provider_catalog_version: "fixture-catalog",
      provider_eligibility: {},
      model_role_ids: [],
      custom_provider_api_ids: [],
      sandbox_images: [{ id: "omp", enabled: true }],
    };
    const ok = parseSettings(base);
    expect(ok && ok.can_manage && !ok.blocked && ok.check_gate).toEqual({ min_score: 90, pass_verdicts: ["ship it", "needs fixes"] });
    expect(ok && ok.can_manage && !ok.blocked && ok.app.github_visibility).toBe("public");
    const { check_gate: _noGate, ...withoutGate } = base;
    expect(parseSettings(withoutGate)).toBeNull();
    const { github_visibility: _noVisibility, ...withoutVisibility } = base.app;
    expect(parseSettings({ ...base, app: withoutVisibility })).toBeNull();
    for (const minScore of [101, -1, 8.5, "80"]) {
      expect(parseSettings({ ...base, check_gate: { ...base.check_gate, min_score: minScore } })).toBeNull();
    }
    expect(parseSettings({ ...base, check_gate: { ...base.check_gate, pass_verdicts: "ship it" } })).toBeNull();
    expect(
      parseSettings({ ...base, check_gate: { ...base.check_gate, pass_verdicts: ["ship it", "looks fine"] } }),
    ).toBeNull();
    expect(parseSettings({ ...base, check_gate: { min_score: 80, pass_verdicts: [] } })).not.toBeNull();
    const unreadable = parseSettings({ ...base, check_gate: null });
    expect(unreadable && unreadable.can_manage && !unreadable.blocked && unreadable.check_gate).toBeNull();
    expect(parseSettings({ ...base, app: { ...base.app, github_visibility: "hidden" } })).toBeNull();
    for (const verdict of SPA_PR_VERDICTS) {
      const parsed = parseSettings({ ...base, check_gate: { min_score: 80, pass_verdicts: [verdict] } });
      expect(parsed && parsed.can_manage && !parsed.blocked && parsed.check_gate?.pass_verdicts).toEqual([verdict]);
    }
    expect(parseSettings({ ...base, app: { ...base.app, github_visibility: "unknown" } })).not.toBeNull();
    expect(parseSettings({ ...base, app: { ...base.app, github_visibility: null } })).not.toBeNull();
  });

  const MANAGER_PAYLOAD = {
    can_manage: true,
    viewer_relation: "created",
    official_workspace: true,
    can_configure_bot: true,
    workspace_id: "ws_0123456789abcdefghijkl",
    targets_many: false,
    installation: null,
    pending_installations: [],
    blocked: false,
    blocked_reason: null,
    target_id: "rt-501",
    app: {
      github_app_id: 1,
      id: "app-demo",
      status: "active",
      created_by: "mallory",
      last_webhook_at: null,
      sandbox_image_id: "omp",
      scope: "owned",
      github_name: "Demo",
      github_slug: "demo",
      github_description: null,
      github_html_url: "https://github.com/apps/demo",
      github_avatar_url: null,
      github_metadata_synced_at: "2026-01-01 00:00:00",
      github_visibility: "unknown",
      review_enabled: true,
      review_trigger_mode: "every_push",
      review_level: null,
      default_review_level: "default",
    },
    check_gate: { min_score: 80, pass_verdicts: ["ship it"] },
    keys: [],
    model_chain: null,
    model_roles: {},
    model_chains: [],
    custom_providers: [],
    configured_providers: [],
    provider_catalog_version: "fixture-catalog",
    provider_eligibility: {},
    model_role_ids: [],
    custom_provider_api_ids: [],
    sandbox_images: [{ id: "omp", enabled: true }],
    installations: [],
  };

  test("parseSettings accepts the manager payloads the worker sends: no allowlist, no owner_overlap", () => {
    const manager = MANAGER_PAYLOAD;
    expect(parseSettings(manager)).toMatchObject({ target_id: "rt-501", check_gate: { min_score: 80 } });
    const blocked = { ...manager, blocked: true, blocked_reason: "bot_not_shared" };
    expect(parseSettings(blocked)).toMatchObject({ blocked: true, target_id: "rt-501" });
    expect(parseSettings({ ...blocked, blocked_reason: null })).toBeNull();
  });

  test("parseSettings requires the share facts on the bot-readable manager face", () => {
    expect(parseSettings(MANAGER_PAYLOAD)).not.toBeNull();
    for (const key of ["official_workspace", "can_configure_bot"] as const) {
      const { [key]: _dropped, ...rest } = MANAGER_PAYLOAD;
      expect(parseSettings(rest), key).toBeNull();
      expect(parseSettings({ ...MANAGER_PAYLOAD, [key]: "yes" }), key).toBeNull();
    }
  });

  test("parseReviewUsage accepts the quota block the worker sends: no month inside quota", () => {
    const usage = {
      month: "2026-11",
      sharedReviews: 12,
      ownReviews: 3,
      sharedBot: "available",
      quota: {
        usedRp: 750,
        limitRp: 2000,
        sharedRp: 620,
        byokRp: 130,
        rpPerCredit: 20,
        profileVersion: 2,
        profileFrom: "2026-11-01",
        resetOn: "2026-12-01",
      },
    };
    expect(parseReviewUsage(usage)?.quota).toEqual(usage.quota);
    expect(parseReviewUsage({ ...usage, quota: { ...usage.quota, limitRp: null } })?.quota?.limitRp).toBeNull();
    expect(parseReviewUsage({ ...usage, quota: { ...usage.quota, resetOn: undefined } })).toBeNull();
  });

  test("parseSettings (identity-only face) requires the D4 identity set — created_at joins the required keys", () => {
    const identityBase = {
      can_manage: false,
      viewer_relation: "installed",
      workspace_id: "ws_0123456789abcdefghijkl",
      target_id: "rt-501",
      blocked: false as const,
      blocked_reason: null,
      app: {
        github_slug: "demo",
        id: "app-demo",
        github_app_id: 1,
        status: "active",
        review_enabled: true,
        created_by: "mallory",
        created_at: "2026-01-01 00:00:00",
        github_name: "Demo",
        github_description: null,
        github_html_url: "https://github.com/apps/demo",
        github_avatar_url: null,
        github_metadata_synced_at: null,
      },
    };
    const ok = parseSettings(identityBase);
    expect(ok?.can_manage).toBe(false);
    expect(ok && !ok.can_manage && ok.app.created_at).toBe("2026-01-01 00:00:00");
    const { created_at: _dropped, ...withoutCreatedAt } = identityBase.app;
    expect(parseSettings({ ...identityBase, app: withoutCreatedAt })).toBeNull();
    const { github_name: _droppedName, ...withoutGithubName } = identityBase.app;
    expect(parseSettings({ ...identityBase, app: withoutGithubName })).toBeNull();
    expect(parseSettings(identityBase)).not.toBeNull();
  });

  test("parseSettings separates configured state from the catalog", () => {
    const manageBase = {
      can_manage: true,
      viewer_relation: "created",
      official_workspace: true,
      can_configure_bot: true,
      installation: null,
      pending_installations: [],
      workspace_id: "ws_0123456789abcdefghijkl",
      target_id: "rt-501",
      blocked: false as const,
      blocked_reason: null,
      app: {
        github_slug: "demo",
        id: "app-demo",
        github_app_id: 1,
        status: "active",
        review_enabled: true,
        created_by: "mallory",
        last_webhook_at: null,
        scope: "owned" as const,
        sandbox_image_id: "omp",
        review_trigger_mode: "every_push",
        review_level: null,
        default_review_level: "default",
        github_visibility: "unknown",
      },
      check_gate: { min_score: 80, pass_verdicts: ["ship it"] },
      keys: [],
      model_chain: null,
      model_roles: {},
      model_chains: [],
      custom_providers: [],
      installations: [],
      configured_providers: [],
      provider_catalog_version: "fixture-catalog",
      provider_eligibility: {},
      model_role_ids: [],
      custom_provider_api_ids: [],
      sandbox_images: [{ id: "omp", enabled: true }],
    };
    const catalogRow = {
      id: "anthropic",
      label: "Anthropic",
      tier: "builtin",
      base_url: null,
      api: null,
      models: ["claude-fable-5"],
      model_limits: {},
      verifiable: true,
      usage_probe: false,
      eligibility: "builtin",
      display_group: "common",
    };
    const unconfigured = parseSettings(manageBase);
    expect(unconfigured && unconfigured.can_manage && !unconfigured.blocked && unconfigured.configured_providers).toEqual([]);
    expect(unconfigured).not.toHaveProperty("provider_catalog");
    expect(unconfigured).not.toHaveProperty("model_limits_snapshot");
    const { configured_providers: _droppedConfigured, ...withoutConfigured } = manageBase;
    expect(parseSettings(withoutConfigured)).toBeNull();
    const { provider_catalog_version: _droppedVersion, ...withoutVersion } = manageBase;
    expect(parseSettings(withoutVersion)).toBeNull();
    const { provider_eligibility: _droppedEligibility, ...withoutEligibility } = manageBase;
    expect(parseSettings(withoutEligibility)).toBeNull();
    expect(parseSettings({ ...manageBase, provider_eligibility: { anthropic: "maybe" } })).toBeNull();
    expect(parseSettings({ ...manageBase, provider_catalog_version: "" })).toBeNull();
    expect(parseSettings({ ...manageBase, configured_providers: [{ ...catalogRow }] })).toBeNull();
    expect(
      parseSettings({
        ...manageBase,
        configured_providers: [
          {
            kind: "key",
            provider: "anthropic",
            key_id: "a".repeat(16),
            last4: "9988",
            updated_at: null,
            verified_at: null,
            verified_status: null,
          },
        ],
      }),
    ).not.toBeNull();
    expect(
      parseSettings({ ...manageBase, configured_providers: [{ kind: "key", provider: "anthropic" }] }),
    ).toBeNull();
    expect(
      parseSettings({
        ...manageBase,
        configured_providers: [{ kind: "key", provider: "anthropic", last4: "9988", updated_at: null }],
      }),
    ).toBeNull();
    expect(
      parseSettings({
        ...manageBase,
        configured_providers: [
          { kind: "custom", provider_id: "my-custom", base_url: "https://example.com/v1", api: "openai-completions", model_ids: ["local-7b"] },
        ],
      }),
    ).not.toBeNull();
    expect(
      parseSettings({
        ...manageBase,
        configured_providers: [
          { kind: "custom", provider_id: "my-custom", base_url: "https://example.com/v1", api: "openai-completions", model_ids: "local-7b" },
        ],
      }),
    ).toBeNull();
    expect(
      parseSettings({ ...manageBase, configured_providers: [{ kind: "template", provider_id: "workers-ai" }] }),
    ).toBeNull();
  });

  test("parseSettings accepts the identity-only non-manager face (no ops stores, no settings zones)", () => {
    const identityApp = {
      github_slug: "demo",
      id: "app-demo",
      github_app_id: 1,
      status: "active",
      review_enabled: true,
      created_by: "mallory",
      created_at: "2026-01-01 00:00:00",
      github_name: "Demo",
      github_description: null,
      github_html_url: "https://github.com/apps/demo",
      github_avatar_url: null,
      github_metadata_synced_at: null,
    };
    const readOnly = parseSettings({
      workspace_id: "ws_0123456789abcdefghijkl",
      target_id: "rt-501",
      blocked: false as const,
      blocked_reason: null,
      can_manage: false,
      viewer_relation: "installed",
      app: identityApp,
    });
    expect(readOnly?.can_manage).toBe(false);
    expect(readOnly && !readOnly.can_manage && readOnly.app.created_at).toBe("2026-01-01 00:00:00");
    expect(readOnly && "keys" in readOnly).toBe(false);
    expect(readOnly && "sandbox_images" in readOnly).toBe(false);
    expect(readOnly && "installations" in readOnly).toBe(false);
    const { created_at: _dropped, ...withoutCreated } = identityApp;
    expect(parseSettings({
      workspace_id: "ws_0123456789abcdefghijkl",
      target_id: "rt-501",
      blocked: false as const,
      blocked_reason: null,
      can_manage: false,
      viewer_relation: "installed",
      app: withoutCreated,
    })).toBeNull();
    expect(
      parseSettings({
        can_manage: true,
        viewer_relation: "created",
        official_workspace: true,
        can_configure_bot: true,
        installation: null,
        pending_installations: [],
        workspace_id: "ws_0123456789abcdefghijkl",
        target_id: "rt-501",
        blocked: false as const,
        blocked_reason: null,
        app: {
          github_slug: "demo",
          id: "app-demo",
          github_app_id: 1,
          status: "active",
          review_enabled: true,
          created_by: "mallory",
          last_webhook_at: null,
          scope: "owned" as const,
          sandbox_image_id: "omp",
          review_trigger_mode: "every_push",
          review_level: null,
          default_review_level: "default",
        },
        installations: [],
      }),
    ).toBeNull();
  });
});

describe("model chain tab model", () => {
  const entry = (name: string, chain: string): ModelChainEntry => ({
    name,
    chain,
    is_default: name === "default",
    created_at: "2026-09-04 00:00:00",
    updated_at: "2026-09-04 00:00:00",
  });

  test("Default is always the first tab — even for an empty or default-less payload", () => {
    expect(modelChainTabs([])).toEqual([{ id: "default", isDefault: true, chain: null }]);
    const tabs = modelChainTabs([entry("alpha", "a/one"), entry("beta", "b/one")]);
    expect(tabs.map((tab) => tab.id)).toEqual(["default", "alpha", "beta"]);
    expect(tabs[0]).toEqual({ id: "default", isDefault: true, chain: null });
    expect(tabs.slice(1).every((tab) => !tab.isDefault)).toBe(true);
  });

  test("a payload row named 'default' collapses into the Default tab and never becomes a named tab", () => {
    const tabs = modelChainTabs([entry("alpha", "a/one"), entry("default", "provider/model")]);
    expect(tabs.map((tab) => tab.id)).toEqual(["default", "alpha"]);
    expect(tabs[0]?.chain).toBeNull();
    expect(tabs.some((tab) => tab.id === "default" && !tab.isDefault)).toBe(false);
  });

  test("named tab ids are the stored names; duplicate names collapse (first row wins)", () => {
    const tabs = modelChainTabs([entry("alpha", "a/one"), entry("alpha", "a/two"), entry("beta", "b/one")]);
    expect(tabs.filter((tab) => !tab.isDefault)).toEqual([
      { id: "alpha", isDefault: false, chain: "a/one" },
      { id: "beta", isDefault: false, chain: "b/one" },
    ]);
  });

  test("activeChainTabId coerces a stale or unknown selection to the Default tab", () => {
    const tabs = modelChainTabs([entry("alpha", "a/one")]);
    expect(activeChainTabId(tabs, "alpha")).toBe("alpha");
    expect(activeChainTabId(tabs, "removed-chain")).toBe("default");
    expect(activeChainTabId(tabs, undefined)).toBe("default");
    expect(activeChainTabId(tabs, null)).toBe("default");
    expect(activeChainTabId(tabs, "")).toBe("default");
    expect(activeChainTabId(modelChainTabs([]), "default")).toBe("default");
  });

  test("DEFAULT_CHAIN_NAME equals the store's reserved name (duplication lock)", () => {
    expect(DEFAULT_CHAIN_NAME).toBe(STORE_DEFAULT_CHAIN_NAME);
    expect(DEFAULT_CHAIN_NAME).toBe("default");
  });
});

describe("provider catalog rows + add selection", () => {
  const manageBase = {
    can_manage: true,
    viewer_relation: "created",
    official_workspace: true,
    can_configure_bot: true,
    installation: null,
    pending_installations: [],
    workspace_id: "ws_0123456789abcdefghijkl",
    target_id: "rt-501",
    blocked: false as const,
    blocked_reason: null,
    app: {
      github_slug: "demo",
      id: "app-demo",
      github_app_id: 1,
      status: "active",
      review_enabled: true,
      created_by: "mallory",
      last_webhook_at: null,
      scope: "owned" as const,
      sandbox_image_id: "omp",
      review_trigger_mode: "every_push",
      review_level: null,
      default_review_level: "default",
      github_visibility: "unknown",
    },
    check_gate: { min_score: 80, pass_verdicts: ["ship it"] },
    keys: [],
    model_chain: null,
    model_limits_snapshot: "2026-01-01",
    model_roles: {},
    model_chains: [],
    custom_providers: [],
    installations: [],
    configured_providers: [],
    provider_catalog: [],
    provider_catalog_version: "fixture-catalog",
    provider_eligibility: {},
    model_role_ids: [],
    custom_provider_api_ids: [],
    sandbox_images: [{ id: "omp", enabled: true }],
  };
  const catalogRow: CatalogProvider = {
    id: "anthropic",
    label: "Anthropic",
    tier: "builtin",
    base_url: null,
    api: null,
    models: ["claude-fable-5"],
    model_limits: {},
    verifiable: true,
    usage_probe: false,
    eligibility: "builtin",
    display_group: "common",
  };

  test("catalog rows are row-validated on models/verifiable/base_url/api (guards)", () => {
    expect(parseProviderCatalog({ ...manageBase, provider_catalog: [catalogRow] })).not.toBeNull();
    const { models: _droppedModels, ...withoutModels } = catalogRow;
    expect(parseProviderCatalog({ ...manageBase, provider_catalog: [withoutModels] })).toBeNull();
    expect(parseProviderCatalog({ ...manageBase, provider_catalog: [{ ...catalogRow, models: "claude-fable-5" }] })).toBeNull();
    expect(parseProviderCatalog({ ...manageBase, provider_catalog: [{ ...catalogRow, verifiable: "yes" }] })).toBeNull();
    expect(parseProviderCatalog({ ...manageBase, provider_catalog: [{ ...catalogRow, verifiable: null }] })).toBeNull();
    expect(parseProviderCatalog({ ...manageBase, provider_catalog: [{ ...catalogRow, usage_probe: "yes" }] })).toBeNull();
    expect(parseProviderCatalog({ ...manageBase, provider_catalog: [{ ...catalogRow, base_url: 5 }] })).toBeNull();
    expect(parseProviderCatalog({ ...manageBase, provider_catalog: [{ ...catalogRow, api: [] }] })).toBeNull();
    const { display_group: _droppedDisplayGroup, ...withoutDisplayGroup } = catalogRow;
    expect(parseProviderCatalog({ ...manageBase, provider_catalog: [withoutDisplayGroup] })).toBeNull();
    expect(parseProviderCatalog({ ...manageBase, provider_catalog: [{ ...catalogRow, display_group: "builtin" }] })).toBeNull();
    const { model_limits: _droppedLimits, ...withoutLimits } = catalogRow;
    expect(parseProviderCatalog({ ...manageBase, provider_catalog: [withoutLimits] })).toBeNull();
    expect(
      parseProviderCatalog({ ...manageBase, provider_catalog: [{ ...catalogRow, model_limits: { m: { contextWindow: 0, maxTokens: 1 } } }] }),
    ).toBeNull();
    expect(
      parseProviderCatalog({ ...manageBase, provider_catalog: [{ ...catalogRow, model_limits: { m: { contextWindow: 10 } } }] }),
    ).toBeNull();
    const { model_limits_snapshot: _droppedSnapshot, ...withoutSnapshot } = manageBase;
    expect(parseProviderCatalog(withoutSnapshot)).toBeNull();
    expect(parseProviderCatalog({ ...manageBase, model_limits_snapshot: "" })).toBeNull();
  });

  test("a merged catalog row's protocol options are row-validated; a single-protocol row omits them", () => {
    const merged: CatalogProvider = {
      ...catalogRow,
      tier: "template",
      base_url: "https://api.merged.test/v1",
      api: "openai-completions",
      protocols: [
        { api: "openai-completions", base_url: "https://api.merged.test/v1", models: ["a"] },
        { api: "anthropic-messages", base_url: "https://api.merged.test/anthropic", models: ["b"] },
      ],
    };
    expect(parseProviderCatalog({ ...manageBase, provider_catalog: [merged] })).not.toBeNull();
    expect(parseProviderCatalog({ ...manageBase, provider_catalog: [catalogRow] })).not.toBeNull();
    expect(
      parseProviderCatalog({ ...manageBase, provider_catalog: [{ ...merged, protocols: [{ api: "anthropic-messages", base_url: 5, models: ["b"] }] }] }),
    ).toBeNull();
    expect(
      parseProviderCatalog({ ...manageBase, provider_catalog: [{ ...merged, protocols: [{ base_url: "https://x.test", models: [] }] }] }),
    ).toBeNull();
    expect(
      parseProviderCatalog({ ...manageBase, provider_catalog: [{ ...merged, protocols: [{ api: "anthropic-messages", base_url: null, models: "b" }] }] }),
    ).toBeNull();
    expect(parseProviderCatalog({ ...manageBase, provider_catalog: [{ ...merged, protocols: [] }] })).toBeNull();
  });

  test("the protocol lookups: a declaration's vocabulary", () => {
    const merged: CatalogProvider = {
      ...catalogRow,
      tier: "template",
      base_url: "https://api.merged.test/v1",
      api: "openai-completions",
      models: ["a"],
      protocols: [
        { api: "openai-completions", base_url: "https://api.merged.test/v1", models: ["a"] },
        { api: "anthropic-messages", base_url: "https://api.merged.test/anthropic", models: ["b"] },
      ],
    };
    expect(modelsForProtocol(merged, "anthropic-messages")).toEqual(["b"]);
    expect(modelsForProtocol(merged, "openai-completions")).toEqual(["a"]);
    expect(modelsForProtocol(merged, "typesafe")).toEqual(["a"]);
    expect(modelsForProtocol(merged, null)).toEqual(["a"]);
    expect(modelsForProtocol(undefined, "anthropic-messages")).toEqual([]);
  });

  test("add selection maps the picked catalog id to its configuration form kind", () => {
    const builtinRow: CatalogProvider = catalogRow;
    const templateRow: CatalogProvider = {
      ...catalogRow,
      id: "workers-ai",
      label: "Workers AI",
      tier: "template",
      eligibility: "template",
    };
    const consoleRow: CatalogProvider = { ...catalogRow, id: "azure-openai", verifiable: false };
    const catalog: CatalogProvider[] = [builtinRow, templateRow, consoleRow];
    expect(selectedCatalogProvider(catalog, "workers-ai")?.id).toBe("workers-ai");
    expect(selectedCatalogProvider(catalog, "not-in-catalog")).toBeNull();
    expect(selectedCatalogProvider(catalog, undefined)).toBeNull();
    expect(selectedCatalogProvider(catalog, null)).toBeNull();
    expect(selectedCatalogProvider(catalog, "")).toBeNull();
    expect(providerFormKind(builtinRow)).toBe("key");
    expect(providerFormKind(templateRow)).toBe("template");
    expect(providerFormKind(consoleRow)).toBe("console");
  });

  test("saved provider refresh: stored keys and custom declarations parse as the configured list", () => {
    const { provider_catalog: _catalog, model_limits_snapshot: _snapshot, ...settings } = manageBase;
    const saved = parseSettings({
      ...settings,
      keys: [
        {
          provider: "anthropic",
          keyId: "a".repeat(16),
          last4: "9988",
          updatedAt: "2026-09-04 10:00:00",
          verifiedAt: "2026-09-04 10:05:00",
          verifiedStatus: "ok",
        },
      ],
      configured_providers: [
        {
          kind: "key",
          provider: "anthropic",
          key_id: "a".repeat(16),
          last4: "9988",
          updated_at: "2026-09-04 10:00:00",
          verified_at: "2026-09-04 10:05:00",
          verified_status: "ok",
        },
        {
          kind: "custom",
          provider_id: "workers-ai",
          base_url: "https://api.cloudflare.com/client/v4/accounts/acct/ai-gateway/openai",
          api: "openai-completions",
          model_ids: ["@cf/meta/llama-3-8b-instruct"],
        },
      ],
    });
    const rows = saved && saved.can_manage && !saved.blocked ? saved.configured_providers : [];
    expect(rows).toHaveLength(2);
    const [keyRow, customRow] = rows;
    expect(keyRow).toMatchObject({ kind: "key", provider: "anthropic", last4: "9988" });
    expect(customRow && customRow.kind === "custom" && customRow.provider_id).toBe("workers-ai");
    expect(saved).not.toHaveProperty("provider_catalog");
  });

  test("multi-key rows stay one row each — a second key of one provider never overwrites the first", () => {
    const first: ProviderKeyRow = {
      provider: "anthropic",
      keyId: "a".repeat(16),
      last4: "1111",
      updatedAt: "2026-09-04 10:00:00",
      verifiedAt: null,
      verifiedStatus: null,
    };
    const second: ProviderKeyRow = { ...first, keyId: "b".repeat(16), last4: "2222" };
    const other: ProviderKeyRow = { ...first, provider: "openai", keyId: "c".repeat(16), last4: "3333" };
    expect(providerKeyRows([first, second, other], "anthropic").map((row) => row.keyId)).toEqual([
      first.keyId,
      second.keyId,
    ]);
    expect(providerKeyRows([first, second, other], "anthropic").map((row) => row.last4)).toEqual(["1111", "2222"]);
    expect(providerKeyRows([first, second, other], "never-stored")).toEqual([]);
  });

  test("parseSettings row-validates the keys face: identity, mask and both nullable bookkeeping columns", () => {
    const keyRow: ProviderKeyRow = {
      provider: "anthropic",
      keyId: "a".repeat(16),
      last4: "1111",
      updatedAt: null,
      verifiedAt: null,
      verifiedStatus: null,
    };
    expect(parseSettings({ ...manageBase, keys: [keyRow] })).not.toBeNull();
    const { keyId: _droppedId, ...withoutId } = keyRow;
    expect(parseSettings({ ...manageBase, keys: [withoutId] })).toBeNull();
    expect(parseSettings({ ...manageBase, keys: [{ provider: "anthropic", last4: "1111" }] })).toBeNull();
    expect(
      parseSettings({ ...manageBase, keys: [{ ...keyRow, verifiedStatus: "maybe" }] }),
    ).toBeNull();
    expect(parseSettings({ ...manageBase, keys: [{ ...keyRow, verifiedStatus: "failed" }] })).not.toBeNull();
    expect(parseSettings({ ...manageBase, keys: [{ ...keyRow, verifiedStatus: "reachable" }] })).not.toBeNull();
  });

  test("a custom pool's key row parses through the same configured key-row guard", () => {
    const customKeyRow = {
      kind: "key" as const,
      provider: "workers-ai",
      key_id: "d".repeat(16),
      last4: "2211",
      updated_at: "2026-10-14 10:00:00",
      verified_at: null,
      verified_status: null,
    };
    const parsed = parseSettings({ ...manageBase, configured_providers: [customKeyRow] });
    expect(parsed === null || !parsed.can_manage || parsed.blocked ? null : parsed.configured_providers).toEqual([customKeyRow]);
  });

  test("removal feedback locates the row by the full (provider, key_id) identity, not the id alone", () => {
    const shared = "a".repeat(16);
    const rows: ConfiguredProvider[] = [
      {
        kind: "key",
        provider: "anthropic",
        key_id: shared,
        last4: "1111",
        updated_at: null,
        verified_at: null,
        verified_status: null,
      },
      {
        kind: "key",
        provider: "openai",
        key_id: shared,
        last4: "2222",
        updated_at: null,
        verified_at: null,
        verified_status: null,
      },
      {
        kind: "custom",
        provider_id: "workers-ai",
        base_url: "https://example.test/v1",
        api: "openai-completions",
        model_ids: ["m"],
      },
    ];
    const slot = configuredKeySlot(rows, "openai", shared);
    expect(slot).toBe(1);
    expect(rows[slot]).toMatchObject({ kind: "key", provider: "openai", key_id: shared });
    expect(configuredKeySlot(rows, "anthropic", shared)).toBe(0);
    expect(configuredKeySlot(rows, "openai", "b".repeat(16))).toBe(-1);
    expect(configuredKeySlot(rows, "google", shared)).toBe(-1);
    expect(configuredKeySlot(rows, "workers-ai", shared)).toBe(-1);
  });

  test("removeChanged reads the remove routes' outcome flag — a no-op never resolves as a change", () => {
    expect(
      removeChanged(JSON.stringify({ changed: false, message: "No stored anthropic key — nothing changed." })),
    ).toBe(false);
    expect(removeChanged(JSON.stringify({ changed: true, message: "Removed the stored anthropic key." }))).toBe(true);
    expect(removeChanged("ok")).toBeNull();
    expect(removeChanged("")).toBeNull();
    expect(removeChanged(JSON.stringify({ message: "no flag here" }))).toBeNull();
    expect(removeChanged(JSON.stringify({ changed: "false" }))).toBeNull();
  });
});

describe("invite grammar + page copy", () => {
  test("invite login grammar matches the legacy route", () => {
    expect(inviteLoginNoticeKey("")).toBe("notice.error.enterLogin");
    expect(inviteLoginNoticeKey("   ")).toBe("notice.error.enterLogin");
    expect(inviteLoginNoticeKey("not a login")).toBe("notice.error.invalidLogin");
    expect(inviteLoginNoticeKey("octocat")).toBeNull();
  });

  test("resident pages interpolate bilingual keys in both dictionaries", () => {
    const keys = [
      "members.pendingHeading",
      "members.role.owner",
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

describe("review gate verdict mirror", () => {
  test("the SPA PR_VERDICTS mirror equals the engine tuple, in order", () => {
    expect([...SPA_PR_VERDICTS]).toEqual([...ENGINE_PR_VERDICTS]);
  });
});

describe("R2 — the usable-bot parser accepts the producer's own payload", () => {
  /**
   * The EXACT shape `usableBotsRead` (`src/dashboard/index.ts`) sends — no
   * `monthly_rp` on a usable bot (that column is the owner's stored default),
   * only the viewer's `effective_ceiling`. A nonempty list must parse.
   */
  const PRODUCER_PAYLOAD = {
    workspace_id: "ws_0123456789abcdefghijkl",
    plan_monthly_rp: 20000,
    bots: [
      {
        id: "app-a",
        name: "Acme Reviewer",
        description: null,
        workspace_id: "ws_0123456789abcdefghijkl",
        workspace_name: "Acme",
        owned: true,
        can_manage: true,
        scope: "owned",
        multiplier: 1,
        month_used_rp: 40,
        effective_ceiling: null,
        archived: false,
      },
      {
        id: "app-b",
        name: "Mstar Standard",
        description: "shared depth",
        workspace_id: "ws_other",
        workspace_name: "Platform",
        owned: false,
        can_manage: false,
        scope: "shared",
        multiplier: 1.5,
        month_used_rp: 1240,
        effective_ceiling: 20000,
        archived: false,
      },
    ],
  };

  test("a nonempty usable-bot list with no per-bot monthly_rp parses", () => {
    const parsed = parseUsableBots(PRODUCER_PAYLOAD);
    expect(parsed).not.toBeNull();
    expect(parsed!.bots).toHaveLength(2);
    expect(parsed!.bots.map((bot) => bot.id)).toEqual(["app-a", "app-b"]);
  });

  test("a quota error payload parses and carries the flag, not a fabricated ceiling", () => {
    const parsed = parseUsableBots({ ...PRODUCER_PAYLOAD, plan_monthly_rp: null, quota_error: true });
    expect(parsed?.quota_error).toBe(true);
    expect(parsed?.plan_monthly_rp).toBeNull();
  });

  // `archived` decides whether a row is offered for selection, so an absent or
  // malformed value must fail the parse — never read as "live".
  test("a row with NO archived field rejects the whole payload", () => {
    const { archived: _omitted, ...first } = PRODUCER_PAYLOAD.bots[0]!;
    expect(parseUsableBots({ ...PRODUCER_PAYLOAD, bots: [first] })).toBeNull();
  });

  test("a row whose archived is not a boolean rejects the whole payload", () => {
    const [first] = PRODUCER_PAYLOAD.bots;
    for (const bogus of ["false", 0, null, undefined]) {
      expect(
        parseUsableBots({ ...PRODUCER_PAYLOAD, bots: [{ ...first!, archived: bogus }] }),
        String(bogus),
      ).toBeNull();
    }
  });

  // The row's ceiling is a served RP amount: it must sit in the same domain the
  // writer accepts, and an ABSENT one is a payload the producer never sends.
  test("the row's effective ceiling must be a real ceiling or explicit null", () => {
    const [first] = PRODUCER_PAYLOAD.bots;
    expect(parseUsableBots(PRODUCER_PAYLOAD)?.bots[1]?.effective_ceiling).toBe(20000);
    for (const bogus of [0, -1, 1.5, "3000", undefined, Number.MAX_SAFE_INTEGER + 2]) {
      expect(
        parseUsableBots({ ...PRODUCER_PAYLOAD, bots: [{ ...first!, effective_ceiling: bogus }] }),
        String(bogus),
      ).toBeNull();
    }
  });
});
