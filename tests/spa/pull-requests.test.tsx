/**
 * Pull requests tab (App detail IA): the per-App PR ledger.
 *
 * Static-SSR pins over the pure faces (the InsightsRecordsView idiom):
 * the manage-gated tab trigger, the list table (title / state / verdict /
 * last seen / failure count), the empty state, and the detail face
 * (reviews, failures — stage + error as TEXT — findings). The fetch
 * wiring is pinned on the URL builders + payload parsers (no DOM runner).
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../../src/i18n";
import {
  appPullRequestDetailUrl,
  appPullRequestsUrl,
  parsePullRequestDetail,
  parsePullRequestList,
  pullRequestRefOf,
  type PullRequestDetail,
  type PullRequestRow,
  type SettingsPayload,
} from "../../src/spa/pages/data";
import { AppDetailView } from "../../src/spa/pages/AppDetailPage";
import {
  PullRequestDetailView,
  PullRequestsListView,
} from "../../src/spa/pages/AppPullRequestsTab";

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

const identityPayload: SettingsPayload = {
  can_manage: false,
  workspace_id: "ws_0123456789abcdefghijkl",
  app: IDENTITY_APP,
};

const managePayload = {
  ...identityPayload,
  can_manage: true,
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

function renderDetail(payload: SettingsPayload) {
  return renderToStaticMarkup(
    createElement(AppDetailView, {
      locale: "en",
      appId: "1",
      payload,
      groups: [],
      notice: null,
      search,
      onReload: noReload,
      onSearch: noSearch,
    }),
  );
}

const ROW_OPEN: PullRequestRow = {
  number: 42,
  owner: "acme",
  repo: "web",
  title: "Add the export button",
  state: "open",
  head_sha: "aaa111bbb222",
  first_seen_at: "2026-10-28 08:00:00",
  last_seen_at: "2026-11-01 10:00:00",
  latest_review: { verdict: "ship it", reviewed_at: "2026-11-01 09:00:00" },
  failure_count: 0,
};

const ROW_CLOSED: PullRequestRow = {
  number: 7,
  owner: "acme",
  repo: "api",
  title: "Revert the cache change",
  state: "closed",
  head_sha: "ccc333ddd444",
  first_seen_at: "2026-10-20 08:00:00",
  last_seen_at: "2026-10-25 10:00:00",
  latest_review: null,
  failure_count: 2,
};

const DETAIL: PullRequestDetail = {
  pull_request: {
    ...ROW_OPEN,
    number: 133,
    title: "Fix the login flow",
    state: "merged",
    latest_review: { verdict: "needs fixes", reviewed_at: "2026-11-01 08:00:00" },
    failure_count: 1,
  },
  reviews: [
    {
      verdict: "ship it",
      summary_md: "Looks good overall.",
      model: "kimi-for-coding",
      provider: "openrouter",
      reviewed_at: "2026-11-01 08:00:00",
      head_sha: "aaa111bbb222",
    },
  ],
  failures: [
    {
      stage: "sandbox",
      // Model/runtime output — must render escaped, never as HTML.
      error: "exit 1: <script>alert(1)</script>",
      created_at: "2026-10-31 23:00:00",
    },
  ],
  findings: [
    {
      finding_id: "f-1",
      severity: "must-fix",
      title: "Use a parameterized query",
      file_path: "src/db.ts",
      line: 42,
      body: "String interpolation reaches the SQL engine.",
    },
  ],
};

describe("tab shell rendering (static SSR)", () => {
  test("the Pull requests trigger appears ONLY on the manage face", () => {
    const manage = renderDetail(managePayload);
    expect(manage).toContain(">Pull requests</button>");
    expect(manage).toContain('data-state="inactive"');
    const identity = renderDetail(identityPayload);
    expect(identity).not.toContain(">Pull requests</button>");
    expect(identity).not.toContain(t("en", "pullRequests.columnPr"));
  });
});

describe("pull requests list face (static SSR)", () => {
  test("a row renders the PR title, state badge and latest verdict", () => {
    const markup = renderToStaticMarkup(
      createElement(PullRequestsListView, { locale: "en", rows: [ROW_OPEN, ROW_CLOSED], onOpen: noSearch }),
    );
    // PR identity cell: `#number` + title, owner/repo on the meta line.
    expect(markup).toContain("#42");
    expect(markup).toContain("Add the export button");
    expect(markup).toContain("acme/web");
    // State badges from the closed vocabulary.
    expect(markup).toContain(t("en", "pullRequests.state.open"));
    expect(markup).toContain(t("en", "pullRequests.state.closed"));
    // Latest verdict, and the no-review dash for the null case.
    expect(markup).toContain("ship it");
    expect(markup).toContain("Revert the cache change");
    // The failure count is the row's own figure.
    expect(markup).toContain(">2</span>");
  });

  test("the empty state renders when the App has seen no PR yet", () => {
    const markup = renderToStaticMarkup(
      createElement(PullRequestsListView, { locale: "en", rows: [], onOpen: noSearch }),
    );
    expect(markup).toContain(t("en", "pullRequests.emptyTitle"));
    expect(markup).toContain(t("en", "pullRequests.emptyDescription"));
    // No table shell leaks through the empty state.
    expect(markup).not.toContain("<table");
  });
});

describe("pull request detail face (static SSR)", () => {
  test("the header names title, address, state and head sha", () => {
    const markup = renderToStaticMarkup(
      createElement(PullRequestDetailView, { locale: "en", detail: DETAIL }),
    );
    expect(markup).toContain("Fix the login flow");
    expect(markup).toContain("acme/web #133");
    expect(markup).toContain(t("en", "pullRequests.state.merged"));
    // The short-sha chip renders the head sha prefix.
    expect(markup).toContain("aaa111b");
  });

  test("a failure renders its stage and error — the error as escaped text, never HTML", () => {
    const markup = renderToStaticMarkup(
      createElement(PullRequestDetailView, { locale: "en", detail: DETAIL }),
    );
    expect(markup).toContain("sandbox");
    expect(markup).toContain("exit 1: &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(markup).not.toContain("<script>");
  });

  test("reviews and findings render their own facts", () => {
    const markup = renderToStaticMarkup(
      createElement(PullRequestDetailView, { locale: "en", detail: DETAIL }),
    );
    expect(markup).toContain("ship it");
    expect(markup).toContain("kimi-for-coding · openrouter");
    expect(markup).toContain("Looks good overall.");
    expect(markup).toContain("Use a parameterized query");
    expect(markup).toContain("must-fix");
    expect(markup).toContain("src/db.ts:42");
  });
});

describe("pull requests data plane (pure helpers)", () => {
  test("the list URL is base-prefixed and encodes the appId", () => {
    expect(appPullRequestsUrl("/dashboard", "1")).toBe("/dashboard/api/apps/1/pull-requests");
    expect(appPullRequestsUrl("/dashboard/acme", "12345")).toBe(
      "/dashboard/acme/api/apps/12345/pull-requests",
    );
  });

  test("the detail URL builder encodes owner/repo so a value cannot break out of the path family", () => {
    expect(appPullRequestDetailUrl("/dashboard", "1", { owner: "acme", repo: "web", number: 42 })).toBe(
      "/dashboard/api/apps/1/pull-requests/acme/web/42",
    );
    // Segment-boundary characters are encoded, not trusted raw.
    expect(
      appPullRequestDetailUrl("/dashboard", "1", { owner: "a/b", repo: "settings?x", number: 42 }),
    ).toBe("/dashboard/api/apps/1/pull-requests/a%2Fb/settings%3Fx/42");
  });

  test("pullRequestRefOf validates the pr param shape and rejects dot segments", () => {
    expect(pullRequestRefOf("acme/web/42")).toEqual({ owner: "acme", repo: "web", number: 42 });
    expect(pullRequestRefOf("42")).toBeNull();
    expect(pullRequestRefOf("acme/web/abc")).toBeNull();
    expect(pullRequestRefOf("/web/42")).toBeNull();
    // Path traversal: encodeURIComponent cannot neutralise a dot-segment
    // (".." encodes to ".."), so the parse boundary rejects it outright.
    expect(pullRequestRefOf("../settings/1")).toBeNull();
    expect(pullRequestRefOf("acme/../1")).toBeNull();
  });

  test("the list parser coerces a drifted row instead of blanking the list (QC)", () => {
    expect(parsePullRequestList({ pull_requests: [ROW_OPEN] })).toEqual([ROW_OPEN]);
    // Nullable display fields coerce to ""; an unknown state clamps to open.
    const drifted = { ...ROW_OPEN, title: null, head_sha: undefined, state: "draft" };
    expect(parsePullRequestList({ pull_requests: [drifted] })).toEqual([
      { ...ROW_OPEN, title: "", head_sha: "", state: "open" },
    ]);
    // A row without its address is dropped individually — the rest stay.
    const noAddress = { ...ROW_OPEN, owner: null };
    expect(parsePullRequestList({ pull_requests: [noAddress, ROW_CLOSED] })).toEqual([ROW_CLOSED]);
    // A malformed latest_review coerces to null, not a failed row.
    expect(parsePullRequestList({ pull_requests: [{ ...ROW_OPEN, latest_review: "ship it" }] })).toEqual([
      { ...ROW_OPEN, latest_review: null },
    ]);
    // The envelope keeps its shape.
    expect(parsePullRequestList({})).toBeNull();
  });

  test("a null title on one row still returns the other rows", () => {
    const parsed = parsePullRequestList({ pull_requests: [{ ...ROW_OPEN, title: null }, ROW_CLOSED] });
    expect(parsed).toHaveLength(2);
    expect(parsed?.[0]?.title).toBe("");
    expect(parsed?.[1]).toEqual(ROW_CLOSED);
  });

  test("the detail parser keeps the envelope strict but drops drifted entries (QC)", () => {
    expect(parsePullRequestDetail(DETAIL)).toEqual(DETAIL);
    // One drifted failure / finding drops that entry, not the whole detail.
    expect(parsePullRequestDetail({ ...DETAIL, failures: [{ stage: 1 }] })?.failures).toEqual([]);
    expect(
      parsePullRequestDetail({ ...DETAIL, findings: [{ ...DETAIL.findings[0], line: "42" }] })?.findings,
    ).toEqual([]);
    // A pull_request without its address still fails the envelope.
    expect(
      parsePullRequestDetail({ ...DETAIL, pull_request: { ...DETAIL.pull_request, owner: null } }),
    ).toBeNull();
    expect(parsePullRequestDetail(null)).toBeNull();
  });

  test("a review with provider null parses and renders without a null leak (QC)", () => {
    const withNulls = {
      ...DETAIL,
      reviews: [
        { ...DETAIL.reviews[0], verdict: null, summary_md: null, model: null, provider: null },
      ],
      findings: [{ ...DETAIL.findings[0], title: null, file_path: null, body: null }],
    };
    const parsed = parsePullRequestDetail(withNulls);
    // The nullable text fields coerce to "" at the parse boundary; the
    // address fields pass through untouched.
    expect(parsed?.reviews[0]).toEqual({
      verdict: "",
      summary_md: "",
      model: "",
      provider: "",
      reviewed_at: "2026-11-01 08:00:00",
      head_sha: "aaa111bbb222",
    });
    expect(parsed?.findings[0]).toEqual({
      finding_id: "f-1",
      severity: "must-fix",
      title: "",
      file_path: "",
      line: 42,
      body: "",
    });
    // And the view renders the coerced row.
    const markup = renderToStaticMarkup(
      createElement(PullRequestDetailView, { locale: "en", detail: parsed ?? DETAIL }),
    );
    expect(markup).not.toContain("undefined");
    expect(markup).not.toContain(">null<");
  });
});
