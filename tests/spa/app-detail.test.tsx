import { describe, expect, test } from "bun:test";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { type Element as DomElement, type HTMLElement as DomHTMLElement, type Window } from "happy-dom";
import { t } from "../../src/i18n";
import {
  appDeliveriesUrl,
  appDetailSearchQuery,
  appStatusPill,
  parseDeliveryPage,
  parseAppDetailSearch,
  parseSettings,
  pullRequestRefOf,
  scopedInsightsSummaryUrl,
  type AppChainEntry,
  type AppDetailSearch,
  type AppDetailTab,
  type SettingsBlockedPayload,
  type SettingsManagePayload,
  type SettingsPayload,
  type SettingsUntargetedPayload,
} from "../../src/spa/pages/data";
import { AppDetailPage, AppDetailView, loadAppDetail } from "../../src/spa/pages/AppDetailPage";
import { DeliveryStatusView } from "../../src/spa/pages/AppDeliveryTab";
import { SettingsView } from "../../src/spa/pages/SettingsPage";
import { apiBase } from "../../src/spa/workspace-base";
import { APP_VERSION } from "../../src/version";
import { installDom, withMarkup } from "./dom";

const IDENTITY_APP = {
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

const identityPayload = {
  can_manage: false as const,
  workspace_id: "ws_0123456789abcdefghijkl",
  target_id: "rt-1",
  blocked: false as const,
  blocked_reason: null,
  app: IDENTITY_APP,
};

/** The blocked manager face: this workspace's target on another workspace's bot. */
function blockedPayload(): SettingsBlockedPayload {
  return {
    can_manage: true,
    blocked: true,
    blocked_reason: "bot_not_shared",
    workspace_id: managePayload.workspace_id,
    target_id: managePayload.target_id,
    app: {
      github_app_id: managePayload.app.github_app_id,
      id: managePayload.app.id,
      status: managePayload.app.status,
      created_by: managePayload.app.created_by,
      review_enabled: managePayload.app.review_enabled,
      review_trigger_mode: managePayload.app.review_trigger_mode,
      review_level: managePayload.app.review_level,
      default_review_level: managePayload.app.default_review_level,
      scope: "owned",
      github_name: managePayload.app.github_name,
      github_slug: managePayload.app.github_slug,
      github_description: managePayload.app.github_description,
      github_html_url: managePayload.app.github_html_url,
      github_avatar_url: managePayload.app.github_avatar_url,
      github_visibility: managePayload.app.github_visibility,
    },
    installation: null,
    check_gate: managePayload.check_gate,
  };
}

const BOOT = { locale: "en" as const, login: "mallory", name: null };

/** One chain row with the fields the panel renders; callers override the ones under test. */
function chainRow(overrides: Partial<AppChainEntry> & { position: number; bot_id: string }): AppChainEntry {
  return {
    name: overrides.bot_id,
    description: null,
    provider_workspace: "ws_0123456789abcdefghijkl",
    owned: true,
    available: true,
    multiplier: 1,
    month_used_rp: 0,
    monthly_rp: null,
    effective_monthly_rp: null,
    ...overrides,
  };
}

const managePayload = {
  can_manage: true as const,
  official_workspace: true as const,
  can_configure_bot: true as const,
  installation: null,
  pending_installations: [],
  blocked: false as const,
  blocked_reason: null,
  workspace_id: "ws_0123456789abcdefghijkl",
  target_id: "rt-1",
  app: {
    ...IDENTITY_APP,
    last_webhook_at: null,
    scope: "owned" as const,
    sandbox_image_id: "omp",
    review_trigger_mode: "every_push" as const,
    review_level: null,
    default_review_level: "default" as const,
    github_visibility: "unknown" as const,
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

const untargetedPayload: SettingsUntargetedPayload = {
  can_manage: true,
  official_workspace: true,
  can_configure_bot: true,
  installation: null,
  pending_installations: [],
  blocked: false,
  blocked_reason: null,
  workspace_id: managePayload.workspace_id,
  app: {
    github_app_id: managePayload.app.github_app_id,
    id: managePayload.app.id,
    status: managePayload.app.status,
    created_by: managePayload.app.created_by,
    last_webhook_at: null,
    sandbox_image_id: "omp",
    scope: "owned",
    github_name: managePayload.app.github_name,
    github_slug: managePayload.app.github_slug,
    github_description: managePayload.app.github_description,
    github_html_url: managePayload.app.github_html_url,
    github_avatar_url: managePayload.app.github_avatar_url,
    github_metadata_synced_at: managePayload.app.github_metadata_synced_at,
    github_visibility: "unknown",
  },
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

const search = { tab: "settings" as const, window: "30" as const, repo: "", pr: "" };
const noReload = async () => true;
const noSearch = () => {};

function renderDetail(payload: SettingsPayload, tab: AppDetailTab = "settings") {
  return renderToStaticMarkup(
    createElement(AppDetailView, {
      locale: "en",
      appId: "1",
      payload,
      groups: [],
      notice: null,
      search: { ...search, tab },
      onReload: noReload,
      onSearch: noSearch,
    }),
  );
}

describe("settings payload parser — the target-owned slice is all-or-nothing", () => {
  test("a face naming a target carries its pause state; a target-less face carries neither, and a half slice is refused", () => {
    expect(parseSettings(identityPayload)?.can_manage).toBe(false);
    expect(parseSettings(identityPayload)?.target_id).toBe("rt-1");
    expect(parseSettings(managePayload)?.can_manage).toBe(true);
    expect(parseSettings(managePayload)?.target_id).toBe("rt-1");
    expect(parseSettings(untargetedPayload)).not.toBeNull();
    expect(parseSettings(untargetedPayload)?.target_id).toBeUndefined();
    const { target_id: _identityTarget, ...identityWithoutTarget } = identityPayload;
    const { target_id: _manageTarget, ...manageWithoutTarget } = managePayload;
    expect(parseSettings(identityWithoutTarget)).toBeNull();
    expect(parseSettings(manageWithoutTarget)).toBeNull();
    expect(parseSettings({ ...identityPayload, target_id: null })).toBeNull();
    expect(parseSettings({ ...managePayload, target_id: 1 })).toBeNull();
    expect(parseSettings({ ...managePayload, target_id: "" })).toBeNull();
  });
});

describe("app detail URL state (shared pure helpers)", () => {
  test("the bare path is the settings tab; only 已安装 is another address", () => {
    expect(parseAppDetailSearch("")).toEqual({ tab: "settings", window: "30", repo: "", pr: "" });
    expect(parseAppDetailSearch("?tab=installations").tab).toBe("installations");
    expect(parseAppDetailSearch("?tab=settings").tab).toBe("settings");
    for (const bogus of ["bogus", "insights", "pull-requests"]) {
      expect(parseAppDetailSearch(`?tab=${bogus}`).tab).toBe("settings");
    }
  });

  test("the open PR detail rides the pr param (owner/repo/number), malformed values fall back to the list", () => {
    expect(parseAppDetailSearch("?pr=acme%2Fweb%2F42")).toEqual({
      tab: "settings",
      window: "30",
      repo: "",
      pr: "acme/web/42",
    });
    expect(parseAppDetailSearch("?pr=42").pr).toBe("");
    expect(parseAppDetailSearch("?pr=acme/web/abc").pr).toBe("");
    expect(parseAppDetailSearch("?pr=a/b/1/2").pr).toBe("");
  });

  test("the pr param and the detail resolver accept exactly the same grammar", () => {
    const accepted = ["acme/web/42", "acme/web/0042", "a/b/1"];
    for (const pr of accepted) {
      expect(pullRequestRefOf(pr)).not.toBeNull();
      expect(parseAppDetailSearch(`?pr=${encodeURIComponent(pr)}`).pr).toBe(pr);
    }
    const rejected = [
      "42",
      "acme/web/abc",
      "acme/web/",
      "/web/42",
      "a/b/1/2",
      "../settings/1",
      "./repo/1",
      "acme/./1",
      "acme/../1",
    ];
    for (const pr of rejected) {
      expect(pullRequestRefOf(pr)).toBeNull();
      expect(parseAppDetailSearch(`?pr=${encodeURIComponent(pr)}`).pr).toBe("");
    }
  });

  test("insights filter params ride the same query (window segments + repo)", () => {
    expect(parseAppDetailSearch("?window=7&repo=acme%2Fweb")).toEqual({
      tab: "settings",
      window: "7",
      repo: "acme/web",
      pr: "",
    });
    expect(parseAppDetailSearch("?window=60").window).toBe("30");
  });

  test("appDetailSearchQuery is the inverse — defaults omitted (loop-free replaceState writes)", () => {
    expect(appDetailSearchQuery({ tab: "settings", window: "30", repo: "", pr: "" })).toBe("");
    expect(appDetailSearchQuery({ tab: "installations", window: "30", repo: "", pr: "" })).toBe(
      "?tab=installations",
    );
    expect(appDetailSearchQuery({ tab: "settings", window: "7", repo: "acme/web", pr: "" })).toBe(
      "?window=7&repo=acme%2Fweb",
    );
    expect(
      appDetailSearchQuery({ tab: "installations", window: "30", repo: "", pr: "acme/web/42" }),
    ).toBe("?tab=installations&pr=acme%2Fweb%2F42");
  });

  test("the summary URL is base-prefixed and addresses the scope; include=repos always rides", () => {
    expect(scopedInsightsSummaryUrl("/dashboard", { kind: "target", targetId: "1" }, "30", "")).toBe(
      "/dashboard/api/targets/1/insights/summary?window=30&include=repos",
    );
    expect(
      scopedInsightsSummaryUrl("/dashboard/acme", { kind: "target", targetId: "12345" }, "7", "acme/web"),
    ).toBe("/dashboard/acme/api/targets/12345/insights/summary?window=7&include=repos&repo=acme%2Fweb");
    expect(scopedInsightsSummaryUrl("/dashboard", { kind: "workspace" }, "90", "")).toBe(
      "/dashboard/api/insights/summary?window=90&include=repos",
    );
    expect(
      scopedInsightsSummaryUrl("/dashboard", { kind: "target", targetId: "1" }, "30", ""),
    ).not.toContain("/api/apps/");
  });
});

describe("tab shell rendering (static SSR)", () => {
  const pageTabs = (container: HTMLElement): string[] =>
    [...(container.querySelector('[role="tablist"]')?.querySelectorAll('[role="tab"]') ?? [])].map(
      (tab) => tab.textContent ?? "",
    );

  test("the manager's tab bar is the App's own four faces, settings first", async () => {
    const manage = renderDetail(managePayload);
    expect(await withMarkup(manage, pageTabs)).toEqual([
      t("en", "appDetail.tabSettings"),
      t("en", "appDetail.tabBots"),
      t("en", "appDetail.tabDelivery"),
      t("en", "appDetail.tabInstallations"),
    ]);
    expect(manage).toContain(">Demo</h1>");
    expect(manage).toContain("by mallory");
  });

  test("a non-manager sees identity-only with no tab bar at all — absence pinned", async () => {
    const identity = renderDetail(identityPayload);
    expect(await withMarkup(identity, pageTabs)).toEqual([]);
    expect(identity).toContain(t("en", "settings.appInfo"));
    expect(identity).not.toContain(t("en", "settings.providers.title"));
  });

  test("应用设置 composes the identity header, the ops zone and the App's own scope switch", () => {
    const settings = renderDetail(managePayload);
    expect(settings).toContain(t("en", "settings.ops"));
    expect(settings).not.toContain(t("en", "settings.pauseReviews"));
    expect(settings).not.toContain(t("en", "settings.resumeReviews"));
    // The bot's own sections moved to /bots/:botId with the App/bot split:
    // no providers block and no seat editor render on the App face. (The
    // metric band's "Model chains" count is an App-payload fact and stays,
    // so the editor is pinned by its section, not by that shared word.)
    expect(settings).not.toContain(t("en", "settings.providers.title"));
    expect(settings).not.toContain(t("en", "settings.seats"));
    expect(settings).toContain(t("en", "apps.shareAppSwitch"));
    for (const key of ["settings.reviewTrigger", "settings.reviewDepth", "settings.reviewGate"] as const) {
      expect(settings).not.toContain(t("en", key));
    }
    expect(settings).not.toContain("Review health");
  });

  test("the roster keeps the install block above it", () => {
    const installed = renderDetail(
      {
        ...managePayload,
        installations: [
          { installation_id: 123, account_login: "acme", seen_at: "2026-01-01 00:00:00" },
        ],
      },
      "installations",
    );
    expect(installed).toContain(">Installed</button>");
    expect(installed).toContain(t("en", "settings.install"));
    expect(installed).toContain('href="https://github.com/apps/demo/installations/new"');
  });

  test("an App with no repository yet states it, with no reverse link to the repository surface", () => {
    expect(parseSettings(untargetedPayload)).not.toBeNull();
    expect(parseSettings(untargetedPayload)?.target_id).toBeUndefined();

    const markup = renderDetail(untargetedPayload);
    expect(markup).toContain(t("en", "appDetail.noRepository"));
    expect(markup).not.toContain(t("en", "settings.ops"));
    for (const key of ["settings.reviewTrigger", "settings.reviewDepth", "settings.reviewGate"] as const) {
      expect(markup).not.toContain(t("en", key));
    }
    expect(markup).not.toContain(t("en", "settings.providers.title"));
    expect(markup).toContain(t("en", "apps.shareAppSwitch"));
  });

  test("an App with several repositories says so, not the zero-repository state", () => {
    const many = { ...untargetedPayload, targets_many: true };
    expect(parseSettings(many)?.targets_many).toBe(true);
    const markup = renderDetail(many);
    expect(markup).toContain(t("en", "appDetail.targetsMany"));
    expect(markup).not.toContain(t("en", "appDetail.noRepository"));
    expect(markup).not.toContain(t("en", "settings.ops"));
    expect(markup).not.toContain(t("en", "settings.providers.title"));
    expect(markup).toContain(t("en", "apps.shareAppSwitch"));
    expect(parseSettings({ ...untargetedPayload, targets_many: "yes" })).toBeNull();
  });

  test("the detail links to REAL bots — the mounted chain, or the usable-bot list, never an inferred App id", () => {
    // F7: with no chain row the link is the workspace's usable-bot list.
    const chainless = renderDetail(managePayload);
    expect(chainless).toContain(`href="${apiBase()}/apps?tab=bots"`);
    expect(chainless).toContain(t("en", "appDetail.botSettingsLink"));
    expect(chainless).not.toContain(`href="${apiBase()}/apps/1/bot"`);

    // F7: a mounted chain links each mounted BOT id, never the App id.
    const mounted = renderDetail({
      ...managePayload,
      chain: [chainRow({ position: 1, bot_id: "bot-a" }), chainRow({ position: 2, bot_id: "bot-b" })],
    });
    expect(mounted).toContain(`href="${apiBase()}/bots/bot-a"`);
    expect(mounted).toContain(`href="${apiBase()}/bots/bot-b"`);
    expect(mounted).not.toContain(`href="${apiBase()}/apps/1/bot"`);
  });

  test("the identity status pill renders the shared primitive from the single derivation", () => {
    const manage = renderDetail(managePayload);
    expect(manage).toContain(t("en", "apps.status.active"));
    expect(manage).toContain('data-tone="success"');
    expect(appStatusPill("en", { status: "active", review_enabled: 0 })).toEqual({
      label: t("en", "apps.status.paused"),
      tone: "warn",
    });
    expect(appStatusPill("en", { status: "disabled", review_enabled: 1 })).toEqual({
      label: t("en", "apps.status.disabled"),
      tone: "warn",
    });
  });
});

describe("installed tab configuration surface (static SSR)", () => {
  test("the install block links to the App's GitHub installation page", () => {
    const manage = renderDetail(managePayload);
    expect(manage).toContain('href="https://github.com/apps/demo/installations/new"');
    expect(manage).toContain('target="_blank"');
    expect(manage).toContain('rel="noopener noreferrer"');
    expect(manage).toContain(
      t("en", "settings.installLinkAria", { link: t("en", "settings.installLink"), name: "Demo" }),
    );
    expect(manage).toContain(t("en", "settings.installCopy"));
  });

  test("the install block renders the App's avatar image", () => {
    const manage = renderDetail(
      {
        ...managePayload,
        app: { ...managePayload.app, github_avatar_url: "https://avatars.example/demo.png" },
      },
      "installations",
    );
    expect(manage).toContain(t("en", "settings.installCopy"));
    const avatar = manage.slice(manage.indexOf(t("en", "settings.installCopy")));
    expect(avatar).toContain('<img src="https://avatars.example/demo.png"');
  });

  test("a null slug keeps the block with explanations and offers no dead link", () => {
    const noSlug = renderDetail(
      { ...managePayload, app: { ...managePayload.app, github_slug: null } },
      "installations",
    );
    expect(noSlug).not.toContain("installations/new");
    expect(noSlug).toContain(t("en", "settings.installNoSlug"));
    expect(noSlug).toContain(t("en", "settings.install"));
  });

  test("no release version string renders anywhere on the page", () => {
    for (const markup of [renderDetail(managePayload), renderDetail(identityPayload)]) {
      expect(markup).not.toContain(`v${APP_VERSION}`);
    }
  });
});

describe("installation roster on the installed tab (static SSR)", () => {
  const rosterRows = (container: HTMLElement): string[][] => {
    const table = [...container.querySelectorAll("table")].find((node) =>
      (node.querySelector("thead")?.textContent ?? "").includes(t("en", "settings.installationsAccount")),
    );
    if (table === undefined) return [];
    return [...table.querySelectorAll("tbody tr")].map((row) =>
      [...row.querySelectorAll("td")].map((cell) => (cell.textContent ?? "").trim()),
    );
  };

  test("one row per installation carries its account, id, last sync and state", async () => {
    const markup = renderDetail(
      {
        ...managePayload,
        installations: [
          { installation_id: 123, account_login: "acme", seen_at: new Date().toISOString() },
          { installation_id: 456, account_login: null, seen_at: new Date().toISOString() },
        ],
      },
      "installations",
    );
    const rows = await withMarkup(markup, rosterRows);

    expect(rows).toHaveLength(2);
    expect(rows.map((cells) => cells[0])).toEqual(["acme", t("en", "common.time.unknown")]);
    expect(rows.map((cells) => cells[1])).toEqual(["123", "456"]);
    expect(rows.map((cells) => cells[2])).toEqual([
      t("en", "common.time.justNow"),
      t("en", "common.time.justNow"),
    ]);
    for (const cells of rows) expect(cells[3]).toBe(t("en", "settings.installationsLive"));
  });

  test("the last-sync cell follows the stamp it is given, not a constant", async () => {
    const stamp = new Date(Date.now() - 2 * 86_400_000 - 3_600_000).toISOString();
    const markup = renderDetail(
      {
        ...managePayload,
        installations: [{ installation_id: 123, account_login: "acme", seen_at: stamp }],
      },
      "installations",
    );
    const rows = await withMarkup(markup, rosterRows);
    expect(rows[0]?.[2]).toBe(t("en", "common.time.daysAgo", { count: 2 }));
    expect(await withMarkup(markup, (container) => {
      const cell = container.querySelector(`td span[title]`);
      return cell?.getAttribute("title") ?? null;
    })).toBe(stamp);
  });

  test("the roster's rows and the header band's figure are the same count", async () => {
    for (const count of [0, 1, 3] as const) {
      const markup = renderDetail(
        {
          ...managePayload,
          installations: Array.from({ length: count }, (_, index) => ({
            installation_id: 100 + index,
            account_login: `acme-${index}`,
            seen_at: "2026-01-01 00:00:00",
          })),
        },
        "installations",
      );
      const banded = /data-slot="metric-key"[^>]*>Installations<\/span><span data-slot="metric-value"[^>]*>(\d+)</.exec(
        markup,
      )?.[1];
      expect(banded, `band at ${count}`).toBe(String(count));
      expect(await withMarkup(markup, rosterRows), `rows at ${count}`).toHaveLength(
        Number(banded),
      );
    }
  });

  test("an App with no installation states it instead of an empty table", () => {
    const markup = renderDetail({ ...managePayload, installations: [] }, "installations");
    expect(markup).toContain(t("en", "settings.noInstallations"));
    expect(markup).toMatch(
      /data-slot="metric-key"[^>]*>Installations<\/span><span data-slot="metric-value"[^>]*>0</,
    );
  });
});

describe("tab shell mounted behaviour (forceMount)", () => {
  const mountedPayload: SettingsPayload = managePayload;

  function ShellHarness() {
    const [tabSearch, setTabSearch] = useState<AppDetailSearch>(search);
    return createElement(AppDetailView, {
      locale: "en",
      appId: "1",
      payload: mountedPayload,
      groups: [],
      notice: null,
      search: tabSearch,
      onReload: noReload,
      onSearch: setTabSearch,
    });
  }

  const click = async (win: Window, node: DomElement | null | undefined) => {
    const pointer = (type: string) =>
      new win.PointerEvent(type, { bubbles: true, cancelable: true, button: 0 });
    const mouse = (type: string) =>
      new win.MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
    await act(async () => {
      node?.dispatchEvent(pointer("pointerdown"));
      node?.dispatchEvent(mouse("mousedown"));
      node?.dispatchEvent(pointer("pointerup"));
      node?.dispatchEvent(mouse("mouseup"));
      node?.dispatchEvent(mouse("click"));
    });
    await act(async () => {});
  };

  const tabTrigger = (container: DomElement, label: string) =>
    [...container.querySelectorAll('[role="tab"]')].find((tab) => tab.textContent === label);

  const panelOf = (container: DomElement, node: DomElement | null) => {
    let current: DomElement | null = node;
    let outer: DomHTMLElement | null = null;
    while (current !== null && current !== container) {
      if (current.getAttribute("role") === "tabpanel") outer = current as DomHTMLElement;
      current = current.parentElement;
    }
    return outer;
  };

  const shellPanels = (container: DomElement) =>
    [...container.querySelectorAll('[data-slot="tabs-content"]')].filter(
      (panel) => panelOf(container, panel) === panel,
    );

  test("an inactive panel stays mounted but hidden across a full tab round trip", async () => {
    const { win, cleanup } = installDom("http://localhost/dashboard/apps/1");
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(createElement(ShellHarness)));
      const settingsPanel = shellPanels(container)[0]!;
      expect(settingsPanel.getAttribute("data-state")).toBe("active");
      expect(
        shellPanels(container)
          .slice(1)
          .every((panel) => panel.getAttribute("data-state") === "inactive"),
      ).toBe(true);

      await click(win, tabTrigger(container, t("en", "appDetail.tabInstallations")));
      expect(shellPanels(container)[0]).toBe(settingsPanel);
      expect(settingsPanel.getAttribute("data-state")).toBe("inactive");

      await click(win, tabTrigger(container, t("en", "appDetail.tabSettings")));
      expect(shellPanels(container)[0]).toBe(settingsPanel);
      expect(settingsPanel.getAttribute("data-state")).toBe("active");
    } finally {
      await act(async () => root.unmount());
      cleanup();
    }
  });

  async function mountPageWithHeldPayload(url: string, body: unknown) {
    const { win, cleanup } = installDom(url);
    const realFetch = globalThis.fetch;
    let release: () => void = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const json = (value: unknown) =>
      new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
    globalThis.fetch = (async (input: unknown) => {
      const target = String(input);
      if (target.endsWith("/models")) return json({ groups: [] });
      if (target.includes("/api/provider-catalog")) return json({ provider_catalog: [], model_limits_snapshot: "fixture" });
      await held;
      return json(body);
    }) as unknown as typeof fetch;
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    await act(async () => root.render(createElement(AppDetailPage, { boot: BOOT, appId: "1" })));
    return {
      win,
      container,
      release: async () => {
        release();
        for (let flush = 0; flush < 4; flush += 1) await act(async () => {});
      },
      unmount: async () => {
        await act(async () => root.unmount());
        globalThis.fetch = realFetch;
        cleanup();
      },
    };
  }

  test("the App's settings tab renders without the bot's model editors, which moved to the bot page", async () => {
    const { win, cleanup } = installDom("https://worker.local/dashboard/default/apps/1");
    const realFetch = globalThis.fetch;
    let releaseModels!: () => void;
    const models = new Promise<void>((resolve) => { releaseModels = resolve; });
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      if (url.endsWith("/apps/1")) return Response.json({
        ...managePayload, provider_catalog_version: "fixture-ready", provider_eligibility: {},
      });
      if (url.endsWith("/models")) {
        await models;
        return Response.json({ groups: [{ provider: "anthropic", source: "verified", selectors: ["anthropic/fixture-model"] }] });
      }
      if (url.includes("/deliveries")) return Response.json({ deliveries: [], total: 0, repos: [], types: [] });
      throw new Error(`Unexpected request: ${url}`);
    }) as typeof fetch;
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(createElement(AppDetailPage, { boot: BOOT, appId: "1" })));
      expect(container.textContent).toContain("Demo");
      expect(tabTrigger(container, t("en", "appDetail.tabDelivery"))).toBeDefined();
      // Models may still be in flight; the App face never waits on them and
      // never shows the bot's editors (those live on /bots/:botId now).
      expect(container.querySelector(`[aria-label="${t("en", "settings.modelChainField")}"]`)).toBeNull();
      expect(container.textContent).toContain(t("en", "apps.shareAppSwitch"));
      await click(win, tabTrigger(container, t("en", "appDetail.tabDelivery")));
      expect(container.textContent).toContain(t("en", "appDetail.delivery.emptyTitle"));
      await act(async () => { releaseModels(); });
      expect(container.querySelector(`[aria-label="${t("en", "settings.modelChainField")}"]`)).toBeNull();
    } finally {
      releaseModels();
      await act(async () => root.unmount());
      globalThis.fetch = realFetch;
      cleanup();
    }
  });

  // Deleted: "model failure stays nonfatal and a provider-local catalog
  // failure can be retried" — both behaviours belong to the bot page's
  // model/catalog editors, which the App detail no longer renders.

  const activeTabLabel = (win: Window, container: DomElement) => {
    const active = shellPanels(container).filter((panel) => panel.getAttribute("data-state") === "active");
    if (active.length !== 1) return active.length === 0 ? "" : "multiple";
    const labelledBy = active[0]?.getAttribute("aria-labelledby") ?? "";
    return win.document.getElementById(labelledBy)?.textContent ?? "";
  };

  test("history traversal re-derives the tab from the URL, through the gate mirror", async () => {
    const page = await mountPageWithHeldPayload("http://localhost/dashboard/apps/1", managePayload);
    try {
      await page.release();
      expect(activeTabLabel(page.win, page.container)).toBe(t("en", "appDetail.tabSettings"));

      page.win.history.pushState(null, "", "/dashboard/apps/1?tab=installations");
      await act(async () => page.win.dispatchEvent(new page.win.Event("popstate")));
      await act(async () => {});
      expect(activeTabLabel(page.win, page.container)).toBe(t("en", "appDetail.tabInstallations"));

      page.win.history.pushState(null, "", "/dashboard/apps/1");
      await act(async () => page.win.dispatchEvent(new page.win.Event("popstate")));
      await act(async () => {});
      expect(activeTabLabel(page.win, page.container)).toBe(t("en", "appDetail.tabSettings"));
    } finally {
      await page.unmount();
    }
  });

  test("a null cached avatar renders AppAvatar's bg-muted fallback in the install block once the derived icon misses", async () => {
    const payload = {
      ...managePayload,
      app: { ...managePayload.app, github_avatar_url: null },
    };
    const { win, cleanup } = installDom("http://localhost/dashboard/apps/1");
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () =>
        root.render(
          createElement(AppDetailView, {
            locale: "en",
            appId: "1",
            payload,
            groups: [],
            notice: null,
            search: { ...search, tab: "installations" },
            onReload: noReload,
            onSearch: noSearch,
          }),
        ),
      );
      const img = container.querySelector('img[class*="h-10 w-10"]');
      expect(img?.getAttribute("src")).toBe("https://avatars.githubusercontent.com/in/1?s=120&v=4");

      await act(async () => {
        img!.dispatchEvent(new win.Event("error"));
      });
      const fallback = container.querySelector(".bg-muted.rounded-full");
      expect(fallback?.getAttribute("class")).toContain("h-10 w-10");
      expect(container.querySelector('img[class*="h-10 w-10"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      cleanup();
    }
  });
});

describe("workspace switch on the App detail page (SF-1)", () => {
  async function readUnder(pathname: string): Promise<string[]> {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      calls.push(String(input));
      return new Response(JSON.stringify(identityPayload), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const loaded = await loadAppDetail(apiBase(pathname), "1");
      expect(loaded?.can_manage).toBe(false);
      return calls;
    } finally {
      globalThis.fetch = realFetch;
    }
  }

  test("two workspaces sharing an app id issue two reads, the second under the new base", async () => {
    expect(await readUnder("/dashboard/acme/apps/1")).toEqual([
      "/dashboard/acme/api/apps/1",
    ]);
    expect(await readUnder("/dashboard/beta/apps/1")).toEqual([
      "/dashboard/beta/api/apps/1",
    ]);
  });

  test("the manage face reads the settings payload only — the model options belong to the same read", async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      calls.push(String(input));
      return new Response(JSON.stringify(managePayload), { status: 200 });
    }) as unknown as typeof fetch;
    try {
      const loaded = await loadAppDetail("/dashboard/beta", "1");
      expect(loaded?.can_manage).toBe(true);
      expect(calls).toEqual(["/dashboard/beta/api/apps/1"]);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});

describe("header metric band on the manage face (static SSR)", () => {
  const keyRow = { provider: "openai", keyId: "0123456789abcdef", last4: "1234", updatedAt: null, verifiedAt: null, verifiedStatus: "ok" as const };
  const chain = { name: "default", chain: "m", is_default: true, created_at: "2026-01-01 00:00:00", updated_at: "2026-01-01 00:00:00" };
  const installation = { installation_id: 1, account_login: "acme", seen_at: "2026-01-01 00:00:00" };
  const summary = (rejected24h: number) => ({
    latest: { event_name: "push", outcome: "ok", status_code: 200, created_at: "2026-01-01 00:00:00" },
    rejected24h,
  });

  const band = (payload: SettingsManagePayload) =>
    [...renderDetail(payload).matchAll(/data-slot="metric-key"[^>]*>([^<]+)<\/span><span data-slot="metric-value"[^>]*class="([^"]*)"[^>]*>(\d+)<\/span>/g)]
      .map((m) => ({ key: m[1]!, value: m[3]!, danger: m[2]!.includes("tone-danger") }));

  // F11: the band is App-scoped. `keys` and `model_chains` were BOT
  // configuration reached through an equal id, so the counts that remain are
  // installations, mounted bots (the chain), and the delivery refusals.
  const payloadWith = (counts: {
    mounted: number;
    installations: number;
    rejected: number | null;
  }): SettingsManagePayload => ({
    ...managePayload,
    installations: Array.from({ length: counts.installations }, () => installation),
    chain: Array.from({ length: counts.mounted }, (_, index) =>
      chainRow({ position: index + 1, bot_id: `bot-${index}` }),
    ),
    delivery_summary: counts.rejected === null ? undefined : summary(counts.rejected),
  });

  test("the three figures render in band order, each wired to its own source count", () => {
    const pairs = band(payloadWith({ installations: 2, mounted: 5, rejected: 7 }));
    expect(pairs.map(({ key, value }) => [key, value])).toEqual([
      ["Installations", "2"],
      ["Mounted bots", "5"],
      ["24h rejected", "7"],
    ]);
  });

  test("no bot-owned figure appears on the App band", () => {
    const pairs = band(payloadWith({ installations: 1, mounted: 1, rejected: 0 }));
    const keys = pairs.map(({ key }) => key);
    expect(keys).not.toContain("Keys");
    expect(keys).not.toContain("Model chains");
  });

  test("a zero rejected count renders without the danger tone; non-zero wears it", () => {
    const zero = band(payloadWith({ installations: 1, mounted: 1, rejected: 0 }));
    expect(zero[2]!).toEqual({ key: "24h rejected", value: "0", danger: false });
    const absent = band(payloadWith({ installations: 1, mounted: 1, rejected: null }));
    expect(absent[2]!).toEqual({ key: "24h rejected", value: "0", danger: false });
    const refused = band(payloadWith({ installations: 1, mounted: 1, rejected: 4 }));
    expect(refused[2]!).toEqual({ key: "24h rejected", value: "4", danger: true });
  });
});

describe("install entry (static SSR)", () => {
  const sharedPayload = (): SettingsManagePayload => ({
    ...managePayload,
    app: { ...managePayload.app, scope: "shared" },
    installation: null,
  });

  test("an unbound shared bot keeps the plain install link, like an owned bot", () => {
    const shared = renderDetail(sharedPayload(), "installations");
    expect(shared).toContain('href="https://github.com/apps/demo/installations/new"');
    expect(shared).toContain(t("en", "settings.installLink"));
    expect(shared).toContain(t("en", "settings.installCopy"));

    const owned = renderDetail(
      { ...sharedPayload(), app: { ...sharedPayload().app, scope: "owned" } },
      "installations",
    );
    expect(owned).toContain('href="https://github.com/apps/demo/installations/new"');
    expect(owned).toContain(t("en", "settings.installLink"));
    expect(owned).toContain(t("en", "settings.installCopy"));
  });

  test("the install block renders the bound installation's account", () => {
    const bound = renderDetail(
      { ...sharedPayload(), installation: { id: 4242, account_login: "acme", removed: false } },
      "installations",
    );
    expect(bound).toContain(t("en", "settings.installBoundAccount", { account: "acme" }));
    expect(bound).not.toContain(t("en", "settings.installRemoved"));
  });

  test("the install block separates an unknown account from a removed installation", () => {
    const unknownAccount = renderDetail(
      { ...sharedPayload(), installation: { id: 4242, account_login: null, removed: false } },
      "installations",
    );
    expect(unknownAccount).toContain(t("en", "settings.installBoundNoAccount", { id: "4242" }));

    const removed = renderDetail(
      { ...sharedPayload(), installation: { id: 4242, account_login: "acme", removed: true } },
      "installations",
    );
    expect(removed).toContain(t("en", "settings.installRemoved"));
    expect(removed).toContain(t("en", "settings.installBoundAccount", { account: "acme" }));
  });

  test("the install payload fields parse fail-closed", () => {
    expect(parseSettings(sharedPayload())?.can_manage).toBe(true);
    expect(parseSettings({ ...sharedPayload(), app: { ...sharedPayload().app, scope: "global" } })).toBeNull();
    expect(
      parseSettings({ ...sharedPayload(), installation: { id: "4242", account_login: null, removed: false } }),
    ).toBeNull();
    expect(
      parseSettings({ ...sharedPayload(), installation: { id: 4242, account_login: null, removed: "yes" } }),
    ).toBeNull();
    expect(parseSettings({ ...sharedPayload(), installation: null })?.can_manage).toBe(true);
  });
});

describe("Blocked and pending installations (static SSR)", () => {

  const sharedPayload = (): SettingsManagePayload => ({
    ...managePayload,
    app: { ...managePayload.app, scope: "shared" },
    installation: null,
  });

  test("the Blocked banner names the reason on both faces", () => {
    const manager = renderDetail(blockedPayload());
    expect(manager).toContain(t("en", "appDetail.blockedBotNotShared"));
    expect(manager).not.toContain(t("en", "appDetail.botSettingsLink"));
    expect(manager).not.toContain(t("en", "settings.installations"));
    expect(manager).not.toContain(t("en", "settings.metricKeys"));
    expect(manager).not.toContain(t("en", "settings.reviewGate"));

    const member = renderToStaticMarkup(
      createElement(AppDetailView, {
        locale: "en",
        appId: "1",
        payload: {
          ...identityPayload,
          blocked: true,
          blocked_reason: "bot_not_shared",
        },
        groups: [],
        notice: null,
        search,
        onReload: noReload,
        onSearch: noSearch,
      }),
    );
    expect(member).toContain(t("en", "appDetail.blockedBotNotShared"));
  });

  test("a Blocked target hides the install action and keeps its review settings", async () => {
    const installed = renderDetail(blockedPayload(), "installations");
    expect(installed).not.toContain(t("en", "settings.installLink"));
    expect(installed).not.toContain('href="https://github.com/apps/demo/installations/new"');
    expect(installed).not.toContain(t("en", "settings.installPendingBind"));

    expect(installed).not.toContain(t("en", "settings.appInfoDeliveryUrl"));
    expect(installed).not.toContain(t("en", "settings.appInfoRefresh"));

    expect(installed).not.toContain(t("en", "settings.installations"));
    expect(installed).not.toContain(t("en", "settings.installationsAccount"));
    expect(installed).not.toContain(t("en", "settings.noInstallations"));
    expect(await withMarkup(installed, (container) => container.querySelectorAll("tbody tr"))).toHaveLength(
      0,
    );
  });

  test("an unbound shared target renders one bind action per pending installation", () => {
    const pending: SettingsManagePayload = {
      ...sharedPayload(),
      pending_installations: [
        { installation_id: 500, account_login: "acme", seen_at: "2026-01-01 00:00:00" },
        { installation_id: 501, account_login: null, seen_at: "2026-01-01 00:00:00" },
      ],
    };
    const markup = renderDetail(pending, "installations");
    expect(markup.match(new RegExp(t("en", "settings.installPendingBind"), "g"))).toHaveLength(2);
    expect(markup).toContain("acme");
    expect(markup).toContain(t("en", "settings.installPendingUnknownAccount", { id: "501" }));

    const bound = renderDetail(
      { ...pending, installation: { id: 4242, account_login: "acme", removed: false } },
      "installations",
    );
    expect(bound).not.toContain(t("en", "settings.installPendingBind"));
  });

  test("an owned target offers no bind action — the route refuses a non-shared bot", () => {
    const ownedPending: SettingsManagePayload = {
      ...sharedPayload(),
      app: { ...sharedPayload().app, scope: "owned" },
      pending_installations: [
        { installation_id: 500, account_login: "acme", seen_at: "2026-01-01 00:00:00" },
      ],
    };
    const markup = renderDetail(ownedPending, "installations");
    expect(markup).not.toContain(t("en", "settings.installPendingBind"));
    expect(markup).toContain('href="https://github.com/apps/demo/installations/new"');
  });

  test("the new fields parse fail-closed on both manager faces", () => {
    expect(parseSettings(managePayload)?.can_manage).toBe(true);
    expect(parseSettings(identityPayload)?.can_manage).toBe(false);
    expect(parseSettings(blockedPayload())?.blocked).toBe(true);
    for (const broken of [
      { ...blockedPayload(), blocked: false },
      { ...blockedPayload(), blocked_reason: "other" },
      { ...blockedPayload(), app: { ...blockedPayload().app, review_trigger_mode: "sometimes" } },
      { ...blockedPayload(), installation: { id: "1", account_login: null, removed: false } },
    ]) {
      expect(parseSettings(broken)).toBeNull();
    }
    const { target_id: _blockedTarget, ...blockedWithoutTarget } = blockedPayload();
    expect(parseSettings(blockedWithoutTarget)).toBeNull();
    const blockedMany = {
      ...blockedPayload(),
      target_id: null,
      targets_many: true,
      app: {
        github_app_id: blockedPayload().app.github_app_id,
        id: blockedPayload().app.id,
        status: "active",
        created_by: "mallory",
        scope: "owned",
        github_name: null,
        github_slug: "demo",
        github_description: null,
        github_html_url: null,
        github_avatar_url: null,
        github_visibility: "unknown",
      },
      installation: null,
    };
    expect(parseSettings(blockedMany)).not.toBeNull();
    expect(parseSettings(blockedMany)?.target_id).toBeNull();
    expect(parseSettings(blockedMany)?.targets_many).toBe(true);
    for (const broken of [
      { ...blockedMany, targets_many: false },
      { ...blockedMany, targets_many: undefined },
      { ...blockedMany, app: { ...blockedMany.app, review_enabled: true } },
      { ...managePayload, target_id: null, targets_many: true },
    ]) {
      expect(parseSettings(broken)).toBeNull();
    }
    const { github_metadata_synced_at: _stamp, ...identityWithoutStamp } = identityPayload.app;
    expect(parseSettings({ ...identityPayload, app: identityWithoutStamp })).toBeNull();
    expect(
      parseSettings({
        ...identityPayload,
        blocked: true,
        blocked_reason: "bot_not_shared",
        app: identityWithoutStamp,
      }),
    ).not.toBeNull();
    expect(
      parseSettings({
        ...managePayload,
        pending_installations: [{ installation_id: "500", account_login: null, seen_at: "x" }],
      }),
    ).toBeNull();
    const { pending_installations: _pending, ...withoutPending } = managePayload;
    expect(parseSettings(withoutPending)).toBeNull();
  });
});

describe("投递状态 tab", () => {
  const summary = { last_webhook_at: null, rejected24h: 0 };
  const deliveryResponse = {
    deliveries: [
      {
        event_name: "pull_request",
        outcome: "rejected",
        status_code: 401,
        repository_full_name: "acme/web",
        reason: "signature verification failed",
        created_at: "2026-01-01 00:00:00",
      },
      {
        event_name: "check_run",
        outcome: "ignored",
        status_code: null,
        repository_full_name: null,
        reason: null,
        created_at: "2026-01-01 00:00:00",
      },
    ],
    total: 42,
    repos: ["acme/web", "acme/api"],
    types: ["check_run", "pull_request"],
  };
  const deliveryPage = parseDeliveryPage(deliveryResponse)!;

  const renderTab = (page: typeof deliveryPage | null) =>
    createElement(DeliveryStatusView, {
      locale: "en",
      summary,
      page,
      filters: { repo: "", since: "", type: "" },
      offset: 0,
      loading: false,
      onFilter: () => {},
      onPage: () => {},
      onReload: () => {},
    });
  const markupOf = (page: typeof deliveryPage | null) =>
    renderToStaticMarkup(renderTab(page));

  test("renders every column the task asks for, and the refusal reason on a rejected row", () => {
    const markup = markupOf(deliveryPage);
    for (const key of [
      "appDetail.delivery.columnRepo",
      "appDetail.delivery.columnType",
      "appDetail.delivery.columnTime",
      "appDetail.delivery.columnOutcome",
      "appDetail.delivery.columnReason",
    ] as const) {
      expect(markup, key).toContain(t("en", key));
    }
    expect(markup).toContain("acme/web");
    expect(markup).toContain("pull_request");
    expect(markup).toContain("signature verification failed");
    expect(markup).toContain(t("en", "appDetail.delivery.unknownRepo"));
  });

  test("offers the three named filters plus the pager", async () => {
    const markup = markupOf(deliveryPage);
    expect(await withMarkup(markup, (container) => [
      ...container.querySelectorAll("[aria-label]"),
    ].map((node) => node.getAttribute("aria-label")))).toEqual(
      expect.arrayContaining([
        t("en", "appDetail.delivery.filterRepo"),
        t("en", "appDetail.delivery.filterWindow"),
        t("en", "appDetail.delivery.filterType"),
      ]),
    );
    expect(markup).toContain(t("en", "appDetail.delivery.pageRange", { from: 1, to: 20, total: 42 }));
    expect(markup).toContain(t("en", "appDetail.delivery.pagePrev"));
    expect(markup).toContain(t("en", "appDetail.delivery.pageNext"));
  });

  test("an empty page states it rather than rendering a bare header band", () => {
    const markup = markupOf({ rows: [], total: 0, repos: [], types: [] });
    expect(markup).toContain(t("en", "appDetail.delivery.emptyTitle"));
    expect(markup).toContain(t("en", "appDetail.delivery.emptyDescription"));
    expect(markup).not.toContain(t("en", "appDetail.delivery.columnReason"));
  });

  test("the read URL carries every filter and the offset; an unset filter is absent", () => {
    expect(appDeliveriesUrl("/dashboard", "1", { repo: "", since: "", type: "" }, 0)).toBe(
      "/dashboard/api/apps/1/deliveries",
    );
    expect(
      appDeliveriesUrl("/dashboard", "1", { repo: "acme/web", since: "7", type: "pull_request" }, 40),
    ).toBe(
      "/dashboard/api/apps/1/deliveries?repo=acme%2Fweb&since=7&type=pull_request&offset=40",
    );
  });

  test("the page parser is strict on total, lenient per row", () => {
    expect(parseDeliveryPage(deliveryResponse)).not.toBeNull();
    expect(deliveryPage.total).toBe(42);
    expect(deliveryPage.repos).toEqual(["acme/web", "acme/api"]);
    const { total: _total, ...withoutTotal } = deliveryResponse;
    expect(parseDeliveryPage(withoutTotal)).toBeNull();
    expect(parseDeliveryPage({ deliveries: [] })).toBeNull();
    const drifted = parseDeliveryPage({
      ...deliveryResponse,
      deliveries: [...deliveryResponse.deliveries, { outcome: "ok" }],
    });
    expect(drifted?.rows).toHaveLength(2);
    expect(drifted?.total).toBe(42);
  });

  test("?tab=delivery opens the tab, and its inverse round-trips", () => {
    expect(parseAppDetailSearch("?tab=delivery").tab).toBe("delivery");
    expect(appDetailSearchQuery({ tab: "delivery", window: "30", repo: "", pr: "" })).toBe(
      "?tab=delivery",
    );
  });

  test("the reverse 仓库 link is gone from every repository-count state", async () => {
    for (const payload of [
      untargetedPayload,
      { ...untargetedPayload, targets_many: true },
    ] as const) {
      const markup = renderDetail(payload as SettingsPayload);
      expect(
        await withMarkup(markup, (container) => [
          ...container.querySelectorAll("a"),
        ].map((node) => node.getAttribute("href"))),
      ).not.toContain(`${apiBase()}/targets`);
    }
  });
});

describe("the bots tab renders the ordered chain read-only (D29, D35)", () => {
  const chainRows = async (markup: string): Promise<string[][]> =>
    withMarkup(markup, (container) => {
      const table = [...container.querySelectorAll("table")].find((node) =>
        (node.querySelector("thead")?.textContent ?? "").includes(t("en", "apps.chain.columnPosition")),
      );
      if (table === undefined) return [];
      return [...table.querySelectorAll("tbody tr")].map((row) =>
        [...row.querySelectorAll("td")].map((cell) => (cell.textContent ?? "").trim()),
      );
    });

  test("?tab=bots opens the tab and its inverse round-trips; unknown values still fall back", () => {
    expect(parseAppDetailSearch("?tab=bots").tab).toBe("bots");
    expect(appDetailSearchQuery({ tab: "bots", window: "30", repo: "", pr: "" })).toBe("?tab=bots");
    expect(parseAppDetailSearch("?tab=chain").tab).toBe("settings");
  });

  test("position, bot name, provider, multiplier and the month cell render in chain order", async () => {
    const markup = renderDetail(
      {
        ...managePayload,
        chain: [
          chainRow({ position: 1, bot_id: "bot-a", name: "Mstar Standard", owned: false, multiplier: 1.5, month_used_rp: 1240 }),
          chainRow({ position: 2, bot_id: "bot-b", name: "acme-own", month_used_rp: 0 }),
        ],
      },
      "bots",
    );
    const rows = await chainRows(markup);

    expect(rows.map((cells) => cells[0])).toEqual(["1", "2"]);
    expect(rows[0]![1]).toContain("Mstar Standard");
    expect(rows[0]![1]).toContain(t("en", "apps.chain.tagShared"));
    expect(rows[1]![1]).toContain(t("en", "apps.chain.tagMine"));
    expect(rows.map((cells) => cells[3])).toEqual(["×1.5", "×1"]);
    expect(rows[0]![4]).toContain("1240");
  });

  test("a manager gets reorder controls; a reader gets none", async () => {
    const row = chainRow({ position: 1, bot_id: "bot-a" });
    const managed = await withMarkup(renderDetail({ ...managePayload, chain: [row] }, "bots"), (container) =>
      [...container.querySelectorAll("[data-slot='app-chain-reorder'] button")].map((node) => node.textContent ?? ""),
    );
    // The order is editable now that `selectReviewBot` reads it (D29): the
    // editor and the code that reads the order ship in the same release. One
    // row, so both arrows are disabled and the remove control is present (D27
    // keeps the LAST row visible).
    expect(managed).toEqual(["↑", "↓", "✕"]);

    const readOnly = await withMarkup(
      renderDetail({ ...managePayload, can_manage: false, chain: [row] }, "bots"),
      (container) => container.querySelectorAll("[data-slot='app-chain-reorder']").length,
    );
    expect(readOnly).toBe(0);
  });

  test("an empty chain names the next step instead of rendering a blank table", async () => {
    // F4: with no PENDING bind, an empty chain is the honest "nothing mounted"
    // answer — not the pending-bind copy, which says no chain can exist yet.
    const markup = renderDetail({ ...managePayload, chain: [], pending_installations: [] }, "bots");
    expect(markup).toContain(t("en", "apps.chain.empty"));
    expect(markup).not.toContain(t("en", "apps.chain.pendingBind"));
    expect(await chainRows(markup)).toEqual([]);
  });

  test("an unbound shared installation yields the pending-bind copy, not the generic empty answer", async () => {
    // F4: pending is a REAL bind state (an unbound installation of a shared App),
    // never `blocked` and never the raw installation array — an owned App's
    // unbound rows are not binds at all.
    const pending = renderDetail(
      {
        ...managePayload,
        chain: [],
        pending_installations: [{ installation_id: 77, account_login: "acme", seen_at: new Date().toISOString() }],
      },
      "bots",
    );
    expect(pending).toContain(t("en", "apps.chain.pendingBind"));
    expect(pending).not.toContain(t("en", "apps.chain.empty"));
  });

  test("a bot its owner stopped sharing renders as a skipped row", async () => {
    const markup = renderDetail(
      { ...managePayload, chain: [chainRow({ position: 1, bot_id: "bot-a", owned: false, available: false })] },
      "bots",
    );
    expect(markup).toContain(t("en", "apps.chain.rowUnavailable"));
  });

  test("the App band and the bot link read the chain, not a same-id bot", async () => {
    const markup = renderDetail(
      { ...managePayload, chain: [chainRow({ position: 1, bot_id: "bot-a" })] },
    );
    expect(markup).toContain(`href="${apiBase()}/bots/bot-a"`);
    expect(markup).toContain(t("en", "appDetail.metricMountedBots"));
  });
});

describe("F3/F5 — the chain reaches members, blocked managers, and states its ceiling", () => {
  const chainRows = async (markup: string): Promise<string[][]> =>
    withMarkup(markup, (container) => {
      const table = [...container.querySelectorAll("table")].find((node) =>
        (node.querySelector("thead")?.textContent ?? "").includes(t("en", "apps.chain.columnPosition")),
      );
      if (table === undefined) return [];
      return [...table.querySelectorAll("tbody tr")].map((row) =>
        [...row.querySelectorAll("td")].map((cell) => (cell.textContent ?? "").trim()),
      );
    });

  test("a member's identity-only face renders the read-only chain", async () => {
    const markup = renderDetail(
      {
        ...identityPayload,
        chain: [chainRow({ position: 1, bot_id: "bot-a", name: "Mstar Standard", owned: false, multiplier: 1.5 })],
      },
    );
    expect(markup).toContain(t("en", "apps.chain.title"));
    expect((await chainRows(markup)).map((cells) => cells[0])).toEqual(["1"]);
  });

  test("a blocked manager keeps the chain and its unavailable row", async () => {
    const markup = renderDetail(
      {
        ...blockedPayload(),
        chain: [chainRow({ position: 1, bot_id: "bot-a", owned: false, available: false })],
      } as SettingsBlockedPayload,
      "bots",
    );
    expect(markup).toContain(t("en", "apps.chain.rowUnavailable"));
    // The blocked face renders the skipped row, never the pending-bind sentence.
    expect(markup).not.toContain(t("en", "apps.chain.pendingBind"));
  });

  test("a blocked manager with no chain at all gets the empty-chain answer", async () => {
    const markup = renderDetail(
      {
        ...blockedPayload(),
        chain: [],
        installations: [{ installation_id: 1, account_login: "acme", seen_at: new Date().toISOString() }],
      } as SettingsBlockedPayload,
      "bots",
    );
    expect(markup).toContain(t("en", "apps.chain.empty"));
    expect(markup).not.toContain(t("en", "apps.chain.pendingBind"));
  });

  test("each row states its real ceiling: owned unlimited, shared cap, shared uncapped", async () => {
    const markup = renderDetail(
      {
        ...managePayload,
        chain: [
          chainRow({ position: 1, bot_id: "bot-own", owned: true, month_used_rp: 40, monthly_rp: 500 }),
          chainRow({ position: 2, bot_id: "bot-capped", owned: false, month_used_rp: 1240, monthly_rp: 2000 }),
          chainRow({ position: 3, bot_id: "bot-free", owned: false, month_used_rp: 10, monthly_rp: null }),
        ],
      },
      "bots",
    );
    const rows = await chainRows(markup);

    expect(rows[0]![4]).toContain(t("en", "bots.monthOwn", { used: 40 }));
    expect(rows[1]![4]).toContain(t("en", "bots.monthLimit", { used: 1240, limit: 2000 }));
    expect(rows[2]![4]).toContain(t("en", "bots.monthNoCeiling", { used: 10 }));
  });
});
