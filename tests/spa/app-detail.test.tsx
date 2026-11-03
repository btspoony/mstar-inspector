/**
 * App detail page (App detail IA): two-tab shell pins.
 * No DOM runner — source-scan + static-SSR + pure-helper contracts, the
 * repo's standard trio (charts-recharts precedent for SSR).
 *
 * 1. Tab shell: default tab 应用设置 on the bare path AND the legacy
 *    /settings deep link; the 洞察 tab renders ONLY on the manage face —
 *    a non-manager must not see the tab at all (absence pinned).
 * 2. Mount-once tab switching: a manager tab switch leaves the settings panel
 *    mounted (and hidden), so typed form state survives (mounted assertion).
 * 3. URL-derived state: one []-mounted popstate listener + replaceState
 *    commits (spa-url-state-resync contract).
 * 4. R1 closure: the kept data.ts insights helpers (parseInsights /
 *    INSIGHTS_WINDOWS / insightsRepo*) get their new consumer — the
 *    per-App insights tab — via the mount-prefixed
 *    /dashboard/api/apps/:appId/insights/summary face.
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
import { installDom } from "./dom";

const spaRoot = join(import.meta.dir, "../../src/spa");
const detailPage = readFileSync(join(spaRoot, "pages/AppDetailPage.tsx"), "utf8");
const insightsTab = readFileSync(join(spaRoot, "pages/AppInsightsTab.tsx"), "utf8");

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
  test("default tab is 应用设置 for both roles; the manager sees ALL three manager tabs", () => {
    const manage = renderDetail(managePayload, true);
    expect(manage).toContain(">Settings</button>");
    expect(manage).toContain(">Installed</button>");
    expect(manage).toContain(">Insights</button>");
    // The identity header serves both tabs — the GitHub display name (D6).
    expect(manage).toContain(">Demo</h1>");
    expect(manage).toContain("by mallory");
  });

  test("a non-manager sees identity-only with NO 洞察 tab rendered — absence pinned", () => {
    const identity = renderDetail(identityPayload, false);
    expect(identity).toContain(">Settings</button>");
    expect(identity).not.toContain(">Installed</button>");
    expect(identity).not.toContain(">Insights</button>");
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
});

describe("tab shell source contracts", () => {
  test("mid-session demotion rewrite: a stale manager-tab URL is rewritten once the non-manager payload lands (qc2)", async () => {
    // Product behaviour: ?tab=pull-requests in the address bar + a payload
    // that says non-manager → the landing effect rewrites the URL to the
    // bare path (replaceState), so the stale param cannot sit in the
    // address bar and no manager face renders. A rename of the page's
    // internals must not false-fail this — it drives the real page.
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
      await act(async () =>
        root.render(createElement(AppDetailPage, { boot: BOOT, appId: "1" })),
      );
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

  test("insights refetch retains data: content renders on data !== null; ErrorState is initial-load-only (qc3)", () => {
    // The filter refetch never blanks the four stat sections — the
    // previous data stays rendered under the polite busy hint, and a
    // refetch failure over retained data reports in a slim alert line
    // instead of unmounting the face.
    expect(insightsTab).toContain('{data !== null ? <InsightsRecordsView locale={locale} data={data} /> : null}');
    expect(insightsTab).toContain('state === "error" && data === null');
    expect(insightsTab).toContain('state === "error" && data !== null');
  });

  test("URL state re-sync: exactly one []-mounted popstate listener; commits ride replaceState, never pushState", () => {
    expect(detailPage.match(/addEventListener\("popstate"/g)?.length).toBe(1);
    expect(detailPage).toContain("removeEventListener(\"popstate\"");
    expect(detailPage).toContain("history.replaceState");
    // The page never pushes history itself (navigation stays in the router).
    expect(detailPage).not.toContain(".pushState(");
    // State derives through the shared pure helper (mount init, appId
    // re-derivation, payload-landing demotion check + re-derivation,
    // popstate).
    expect(detailPage.match(/parseAppDetailSearch\(/g)?.length).toBe(5);
  });

  test("manager deep-link fix: the gate rides a ref mirror, re-derived when the payload lands — never a stale false closure", () => {
    // (Fix round 1): the registered-once popstate listener (and the
    // mount/appId re-derivations) must read the canManageRef mirror — a
    // stale `payload?.can_manage ?? false` closure would permanently
    // resolve a manager's `?tab=insights` deep link and history
    // back/forward to the settings tab.
    expect(detailPage).toContain("const canManageRef = useRef(false);");
    expect(detailPage).toContain(
      "const onPop = () => setSearch(parseAppDetailSearch(window.location.search, canManageRef.current));",
    );
    expect(detailPage).not.toContain("parseAppDetailSearch(window.location.search, payload?.can_manage ?? false)");
    // One re-derivation when the payload lands: the gate mirror is written
    // and the location re-parsed, so a manager's `?tab=insights` deep link
    // (and a history entry carrying it — native popstate re-reads the same
    // ref) activates the insights tab as soon as can_manage is known.
    const landing = detailPage.slice(
      detailPage.indexOf("// When the payload lands"),
      detailPage.indexOf("const onPop"),
    );
    expect(landing).toContain("canManageRef.current = payload?.can_manage ?? false;");
    expect(landing).toContain(
      "setSearch(parseAppDetailSearch(window.location.search, canManageRef.current));",
    );
  });

  test("manager deep-link first paint: the tab face is withheld until the URL tab is committed against the landed payload (qc4)", () => {
    // The shell seeds `search` with the mount-time gate (false), and the
    // payload flips `state` to "ok" BEFORE the landing effect re-derives
    // the tab — rendering the face in between would first-paint 应用设置
    // on a manager's `?tab=insights` deep link. `searchReady` withholds
    // the face behind the loading skeleton until the landing effect has
    // committed the URL-requested tab (or performed the demotion rewrite).
    expect(detailPage).toContain("const [searchReady, setSearchReady] = useState(false);");
    const landing = detailPage.slice(
      detailPage.indexOf("// When the payload lands"),
      detailPage.indexOf("const onPop"),
    );
    // BOTH landing paths commit readiness: the demotion rewrite and the
    // re-derivation. The gate stays true afterwards — background reloads
    // never re-flash the skeleton.
    expect(landing.match(/setSearchReady\(true\);/g)?.length).toBe(2);
    const render = detailPage.slice(detailPage.indexOf("if (state === \"loading\")"));
    expect(render).toContain('if (state === "ok" && payload && !searchReady)');
    expect(render).toContain("<PageSkeleton locale={locale} kind=\"forms\" />");
    // Loop-free unchanged: the withhold adds no history writes and no new
    // location parses (the demotion rewrite keeps its replaceState).
    expect(detailPage).not.toContain(".pushState(");
  });

  test("R1 closure: the insights tab consumes the kept data.ts helpers over the mount-prefixed per-App face", () => {
    expect(insightsTab).toContain("appInsightsSummaryUrl(apiBase(), appId");
    expect(insightsTab).toContain("parseInsights(");
    expect(insightsTab).toContain("INSIGHTS_WINDOWS.map");
    expect(insightsTab).toContain("insightsRepoOptions(");
    expect(insightsTab).toContain('from "./data"');
    // The repo selector keeps its behaviour: the value goes through the kept
    // helper, "all" stays the default option, and the options are the
    // window's repos in the helper's order.
    expect(insightsTab).toContain("value={insightsRepoSelectValue(search.repo)}");
    expect(insightsTab).toContain("<SelectItem value={INSIGHTS_REPO_ALL}>");
    expect(insightsTab).toContain("repoChoices.map((repo) => (");
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
    // Retained-data contract unchanged: content still renders on
    // data !== null, and the retained-data busy hint keeps its own face.
    expect(insightsTab).toContain('{state === "loading" && data === null ?');
    expect(insightsTab).toContain('{state === "loading" && data !== null ?');
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
