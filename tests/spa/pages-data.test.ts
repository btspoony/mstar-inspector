/**
 * Pure page-data parsers and client guards (no DOM runner).
 */
import { describe, expect, test } from "bun:test";
import { t } from "../../src/i18n";
import {
  activeChainTabId,
  canInviteMembers,
  configuredKeySlot,
  DEFAULT_CHAIN_NAME,
  insightsRepoFromSelect,
  insightsRepoOptions,
  insightsRepoSelectValue,
  INSIGHTS_REPO_ALL,
  inviteLoginNoticeKey,
  isPaused,
  modelChainTabs,
  parseApps,
  parseInsights,
  parseInvites,
  parseInsightsSearch,
  parseMembers,
  parseSettings,
  providerFormKind,
  providerKeyRows,
  removeChanged,
  REVIEW_TRIGGER_MODES,
  selectedCatalogProvider,
  type CatalogProvider,
  type ConfiguredProvider,
  type ModelChainEntry,
  type ProviderKeyRow,
} from "../../src/spa/pages/data";
import { DEFAULT_CHAIN_NAME as STORE_DEFAULT_CHAIN_NAME } from "../../src/dashboard/app-config-store";

describe("workspace role guard", () => {
  test("owner and admin manage members; a plain member only reads the list", () => {
    expect(canInviteMembers("owner")).toBe(true);
    expect(canInviteMembers("admin")).toBe(true);
    expect(canInviteMembers("member")).toBe(false);
    expect(canInviteMembers(null)).toBe(false);
  });

  test("paused is active + reviews disabled (both wire forms: integer and boolean)", () => {
    // Integer form: the apps list face (raw store column, dashboard/index.ts).
    expect(isPaused({ status: "active", review_enabled: 0 })).toBe(true);
    expect(isPaused({ status: "active", review_enabled: 1 })).toBe(false);
    expect(isPaused({ status: "disabled", review_enabled: 0 })).toBe(false);
    // Boolean form: the settings face (`review_enabled !== 0` coercion).
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
      // (window-bucketing contract 2026-09-20): the day-bucket trend grid
      // is REQUIRED like the other aggregations — week-window payloads
      // carry exactly [] (this fixture's shape, window 30 = day window).
      daily_trend: [],
      // (AD-652): the distribution grid is REQUIRED like the other
      // aggregations — one realistic day bucket (the task-1 store shape:
      // fixed severity key set + window-union category keys + fallback).
      findings_distribution: [
        {
          bucket_start: "2026-08-17",
          granularity: "day",
          by_severity: { "must-fix": 2, "should-fix": 1, nit: 0 },
          by_category: { logic: 2, style: 0, uncategorized: 1 },
        },
      ],
      recurring_top: [],
      repos: [],
    };
    expect(parseInsights(body)?.reviews_total).toBe(0);
    // The bucket rows parse verbatim — the stacked charts read these grids
    // directly (row-strict guard).
    expect(parseInsights(body)?.findings_distribution).toEqual([
      {
        bucket_start: "2026-08-17",
        granularity: "day",
        by_severity: { "must-fix": 2, "should-fix": 1, nit: 0 },
        by_category: { logic: 2, style: 0, uncategorized: 1 },
      },
    ]);
    expect(parseInsights({ ...body, repos: ["acme/web"] })?.repos).toEqual(["acme/web"]);
    expect(parseInsights({ reviews_total: 0 })).toBeNull();
    // repos is opt-in (QC F-001): missing is tolerated (defaults
    // to undefined on the parsed shape), malformed is rejected.
    expect(parseInsights({ ...body, repos: undefined })?.repos).toBeUndefined();
    expect(parseInsights({ ...body, repos: "acme/web" })).toBeNull();
    expect(parseInsights({ ...body, repos: [1, 2] })).toBeNull();
    // findings_distribution is NOT opt-in: a missing field (rolled-back
    // Worker) or any drifted row takes the same null fallback as the other
    // aggregations.
    expect(parseInsights({ ...body, findings_distribution: undefined })).toBeNull();
    expect(parseInsights({ ...body, findings_distribution: "2026-08-17" })).toBeNull();
    expect(parseInsights({ ...body, findings_distribution: [{ bucket_start: "2026-08-17" }] })).toBeNull();
    expect(
      parseInsights({
        ...body,
        findings_distribution: [{ bucket_start: "2026-08-17", granularity: "month", by_severity: {}, by_category: {} }],
      }),
    ).toBeNull();
    expect(
      parseInsights({
        ...body,
        findings_distribution: [
          { bucket_start: "2026-08-17", granularity: "day", by_severity: { "must-fix": "2" }, by_category: {} },
        ],
      }),
    ).toBeNull();
    // daily_trend is NOT opt-in either (same AD-652 precedent): a missing
    // field (rolled-back Worker) or a drifted row takes the null fallback.
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
    // An off-vocabulary role fails the parse instead of rendering it.
    expect(parseMembers({ viewer: { role: "owner" }, workspace, members: [{ ...row, role: "adminx" }] })).toBeNull();
    expect(parseMembers({ viewer: { role: "owner" }, workspace, members: [{ github_login: "octocat" }] })).toBeNull();
    // No viewer role = not a members payload (a non-member cannot get here).
    expect(parseMembers({ members: [row] })).toBeNull();
    // A rolled-back Worker without the summary fails instead of inventing limits.
    expect(parseMembers({ viewer: { role: "owner" }, members: [row] })).toBeNull();
    expect(
      parseMembers({ viewer: { role: "owner" }, workspace: { plan: { id: "free" }, memberLimit: 5 }, members: [row] }),
    ).toBeNull();
    // The pending count is required too: a partial summary never renders.
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
    // `null` is the unlimited tier's real value: the summary must parse, not be
    // discarded over a field that is present and meaningful.
    expect(parseMembers({ viewer: { role: "owner" }, workspace: unlimited, members: [row] })).toEqual({
      viewer: { role: "owner" },
      workspace: unlimited,
      members: [row],
    });
    // Absent is still drift, so the field stays required.
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
    // `owner` is never invitable (migration 0028 CHECK domain).
    expect(parseInvites({ invites: [{ ...row, role: "owner" }] })).toBeNull();
    expect(parseInvites({ invites: [{ ...row, expires_at: undefined }] })).toBeNull();
    expect(parseInvites({})).toBeNull();
  });

  test("parseApps requires viewer + apps", () => {
    const ok = parseApps({ viewer: { login: "mallory", role: "member" }, apps: [] });
    expect(ok?.viewer.login).toBe("mallory");
    expect(parseApps({ apps: [] })).toBeNull();
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
      app: {
        github_slug: "demo",
        id: "app-demo",
        github_app_id: 1,
        status: "active",
        review_enabled: true,
        created_by: "mallory",
        last_webhook_at: null,
        sandbox_image_id: "omp",
        review_trigger_mode: "every_push",
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
    expect(ok?.app.id).toBe("app-demo");
    expect(ok?.can_manage).toBe(true);
    expect(
      parseSettings({
        app: { github_slug: "demo", id: "app-demo", status: "active", review_enabled: 1, last_webhook_at: null },
        keys: [],
        configured_providers: [],
        provider_catalog: [],
        model_role_ids: [],
        custom_provider_api_ids: [],
      }),
    ).toBeNull();
  });

  test("parseSettings requires the sandbox image selection + selector choices", () => {
    const manageBase = {
      can_manage: true,
      app: {
        github_slug: "demo",
        id: "app-demo",
        github_app_id: 1,
        status: "active",
        review_enabled: true,
        created_by: "mallory",
        last_webhook_at: null,
        sandbox_image_id: "omp",
        review_trigger_mode: "every_push",
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

  test("parseSettings requires the review trigger mode on the manage face; off-vocabulary fails the parse", () => {
    const base = {
      can_manage: true,
      app: {
        github_slug: "demo",
        id: "app-demo",
        github_app_id: 1,
        status: "active",
        review_enabled: true,
        created_by: "mallory",
        last_webhook_at: null,
        sandbox_image_id: "omp",
        review_trigger_mode: "every_push",
      },
      keys: [],
      model_chain: null,
      model_roles: {},
      model_chains: [],
      custom_providers: [],
      configured_providers: [],
      provider_catalog: [],
      model_role_ids: [],
      custom_provider_api_ids: [],
      sandbox_images: [{ id: "omp", enabled: true }],
      installations: [],
      deliveries: [],
    };
    // Missing mode is a contract breach on the MANAGE face — the control
    // would render without a current value, so the whole payload fails the
    // parse (sandbox_image_id precedent).
    const { review_trigger_mode: _dropped, ...withoutMode } = base.app;
    expect(parseSettings({ ...base, app: withoutMode })).toBeNull();
    // An off-vocabulary value (impossible from the DB CHECK, but a drifted
    // worker could serve it) fails the parse instead of rendering a dead
    // selection — never silently coerced to the default.
    expect(parseSettings({ ...base, app: { ...base.app, review_trigger_mode: "whenever" } })).toBeNull();
    expect(parseSettings({ ...base, app: { ...base.app, review_trigger_mode: "EVERY_PUSH" } })).toBeNull();
    // Every vocabulary value parses verbatim — the manage face keeps
    // today's required-field contract.
    for (const mode of REVIEW_TRIGGER_MODES) {
      const manage = parseSettings({ ...base, app: { ...base.app, review_trigger_mode: mode } });
      expect(manage && manage.can_manage && manage.app.review_trigger_mode).toBe(mode);
    }
  });

  test("parseSettings (identity-only face) requires the D4 identity set — created_at joins the required keys", () => {
    const identityBase = {
      can_manage: false,
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
    // created_at is REQUIRED on the identity face.
    const { created_at: _dropped, ...withoutCreatedAt } = identityBase.app;
    expect(parseSettings({ ...identityBase, app: withoutCreatedAt })).toBeNull();
    // GitHub profile fields are nullable but never absent.
    const { github_name: _droppedName, ...withoutGithubName } = identityBase.app;
    expect(parseSettings({ ...identityBase, app: withoutGithubName })).toBeNull();
    // The manage-face extras are NOT part of this face: a payload without
    // sandbox_image_id / review_trigger_mode / installations / deliveries
    // still parses — the identity set is the whole contract.
    expect(parseSettings(identityBase)).not.toBeNull();
  });

  test("parseSettings separates configured state from the catalog", () => {
    const manageBase = {
      can_manage: true,
      app: {
        github_slug: "demo",
        id: "app-demo",
        github_app_id: 1,
        status: "active",
        review_enabled: true,
        created_by: "mallory",
        last_webhook_at: null,
        sandbox_image_id: "omp",
        review_trigger_mode: "every_push",
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
      display_group: "common",
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
    // Both collections are REQUIRED (clean cutover — no legacy shape).
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
    // Key rows need their identity, the masked tail (never plaintext) and the
    // nullable bookkeeping columns.
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
    // A key row without its identity (the pre-multi-key shape) is rejected —
    // the row could not be deleted or re-verified without it.
    expect(
      parseSettings({
        ...manageBase,
        configured_providers: [{ kind: "key", provider: "anthropic", last4: "9988", updated_at: null }],
      }),
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

  test("parseSettings accepts the identity-only non-manager face (no ops stores, no settings zones)", () => {
    // SUPERSEDE (App detail IA): can_manage=false now carries ONLY the D4
    // identity set — created_at + the cached public GitHub profile; no
    // installations/deliveries, no sandbox image, no trigger mode.
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
    const readOnly = parseSettings({ can_manage: false, app: identityApp });
    expect(readOnly?.can_manage).toBe(false);
    expect(readOnly && !readOnly.can_manage && readOnly.app.created_at).toBe("2026-01-01 00:00:00");
    expect(readOnly && "keys" in readOnly).toBe(false);
    expect(readOnly && "sandbox_images" in readOnly).toBe(false);
    expect(readOnly && "installations" in readOnly).toBe(false);
    // A missing identity field is a contract breach.
    const { created_at: _dropped, ...withoutCreated } = identityApp;
    expect(parseSettings({ can_manage: false, app: withoutCreated })).toBeNull();
    // can_manage=true without the settings zones is also a breach.
    expect(
      parseSettings({
        can_manage: true,
        app: {
          github_slug: "demo",
          id: "app-demo",
          github_app_id: 1,
          status: "active",
          review_enabled: true,
          created_by: "mallory",
          last_webhook_at: null,
          sandbox_image_id: "omp",
          review_trigger_mode: "every_push",
        },
        installations: [],
        deliveries: [],
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
    // The empty list still yields the non-removable Default tab.
    expect(modelChainTabs([])).toEqual([{ id: "default", isDefault: true, chain: null }]);
    // Malformed/legacy ordering: named rows only — Default is synthesized first.
    const tabs = modelChainTabs([entry("alpha", "a/one"), entry("beta", "b/one")]);
    expect(tabs.map((tab) => tab.id)).toEqual(["default", "alpha", "beta"]);
    expect(tabs[0]).toEqual({ id: "default", isDefault: true, chain: null });
    expect(tabs.slice(1).every((tab) => !tab.isDefault)).toBe(true);
  });

  test("a payload row named 'default' collapses into the Default tab and never becomes a named tab", () => {
    const tabs = modelChainTabs([entry("alpha", "a/one"), entry("default", "provider/model")]);
    expect(tabs.map((tab) => tab.id)).toEqual(["default", "alpha"]);
    // The Default tab's editor consumes the dedicated model_chain field, not the row.
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
    // A deleted chain name (or a blank selection) falls back to Default.
    expect(activeChainTabId(tabs, "removed-chain")).toBe("default");
    expect(activeChainTabId(tabs, undefined)).toBe("default");
    expect(activeChainTabId(tabs, null)).toBe("default");
    expect(activeChainTabId(tabs, "")).toBe("default");
    // Even with no named chains the Default tab is a valid selection.
    expect(activeChainTabId(modelChainTabs([]), "default")).toBe("default");
  });

  test("DEFAULT_CHAIN_NAME equals the store's reserved name (duplication lock)", () => {
    // src/spa/pages/data.ts mirrors src/dashboard/app-config-store.ts across
    // the bundle boundary (documented, deliberately not imported): the store
    // rejects the reserved name as a named chain, so a one-sided rename here
    // would silently break tab ids and seat coercion. Same duplication-lock
    // convention as PROVIDER_META — drift fails this test.
    expect(DEFAULT_CHAIN_NAME).toBe(STORE_DEFAULT_CHAIN_NAME);
    expect(DEFAULT_CHAIN_NAME).toBe("default");
  });
});

describe("provider catalog rows + add selection", () => {
  const manageBase = {
    can_manage: true,
    app: {
      github_slug: "demo",
      id: "app-demo",
      github_app_id: 1,
      status: "active",
      review_enabled: true,
      created_by: "mallory",
      last_webhook_at: null,
      sandbox_image_id: "omp",
      review_trigger_mode: "every_push",
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
    display_group: "common",
  };

  test("catalog rows are row-validated on models/verifiable/base_url/api (guards)", () => {
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
    // Review handoff S2: the display-group stamp is word-checked —
    // a row missing `display_group` (the pre-54 route shape) or carrying a
    // stray value fails the parse instead of silently falling out of both
    // picker groups.
    const { display_group: _droppedDisplayGroup, ...withoutDisplayGroup } = catalogRow;
    expect(parseSettings({ ...manageBase, provider_catalog: [withoutDisplayGroup] })).toBeNull();
    expect(parseSettings({ ...manageBase, provider_catalog: [{ ...catalogRow, display_group: "builtin" }] })).toBeNull();
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
      provider_catalog: [
        catalogRow,
        { ...catalogRow, id: "workers-ai", label: "Workers AI", tier: "template", eligibility: "template" },
      ],
    });
    const rows = saved && saved.can_manage ? saved.configured_providers : [];
    expect(rows).toHaveLength(2);
    const [keyRow, customRow] = rows;
    expect(keyRow).toMatchObject({ kind: "key", provider: "anthropic", last4: "9988" });
    expect(customRow && customRow.kind === "custom" && customRow.provider_id).toBe("workers-ai");
    // The refreshed payload keeps catalog vs configured disjoint even after
    // a save: both catalog rows remain discovery-only.
    const catalogRows = saved && saved.can_manage ? saved.provider_catalog : [];
    expect(catalogRows).toHaveLength(2);
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
    // The provider's rows come back whole, in payload order — the client map
    // that used to fold them by provider id dropped the second row.
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
    // A drifted row (no key identity, no mask) fails the parse instead of
    // rendering a row nothing can address.
    const { keyId: _droppedId, ...withoutId } = keyRow;
    expect(parseSettings({ ...manageBase, keys: [withoutId] })).toBeNull();
    expect(parseSettings({ ...manageBase, keys: [{ provider: "anthropic", last4: "1111" }] })).toBeNull();
    // The verification vocabulary is closed (store-enforced ok|failed) — an
    // off-vocabulary status fails the parse instead of rendering a state the
    // row can never hold.
    expect(
      parseSettings({ ...manageBase, keys: [{ ...keyRow, verifiedStatus: "maybe" }] }),
    ).toBeNull();
    expect(parseSettings({ ...manageBase, keys: [{ ...keyRow, verifiedStatus: "failed" }] })).not.toBeNull();
  });

  test("a custom pool's key row parses through the same configured key-row guard", () => {
    // Built-in and custom pools share one row contract: provider + key
    // identity + mask + per-key verification state (the providers card
    // renders both through ConfiguredKeyRow).
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
    expect(parsed === null || !parsed.can_manage ? null : parsed.configured_providers).toEqual([customKeyRow]);
  });

  test("removal feedback locates the row by the full (provider, key_id) identity, not the id alone", () => {
    // Key ids are derived from the plaintext only, so ONE key stored under two
    // providers legitimately shares its id. The delete POST carries both, so
    // the feedback slot must match both — an id-only match resolves the FIRST
    // provider's row and renders the outcome beside a row that is still there.
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
    // …and the row at that slot is the one the POST names.
    expect(rows[slot]).toMatchObject({ kind: "key", provider: "openai", key_id: shared });
    // The earlier provider's row keeps its own slot.
    expect(configuredKeySlot(rows, "anthropic", shared)).toBe(0);
    // A row the payload no longer holds (or a provider-less id) is not found.
    expect(configuredKeySlot(rows, "openai", "b".repeat(16))).toBe(-1);
    expect(configuredKeySlot(rows, "google", shared)).toBe(-1);
    // The custom declaration's provider_id is never a key handle.
    expect(configuredKeySlot(rows, "workers-ai", shared)).toBe(-1);
  });

  test("removeChanged reads the remove routes' outcome flag — a no-op never resolves as a change", () => {
    // The tolerant ops (key delete / custom provider remove) answer the
    // no-change case as `changed: false`, which the SPA renders as its
    // localized no-change notice instead of the generic "Changes saved.".
    expect(
      removeChanged(JSON.stringify({ changed: false, message: "No stored anthropic key — nothing changed." })),
    ).toBe(false);
    expect(removeChanged(JSON.stringify({ changed: true, message: "Removed the stored anthropic key." }))).toBe(true);
    // Everything without the flag keeps the caller's default outcome: the
    // plain-text 2xx faces (pause/resume/…) and a drifted body included.
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
