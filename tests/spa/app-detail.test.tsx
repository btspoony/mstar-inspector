/**
 * App detail page: the tab shell's product behaviour.
 * Static-SSR over the pure views plus happy-dom mounts for the stateful
 * shell, the repo's standard duo (charts-recharts precedent for SSR).
 *
 * 1. Tab shell: the manager face's tabs are the App's own — 应用设置 (the
 *    default) and 已安装. A non-manager sees the identity card with no tab bar
 *    at all (absence pinned).
 * 2. 应用设置 composes the App's identity header, its ops zone and the bot's
 *    own sections; an App the workspace has added no repository under yet has
 *    no ops zone and no review policy — it states that and points at the
 *    repository surface.
 * 3. Mount-once tab switching keeps the inactive panel mounted (typed state and
 *    every editor survive a switch).
 * 4. The target-owned review policy lives on the review-target surface and is
 *    pinned through `SettingsView` here.
 */
import { describe, expect, test } from "bun:test";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { type Element as DomElement, type HTMLElement as DomHTMLElement, type Window } from "happy-dom";
import { t } from "../../src/i18n";
import {
  appDetailSearchQuery,
  appInsightsSummaryUrl,
  appStatusPill,
  parseAppDetailSearch,
  parseSettings,
  PR_VERDICTS,
  pullRequestRefOf,
  type AppDetailSearch,
  type AppDetailTab,
  type SettingsBlockedPayload,
  type SettingsManagePayload,
  type SettingsPayload,
  type SettingsUntargetedPayload,
} from "../../src/spa/pages/data";
import { AppDetailPage, AppDetailView, loadAppDetail } from "../../src/spa/pages/AppDetailPage";
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
  // The derived Blocked state rides BOTH faces: a member must know why the
  // target reviews nothing.
  blocked: false as const,
  blocked_reason: null,
  app: IDENTITY_APP,
};

/** Minimal boot for mounting the stateful shell (the URL-state test). */
const BOOT = { locale: "en" as const, login: "mallory", name: null };

const managePayload = {
  can_manage: true as const,
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
  allowlist: { enabled: false, owners: [] },
  owner_overlap: false,
  keys: [],
  model_chain: null,
  model_limits_snapshot: "2026-01-01",
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

/**
 * The manager face of an App the workspace has added no repository under yet:
 * the bot's sections are the whole payload, and every target-owned fact —
 * `target_id`, the pause state, the review policy, the gate, the allowlist —
 * is ABSENT rather than defaulted.
 */
const untargetedPayload: SettingsUntargetedPayload = {
  can_manage: true,
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
  model_limits_snapshot: "2026-01-01",
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

/**
 * The review-target surface's detail body — the target-owned policy the App
 * detail used to host as its settings tab. The page shell (load, back link,
 * identity header) is pinned by the targets-page suite.
 */
function renderTargetBody(payload: SettingsPayload) {
  return renderToStaticMarkup(
    createElement(SettingsView, { locale: "en", payload, onReload: noReload }),
  );
}

describe("settings payload parser — the target-owned slice is all-or-nothing", () => {
  test("a face naming a target carries its pause state; a target-less face carries neither, and a half slice is refused", () => {
    // Both faces carry the review configuration's id beside workspace_id when
    // the workspace has a repository under this App.
    expect(parseSettings(identityPayload)?.can_manage).toBe(false);
    expect(parseSettings(identityPayload)?.target_id).toBe("rt-1");
    expect(parseSettings(managePayload)?.can_manage).toBe(true);
    expect(parseSettings(managePayload)?.target_id).toBe("rt-1");
    // No target: nothing that belongs to one — a real state, not a breach.
    expect(parseSettings(untargetedPayload)).not.toBeNull();
    expect(parseSettings(untargetedPayload)?.target_id).toBeUndefined();
    // Half a slice is a breach on both faces: a payload that cannot name its
    // target cannot report its pause state either.
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
    // Unknown tab values — including the retired data-tab spellings — fall back
    // to the default; a URL cannot open a face this page does not own.
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
    // ONE grammar: whatever the URL state accepts, the detail read resolves —
    // and vice versa. The dot-segment spellings the old shape regex let
    // through are rejected on both sides, so the address bar can never
    // advertise a detail that can never open.
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
    // Off-set windows resolve to the default segment (pinned helper).
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

  test("the per-App summary URL is base-prefixed and encodes appId + filters; include=repos always rides", () => {
    expect(appInsightsSummaryUrl("/dashboard", "1", "30", "")).toBe(
      "/dashboard/api/apps/1/insights/summary?window=30&include=repos",
    );
    // A workspace-scoped page rides its own prefix (no legacy App family there).
    expect(appInsightsSummaryUrl("/dashboard/acme", "12345", "7", "acme/web")).toBe(
      "/dashboard/acme/api/apps/12345/insights/summary?window=7&include=repos&repo=acme%2Fweb",
    );
  });
});

describe("tab shell rendering (static SSR)", () => {
  /**
   * The PAGE's tab bar: the outermost tab list. Nested editors (the model
   * chain strip inside the settings panel) carry tab lists of their own, so a
   * bare `[role="tab"]` query would read those too.
   */
  const pageTabs = (container: HTMLElement): string[] =>
    [...(container.querySelector('[role="tablist"]')?.querySelectorAll('[role="tab"]') ?? [])].map(
      (tab) => tab.textContent ?? "",
    );

  test("the manager's tab bar is the App's own two faces, settings first", async () => {
    const manage = renderDetail(managePayload);
    // The triggers read by role and name, the way an assistive technology
    // finds them — never by serialized tag adjacency.
    expect(await withMarkup(manage, pageTabs)).toEqual([
      t("en", "appDetail.tabSettings"),
      t("en", "appDetail.tabInstallations"),
    ]);
    // The identity header serves every tab — the GitHub display name (D6).
    expect(manage).toContain(">Demo</h1>");
    expect(manage).toContain("by mallory");
  });

  test("a non-manager sees identity-only with no tab bar at all — absence pinned", async () => {
    const identity = renderDetail(identityPayload);
    expect(await withMarkup(identity, pageTabs)).toEqual([]);
    // The D4 identity card is the whole face.
    expect(identity).toContain(t("en", "settings.appInfo"));
    // No bot section markup anywhere on the face.
    expect(identity).not.toContain(t("en", "settings.providers.title"));
  });

  test("应用设置 composes the identity header, the ops zone and the bot's own sections", () => {
    const settings = renderDetail(managePayload);
    // The ops zone is the App's own (pause / disable / delete).
    expect(settings).toContain(t("en", "settings.ops"));
    // The bot-owned configuration the plan moves onto this tab.
    for (const key of [
      "settings.providers.title",
      "settings.modelChains",
      "settings.seats",
      "botSettings.health",
    ] as const) {
      expect(settings).toContain(t("en", key));
    }
    // The data faces and the target-owned policy are not this page's any more.
    for (const key of ["settings.reviewTrigger", "settings.reviewDepth", "settings.reviewGate"] as const) {
      expect(settings).not.toContain(t("en", key));
    }
    expect(settings).not.toContain("Review health");
  });

  test("已安装 keeps the install block; the allowlist and the installations table are gone", () => {
    const installed = renderDetail(
      {
        ...managePayload,
        installations: [
          { installation_id: 123, account_login: "acme", seen_at: "2026-01-01 00:00:00" },
        ],
        deliveries: [
          {
            event_name: "pull_request",
            outcome: "ok",
            status_code: null,
            repository_full_name: "acme/web",
            created_at: "2026-01-01 00:00:00",
          },
        ],
      },
      "installations",
    );
    expect(installed).toContain(">Installed</button>");
    expect(installed).toContain(t("en", "settings.install"));
    // The owner allowlist was deleted, and the bot's installations table moved
    // off this page entirely (bot health reports deliveries, not rows).
    expect(installed).not.toContain(t("en", "settings.allowlist"));
    expect(installed).not.toContain(t("en", "settings.installationsAccount"));
  });

  test("an App with no repository yet states it and points at the repository surface", () => {
    // The read is accepted: a manager payload with no `target_id` and no
    // `review_*` fact is the zero-repository contract, not a malformed read.
    expect(parseSettings(untargetedPayload)).not.toBeNull();
    expect(parseSettings(untargetedPayload)?.target_id).toBeUndefined();

    const markup = renderDetail(untargetedPayload);
    // The App is visible; the zero-repository state is a notice, not an error.
    expect(markup).toContain(t("en", "appDetail.noRepository"));
    expect(markup).toContain(`href="${apiBase()}/targets"`);
    expect(markup).toContain(t("en", "targets.add"));
    // No target-owned control renders: there is no target to write to.
    expect(markup).not.toContain(t("en", "settings.ops"));
    for (const key of ["settings.reviewTrigger", "settings.reviewDepth", "settings.reviewGate"] as const) {
      expect(markup).not.toContain(t("en", key));
    }
    // The bot's own sections are the whole settings face.
    expect(markup).toContain(t("en", "settings.providers.title"));
    expect(markup).toContain(t("en", "botSettings.health"));
  });

  test("the detail links to the bot's own settings page", () => {
    for (const [payload, label] of [
      [managePayload, "manager"],
      [identityPayload, "member"],
    ] as const) {
      const markup = renderDetail(payload);
      expect(markup, label).toContain(`href="${apiBase()}/apps/1/bot"`);
      expect(markup, label).toContain(t("en", "appDetail.botSettingsLink"));
    }
  });

  test("the park action renders only while the owner claim overlaps", () => {
    const parked = renderToStaticMarkup(
      createElement(SettingsView, {
        locale: "en",
        payload: { ...managePayload, owner_overlap: true },
        onReload: noReload,
      }),
    );
    // The row names the overlap and offers the action; the confirm copy exists
    // in the dictionary for the dialog it opens.
    expect(parked).toContain(t("en", "settings.opsParkTitle"));
    expect(parked).toContain(t("en", "settings.opsParkAction"));
    expect(t("en", "settings.confirmParkTitle", { name: "Demo" })).toContain("Demo");
    expect(t("zh_CN", "settings.opsParkTitle").length).toBeGreaterThan(0);
    // No overlap → no park affordance (the route would refuse it anyway).
    const quiet = renderToStaticMarkup(
      createElement(SettingsView, { locale: "en", payload: managePayload, onReload: noReload }),
    );
    expect(quiet).not.toContain(t("en", "settings.opsParkTitle"));
  });

  test("the identity status pill renders the shared primitive from the single derivation", () => {
    // The adapter that used to live in AppsPage is gone; the page and the
    // list both read this one derivation, and the pill face is the shared
    // component's token-backed tone.
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

  test("the target body renders its own (target-scoped) section titles", () => {
    const manage = renderTargetBody(managePayload);
    // The App-side SectionCard titles, resolved through the dictionary — the
    // heading/stat migration may not drop or rename a section. The bot-scoped
    // sections (providers, chains, seats, sandbox image) live on 应用设置.
    for (const key of [
      "settings.appInfo",
      "settings.reviewTrigger",
      "settings.reviewDepth",
      "settings.reviewGate",
      "settings.ops",
    ] as const) {
      expect(manage).toContain(t("en", key));
    }
    // The header's metric band still labels the installations / chains counts
    // (the payload keeps those keys), so only the SECTION titles are asserted
    // absent here.
    for (const key of ["settings.providers.title", "settings.seats"] as const) {
      expect(manage).not.toContain(t("en", key));
    }
    // The workspace settings live on /dashboard/<ref>/settings; the target
    // surface must not keep a second entry point to them.
    expect(manage).not.toContain(t("en", "workspace.settingsHeading"));
  });
});

describe("installed tab configuration surface (static SSR)", () => {
  test("the install block links to the App's GitHub installation page", () => {
    const manage = renderDetail(managePayload);
    expect(manage).toContain('href="https://github.com/apps/demo/installations/new"');
    expect(manage).toContain('target="_blank"');
    expect(manage).toContain('rel="noopener noreferrer"');
    // The link's accessible name names the App, not the URL.
    expect(manage).toContain(t("en", "settings.installLinkAria", { name: "Demo" }));
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
    // The install block's copy line is unique to this section; the avatar it
    // renders is the h-10 box, where the identity card's is h-12.
    expect(manage).toContain(t("en", "settings.installCopy"));
    const avatar = manage.slice(manage.indexOf(t("en", "settings.installCopy")));
    expect(avatar).toContain('<img src="https://avatars.example/demo.png"');
    // The null-avatar fallback is the mounted test below, not this HTML slice.
  });

  test("a null slug keeps the block with explanations and offers no dead link", () => {
    const noSlug = renderDetail(
      { ...managePayload, app: { ...managePayload.app, github_slug: null } },
      "installations",
    );
    expect(noSlug).not.toContain("installations/new");
    expect(noSlug).toContain(t("en", "settings.installNoSlug"));
    // The block itself stays rendered (title + the App name).
    expect(noSlug).toContain(t("en", "settings.install"));
  });

  test("the review gate renders a 0..100 score input and one checkbox per verdict", async () => {
    const gate = await withMarkup(renderTargetBody(managePayload), (container) => {
      // The gate's own section, by its resolved heading — the body mounts
      // every section, so a page-wide input query would read other inputs.
      const section = [...container.querySelectorAll('[data-slot="flow-section"]')].find(
        (node) => node.querySelector("h2")?.textContent === t("en", "settings.reviewGate"),
      );
      const inputs = [...(section?.querySelectorAll("input") ?? [])];
      const score = inputs.find((input) => input.getAttribute("type") === "number");
      // Everything is read INSIDE the callback: the throwaway document is
      // torn down when it returns, and a live element read afterwards is hollow.
      return {
        min: score?.getAttribute("min") ?? "",
        max: score?.getAttribute("max") ?? "",
        value: score?.getAttribute("value") ?? "",
        verdicts: inputs
          .filter((input) => input.getAttribute("type") === "checkbox")
          .map((input) => ({
            label: input.parentElement?.textContent ?? "",
            checked: (input as HTMLInputElement).checked,
          })),
      };
    });
    expect(gate.min).toBe("0");
    expect(gate.max).toBe("100");
    expect(gate.value).toBe("80");
    // The vocabulary is the whole engine set, and the payload's stored
    // verdicts are the checked subset.
    expect(gate.verdicts.map((box) => box.label)).toEqual([...PR_VERDICTS]);
    expect(gate.verdicts.filter((box) => box.checked).map((box) => box.label)).toEqual(["ship it"]);
  });

  test("the review gate with no verdict checked states that no review can pass", () => {
    const empty = renderTargetBody({ ...managePayload, check_gate: { min_score: 80, pass_verdicts: [] } });
    expect(empty).toContain(t("en", "settings.reviewGateFailClosed"));
    // The stored default passes on "ship it", so it carries no warning.
    expect(renderTargetBody(managePayload)).not.toContain(t("en", "settings.reviewGateFailClosed"));
  });

  test("no release version string renders anywhere on the page", () => {
    for (const markup of [renderDetail(managePayload), renderDetail(identityPayload)]) {
      expect(markup).not.toContain(`v${APP_VERSION}`);
    }
  });
});

describe("tab shell mounted behaviour (forceMount)", () => {
  /** A manager payload whose 应用设置 panel mounts the chain editors. */
  const mountedPayload: SettingsPayload = managePayload;

  /** The page's stateful wrapper: the shell owns `search` in production. */
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

  /** One press as the browser performs it — a Radix trigger selects on mousedown. */
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

  /**
   * The OUTERMOST tabpanel holding `node` — the shell's panel. The settings
   * body hosts its own nested Tabs (the model-chain editors), so the nearest
   * panel would be a chain panel that stays active either way.
   */
  const panelOf = (container: DomElement, node: DomElement | null) => {
    let current: DomElement | null = node;
    let outer: DomHTMLElement | null = null;
    while (current !== null && current !== container) {
      if (current.getAttribute("role") === "tabpanel") outer = current as DomHTMLElement;
      current = current.parentElement;
    }
    return outer;
  };

  /** The shell's own panels, outer-first: one of them is active at a time. */
  const shellPanels = (container: DomElement) =>
    [...container.querySelectorAll('[data-slot="tabs-content"]')].filter(
      (panel) => panelOf(container, panel) === panel,
    );

  test("an inactive panel stays mounted but hidden across a full tab round trip", async () => {
    // Radix unmounts inactive panels by default, which would destroy the
    // settings forms (typed input, open dialogs, chain drafts) on every
    // switch. The shell forceMounts every panel; the wrapper's
    // data-[state=inactive]:hidden keeps the one-visible-panel invariant.
    const { win, cleanup } = installDom("http://localhost/dashboard/apps/1");
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(createElement(ShellHarness)));
      // Two faces, settings active: the other one is mounted and hidden.
      expect(shellPanels(container).map((panel) => panel.getAttribute("data-state"))).toEqual([
        "active",
        "inactive",
      ]);
      const settingsPanel = shellPanels(container)[0]!;

      // Switch to 已安装: the settings panel stays mounted (same node) and hides.
      await click(win, tabTrigger(container, t("en", "appDetail.tabInstallations")));
      expect(shellPanels(container)[0]).toBe(settingsPanel);
      expect(shellPanels(container).map((panel) => panel.getAttribute("data-state"))).toEqual([
        "inactive",
        "active",
      ]);

      // …and back: the same node, active again — nothing was remounted.
      await click(win, tabTrigger(container, t("en", "appDetail.tabSettings")));
      expect(shellPanels(container)[0]).toBe(settingsPanel);
      expect(shellPanels(container).map((panel) => panel.getAttribute("data-state"))).toEqual([
        "active",
        "inactive",
      ]);
    } finally {
      await act(async () => root.unmount());
      cleanup();
    }
  });

  /**
   * Mount the stateful page on `url` with the settings read held until the test
   * releases it, so the frame the payload lands in can be observed rather than
   * raced.
   */
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

  /** The label of the tab whose panel is active — empty when no panel is. */
  const activeTabLabel = (win: Window, container: DomElement) => {
    const active = shellPanels(container).filter((panel) => panel.getAttribute("data-state") === "active");
    if (active.length !== 1) return active.length === 0 ? "" : "multiple";
    const labelledBy = active[0]?.getAttribute("aria-labelledby") ?? "";
    return win.document.getElementById(labelledBy)?.textContent ?? "";
  };

  test("history traversal re-derives the tab from the URL, through the gate mirror", async () => {
    // The popstate listener is registered once, so it reads the payload's
    // can_manage through the ref mirror rather than a stale mount-time closure.
    // A back/forward move onto ?tab=installations must therefore activate
    // 已安装 even though the gate was still false when the listener was
    // attached.
    const page = await mountPageWithHeldPayload("http://localhost/dashboard/apps/1", managePayload);
    try {
      await page.release();
      expect(activeTabLabel(page.win, page.container)).toBe(t("en", "appDetail.tabSettings"));

      // A forward move: the address changes, then the router's popstate lands.
      page.win.history.pushState(null, "", "/dashboard/apps/1?tab=installations");
      await act(async () => page.win.dispatchEvent(new page.win.Event("popstate")));
      await act(async () => {});
      expect(activeTabLabel(page.win, page.container)).toBe(t("en", "appDetail.tabInstallations"));

      // …and back to the bare path returns to the default 应用设置 tab.
      page.win.history.pushState(null, "", "/dashboard/apps/1");
      await act(async () => page.win.dispatchEvent(new page.win.Event("popstate")));
      await act(async () => {});
      expect(activeTabLabel(page.win, page.container)).toBe(t("en", "appDetail.tabSettings"));
    } finally {
      await page.unmount();
    }
  });

  test("a null cached avatar renders AppAvatar's bg-muted fallback in the install block once the derived icon misses", async () => {
    // The fallback swaps in only on a CDN miss (AppAvatar's onError), which a
    // static render cannot fire — hence the mount, and the identity probed is
    // the component's own bg-muted wrapper, not a copy of the icon's path
    // data. The cached column is NULL here, so the icon URL derives from the
    // numeric App id.
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
      // The install block's avatar is the h-10 one (the identity card's is
      // h-12); with a NULL cache its src is the id-derived CDN object.
      const img = container.querySelector('img[class*="h-10 w-10"]');
      expect(img?.getAttribute("src")).toBe("https://avatars.githubusercontent.com/in/1?s=120&v=4");

      // The CDN miss: the octocat fallback takes the SAME box, inside the
      // install block.
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
  /** Record every URL the page's read fetches, and answer it. */
  async function readUnder(pathname: string): Promise<string[]> {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      calls.push(String(input));
      // A non-manager: one request, no model round trip.
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
    // The switcher rewrites only the workspace segment, so `appId` stays
    // "1": the base must be derived per render (AppsPage precedent) or
    // the page keeps the previous workspace's settings on screen.
    expect(await readUnder("/dashboard/acme/apps/1")).toEqual([
      "/dashboard/acme/api/apps/1/settings",
    ]);
    expect(await readUnder("/dashboard/beta/apps/1")).toEqual([
      "/dashboard/beta/api/apps/1/settings",
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
      expect(calls).toEqual(["/dashboard/beta/api/apps/1/settings"]);
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

  // Key/value pairs in band order, with the value cell's resolved class —
  // the danger tone is the only tone channel the band has.
  const band = (payload: SettingsManagePayload) =>
    [...renderDetail(payload).matchAll(/data-slot="metric-key"[^>]*>([^<]+)<\/span><span data-slot="metric-value"[^>]*class="([^"]*)"[^>]*>(\d+)<\/span>/g)]
      .map((m) => ({ key: m[1]!, value: m[3]!, danger: m[2]!.includes("tone-danger") }));

  const payloadWith = (counts: { keys: number; chains: number; installations: number; rejected: number | null }): SettingsManagePayload => ({
    ...managePayload,
    keys: Array.from({ length: counts.keys }, () => keyRow),
    model_chains: Array.from({ length: counts.chains }, () => chain),
    installations: Array.from({ length: counts.installations }, () => installation),
    delivery_summary: counts.rejected === null ? undefined : summary(counts.rejected),
  });

  test("the four figures render in band order, each wired to its own source count", () => {
    // Distinct counts: a swap of two array lengths is type-compatible and
    // must move a number off its label.
    const pairs = band(payloadWith({ installations: 2, keys: 3, chains: 5, rejected: 7 }));
    expect(pairs.map(({ key, value }) => [key, value])).toEqual([
      ["Installations", "2"],
      ["Keys", "3"],
      ["Model chains", "5"],
      ["24h rejected", "7"],
    ]);
  });

  test("a zero rejected count renders without the danger tone; non-zero wears it", () => {
    const zero = band(payloadWith({ installations: 1, keys: 1, chains: 1, rejected: 0 }));
    expect(zero[3]!).toEqual({ key: "24h rejected", value: "0", danger: false });
    // The `?? 0` fallback: a missing delivery summary must still render the
    // fourth figure as 0, silently absent summary ≠ missing metric.
    const absent = band(payloadWith({ installations: 1, keys: 1, chains: 1, rejected: null }));
    expect(absent[3]!).toEqual({ key: "24h rejected", value: "0", danger: false });
    const refused = band(payloadWith({ installations: 1, keys: 1, chains: 1, rejected: 4 }));
    expect(refused[3]!).toEqual({ key: "24h rejected", value: "4", danger: true });
  });
});

describe("install claim entry (static SSR)", () => {
  /** The manager face of a SHARED bot with no bound installation. */
  const sharedPayload = (): SettingsManagePayload => ({
    ...managePayload,
    app: { ...managePayload.app, scope: "shared" },
    installation: null,
  });

  test("the claim action renders for a shared bot only, and an owned bot keeps the plain link", () => {
    const shared = renderDetail(sharedPayload(), "installations");
    expect(shared).toContain(t("en", "settings.installClaim"));
    expect(shared).toContain(t("en", "settings.installClaimCopy"));
    // The claim is the entry point: the raw install link would skip the claim
    // record that makes the callback's 0/1/N split possible.
    expect(shared).not.toContain('href="https://github.com/apps/demo/installations/new"');

    const owned = renderDetail(
      { ...sharedPayload(), app: { ...sharedPayload().app, scope: "owned" } },
      "installations",
    );
    expect(owned).not.toContain(t("en", "settings.installClaim"));
    expect(owned).toContain('href="https://github.com/apps/demo/installations/new"');
    // Everything else on the block is unchanged copy.
    expect(owned).toContain(t("en", "settings.installLink"));
    expect(owned).toContain(t("en", "settings.installCopy"));
  });

  test("the claim block renders the bound installation's account", () => {
    const bound = renderDetail(
      { ...sharedPayload(), installation: { id: 4242, account_login: "acme", removed: false } },
      "installations",
    );
    expect(bound).toContain(t("en", "settings.installBoundAccount", { account: "acme" }));
    expect(bound).not.toContain(t("en", "settings.installRemoved"));
    // A bound target cannot start a claim (the route answers 409), so the
    // action is not rendered: the operator's unbind is the way to re-bind.
    expect(bound).not.toContain(t("en", "settings.installClaim"));
  });

  test("the claim block separates an unknown account from a removed installation", () => {
    const unknownAccount = renderDetail(
      { ...sharedPayload(), installation: { id: 4242, account_login: null, removed: false } },
      "installations",
    );
    expect(unknownAccount).toContain(t("en", "settings.installBoundNoAccount", { id: "4242" }));

    const removed = renderDetail(
      { ...sharedPayload(), installation: { id: 4242, account_login: "acme", removed: true } },
      "installations",
    );
    // The binding survives the uninstall; the line says reviews stopped.
    expect(removed).toContain(t("en", "settings.installRemoved"));
    expect(removed).toContain(t("en", "settings.installBoundAccount", { account: "acme" }));
  });

  test("the claim payload fields parse fail-closed", () => {
    expect(parseSettings(sharedPayload())?.can_manage).toBe(true);
    // An off-vocabulary scope or a malformed installation fails the whole read
    // instead of rendering a control the server would refuse.
    expect(parseSettings({ ...sharedPayload(), app: { ...sharedPayload().app, scope: "global" } })).toBeNull();
    expect(
      parseSettings({ ...sharedPayload(), installation: { id: "4242", account_login: null, removed: false } }),
    ).toBeNull();
    expect(
      parseSettings({ ...sharedPayload(), installation: { id: 4242, account_login: null, removed: "yes" } }),
    ).toBeNull();
    // `null` is the unbound state, and it stays legal.
    expect(parseSettings({ ...sharedPayload(), installation: null })?.can_manage).toBe(true);
  });
});

/**
 * The derived Blocked state and the pending-installation bind entry.
 *
 * Blocked is server-derived per read (`review_bots.scope = 'owned'` and the
 * target's workspace is another one): the page names the reason and the
 * install block offers no action, while the review settings stay readable.
 * A pending installation — the bot's live installation no target references —
 * is the install block's second action, and it exists only while the target
 * holds no binding.
 */
describe("Blocked and pending installations (static SSR)", () => {
  /** The Blocked manager face: target-owned sections only, no bot sections. */
  const blockedPayload = (): SettingsBlockedPayload => ({
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
    allowlist: managePayload.allowlist,
    owner_overlap: false,
  });

  const sharedPayload = (): SettingsManagePayload => ({
    ...managePayload,
    app: { ...managePayload.app, scope: "shared" },
    installation: null,
  });

  test("the Blocked banner names the reason on both faces", () => {
    const manager = renderDetail(blockedPayload());
    expect(manager).toContain(t("en", "appDetail.blockedBotNotShared"));
    // The bot page is not readable from a blocked workspace (its bot serves
    // another one now), so the header does not offer a link that 404s.
    expect(manager).not.toContain(t("en", "appDetail.botSettingsLink"));
    // The metric band's figures are all the bot's: none render, and no zero is
    // fabricated in their place.
    expect(manager).not.toContain(t("en", "settings.installations"));
    expect(manager).not.toContain(t("en", "settings.metricKeys"));
    // The review settings are the target's, so the target body keeps them.
    expect(renderTargetBody(blockedPayload())).toContain(t("en", "settings.reviewGate"));

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

  test("a Blocked target hides the install and claim actions, and keeps its review settings", async () => {
    const installed = renderDetail(blockedPayload(), "installations");
    expect(installed).not.toContain(t("en", "settings.installClaim"));
    expect(installed).not.toContain(t("en", "settings.installLink"));
    expect(installed).not.toContain('href="https://github.com/apps/demo/installations/new"');
    // Nothing is pending for a bot this workspace may not use.
    expect(installed).not.toContain(t("en", "settings.installPendingBind"));

    // The review configuration is still readable — Blocked hides an action,
    // not the settings a manager can inspect.
    const policy = renderTargetBody(blockedPayload());
    expect(policy).toContain(t("en", "settings.reviewGate"));

    // The bot-shaped parts of the identity card are gone with the bot data:
    // the delivery URL and the refresh are bot-scope writes this workspace
    // cannot make.
    expect(installed).not.toContain(t("en", "settings.appInfoDeliveryUrl"));
    expect(installed).not.toContain(t("en", "settings.appInfoRefresh"));
    // The bot's installation table is not on this page at all any more; the
    // install block still states WHY it offers nothing.
    const installedText = await withMarkup(installed, (container) => container.textContent ?? "");
    expect(installedText).not.toContain(t("en", "settings.noInstallations"));
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

    // A bound target binds nothing more: the operator's unbind is the repair.
    const bound = renderDetail(
      { ...pending, installation: { id: 4242, account_login: "acme", removed: false } },
      "installations",
    );
    expect(bound).not.toContain(t("en", "settings.installPendingBind"));
  });

  test("the new fields parse fail-closed on both manager faces", () => {
    expect(parseSettings(managePayload)?.can_manage).toBe(true);
    expect(parseSettings(identityPayload)?.can_manage).toBe(false);
    // The blocked face is accepted, and both manager faces keep their own
    // required keys: a blocked payload carrying the bot sections is still a
    // blocked payload (the extras are ignored), but dropping a TARGET-owned
    // key fails the read.
    expect(parseSettings(blockedPayload())?.blocked).toBe(true);
    for (const broken of [
      { ...blockedPayload(), blocked: false },
      { ...blockedPayload(), blocked_reason: "other" },
      { ...blockedPayload(), owner_overlap: "no" },
      { ...blockedPayload(), app: { ...blockedPayload().app, review_trigger_mode: "sometimes" } },
      { ...blockedPayload(), installation: { id: "1", account_login: null, removed: false } },
    ]) {
      expect(parseSettings(broken)).toBeNull();
    }
    // A Blocked read is a target's: without the target-owned slice it is not
    // a settings read at all.
    const { target_id: _blockedTarget, ...blockedWithoutTarget } = blockedPayload();
    expect(parseSettings(blockedWithoutTarget)).toBeNull();
    // The bot's metadata stamp is the OWNER's: a Blocked face omits it, and a
    // readable face must carry it.
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
    // A pending row without a usable installation id would render an action
    // the route cannot address.
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
