/**
 * Pull requests tab (App detail IA): the per-App PR ledger.
 *
 * Static-SSR pins over the pure faces (the InsightsRecordsView idiom):
 * the manage-gated tab trigger, the list table (title / state / verdict /
 * last seen / failure count), the empty state, and the detail face
 * (reviews, failures — stage + error as TEXT — findings). Mounted
 * (happy-dom) pins cover what only real effects and events prove: the
 * manage-gated click-through to the ledger, the failures-column cell
 * content, and the S2 switching contract — a retained detail from PR A
 * must never render while PR B loads, and a failed fetch for the new PR
 * renders the error face with a retry.
 */
import { describe, expect, test } from "bun:test";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../../src/i18n";
import {
  appPullRequestDetailUrl,
  appPullRequestsUrl,
  parsePullRequestDetail,
  parsePullRequestList,
  pullRequestRefOf,
  type AppDetailSearch,
  type PullRequestDetail,
  type PullRequestRow,
  type SettingsPayload,
} from "../../src/spa/pages/data";
import { AppDetailView } from "../../src/spa/pages/AppDetailPage";
import {
  AppPullRequestsTab,
  currentDetailRead,
  PullRequestDetailView,
  PullRequestsListView,
  type DetailRead,
} from "../../src/spa/pages/AppPullRequestsTab";
import { installDom } from "./dom";

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
  // Newest first, as the store orders them: the first row is the latest verdict.
  reviews: [
    {
      verdict: "needs fixes",
      summary_md: "The refresh race is still reachable.",
      model: "kimi-for-coding",
      provider: "openrouter",
      reviewed_at: "2026-11-01 08:00:00",
      head_sha: "aaa111bbb222",
    },
    {
      verdict: "ship it",
      summary_md: "Looks good overall.",
      model: "claude-sonnet-4.5",
      // v1 never records a provider — the separator must disappear with it.
      provider: "",
      reviewed_at: "2026-10-30 08:00:00",
      head_sha: "f00d12c1",
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
    {
      finding_id: "f-2",
      severity: "should-fix",
      title: "Session cookie lacks HttpOnly",
      file_path: "src/auth/session.ts",
      line: 88,
      body: "The refresh cookie is set with secure only.",
    },
    {
      finding_id: "f-3",
      severity: "nit",
      title: "Rename tmp to pending",
      // A repo-wide finding: no file_path, so the location chip disappears.
      file_path: "",
      line: null,
      body: "The variable holds the pending redirect target.",
    },
  ],
};

describe("tab shell rendering (static SSR)", () => {
  test("the Pull requests trigger appears ONLY on the manage face", () => {
    const manage = renderDetail(managePayload);
    expect(manage).toContain(">Pull requests</button>");
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
    // The failures column header rides the table; the count INSIDE the
    // column is pinned by the mounted suite.
    expect(markup).toContain(t("en", "pullRequests.columnFailures"));
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
  const render = (detail: PullRequestDetail) =>
    renderToStaticMarkup(createElement(PullRequestDetailView, { locale: "en", detail }));

  /** The family triggers in render order: selected state + their text content. */
  const familyTabs = (markup: string) =>
    [...markup.matchAll(/<button[^>]*role="tab"[^>]*>([\s\S]*?)<\/button>/g)].map((match) => ({
      selected: /aria-selected="true"/.test(match[0]),
      text: (match[1] ?? "").replace(/<[^>]*>/g, ""),
    }));

  /** The positions of `needles` in `markup`, asserted to be present first. */
  const positions = (markup: string, needles: readonly string[]) =>
    needles.map((needle) => {
      const at = markup.indexOf(needle);
      expect(at, needle).toBeGreaterThan(-1);
      return at;
    });

  /**
   * A failure-only detail: no finding carries a must-fix, so the face opens on
   * the failures family and the diagnostic payload is in the markup.
   */
  const FAILING: PullRequestDetail = { ...DETAIL, findings: [] };

  test("the header names the PR's own facts; the band aggregates them", () => {
    const markup = render(DETAIL);
    expect(markup).toContain("Fix the login flow");
    expect(markup).toContain("acme/web #133");
    expect(markup).toContain(t("en", "pullRequests.state.merged"));
    // Short-sha chip over the head sha, titled with the full-name tooltip.
    expect(markup).toContain(">aaa111b<");
    expect(markup).toContain(t("en", "pullRequests.headSha"));
    // Meta line: first seen, last seen, latest review attribution.
    for (const label of ["firstSeen", "lastSeen", "latestReview"] as const) {
      expect(markup).toContain(t("en", `pullRequests.${label}`));
    }
    expect(markup).toContain("kimi-for-coding · openrouter");
    // Band: four metrics — verdict, reviews, failures, findings with its note.
    expect(markup.match(/data-slot="metric"/g) ?? []).toHaveLength(4);
    expect(markup).toContain("needs fixes");
    expect(markup).toContain(t("en", "pullRequests.mustFixNote", { count: 1 }));
  });

  test("the band wears the danger face for a non-shipping verdict and any failure", () => {
    const tones = [...render(DETAIL).matchAll(/data-slot="metric-value" class="([^"]*)"/g)].map(
      (match) => match[1] ?? "",
    );
    // Verdict (needs fixes) and failures (1); a review count is never an alert.
    expect(tones.filter((classes) => classes.includes("--tone-danger-fg"))).toHaveLength(2);
  });

  test("a must-fix finding opens the findings family, grouped by severity", () => {
    const markup = render(DETAIL);
    const tabs = familyTabs(markup);
    expect(tabs.map((tab) => tab.selected)).toEqual([true, false, false]);
    expect(tabs[0]?.text.startsWith(t("en", "pullRequests.findings"))).toBe(true);
    // Counts are text, so the trigger reads "Findings3".
    expect(tabs.map((tab) => tab.text)).toEqual([
      `${t("en", "pullRequests.findings")}3`,
      `${t("en", "pullRequests.reviews")}2`,
      `${t("en", "pullRequests.failures")}1`,
    ]);
    // Group headers in severity order, each carrying its own count.
    const groups = positions(markup, [
      t("en", "pullRequests.severityMustFix"),
      t("en", "pullRequests.severityShouldFix"),
      t("en", "pullRequests.severityNit"),
    ]);
    expect([...groups].sort((a, b) => a - b)).toEqual(groups);
    expect(markup).toContain("Use a parameterized query");
    expect(markup).toContain("src/db.ts:42");
    // A repo-wide finding (empty file_path) renders no location at all.
    expect(markup).toContain("Rename tmp to pending");
    expect(markup).not.toContain(":null");
  });

  /**
   * Fold pairs read off the serialized markup: each control's `aria-expanded`,
   * the body its `aria-controls` names, and whether that body carries `hidden`.
   * Bodies stay mounted, so the attribute — not presence — is the fold.
   */
  const foldPairs = (markup: string) => {
    const bodies = new Map(
      [...markup.matchAll(/<p id="([^"]+)"([^>]*)>/g)].map((match) => [
        match[1] ?? "",
        /\bhidden=""/.test(match[2] ?? ""),
      ]),
    );
    return [...markup.matchAll(/<button([^>]*)>/g)].flatMap((match) => {
      const attrs = match[1] ?? "";
      const expanded = /aria-expanded="(true|false)"/.exec(attrs);
      const controls = /aria-controls="([^"]+)"/.exec(attrs);
      if (expanded === null || controls === null) return [];
      return [
        {
          expanded: expanded[1] === "true",
          hidden: bodies.get(controls[1] as string),
        },
      ];
    });
  };

  test("only the must-fix body opens; every other group starts folded", () => {
    const markup = render(DETAIL);
    // Fold order follows the group order: must-fix, should-fix, nit.
    const pairs = foldPairs(markup);
    expect(pairs.map((pair) => pair.expanded)).toEqual([true, false, false]);
    // Every body is resolved by its control, and `hidden` is the fold — the
    // folded text stays in the DOM rather than dropping out of the markup.
    expect(pairs.map((pair) => pair.hidden)).toEqual([false, true, true]);
    expect(markup).toContain("String interpolation reaches the SQL engine.");
    expect(markup).toContain("The refresh cookie is set with secure only.");
    expect(markup).toContain("The variable holds the pending redirect target.");
    // One expanded control (the must-fix finding), two folded ones.
    expect(markup.match(/aria-expanded="true"/g) ?? []).toHaveLength(1);
    expect(markup.match(/aria-expanded="false"/g) ?? []).toHaveLength(2);
  });

  test("a clean detail opens on the reviews family with the latest summary readable", () => {
    const reviews = [
      {
        verdict: "ship it",
        summary_md: "Everything the last round asked for is in.",
        model: "kimi-for-coding",
        provider: "openrouter",
        reviewed_at: "2026-11-01 09:00:00",
        head_sha: "aaa111b",
      },
      {
        verdict: "ship it",
        summary_md: "An older round, folded by default.",
        model: "kimi-for-coding",
        provider: "",
        reviewed_at: "2026-10-30 09:00:00",
        head_sha: "bbb222c",
      },
    ];
    const clean: PullRequestDetail = {
      pull_request: {
        ...ROW_OPEN,
        number: 7,
        title: "Add the export button",
        latest_review: { verdict: "ship it", reviewed_at: "2026-11-01 09:00:00" },
        failure_count: 0,
      },
      reviews,
      failures: [],
      findings: [],
    };
    const markup = render(clean);
    expect(familyTabs(markup).map((tab) => tab.selected)).toEqual([false, true, false]);
    expect(markup).toContain("Everything the last round asked for is in.");
    // The latest summary opens; older history is mounted but folded.
    expect(foldPairs(markup)).toEqual([
      { expanded: true, hidden: false },
      { expanded: false, hidden: true },
    ]);
    // No provider means no dangling separator.
    expect(markup).toContain("kimi-for-coding</span>");
    expect(markup).not.toContain("kimi-for-coding · </span>");
    expect(markup).not.toContain(t("en", "pullRequests.noReviews"));
  });

  test("an empty head sha renders neither chip nor aside row", () => {
    const markup = render({
      ...DETAIL,
      pull_request: { ...DETAIL.pull_request, head_sha: "", latest_review: null },
    });
    // The review rows still carry their own shas; only the PR-level ones go —
    // chip, tooltip and the aside's Head row all disappear together.
    expect(markup.match(/>aaa111b</g) ?? []).toHaveLength(0);
    expect(markup).not.toContain(t("en", "pullRequests.headSha"));
    expect(markup).not.toContain(t("en", "pullRequests.factHead"));
    // The verdict figure is announced rather than left blank.
    expect(markup).toContain(t("en", "pullRequests.noVerdict"));
  });

  test("the aside timeline is capped and still ends on the PR's first sighting", () => {
    const history = Array.from({ length: 12 }, (_, index) => ({
      verdict: "needs fixes",
      summary_md: `Round ${index}`,
      // The timeline's meta line renders the review's model, so a per-review
      // model is the one stable, rendered marker of WHICH rows survived.
      model: `model-${String(index).padStart(2, "0")}`,
      provider: "",
      // Newest first, as the store orders them; one hour apart.
      reviewed_at: `2026-11-01 ${String(12 - index).padStart(2, "0")}:00:00`,
      head_sha: `sha${index}`,
    }));
    const markup = render({
      ...DETAIL,
      pull_request: {
        ...DETAIL.pull_request,
        latest_review: { verdict: "needs fixes", reviewed_at: history[0]?.reviewed_at ?? "" },
      },
      reviews: history,
    });
    // `· model-NN` is the timeline's meta separator: the header names the model
    // without it, so the marker identifies exactly the rows that rendered.
    const marker = (index: number) => ` · model-${String(index).padStart(2, "0")}`;
    // Newest seven (indices 0..6) survive, in newest-first order, and the anchor
    // closes the list — a cap that kept the OLDEST seven would fail below.
    const order = positions(markup, [
      ...[0, 1, 2, 3, 4, 5, 6].map(marker),
      t("en", "pullRequests.timelineFirstSeen"),
    ]);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    for (const index of [7, 8, 9, 10, 11]) {
      expect(markup, marker(index)).not.toContain(marker(index));
    }
    // Additional evidence: eight rows — seven activity entries plus the anchor.
    expect(markup.match(/<li class="flex gap-2">/g) ?? []).toHaveLength(8);
  });

  test("a failure's first line renders as escaped text and its full output stays in details", () => {
    const markup = render(FAILING);
    expect(familyTabs(markup).map((tab) => tab.selected)).toEqual([false, false, true]);
    expect(markup).toContain("sandbox");
    expect(markup).toContain("exit 1: &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(markup).not.toContain("<script>");
    // A multi-line error folds its full output behind a native details block.
    const multiline = render({
      ...FAILING,
      failures: [{ stage: "sandbox", error: "first line\nsecond line", created_at: "2026-10-31 23:00:00" }],
    });
    expect(multiline).toContain("<details>");
    expect(multiline).toContain(t("en", "pullRequests.failureFullOutput"));
    expect(multiline).toContain("second line");
  });

  test("the aside carries the PR facts and one merged timeline, newest first", () => {
    const markup = render(DETAIL);
    for (const label of ["factRepo", "factNumber", "factState", "factHead"] as const) {
      expect(markup).toContain(t("en", `pullRequests.${label}`));
    }
    expect(markup).toContain(t("en", "pullRequests.asideActivity"));
    // Review (11-01 08:00) → failure (10-31 23:00) → the PR's first sighting.
    const order = positions(markup, [
      t("en", "pullRequests.timelineReview", { verdict: "needs fixes" }),
      t("en", "pullRequests.timelineFailure", { stage: "sandbox" }),
      t("en", "pullRequests.timelineFirstSeen"),
    ]);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
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
    // And the view renders the coerced row: the review meta line resolves
    // the model/provider template with both coerced fields, and the empty
    // finding path renders no location at all, no bare `:line` (N12).
    const markup = renderToStaticMarkup(
      createElement(PullRequestDetailView, { locale: "en", detail: parsed ?? DETAIL }),
    );
    expect(markup).toContain(t("en", "pullRequests.reviewMeta", { model: "", provider: "" }));
    expect(markup).not.toContain(":42");
    expect(markup).not.toContain(">null<");
  });
});

/** A second PR's detail payload — the switch target in the S2 test. */
const DETAIL_B: PullRequestDetail = {
  pull_request: {
    ...ROW_OPEN,
    number: 9,
    title: "Bump the dependencies",
    latest_review: null,
    failure_count: 0,
  },
  reviews: [],
  failures: [],
  findings: [],
};

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** The stateful wrapper AppDetailView expects: the harness owns the search. */
function DetailHarness() {
  const [search, setSearch] = useState<AppDetailSearch>({
    tab: "settings",
    window: "30",
    repo: "",
    pr: "",
  });
  return createElement(AppDetailView, {
    locale: "en",
    appId: "1",
    payload: managePayload,
    groups: [],
    notice: null,
    search,
    onReload: noReload,
    onSearch: setSearch,
  });
}

describe("pull requests detail read derivation (pure)", () => {
  test("a read stamped for another pr derives to not-yet-loaded, whatever its kind (N1)", () => {
    const okA: DetailRead = { pr: "acme/web/1", kind: "ok", data: DETAIL };
    const errorA: DetailRead = { pr: "acme/web/1", kind: "error" };
    const loadingA: DetailRead = { pr: "acme/web/1", kind: "loading" };
    // A's view AND A's error must not render for B — the B transition
    // frame derives to null, which renders the loading face.
    expect(currentDetailRead(okA, "acme/web/2")).toBeNull();
    expect(currentDetailRead(errorA, "acme/web/2")).toBeNull();
    expect(currentDetailRead(loadingA, "acme/web/2")).toBeNull();
    // The matching stamp passes through — including the error, for retry.
    expect(currentDetailRead(okA, "acme/web/1")).toEqual(okA);
    expect(currentDetailRead(errorA, "acme/web/1")).toEqual(errorA);
    expect(currentDetailRead(null, "acme/web/1")).toBeNull();
  });
});

describe("pull requests tab (mounted)", () => {
  test("clicking the Pull requests tab on the manage face opens the ledger", async () => {
    const { win, cleanup } = installDom("http://localhost/dashboard/apps/1");
    const realFetch = globalThis.fetch;
    // Every read answers the same empty ledger.
    globalThis.fetch = (async () => jsonResponse({ pull_requests: [] })) as unknown as typeof fetch;
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(createElement(DetailHarness)));
      await act(async () => {});
      const trigger = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === t("en", "appDetail.tabPullRequests"),
      );
      expect(trigger).toBeDefined();
      await act(async () => {
        trigger?.dispatchEvent(new win.MouseEvent("mousedown", { bubbles: true, cancelable: true, button: 0 }));
        trigger?.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      });
      await act(async () => {});
      // The ledger's empty state is the opened tab's face.
      expect(container.textContent ?? "").toContain(t("en", "pullRequests.emptyTitle"));
    } finally {
      await act(async () => root.unmount());
      globalThis.fetch = realFetch;
      cleanup();
    }
  });

  test("the failures column carries the row's failure count", async () => {
    const { win, cleanup } = installDom("http://localhost/dashboard/apps/1");
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () =>
        root.render(
          createElement(PullRequestsListView, { locale: "en", rows: [ROW_OPEN, ROW_CLOSED], onOpen: noSearch }),
        ),
      );
      await act(async () => {});
      const headers = [...container.querySelectorAll("th")].map((th) => th.textContent ?? "");
      const failuresAt = headers.indexOf(t("en", "pullRequests.columnFailures"));
      expect(failuresAt).toBeGreaterThan(-1);
      const row = [...container.querySelectorAll("tr")].find((tr) =>
        (tr.textContent ?? "").includes("Revert the cache change"),
      );
      const cells = [...(row?.querySelectorAll("td") ?? [])];
      expect(cells[failuresAt]?.textContent?.trim()).toBe("2");
    } finally {
      await act(async () => root.unmount());
      cleanup();
    }
  });

  test("switching PRs never shows the previous PR's data; a failed fetch renders the error face with a retry (S2)", async () => {
    const { win, cleanup } = installDom("http://localhost/dashboard/apps/1");
    const realFetch = globalThis.fetch;
    // Gate every fetch: the test resolves each read by its URL suffix.
    type Gate = { promise: Promise<Response>; resolve: (response: Response) => void };
    const gates = new Map<string, Gate>();
    globalThis.fetch = (async (input: unknown) => {
      const gate: Gate = Promise.withResolvers<Response>();
      gates.set(String(input), gate);
      return gate.promise;
    }) as unknown as typeof fetch;
    const resolve = (suffix: string, response: Response) => {
      const url = [...gates.keys()].reverse().find((key) => key.endsWith(suffix));
      const gate = url === undefined ? undefined : gates.get(url);
      if (!gate) throw new Error(`no fetch issued for ${suffix}`);
      gate.resolve(response);
    };
    const tabElementFor = (pr: string) =>
      createElement(AppPullRequestsTab, {
        locale: "en",
        appId: "1",
        search: { tab: "pull-requests", window: "30", repo: "", pr },
        onSearch: noSearch,
      });
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const text = () => container.textContent ?? "";
    try {
      await act(async () => root.render(tabElementFor("acme/web/1")));
      await act(async () => {});
      await act(async () => {
        resolve("/pull-requests/acme/web/1", jsonResponse(DETAIL));
      });
      await act(async () => {});
      expect(text()).toContain("Fix the login flow");

      // Switch to PR B: A's detail is retained in state but must NOT render.
      await act(async () => root.render(tabElementFor("acme/web/2")));
      await act(async () => {});
      expect(text()).not.toContain("Fix the login flow");
      expect(text()).toContain(t("en", "common.loading"));

      // B's fetch fails: the error face replaces the loading face — A's
      // data never reappears — and a retry is offered.
      await act(async () => {
        resolve("/pull-requests/acme/web/2", new Response("boom", { status: 500 }));
      });
      await act(async () => {});
      expect(text()).not.toContain("Fix the login flow");
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
      expect(text()).toContain(t("en", "common.loadFailed"));
      const retry = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === t("en", "common.retry"),
      );
      expect(retry).toBeDefined();

      // Retry re-issues the read; B's payload lands.
      await act(async () => {
        retry?.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      });
      await act(async () => {});
      await act(async () => {
        resolve("/pull-requests/acme/web/2", jsonResponse(DETAIL_B));
      });
      await act(async () => {});
      expect(text()).toContain("Bump the dependencies");
      expect(text()).not.toContain("Fix the login flow");
    } finally {
      await act(async () => root.unmount());
      globalThis.fetch = realFetch;
      cleanup();
    }
  });

  test("a failed read for A leaves no error on B's transition frame (N1)", async () => {
    const { win, cleanup } = installDom("http://localhost/dashboard/apps/1");
    const realFetch = globalThis.fetch;
    type Gate = { promise: Promise<Response>; resolve: (response: Response) => void };
    const gates = new Map<string, Gate>();
    globalThis.fetch = (async (input: unknown) => {
      const gate: Gate = Promise.withResolvers<Response>();
      gates.set(String(input), gate);
      return gate.promise;
    }) as unknown as typeof fetch;
    const resolve = (suffix: string, response: Response) => {
      const url = [...gates.keys()].reverse().find((key) => key.endsWith(suffix));
      const gate = url === undefined ? undefined : gates.get(url);
      if (!gate) throw new Error(`no fetch issued for ${suffix}`);
      gate.resolve(response);
    };
    const tabElementFor = (pr: string) =>
      createElement(AppPullRequestsTab, {
        locale: "en",
        appId: "1",
        search: { tab: "pull-requests", window: "30", repo: "", pr },
        onSearch: noSearch,
      });
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const text = () => container.textContent ?? "";
    try {
      await act(async () => root.render(tabElementFor("acme/web/1")));
      await act(async () => {});
      // A's read fails: the error face is correct FOR A.
      await act(async () => {
        resolve("/pull-requests/acme/web/1", new Response("boom", { status: 500 }));
      });
      await act(async () => {});
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
      expect(text()).toContain(t("en", "common.loadFailed"));

      // Switch to B: the face is the loading face — never A's error, which
      // would name the wrong PR (and announce assertively) before B's
      // fetch is even issued.
      await act(async () => root.render(tabElementFor("acme/web/2")));
      await act(async () => {});
      expect(text()).toContain(t("en", "common.loading"));
      expect(text()).not.toContain(t("en", "common.loadFailed"));
      expect(container.querySelector('[role="alert"]')).toBeNull();

      // B's read lands; B's face replaces the loading face.
      await act(async () => {
        resolve("/pull-requests/acme/web/2", jsonResponse(DETAIL_B));
      });
      await act(async () => {});
      expect(text()).toContain("Bump the dependencies");
      expect(container.querySelector('[role="alert"]')).toBeNull();
    } finally {
      await act(async () => root.unmount());
      globalThis.fetch = realFetch;
      cleanup();
    }
  });
});
