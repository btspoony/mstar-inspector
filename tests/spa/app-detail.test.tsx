/**
 * App detail page (App detail IA): the tab shell's product behaviour.
 * Static-SSR over the pure views plus happy-dom mounts for the stateful
 * shell, the repo's standard duo (charts-recharts precedent for SSR).
 *
 * 1. Tab shell: default tab 应用设置 on the bare path AND the legacy
 *    /settings deep link; the 洞察 tab renders ONLY on the manage face —
 *    a non-manager must not see the tab at all (absence pinned).
 * 2. Mount-once tab switching: a manager tab switch leaves the settings panel
 *    mounted (and hidden), so typed form state survives (mounted assertion).
 * 3. Mid-session demotion: a stale manager-tab URL is rewritten once the
 *    non-manager payload lands (mounted against the real page).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
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
  PR_VERDICTS,
  pullRequestRefOf,
  type AppDetailSearch,
  type AppDetailTab,
  type InsightsSummary,
  type SettingsManagePayload,
  type SettingsPayload,
} from "../../src/spa/pages/data";
import { AppDetailPage, AppDetailView, loadAppDetail } from "../../src/spa/pages/AppDetailPage";
import { SettingsView } from "../../src/spa/pages/SettingsPage";
import { apiBase } from "../../src/spa/workspace-base";
import { AppInsightsTab, InsightsRecordsView, SEVERITY_SLOTS } from "../../src/spa/pages/AppInsightsTab";
import { APP_VERSION } from "../../src/version";
import { installDom, withMarkup } from "./dom";

const spaRoot = join(import.meta.dir, "../../src/spa");

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
  app: IDENTITY_APP,
};

/** Minimal boot for mounting the stateful shell (the DOM demotion test). */
const BOOT = { locale: "en" as const, login: "mallory", name: null };

const managePayload = {
  can_manage: true as const,
  workspace_id: "ws_0123456789abcdefghijkl",
  app: {
    ...IDENTITY_APP,
    last_webhook_at: null,
    sandbox_image_id: "omp",
    review_trigger_mode: "every_push" as const,
    github_visibility: "unknown" as const,
  },
  check_gate: { min_score: 80, pass_verdicts: ["ship it"] },
  allowlist: { enabled: false, owners: [] },
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

const search = { tab: "settings" as const, window: "30" as const, repo: "", pr: "" };
const noReload = async () => true;
const noSearch = () => {};

function renderDetail(payload: SettingsPayload, canManage: boolean, tab: AppDetailTab = "settings") {
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

describe("app detail URL state (shared pure helpers)", () => {
  test("default tab is settings on the bare path; ?tab=insights only for a manager", () => {
    expect(parseAppDetailSearch("", true)).toEqual({ tab: "settings", window: "30", repo: "", pr: "" });
    expect(parseAppDetailSearch("?tab=installations", true).tab).toBe("installations");
    expect(parseAppDetailSearch("?tab=insights", true).tab).toBe("insights");
    expect(parseAppDetailSearch("?tab=pull-requests", true).tab).toBe("pull-requests");
    // A non-manager never resolves to a manager tab — the URL cannot
    // grant the tab the payload denies.
    expect(parseAppDetailSearch("?tab=installations", false).tab).toBe("settings");
    expect(parseAppDetailSearch("?tab=insights", false).tab).toBe("settings");
    expect(parseAppDetailSearch("?tab=pull-requests", false).tab).toBe("settings");
    // Unknown tab values fall back to settings.
    expect(parseAppDetailSearch("?tab=bogus", true).tab).toBe("settings");
  });

  test("the open PR detail rides the pr param (owner/repo/number), malformed values fall back to the list", () => {
    expect(parseAppDetailSearch("?tab=pull-requests&pr=acme%2Fweb%2F42", true)).toEqual({
      tab: "pull-requests",
      window: "30",
      repo: "",
      pr: "acme/web/42",
    });
    expect(parseAppDetailSearch("?pr=acme/web/42", true).pr).toBe("acme/web/42");
    expect(parseAppDetailSearch("?pr=42", true).pr).toBe("");
    expect(parseAppDetailSearch("?pr=acme/web/abc", true).pr).toBe("");
    expect(parseAppDetailSearch("?pr=a/b/1/2", true).pr).toBe("");
  });

  test("the pr param and the detail resolver accept exactly the same grammar", () => {
    // ONE grammar: whatever the URL state accepts, the detail read resolves —
    // and vice versa. The dot-segment spellings the old shape regex let
    // through are rejected on both sides, so the address bar can never
    // advertise a detail that can never open.
    const accepted = ["acme/web/42", "acme/web/0042", "a/b/1"];
    for (const pr of accepted) {
      expect(pullRequestRefOf(pr)).not.toBeNull();
      expect(parseAppDetailSearch(`?pr=${encodeURIComponent(pr)}`, true).pr).toBe(pr);
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
      expect(parseAppDetailSearch(`?pr=${encodeURIComponent(pr)}`, true).pr).toBe("");
    }
  });

  test("insights filter params ride the same query (window segments + repo)", () => {
    expect(parseAppDetailSearch("?tab=insights&window=7&repo=acme%2Fweb", true)).toEqual({
      tab: "insights",
      window: "7",
      repo: "acme/web",
      pr: "",
    });
    // Off-set windows resolve to the default segment (pinned helper).
    expect(parseAppDetailSearch("?window=60", true).window).toBe("30");
  });

  test("appDetailSearchQuery is the inverse — defaults omitted (loop-free replaceState writes)", () => {
    expect(appDetailSearchQuery({ tab: "settings", window: "30", repo: "", pr: "" })).toBe("");
    expect(appDetailSearchQuery({ tab: "insights", window: "30", repo: "", pr: "" })).toBe("?tab=insights");
    expect(appDetailSearchQuery({ tab: "insights", window: "7", repo: "acme/web", pr: "" })).toBe(
      "?tab=insights&window=7&repo=acme%2Fweb",
    );
    expect(
      appDetailSearchQuery({ tab: "pull-requests", window: "30", repo: "", pr: "acme/web/42" }),
    ).toBe("?tab=pull-requests&pr=acme%2Fweb%2F42");
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

  test("default tab is 应用设置 for both roles; the manager sees ALL three manager tabs", async () => {
    const manage = renderDetail(managePayload, true);
    // The triggers read by role and name, the way an assistive technology
    // finds them — never by serialized tag adjacency.
    expect(await withMarkup(manage, pageTabs)).toEqual([
      t("en", "appDetail.tabSettings"),
      t("en", "appDetail.tabInstallations"),
      t("en", "appDetail.tabInsights"),
      t("en", "appDetail.tabPullRequests"),
    ]);
    // The identity header serves both tabs — the GitHub display name (D6).
    expect(manage).toContain(">Demo</h1>");
    expect(manage).toContain("by mallory");
  });

  test("a non-manager sees identity-only with NO manager tab rendered — absence pinned", async () => {
    const identity = renderDetail(identityPayload, false);
    expect(await withMarkup(identity, pageTabs)).toEqual([t("en", "appDetail.tabSettings")]);
    // No insights panel markup anywhere on the face.
    expect(identity).not.toContain("Review health");
  });

  test("the settings tab no longer carries the installations table or the delivery list — both moved to the Installed tab", () => {
    const settingsOnly = renderToStaticMarkup(
      createElement(SettingsView, {
        locale: "en",
        payload: {
          ...managePayload,
          installations: [{ installation_id: 123, account_login: "acme", seen_at: "2026-01-01 00:00:00" }],
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
        groups: [],
        onReload: noReload,
      }),
    );
    expect(settingsOnly).not.toContain(t("en", "settings.installationsAccount"));
    expect(settingsOnly).not.toContain(t("en", "settings.recentDeliveries"));
    expect(settingsOnly).not.toContain("acme/web");
  });

  test("the Installed tab renders the installations table and leads each delivery with its source repo", () => {
    const installed = renderDetail(
      {
        ...managePayload,
        installations: [
          { installation_id: 123, account_login: "acme", seen_at: "2026-01-01 00:00:00" },
          { installation_id: 456, account_login: null, seen_at: "2026-01-01 00:00:00" },
        ],
        deliveries: [
          {
            event_name: "pull_request",
            outcome: "ok",
            status_code: null,
            repository_full_name: "acme/web",
            created_at: "2026-01-01 00:00:00",
          },
          {
            event_name: "ping",
            outcome: "ignored",
            status_code: null,
            repository_full_name: null,
            created_at: "2026-01-01 00:00:00",
          },
        ],
      },
      true,
      "installations",
    );
    expect(installed).toContain(">Installed</button>");
    // The table lives in the installations panel, and that panel is the ACTIVE
    // one when the Installed tab is selected (the other panels are mounted but
    // inactive — the forceMount idiom).
    const at = installed.indexOf(t("en", "settings.installationsAccount"));
    const panelTag = installed.slice(
      installed.lastIndexOf("<div", installed.lastIndexOf('data-slot="tabs-content"', at)),
      at,
    );
    expect(panelTag).toContain('data-state="active"');
    expect(installed).toContain(t("en", "settings.installationsAccount"));
    expect(installed).toContain("acme");
    // The delivery line leads with its repo; a pre-0043 row (NULL source)
    // falls back to the unknown-source label rather than a blank line.
    expect(installed).toContain("acme/web");
    expect(installed).toContain(t("en", "settings.unknownSource"));
  });

  test("the identity status pill renders the shared primitive from the single derivation", () => {
    // The adapter that used to live in AppsPage is gone; the page and the
    // list both read this one derivation, and the pill face is the shared
    // component's token-backed tone.
    const manage = renderDetail(managePayload, true);
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

  test("the settings face renders its own section titles (workspace rename moved out)", () => {
    const manage = renderDetail(managePayload, true);
    // The App-side SectionCard titles, resolved through the dictionary — the
    // heading/stat migration may not drop or rename a section.
    for (const key of [
      "settings.appInfo",
      "settings.ops",
      "settings.runtimeHarness",
      "settings.providers.title",
      "settings.modelChains",
      "settings.seats",
    ] as const) {
      expect(manage).toContain(t("en", key));
    }
    // The workspace settings live on /dashboard/<ref>/settings; the App
    // settings tab must not keep a second entry point to them.
    expect(manage).not.toContain(t("en", "workspace.settingsHeading"));
  });
});

describe("installed tab configuration surface (static SSR)", () => {
  test("the install block links to the App's GitHub installation page", () => {
    const manage = renderDetail(managePayload, true);
    expect(manage).toContain('href="https://github.com/apps/demo/installations/new"');
    expect(manage).toContain('target="_blank"');
    expect(manage).toContain('rel="noopener noreferrer"');
    // The link's accessible name names the App, not the URL.
    expect(manage).toContain(t("en", "settings.installLinkAria", { name: "Demo" }));
    expect(manage).toContain(t("en", "settings.installCopy"));
  });

  test("a null slug keeps the block with explanations and offers no dead link", () => {
    const noSlug = renderDetail(
      { ...managePayload, app: { ...managePayload.app, github_slug: null } },
      true,
    );
    expect(noSlug).not.toContain("installations/new");
    expect(noSlug).toContain(t("en", "settings.installNoSlug"));
    // The block itself stays rendered (title + the App name).
    expect(noSlug).toContain(t("en", "settings.install"));
  });

  test("a private App renders no allowlist control at all — absence pinned", () => {
    const priv = renderDetail(
      { ...managePayload, app: { ...managePayload.app, github_visibility: "private" } },
      true,
    );
    expect(priv).not.toContain(t("en", "settings.allowlist"));
    expect(priv).not.toContain(t("en", "settings.allowlistEnable"));
    // `unknown` cannot prove private, so the control stays visible there.
    expect(renderDetail(managePayload, true)).toContain(t("en", "settings.allowlist"));
  });

  test("the switch on with an empty list states the fail-closed consequence", () => {
    const on = renderDetail(
      { ...managePayload, allowlist: { enabled: true, owners: [] } },
      true,
    );
    expect(on).toContain(t("en", "settings.allowlistFailClosed"));
    // The logins field exists once the switch is on.
    expect(on).toContain(t("en", "settings.allowlistOwners"));
    // Off with the same empty list carries no warning.
    expect(renderDetail(managePayload, true)).not.toContain(t("en", "settings.allowlistFailClosed"));
    // On with an owner stored has nothing to warn about.
    expect(
      renderDetail({ ...managePayload, allowlist: { enabled: true, owners: ["acme"] } }, true),
    ).not.toContain(t("en", "settings.allowlistFailClosed"));
  });

  test("the review gate renders a 0..100 score input and one checkbox per verdict", async () => {
    const gate = await withMarkup(renderDetail(managePayload, true), (container) => {
      // The gate's own section, by its resolved heading — the settings panel
      // mounts every section, so a page-wide input query would read the
      // allowlist's switch too.
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

  test("no release version string renders anywhere on the page", () => {
    for (const markup of [renderDetail(managePayload, true), renderDetail(identityPayload, false)]) {
      expect(markup).not.toContain(`v${APP_VERSION}`);
    }
  });
});

describe("tab shell mounted behaviour (forceMount)", () => {
  /** The page's stateful wrapper: the shell owns `search` in production. */
  function ShellHarness() {
    const [tabSearch, setTabSearch] = useState<AppDetailSearch>(search);
    return createElement(AppDetailView, {
      locale: "en",
      appId: "1",
      payload: managePayload,
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

  /** The label of the tab whose panel is active — empty when no panel is. */
  const activeTabLabel = (win: Window, container: DomElement) => {
    const active = shellPanels(container).filter((panel) => panel.getAttribute("data-state") === "active");
    if (active.length !== 1) return active.length === 0 ? "" : "multiple";
    const labelledBy = active[0]?.getAttribute("aria-labelledby") ?? "";
    return win.document.getElementById(labelledBy)?.textContent ?? "";
  };

  test("an inactive panel stays mounted but hidden, and the settings form keeps its typed value across a tab switch", async () => {
    // Radix unmounts inactive panels by default, which would destroy the
    // settings forms and refetch a manager tab on every switch. The shell
    // forceMounts every panel; the wrapper's data-[state=inactive]:hidden keeps
    // the one-visible-panel invariant. Typed state surviving the switch is the
    // behaviour, asserted on the live tree rather than in page source.
    const { win, cleanup } = installDom("http://localhost/dashboard/apps/1");
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(createElement(ShellHarness)));
      // Open the draft chain panel, then type a name into its input.
      const addChain = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === t("en", "settings.addChain"),
      );
      await click(win, addChain);
      const input = () =>
        container.querySelector(`input[placeholder="${t("en", "settings.chainNamePlaceholder")}"]`);
      const setValue = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
      await act(async () => {
        setValue?.call(input(), "deep-review");
        input()?.dispatchEvent(new win.Event("input", { bubbles: true }));
      });
      expect((input() as HTMLInputElement | null)?.value).toBe("deep-review");
      const settingsPanel = panelOf(container, input());
      expect(settingsPanel?.getAttribute("data-state")).toBe("active");

      // Switch to Installed: the settings panel is still mounted, now hidden.
      await click(win, tabTrigger(container, t("en", "appDetail.tabInstallations")));
      expect(panelOf(container, input())).toBe(settingsPanel);
      expect(settingsPanel?.getAttribute("data-state")).toBe("inactive");
      // One visible panel: every other shell panel reads inactive.
      expect(shellPanels(container).map((panel) => panel.getAttribute("data-state"))).toEqual([
        "inactive",
        "active",
        "inactive",
        "inactive",
      ]);
      expect((input() as HTMLInputElement | null)?.value).toBe("deep-review");

      // …and back: the value survived a full round trip.
      await click(win, tabTrigger(container, t("en", "appDetail.tabSettings")));
      expect(settingsPanel?.getAttribute("data-state")).toBe("active");
      expect((input() as HTMLInputElement | null)?.value).toBe("deep-review");
    } finally {
      await act(async () => root.unmount());
      cleanup();
    }
  });

  /** A parseable insights summary, so the insights face renders its own body. */
  const INSIGHTS_SUMMARY = {
    window_days: 30,
    repo: "",
    reviews_total: 0,
    findings_by_severity: [],
    verdict_distribution: [],
    weekly_trend: [],
    daily_trend: [],
    findings_distribution: [],
    repos: [],
  };

  /**
   * Mount the stateful page on `url` with the settings read held until the test
   * releases it, so the frame the payload lands in can be observed rather than
   * raced. The insights summary answers empty, like the demotion test.
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
      if (target.includes("/insights/summary")) return json(INSIGHTS_SUMMARY);
      if (target.includes("/pull-requests")) return json({ pull_requests: [] });
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

  test("history traversal re-derives the tab from the URL, through the gate mirror", async () => {
    // The popstate listener is registered once, so it reads the payload's
    // can_manage through the ref mirror rather than a stale mount-time closure.
    // A back/forward move onto ?tab=insights must therefore activate 洞察 even
    // though the gate was still false when the listener was attached.
    const page = await mountPageWithHeldPayload("http://localhost/dashboard/apps/1", managePayload);
    try {
      await page.release();
      expect(activeTabLabel(page.win, page.container)).toBe(t("en", "appDetail.tabSettings"));

      // A forward move: the address changes, then the router's popstate lands.
      page.win.history.pushState(null, "", "/dashboard/apps/1?tab=insights");
      await act(async () => page.win.dispatchEvent(new page.win.Event("popstate")));
      await act(async () => {});
      expect(activeTabLabel(page.win, page.container)).toBe(t("en", "appDetail.tabInsights"));

      // …and back to the bare path returns to 应用设置.
      page.win.history.pushState(null, "", "/dashboard/apps/1");
      await act(async () => page.win.dispatchEvent(new page.win.Event("popstate")));
      await act(async () => {});
      expect(activeTabLabel(page.win, page.container)).toBe(t("en", "appDetail.tabSettings"));
    } finally {
      await page.unmount();
    }
  });

  test("a manager's ?tab=insights deep link never activates the settings panel in any commit", async () => {
    // Mounting with the gate still unknown would resolve ?tab=insights to
    // settings, so the shell withholds the tab face until the payload's gate
    // is committed. Proving "no settings frame was ever painted" needs a
    // FRAME-accurate sample: a MutationObserver is delivered as a coalesced
    // batch and reads the DOM at callback time, so a settings paint immediately
    // replaced by insights inside one batch is invisible to it. React writes
    // `data-state` synchronously during each commit, so patching the setter
    // records every panel activation the tree ever had — one entry per commit,
    // never coalesced.
    const page = await mountPageWithHeldPayload("http://localhost/dashboard/apps/1?tab=insights", managePayload);
    const everActive = new Set<DomElement>();
    const setAttribute = page.win.Element.prototype.setAttribute;
    page.win.Element.prototype.setAttribute = function (name: string, value: string) {
      if (name === "data-state" && value === "active") everActive.add(this);
      return setAttribute.call(this, name, value);
    };
    try {
      // While the settings read is held the tab face does not exist at all —
      // the skeleton is the only committed face.
      expect(page.container.querySelector('[data-slot="page-skeleton"]')).not.toBeNull();
      expect(shellPanels(page.container)).toEqual([]);

      await page.release();
      // The shell panels live across commits (forceMount), so every activation
      // the probe recorded can still be labelled from the settled tree.
      const activated = [...everActive].filter(
        (element) =>
          element.getAttribute("data-slot") === "tabs-content" &&
          shellPanels(page.container).includes(element as DomHTMLElement),
      );
      expect(
        activated.map(
          (element) =>
            page.win.document.getElementById(element.getAttribute("aria-labelledby") ?? "")?.textContent,
        ),
      ).toEqual([t("en", "appDetail.tabInsights")]);
      // The gate confirmed the deep link instead of demoting it: the address
      // still names the insights tab, so no later popstate re-reads settings.
      expect(page.win.location.search).toContain("tab=insights");
    } finally {
      page.win.Element.prototype.setAttribute = setAttribute;
      await page.unmount();
    }
  });

  test("mid-session demotion: a stale manager-tab URL is rewritten once the non-manager payload lands", async () => {
    // ?tab=pull-requests in the address bar + a payload that says non-manager
    // → the landing effect rewrites the URL to the bare path (replaceState),
    // so the stale param cannot sit there and no manager face renders.
    const { win, cleanup } = installDom("http://localhost/dashboard/apps/1?tab=pull-requests");
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify(identityPayload), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(createElement(AppDetailPage, { boot: BOOT, appId: "1" })));
      await act(async () => {});
      expect(win.location.search).not.toContain("tab=pull-requests");
      const text = container.textContent ?? "";
      expect(text).not.toContain(t("en", "appDetail.tabPullRequests"));
      expect(text).toContain(t("en", "appDetail.tabSettings"));
    } finally {
      await act(async () => root.unmount());
      globalThis.fetch = realFetch;
      cleanup();
    }
  });
});

describe("insights tab face (static SSR over the kept charts)", () => {
  const data: InsightsSummary = {
    window_days: 7,
    repo: "",
    reviews_total: 3,
    findings_by_severity: [{ severity: "must-fix", count: 2 }],
    verdict_distribution: [{ verdict: "approve", count: 3 }],
    weekly_trend: [{ week_start: "2026-09-07", reviews: 3, findings: 2 }],
    // (window-bucketing contract 2026-09-20): the 7-day window's trend
    // card reads the zero-filled day grid, not weekly_trend.
    daily_trend: [{ day_start: "2026-09-10", reviews: 3, findings: 2 }],
    findings_distribution: [
      {
        bucket_start: "2026-09-10",
        granularity: "day",
        by_severity: { "must-fix": 2, "should-fix": 0, nit: 0 },
      },
    ],
    repos: ["acme/web"],
  };

  test("the records face renders the three sections over the shared charts (recharts 2.x static face)", () => {
    const html = renderToStaticMarkup(createElement(InsightsRecordsView, { locale: "en", data }));
    expect(html).toContain("Review health");
    expect(html).toContain("Findings by severity");
    // Window-neutral trend card title (window-bucketing contract
    // 2026-09-20) — day windows no longer claim "Weekly".
    expect(html).toContain("Trend");
    expect(html).toContain("recharts-surface");
  });

  test("the records face is one section flow of summary + severity + trend", () => {
    const html = renderToStaticMarkup(createElement(InsightsRecordsView, { locale: "en", data }));
    // One content plane divided by hairlines — health, the severity chart
    // and the trend.
    expect(html.match(/data-slot="flow-section"/g) ?? []).toHaveLength(3);
    for (const title of ["Review health", "Findings by severity", "Trend"]) {
      expect(html, title).toContain(`>${title}</h2>`);
    }
  });

  test("chart series fill from --chart-{n} and legend swatches from --chart-{n}-mark (D14 split)", () => {
    const html = renderToStaticMarkup(createElement(InsightsRecordsView, { locale: "en", data }));
    const fills = [...new Set([...html.matchAll(/chart-fill-(\d)/g)].map((match) => match[1]!))];
    const swatches = [...new Set([...html.matchAll(/chart-legend-swatch chart-swatch-(\d)/g)].map((match) => match[1]!))];
    expect(fills.length).toBeGreaterThan(0);
    expect(swatches.length).toBeGreaterThan(0);
    // The surface maps semantics onto the page's slots only: the severity
    // chart paints its declared merge-class slot, and the trend's two
    // series keep the pair the chart fixes.
    for (const slot of [SEVERITY_SLOTS["must-fix"], 5, 3]) {
      expect(fills, `fill ${slot}`).toContain(String(slot));
      expect(swatches, `swatch ${slot}`).toContain(String(slot));
    }
    // Each slot the surface paints has both faces in the stylesheet: the
    // large fill on the quiet `--chart-{n}`, the small mark on `-mark`.
    const css = readFileSync(join(spaRoot, "components/charts/charts.css"), "utf8");
    for (const slot of [...fills, ...swatches]) {
      expect(css, slot).toContain(`.chart-fill-${slot} { fill: var(--chart-${slot}); }`);
      expect(css, slot).toContain(`.chart-swatch-${slot} { background-color: var(--chart-${slot}-mark); }`);
    }
  });

  test("the zero-review window renders the composed empty state, never a bare axis", () => {
    const empty: InsightsSummary = { ...data, reviews_total: 0, findings_by_severity: [] };
    const html = renderToStaticMarkup(createElement(InsightsRecordsView, { locale: "en", data: empty }));
    expect(html).toContain("No reviews yet");
  });

  test("initial load renders a polite loading face before the first fetch lands (qc4)", () => {
    // SSR render = the pre-effect mount: data is null and state is
    // "loading", exactly the first-paint face of a deep link or an
    // in-flight first request. The tab must not be a bare toolbar.
    const html = renderToStaticMarkup(
      createElement(AppInsightsTab, {
        locale: "en",
        appId: "1",
        search: { tab: "insights", window: "30", repo: "", pr: "" },
        onSearch: () => {},
      }),
    );
    expect(html).toContain('role="status"');
    expect(html).toContain("Loading…");
  });

  test("a refetch over retained data keeps the records mounted, then reports the failure in place", async () => {
    // The no-flash contract, driven through the tab's own effect: the
    // filter change starts a load, and the previous sections stay on screen
    // under the polite busy hint; a failed refetch reports in a slim alert
    // line instead of unmounting the face or falling to the initial-load
    // ErrorState. Both states are read off the live tree, not the source.
    const pending: Array<(error: Error) => void> = [];
    let release = false;
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async () => {
      if (!release) return new Response(JSON.stringify(data), { status: 200 });
      return new Promise<Response>((_resolve, reject) => {
        pending.push(reject);
      });
    }) as unknown as typeof fetch;

    let setWindow: (next: AppDetailSearch["window"]) => void = () => {};
    function Harness() {
      const [search, setSearch] = useState<AppDetailSearch>({ tab: "insights", window: "30", repo: "", pr: "" });
      setWindow = (next) => setSearch((previous) => ({ ...previous, window: next }));
      return createElement(AppInsightsTab, { locale: "en", appId: "1", search, onSearch: setSearch });
    }

    const { win, cleanup } = installDom("http://localhost/dashboard/apps/1");
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const heading = () => container.querySelector("h2")?.textContent ?? "";
    try {
      await act(async () => root.render(createElement(Harness)));
      await act(async () => {});
      expect(heading()).toContain("Review health");

      // In-flight refetch: the previous sections stay, the busy state is on.
      release = true;
      await act(async () => setWindow("90"));
      expect(heading()).toContain("Review health");
      expect(container.querySelector('[aria-busy="true"]')).not.toBeNull();

      // The refetch fails: the records are still there, the failure is a line
      // in place, and the initial-load face is not.
      await act(async () => pending.at(-1)?.(new Error("offline")));
      await act(async () => {});
      expect(heading()).toContain("Review health");
      expect(container.textContent ?? "").toContain(t("en", "common.loadFailed"));
      expect(container.querySelector('[data-slot="error-state"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      globalThis.fetch = realFetch;
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
      expect(loaded?.payload.can_manage).toBe(false);
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

  test("the manage face reads the model options off the SAME base", async () => {
    const calls: string[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      return new Response(
        JSON.stringify(url.endsWith("/models") ? { groups: [] } : managePayload),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    try {
      await loadAppDetail("/dashboard/beta", "1");
      expect(calls).toEqual([
        "/dashboard/beta/api/apps/1/settings",
        "/dashboard/beta/api/apps/1/models",
      ]);
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
    [...renderDetail(payload, true).matchAll(/data-slot="metric-key"[^>]*>([^<]+)<\/span><span data-slot="metric-value"[^>]*class="([^"]*)"[^>]*>(\d+)<\/span>/g)]
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
