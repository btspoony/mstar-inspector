/**
 * App detail page (App detail IA): two-tab shell pins.
 * No DOM runner — source-scan + static-SSR + pure-helper contracts, the
 * repo's standard trio (charts-recharts precedent for SSR).
 *
 * 1. Tab shell: default tab 应用设置 on the bare path AND the legacy
 *    /settings deep link; the 洞察 tab renders ONLY on the manage face —
 *    a non-manager must not see the tab at all (absence pinned).
 * 2. Radix Tabs forceMount knowledge: inactive panels must be hidden by
 *    the wrapper's `data-[state=inactive]:hidden` (ui-bugs knowledge pin).
 * 3. URL-derived state: one []-mounted popstate listener + replaceState
 *    commits (spa-url-state-resync contract).
 * 4. R1 closure: the kept data.ts insights helpers (parseInsights /
 *    INSIGHTS_WINDOWS / insightsRepo*) get their new consumer — the
 *    per-App insights tab — via the mount-prefixed
 *    /dashboard/api/apps/:slug/insights/summary face.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import {
  appDetailSearchQuery,
  appInsightsSummaryUrl,
  parseAppDetailSearch,
  type InsightsSummary,
} from "../../src/spa/pages/data";
import { AppDetailView } from "../../src/spa/pages/AppDetailPage";
import { AppInsightsTab, InsightsRecordsView } from "../../src/spa/pages/AppInsightsTab";

const spaRoot = join(import.meta.dir, "../../src/spa");
const detailPage = readFileSync(join(spaRoot, "pages/AppDetailPage.tsx"), "utf8");
const insightsTab = readFileSync(join(spaRoot, "pages/AppInsightsTab.tsx"), "utf8");
const tabsWrapper = readFileSync(join(spaRoot, "components/ui/tabs.tsx"), "utf8");

const IDENTITY_APP = {
  slug: "demo",
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

const identityPayload = { can_manage: false as const, app: IDENTITY_APP };

const managePayload = {
  can_manage: true as const,
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

const search = { tab: "settings" as const, window: "30" as const, repo: "" };
const noReload = async () => true;
const noSearch = () => {};

function renderDetail(payload: typeof identityPayload | typeof managePayload, canManage: boolean) {
  return renderToStaticMarkup(
    createElement(AppDetailView, {
      locale: "en",
      slug: "demo",
      payload,
      groups: [],
      notice: null,
      search,
      onReload: noReload,
      onSearch: noSearch,
    }),
  );
}

describe("app detail URL state (shared pure helpers)", () => {
  test("default tab is settings on the bare path; ?tab=insights only for a manager", () => {
    expect(parseAppDetailSearch("", true)).toEqual({ tab: "settings", window: "30", repo: "" });
    expect(parseAppDetailSearch("?tab=insights", true).tab).toBe("insights");
    // A non-manager never resolves to the insights tab — the URL cannot
    // grant the tab the payload denies.
    expect(parseAppDetailSearch("?tab=insights", false).tab).toBe("settings");
  });

  test("insights filter params ride the same query (window segments + repo)", () => {
    expect(parseAppDetailSearch("?tab=insights&window=7&repo=acme%2Fweb", true)).toEqual({
      tab: "insights",
      window: "7",
      repo: "acme/web",
    });
    // Off-set windows resolve to the default segment (pinned helper).
    expect(parseAppDetailSearch("?window=60", true).window).toBe("30");
  });

  test("appDetailSearchQuery is the inverse — defaults omitted (loop-free replaceState writes)", () => {
    expect(appDetailSearchQuery({ tab: "settings", window: "30", repo: "" })).toBe("");
    expect(appDetailSearchQuery({ tab: "insights", window: "30", repo: "" })).toBe("?tab=insights");
    expect(appDetailSearchQuery({ tab: "insights", window: "7", repo: "acme/web" })).toBe(
      "?tab=insights&window=7&repo=acme%2Fweb",
    );
  });

  test("the per-App summary URL is mount-prefixed and encodes slug + filters; include=repos always rides", () => {
    expect(appInsightsSummaryUrl("demo", "30", "")).toBe(
      "/dashboard/api/apps/demo/insights/summary?window=30&include=repos",
    );
    expect(appInsightsSummaryUrl("acme inc", "7", "acme/web")).toBe(
      "/dashboard/api/apps/acme%20inc/insights/summary?window=7&include=repos&repo=acme%2Fweb",
    );
  });
});

describe("tab shell rendering (static SSR)", () => {
  test("default tab is 应用设置 for both roles; the manager sees BOTH tabs", () => {
    const manage = renderDetail(managePayload, true);
    expect(manage).toContain(">Settings</button>");
    expect(manage).toContain(">Insights</button>");
    // The identity header serves both tabs.
    expect(manage).toContain(">demo</h1>");
    expect(manage).toContain("by mallory");
  });

  test("a non-manager sees identity-only with NO 洞察 tab rendered — absence pinned", () => {
    const identity = renderDetail(identityPayload, false);
    expect(identity).toContain(">Settings</button>");
    expect(identity).not.toContain(">Insights</button>");
    // No insights panel markup anywhere on the face.
    expect(identity).not.toContain("Review health");
  });
});

describe("tab shell source contracts", () => {
  test("wayfinding: the back link is the shell's first element on both faces — before the identity-header h1", () => {
    // The back link moved out of the settings tab body (SettingsView) to
    // the stateful AppDetailPage shell, so it renders on the error face
    // AND the ok face (both roles — the shell serves managers and
    // non-managers alike) as the page's first element. The loading
    // skeleton early returns stay excluded (transient faces). The link
    // face is the SettingsPage idiom: ArrowLeft aria-hidden + label.
    const wayfindingAt = detailPage.indexOf('href="/dashboard/apps"');
    expect(wayfindingAt).toBeGreaterThan(-1);
    expect(detailPage).toContain('t(locale, "appDetail.backToApps")');
    expect(detailPage).toContain("spaClick");
    const h1At = detailPage.indexOf("{slug}</h1>");
    expect(h1At).toBeGreaterThan(wayfindingAt);
    // The link-face window spans the whole anchor — open tag through the
    // label call — so the ArrowLeft (which follows the href in source)
    // is covered (the settings-layout idiom).
    const labelAt = detailPage.indexOf('t(locale, "appDetail.backToApps")');
    expect(labelAt).toBeGreaterThan(wayfindingAt);
    const wayfinding = detailPage.slice(detailPage.lastIndexOf("<a", wayfindingAt), labelAt);
    expect(wayfinding).toContain("<ArrowLeft");
    expect(wayfinding).toContain('aria-hidden="true"');
    expect(wayfinding).toContain("inline-flex items-center gap-1.5");
    // The shell's returned fragment carries the link before both faces:
    // error face (ErrorState) and ok face (AppDetailView).
    const returnAt = detailPage.indexOf('state === "error" ? <ErrorState');
    expect(returnAt).toBeGreaterThan(-1);
    expect(detailPage.lastIndexOf('href="/dashboard/apps"', returnAt)).toBeGreaterThan(-1);
    // The pure view gained nothing: no back link inside AppDetailView.
    const viewAt = detailPage.indexOf("export function AppDetailView");
    expect(detailPage.indexOf('href="/dashboard/apps"', viewAt)).toBe(-1);
  });

  test("forceMount knowledge: the ui wrapper hides inactive panels via data-[state=inactive]:hidden", () => {
    expect(tabsWrapper).toContain("data-[state=inactive]:hidden");
  });

  test("mount-once tab switching: BOTH panels forceMount — switching tabs preserves settings form state (qc1)", () => {
    // Radix unmounts inactive panels by default, which would destroy the
    // settings forms (typed inputs, Add Provider panel, op notices) and
    // refetch insights from scratch on every 应用设置 ↔ 洞察 switch. Both
    // panels forceMount; the wrapper's data-[state=inactive]:hidden keeps
    // the one-visible-panel invariant (pin above).
    expect(detailPage.match(/<TabsContent value="settings" forceMount>/g)?.length).toBe(1);
    expect(detailPage.match(/<TabsContent value="insights" forceMount>/g)?.length).toBe(1);
    // No unmount-by-default panel remains on the shell.
    expect(detailPage).not.toMatch(/<TabsContent value="[^"]+">\s*\n/);
  });

  test("mid-session demotion rewrite: a stale ?tab=insights is replaced when the payload says non-manager (qc2)", () => {
    // The payload-landing effect rewrites the URL (replaceState via
    // commitSearch — loop-free) to the settings tab, so the stale param
    // cannot auto-reactivate the insights face on a later re-promotion.
    const landing = detailPage.slice(
      detailPage.indexOf("// When the payload lands"),
      detailPage.indexOf("const onPop"),
    );
    expect(landing).toContain('parseAppDetailSearch(window.location.search, true).tab === "insights"');
    expect(landing).toContain('commitSearch({ tab: "settings", window: "30", repo: "" });');
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
    // State derives through the shared pure helper (mount init, slug
    // re-derivation, payload-landing demotion check + re-derivation,
    // popstate).
    expect(detailPage.match(/parseAppDetailSearch\(/g)?.length).toBe(5);
  });

  test("manager deep-link fix: the gate rides a ref mirror, re-derived when the payload lands — never a stale false closure", () => {
    // (Fix round 1): the registered-once popstate listener (and the
    // mount/slug re-derivations) must read the canManageRef mirror — a
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
    expect(insightsTab).toContain("appInsightsSummaryUrl(slug");
    expect(insightsTab).toContain("parseInsights(");
    expect(insightsTab).toContain("INSIGHTS_WINDOWS.map");
    expect(insightsTab).toContain("insightsRepoOptions(");
    expect(insightsTab).toContain('from "./data"');
  });
});

describe("insights tab face (static SSR over the kept charts)", () => {
  const data: InsightsSummary = {
    window_days: 7,
    repo: "",
    reviews_total: 3,
    findings_by_severity: [{ severity: "must-fix", count: 2 }],
    findings_by_category: [{ category: "DEBT", count: 2 }],
    verdict_distribution: [{ verdict: "approve", count: 3 }],
    weekly_trend: [{ week_start: "2026-09-07", reviews: 3, findings: 2 }],
    findings_distribution: [
      {
        bucket_start: "2026-09-10",
        granularity: "day",
        by_severity: { "must-fix": 2, "should-fix": 0, nit: 0 },
        by_category: { DEBT: 2, uncategorized: 0 },
      },
    ],
    recurring_top: [{ fingerprint: "fp1", title_sample: "Off-by-one", count: 2, repos: ["acme/web"] }],
    repos: ["acme/web"],
  };

  test("the records face renders the four sections over the shared charts (recharts 2.x static face)", () => {
    const html = renderToStaticMarkup(createElement(InsightsRecordsView, { locale: "en", data }));
    expect(html).toContain("Review health");
    expect(html).toContain("Findings by severity");
    expect(html).toContain("Weekly trend");
    expect(html).toContain("Recurring findings");
    expect(html).toContain("recharts-surface");
  });

  test("the zero-review window renders the composed empty state, never a bare axis", () => {
    const empty: InsightsSummary = { ...data, reviews_total: 0, findings_by_severity: [], findings_by_category: [] };
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
        slug: "demo",
        search: { tab: "insights", window: "30", repo: "" },
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
