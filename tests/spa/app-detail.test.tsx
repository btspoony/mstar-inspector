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
  appDeliveriesUrl,
  appDetailSearchQuery,
  appStatusPill,
  parseDeliveryPage,
  parseAppDetailSearch,
  parseSettings,
  pullRequestRefOf,
  scopedInsightsSummaryUrl,
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

/**
 * The manager face of an App the workspace has added no repository under yet:
 * the bot's sections are the whole payload, and every target-owned fact —
 * `target_id`, the pause state, the review policy and the gate — is ABSENT
 * rather than defaulted.
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

  test("the summary URL is base-prefixed and addresses the scope; include=repos always rides", () => {
    // One repository: the target-addressed family.
    expect(scopedInsightsSummaryUrl("/dashboard", { kind: "target", targetId: "1" }, "30", "")).toBe(
      "/dashboard/api/targets/1/insights/summary?window=30&include=repos",
    );
    // A workspace-scoped page rides its own prefix and the workspace face.
    expect(
      scopedInsightsSummaryUrl("/dashboard/acme", { kind: "target", targetId: "12345" }, "7", "acme/web"),
    ).toBe("/dashboard/acme/api/targets/12345/insights/summary?window=7&include=repos&repo=acme%2Fweb");
    expect(scopedInsightsSummaryUrl("/dashboard", { kind: "workspace" }, "90", "")).toBe(
      "/dashboard/api/insights/summary?window=90&include=repos",
    );
    // The removed App-addressed family is never emitted.
    expect(
      scopedInsightsSummaryUrl("/dashboard", { kind: "target", targetId: "1" }, "30", ""),
    ).not.toContain("/api/apps/");
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

  test("the manager's tab bar is the App's own three faces, settings first", async () => {
    const manage = renderDetail(managePayload);
    // The triggers read by role and name, the way an assistive technology
    // finds them — never by serialized tag adjacency.
    expect(await withMarkup(manage, pageTabs)).toEqual([
      t("en", "appDetail.tabSettings"),
      t("en", "appDetail.tabDelivery"),
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
    // The ops zone is the App's own (disable / delete); the review pause is
    // the repository's, so no control here may POST it.
    expect(settings).toContain(t("en", "settings.ops"));
    expect(settings).not.toContain(t("en", "settings.pauseReviews"));
    expect(settings).not.toContain(t("en", "settings.resumeReviews"));
    // The bot-owned configuration this tab composes (deliveries have their own tab).
    for (const key of [
      "settings.providers.title",
      "settings.modelChains",
      "settings.seats",
    ] as const) {
      expect(settings).toContain(t("en", key));
    }
    // The data faces and the target-owned policy are not this page's any more.
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
    // The read is accepted: a manager payload with no `target_id` and no
    // `review_*` fact is the zero-repository contract, not a malformed read.
    expect(parseSettings(untargetedPayload)).not.toBeNull();
    expect(parseSettings(untargetedPayload)?.target_id).toBeUndefined();

    const markup = renderDetail(untargetedPayload);
    // The App is visible; the zero-repository state is a sentence, not an error.
    expect(markup).toContain(t("en", "appDetail.noRepository"));
    // No target-owned control renders: there is no target to write to.
    expect(markup).not.toContain(t("en", "settings.ops"));
    for (const key of ["settings.reviewTrigger", "settings.reviewDepth", "settings.reviewGate"] as const) {
      expect(markup).not.toContain(t("en", key));
    }
    // The bot's own sections are the whole settings face.
    expect(markup).toContain(t("en", "settings.providers.title"));
  });

  test("an App with several repositories says so, not the zero-repository state", () => {
    const many = { ...untargetedPayload, targets_many: true };
    // The flag is a plain optional boolean on the parsed face.
    expect(parseSettings(many)?.targets_many).toBe(true);
    const markup = renderDetail(many);
    expect(markup).toContain(t("en", "appDetail.targetsMany"));
    // The zero-repository copy would be a lie here: at least two exist.
    expect(markup).not.toContain(t("en", "appDetail.noRepository"));
    // No single repository's policy is this page's to edit.
    expect(markup).not.toContain(t("en", "settings.ops"));
    expect(markup).toContain(t("en", "settings.providers.title"));
    // A non-boolean flag is a malformed read, not a silent "not many".
    expect(parseSettings({ ...untargetedPayload, targets_many: "yes" })).toBeNull();
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
});

describe("installed tab configuration surface (static SSR)", () => {
  test("the install block links to the App's GitHub installation page", () => {
    const manage = renderDetail(managePayload);
    expect(manage).toContain('href="https://github.com/apps/demo/installations/new"');
    expect(manage).toContain('target="_blank"');
    expect(manage).toContain('rel="noopener noreferrer"');
    // The accessible name starts with the visible label and adds the App name.
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

  test("no release version string renders anywhere on the page", () => {
    for (const markup of [renderDetail(managePayload), renderDetail(identityPayload)]) {
      expect(markup).not.toContain(`v${APP_VERSION}`);
    }
  });
});

describe("installation roster on the installed tab (static SSR)", () => {
  /** The roster table's cells, read the way a person scans them: per row. */
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
    // The last-sync cell is the relative formatter's output for `seen_at`, not
    // a blank: a stamp seconds old can only read as the sub-minute bucket.
    expect(rows.map((cells) => cells[2])).toEqual([
      t("en", "common.time.justNow"),
      t("en", "common.time.justNow"),
    ]);
    // The state is stated on every row: the read carries live rows only, so a
    // row that rendered no state would read as an unqualified install.
    for (const cells of rows) expect(cells[3]).toBe(t("en", "settings.installationsLive"));
  });

  test("the last-sync cell follows the stamp it is given, not a constant", async () => {
    // A fixed stamp two days back: the formatter's day bucket, which no clock
    // can drift across in a test run. A rendering that ignored `seen_at` (a
    // literal, the account column repeated, "just now" for everything) fails.
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
    // The raw stamp stays reachable as the native tooltip, the way every other
    // relative-time cell in the product carries it.
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
      // The count is the ROW count, not a second figure that could drift.
      expect(await withMarkup(markup, rosterRows), `rows at ${count}`).toHaveLength(
        Number(banded),
      );
    }
  });

  test("an App with no installation states it instead of an empty table", () => {
    const markup = renderDetail({ ...managePayload, installations: [] }, "installations");
    expect(markup).toContain(t("en", "settings.noInstallations"));
    // The band still names the zero — the absence is a figure, not a blank.
    expect(markup).toMatch(
      /data-slot="metric-key"[^>]*>Installations<\/span><span data-slot="metric-value"[^>]*>0</,
    );
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
      // 应用设置 active, every other face mounted and hidden.
      const settingsPanel = shellPanels(container)[0]!;
      expect(settingsPanel.getAttribute("data-state")).toBe("active");
      expect(
        shellPanels(container)
          .slice(1)
          .every((panel) => panel.getAttribute("data-state") === "inactive"),
      ).toBe(true);

      // Switch to 已安装: the settings panel stays mounted (same node) and hides.
      await click(win, tabTrigger(container, t("en", "appDetail.tabInstallations")));
      expect(shellPanels(container)[0]).toBe(settingsPanel);
      expect(settingsPanel.getAttribute("data-state")).toBe("inactive");

      // …and back: the same node, active again — nothing was remounted.
      await click(win, tabTrigger(container, t("en", "appDetail.tabSettings")));
      expect(shellPanels(container)[0]).toBe(settingsPanel);
      expect(settingsPanel.getAttribute("data-state")).toBe("active");
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

  test("settings and delivery render before models/catalog resolve; only their editors wait", async () => {
    const { win, cleanup } = installDom("https://worker.local/dashboard/default/apps/1");
    const realFetch = globalThis.fetch;
    let releaseModels!: () => void;
    let releaseCatalog!: () => void;
    const models = new Promise<void>((resolve) => { releaseModels = resolve; });
    const catalog = new Promise<void>((resolve) => { releaseCatalog = resolve; });
    const calls: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/settings")) return Response.json({
        ...managePayload, provider_catalog_version: "fixture-ready", provider_eligibility: {},
      });
      if (url.endsWith("/models")) {
        await models;
        return Response.json({ groups: [{ provider: "anthropic", source: "verified", selectors: ["anthropic/fixture-model"] }] });
      }
      if (url.includes("/api/provider-catalog")) {
        await catalog;
        return Response.json({ provider_catalog: [], model_limits_snapshot: "fixture-snapshot" });
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
      expect(container.querySelector(`[aria-label="${t("en", "settings.modelChainField")}"]`)).toBeNull();
      expect(container.textContent).toContain(t("en", "common.loading"));
      expect(container.textContent).toContain(t("en", "settings.seats"));
      await click(win, tabTrigger(container, t("en", "appDetail.tabDelivery")));
      expect(container.textContent).toContain(t("en", "appDetail.delivery.emptyTitle"));
      await click(win, tabTrigger(container, t("en", "appDetail.tabSettings")));
      await act(async () => { releaseModels(); });
      const picker = container.querySelector(`[aria-label="${t("en", "settings.modelChainField")}"]`);
      expect(picker).not.toBeNull();
      await click(win, picker);
      expect(win.document.body.textContent).toContain("anthropic/fixture-model");
      await act(async () => { releaseCatalog(); });
      expect(container.textContent).toContain(t("en", "settings.addProvider"));
      expect(calls.filter((url) => url.includes("/api/provider-catalog"))).toHaveLength(1);
    } finally {
      releaseModels();
      releaseCatalog();
      await act(async () => root.unmount());
      globalThis.fetch = realFetch;
      cleanup();
    }
  });

  test("model failure stays nonfatal and a provider-local catalog failure can be retried", async () => {
    const { win, cleanup } = installDom("https://worker.local/dashboard/default/apps/1");
    const realFetch = globalThis.fetch;
    let catalogAttempts = 0;
    globalThis.fetch = (async (input: unknown) => {
      if (String(input).endsWith("/settings")) return Response.json({
        ...managePayload, provider_catalog_version: "fixture-section-error", provider_eligibility: {},
      });
      if (String(input).includes("/api/provider-catalog") && ++catalogAttempts > 1) {
        return Response.json({ provider_catalog: [], model_limits_snapshot: "fixture-snapshot" });
      }
      return new Response("unavailable", { status: 503 });
    }) as typeof fetch;
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(createElement(AppDetailPage, { boot: BOOT, appId: "1" })));
      expect(container.textContent).toContain("Demo");
      expect(container.querySelector(`[aria-label="${t("en", "settings.modelChainField")}"]`)).not.toBeNull();
      const alerts = [...container.querySelectorAll('[role="alert"]')];
      expect(alerts).toHaveLength(1);
      expect(alerts[0]?.parentElement?.textContent).toContain(t("en", "settings.providers.title"));
      const retry = [...container.querySelectorAll("button")].find((button) => button.textContent === t("en", "common.retry"));
      expect(retry).toBeDefined();
      await click(win, retry!);
      expect(catalogAttempts).toBe(2);
      expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
      expect(container.textContent).toContain(t("en", "settings.addProvider"));
    } finally {
      await act(async () => root.unmount());
      globalThis.fetch = realFetch;
      cleanup();
    }
  });

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
    // The target-owned review policy is not this page's: the repository
    // surface owns it (targets-page.test.tsx pins that tab).
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

  test("a Blocked target hides the install and claim actions, and keeps its review settings", async () => {
    const installed = renderDetail(blockedPayload(), "installations");
    expect(installed).not.toContain(t("en", "settings.installClaim"));
    expect(installed).not.toContain(t("en", "settings.installLink"));
    expect(installed).not.toContain('href="https://github.com/apps/demo/installations/new"');
    // Nothing is pending for a bot this workspace may not use.
    expect(installed).not.toContain(t("en", "settings.installPendingBind"));

    // The bot-shaped parts of the identity card are gone with the bot data:
    // the delivery URL and the refresh are bot-scope writes this workspace
    // cannot make.
    expect(installed).not.toContain(t("en", "settings.appInfoDeliveryUrl"));
    expect(installed).not.toContain(t("en", "settings.appInfoRefresh"));

    // The parity invariant holds in its degenerate form here: the roster is
    // dropped with the bot's data (`bot === null`), and the band's installation
    // figure is dropped by the same face — neither half can be left reporting
    // a number the other no longer backs.
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
      { ...blockedPayload(), app: { ...blockedPayload().app, review_trigger_mode: "sometimes" } },
      { ...blockedPayload(), installation: { id: "1", account_login: null, removed: false } },
    ]) {
      expect(parseSettings(broken)).toBeNull();
    }
    // A Blocked read is a target's: without the target-owned slice it is not
    // a settings read at all.
    const { target_id: _blockedTarget, ...blockedWithoutTarget } = blockedPayload();
    expect(parseSettings(blockedWithoutTarget)).toBeNull();
    // The one exception is the several-repository Blocked face: it says
    // `target_id: null` plus `targets_many`, so the page can name that state
    // instead of reading it as the zero-repository App.
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
      // `null` without the several-repository flag is not a state.
      { ...blockedMany, targets_many: false },
      { ...blockedMany, targets_many: undefined },
      // A target-less Blocked read reports no pause state: its presence would
      // state configuration the payload has no target for.
      { ...blockedMany, app: { ...blockedMany.app, review_enabled: true } },
      // The fail-closed rule survives outside the Blocked face.
      { ...managePayload, target_id: null, targets_many: true },
    ]) {
      expect(parseSettings(broken)).toBeNull();
    }
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

/**
 * The 投递状态 tab: the delivery table, its filters and the pager. Static SSR
 * over the pure view (so the columns and the filter controls are assertable by
 * their accessible names), plus the URL builder/parser pair the tab reads
 * through.
 */
describe("投递状态 tab", () => {
  const summary = { last_webhook_at: null, rejected24h: 0 };
  /** The wire payload (the route's own keys). */
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
    // The values, not only the headers: a table that renders empty cells under
    // correct headers would pass a header-only assertion.
    expect(markup).toContain("acme/web");
    expect(markup).toContain("pull_request");
    expect(markup).toContain("signature verification failed");
    // A row without a repository says so rather than rendering a blank cell.
    expect(markup).toContain(t("en", "appDetail.delivery.unknownRepo"));
  });

  test("offers the three named filters plus the pager", async () => {
    const markup = markupOf(deliveryPage);
    // Each filter is a named control, read the way an assistive technology
    // finds it.
    expect(await withMarkup(markup, (container) => [
      ...container.querySelectorAll("[aria-label]"),
    ].map((node) => node.getAttribute("aria-label")))).toEqual(
      expect.arrayContaining([
        t("en", "appDetail.delivery.filterRepo"),
        t("en", "appDetail.delivery.filterWindow"),
        t("en", "appDetail.delivery.filterType"),
      ]),
    );
    // The pager names the FILTERED total over the loaded window, and both page
    // actions exist.
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
    // A page without a total cannot page.
    const { total: _total, ...withoutTotal } = deliveryResponse;
    expect(parseDeliveryPage(withoutTotal)).toBeNull();
    expect(parseDeliveryPage({ deliveries: [] })).toBeNull();
    // A drifted row is dropped, not fatal: the rest of the page still renders.
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
    // The page states the fact; it no longer points back at the repository
    // surface. Both states are covered, and the probe is the ANCHOR — the
    // sentences legitimately name the repository surface in prose.
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
