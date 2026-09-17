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
import { InsightsRecordsView } from "../../src/spa/pages/AppInsightsTab";

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

  test("the per-App summary URL is mount-prefixed and encodes slug + filters", () => {
    expect(appInsightsSummaryUrl("demo", "30", "", true)).toBe(
      "/dashboard/api/apps/demo/insights/summary?window=30&include=repos",
    );
    expect(appInsightsSummaryUrl("acme inc", "7", "acme/web", false)).toBe(
      "/dashboard/api/apps/acme%20inc/insights/summary?window=7&repo=acme%2Fweb",
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
  test("forceMount knowledge: the ui wrapper hides inactive panels via data-[state=inactive]:hidden", () => {
    expect(tabsWrapper).toContain("data-[state=inactive]:hidden");
  });

  test("URL state re-sync: exactly one []-mounted popstate listener; commits ride replaceState, never pushState", () => {
    expect(detailPage.match(/addEventListener\("popstate"/g)?.length).toBe(1);
    expect(detailPage).toContain("removeEventListener(\"popstate\"");
    expect(detailPage).toContain("history.replaceState");
    // The page never pushes history itself (navigation stays in the router).
    expect(detailPage).not.toContain(".pushState(");
    // State derives through the shared pure helper (mount + popstate).
    expect(detailPage.match(/parseAppDetailSearch\(/g)?.length).toBe(3);
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
});
