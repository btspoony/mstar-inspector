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
  providerFormKind,
  selectedCatalogProvider,
  type CatalogProvider,
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

  test("parseSettings requires can_manage, created_by, the plan-38 collections, and chains", () => {
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
      configured_providers: [],
      provider_catalog: [],
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
        configured_providers: [],
        provider_catalog: [],
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
      configured_providers: [],
      provider_catalog: [],
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

  test("parseSettings separates configured state from the catalog (plan 38)", () => {
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
      configured_providers: [],
      provider_catalog: [],
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
      verifiable: true,
      eligibility: "builtin",
    };
    // The required unconfigured-App case: EMPTY configured state + a
    // non-empty catalog parses — a catalog dump is never configured state.
    const unconfigured = parseSettings({
      ...manageBase,
      provider_catalog: [
        catalogRow,
        { ...catalogRow, id: "workers-ai", tier: "template", eligibility: "template" },
      ],
    });
    expect(unconfigured && unconfigured.can_manage && unconfigured.configured_providers).toEqual([]);
    expect(unconfigured && unconfigured.can_manage && unconfigured.provider_catalog).toHaveLength(2);
    // Both plan-38 collections are REQUIRED (clean cutover — no legacy shape).
    const { configured_providers: _droppedConfigured, ...withoutConfigured } = manageBase;
    expect(parseSettings(withoutConfigured)).toBeNull();
    const { provider_catalog: _droppedCatalog, ...withoutCatalog } = manageBase;
    expect(parseSettings(withoutCatalog)).toBeNull();
    // A catalog row without eligibility (the old dump shape) is rejected.
    const { eligibility: _droppedEligibility, ...rowWithoutEligibility } = catalogRow;
    expect(parseSettings({ ...manageBase, provider_catalog: [rowWithoutEligibility] })).toBeNull();
    expect(parseSettings({ ...manageBase, provider_catalog: [{ ...catalogRow, eligibility: "maybe" }] })).toBeNull();
    // A configured row without the `kind` discriminator (catalog-shaped) is rejected.
    expect(parseSettings({ ...manageBase, configured_providers: [{ ...catalogRow }] })).toBeNull();
    // Key rows need the masked tail (never plaintext) and a nullable timestamp.
    expect(
      parseSettings({
        ...manageBase,
        configured_providers: [{ kind: "key", provider: "anthropic", last4: "9988", updated_at: null }],
      }),
    ).not.toBeNull();
    expect(
      parseSettings({ ...manageBase, configured_providers: [{ kind: "key", provider: "anthropic" }] }),
    ).toBeNull();
    // Custom declaration rows need base_url/api and a string model list.
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
    // Unknown kinds are rejected — the union is closed.
    expect(
      parseSettings({ ...manageBase, configured_providers: [{ kind: "template", provider_id: "workers-ai" }] }),
    ).toBeNull();
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

describe("provider catalog rows + add selection (plan 38 T2)", () => {
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
    configured_providers: [],
    provider_catalog: [],
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
    verifiable: true,
    eligibility: "builtin",
  };

  test("catalog rows are row-validated on models/verifiable/base_url/api (plan 38 T2 guards)", () => {
    // A well-formed row (nullable url/api for builtins) parses.
    expect(parseSettings({ ...manageBase, provider_catalog: [catalogRow] })).not.toBeNull();
    // A drifted payload missing `models` must fail the parse — the Add
    // Provider UI branches on it, so a partial row can never render.
    const { models: _droppedModels, ...withoutModels } = catalogRow;
    expect(parseSettings({ ...manageBase, provider_catalog: [withoutModels] })).toBeNull();
    expect(parseSettings({ ...manageBase, provider_catalog: [{ ...catalogRow, models: "claude-fable-5" }] })).toBeNull();
    // verifiable decides the form kind — non-boolean is a contract breach.
    expect(parseSettings({ ...manageBase, provider_catalog: [{ ...catalogRow, verifiable: "yes" }] })).toBeNull();
    expect(parseSettings({ ...manageBase, provider_catalog: [{ ...catalogRow, verifiable: null }] })).toBeNull();
    // base_url / api are string-or-null.
    expect(parseSettings({ ...manageBase, provider_catalog: [{ ...catalogRow, base_url: 5 }] })).toBeNull();
    expect(parseSettings({ ...manageBase, provider_catalog: [{ ...catalogRow, api: [] }] })).toBeNull();
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
    // The selection resolves against the catalog; unknown/absent picks → null.
    expect(selectedCatalogProvider(catalog, "workers-ai")?.id).toBe("workers-ai");
    expect(selectedCatalogProvider(catalog, "not-in-catalog")).toBeNull();
    expect(selectedCatalogProvider(catalog, undefined)).toBeNull();
    expect(selectedCatalogProvider(catalog, null)).toBeNull();
    expect(selectedCatalogProvider(catalog, "")).toBeNull();
    // Template entries materialize, verifiable builtins use verify-first,
    // console-only builtins have no in-app form.
    expect(providerFormKind(builtinRow)).toBe("key");
    expect(providerFormKind(templateRow)).toBe("template");
    expect(providerFormKind(consoleRow)).toBe("console");
  });

  test("saved provider refresh: stored keys and custom declarations parse as the configured list", () => {
    const saved = parseSettings({
      ...manageBase,
      configured_providers: [
        { kind: "key", provider: "anthropic", last4: "9988", updated_at: "2026-09-04 10:00:00" },
        {
          kind: "custom",
          provider_id: "workers-ai",
          base_url: "https://api.cloudflare.com/client/v4/accounts/acct/ai-gateway/openai",
          api: "openai-completions",
          model_ids: ["@cf/meta/llama-3-8b-instruct"],
        },
      ],
      provider_catalog: [
        catalogRow,
        { ...catalogRow, id: "workers-ai", label: "Workers AI", tier: "template", eligibility: "template" },
      ],
    });
    const rows = saved && saved.can_manage ? saved.configured_providers : [];
    expect(rows).toHaveLength(2);
    const [keyRow, customRow] = rows;
    expect(keyRow).toEqual({ kind: "key", provider: "anthropic", last4: "9988", updated_at: "2026-09-04 10:00:00" });
    expect(customRow && customRow.kind === "custom" && customRow.provider_id).toBe("workers-ai");
    // The refreshed payload keeps catalog vs configured disjoint even after
    // a save: both catalog rows remain discovery-only.
    const catalogRows = saved && saved.can_manage ? saved.provider_catalog : [];
    expect(catalogRows).toHaveLength(2);
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
