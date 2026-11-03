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
import { describe, expect, jest, test } from "bun:test";
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
import { AppPullRequestsTab, PullRequestsListView } from "../../src/spa/pages/AppPullRequestsTab";
import { currentDetailRead, PullRequestDetailView, type DetailRead } from "../../src/spa/pages/PullRequestDetail";
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
  const familyTabs = (container: HTMLElement) =>
    [...container.querySelectorAll<HTMLElement>('[role="tab"]')].map((tab) => ({
      selected: tab.getAttribute("aria-selected") === "true",
      text: tab.textContent ?? "",
    }));

  /** The positions of `needles` in `markup`, asserted to be present first. */
  const positions = (markup: string, needles: readonly string[]) =>
    needles.map((needle) => {
      const at = markup.indexOf(needle);
      expect(at, needle).toBeGreaterThan(-1);
      return at;
    });

  /**
   * The head line (verdict, attribution, when, sha) of the review row that owns
   * `summary` — the row's own text, so a claim about it reads the rendered
   * content rather than the serialized tag around it. The head carries no
   * identifying text of its own, so it is selected by its slot inside the row
   * the summary identifies.
   */
  const reviewHead = (container: HTMLElement, summary: string): string => {
    const row = [...container.querySelectorAll<HTMLElement>("li")].find((item) =>
      [...item.querySelectorAll("p")].some((node) => node.textContent === summary),
    );
    expect(row, summary).toBeDefined();
    return row?.querySelector<HTMLElement>('[data-slot="review-head"]')?.textContent ?? "";
  };

  /**
   * A failure-only detail: no finding carries a must-fix or a should-fix, so
   * the face opens on the failures family and the diagnostic payload is in the
   * markup.
   */
  const FAILING: PullRequestDetail = { ...DETAIL, findings: [] };

  test("the header names the PR's own facts; the band aggregates them", () => {
    const markup = render(DETAIL);
    expect(markup).toContain("Fix the login flow");
    expect(markup).toContain("acme/web #133");
    expect(markup).toContain(t("en", "pullRequests.state.merged"));
    // Short-sha chip over the head sha, titled with the full-name tooltip.
    const chips = withMarkup(render(DETAIL), (container) =>
      [...container.querySelectorAll<HTMLElement>('[data-slot="head-sha"]')].map((chip) => chip.textContent ?? ""),
    );
    expect(chips).toEqual(["aaa111b"]);
    expect(markup).toContain(t("en", "pullRequests.headSha"));
    // Meta line: first seen, last seen.
    for (const label of ["firstSeen", "lastSeen"] as const) {
      expect(markup).toContain(t("en", `pullRequests.${label}`));
    }
    // The latest-review attribution is the header meta line's own item; the
    // reviews panel renders the same string, so it is read off that line —
    // selected by its slot, not by its position among the header's children.
    const headerMeta = withMarkup(
      render(DETAIL),
      (container) => container.querySelector('[data-slot="pr-meta"]')?.textContent ?? "",
    );
    expect(headerMeta).toContain(t("en", "pullRequests.latestReview"));
    expect(headerMeta).toContain(
      t("en", "pullRequests.reviewMeta", { model: "kimi-for-coding", provider: "openrouter" }),
    );
    // A review that records neither model nor provider has no attribution to
    // show: the item disappears rather than rendering an empty label.
    expect(
      withMarkup(
        render({
          ...DETAIL,
          reviews: [
            {
              verdict: "needs fixes",
              summary_md: "An unattributed round.",
              model: "",
              provider: "",
              reviewed_at: "2026-11-01 08:00:00",
              head_sha: "aaa111b",
            },
          ],
        }),
        (container) => container.querySelector('[data-slot="pr-meta"]')?.textContent ?? "",
      ),
    ).not.toContain(t("en", "pullRequests.latestReview"));
    // Band: the four label/figure pairs, in order — the aggregate the header
    // claims, read as the operator reads it.
    const metrics = withMarkup(render(DETAIL), (container) =>
      [...container.querySelectorAll('[data-slot="metric"]')].map((metric) => [
        metric.querySelector('[data-slot="metric-key"]')?.textContent ?? "",
        metric.querySelector('[data-slot="metric-value"]')?.textContent ?? "",
      ]),
    );
    expect(metrics[0]).toEqual([t("en", "pullRequests.columnVerdict"), "needs fixes"]);
    expect(metrics[1]).toEqual([t("en", "pullRequests.reviews"), "2"]);
    expect(metrics[2]).toEqual([t("en", "pullRequests.failures"), "1"]);
    expect(metrics[3]?.[0]).toBe(t("en", "pullRequests.findings"));
    expect(metrics[3]?.[1]).toContain(t("en", "pullRequests.mustFixNote", { count: 1 }));
  });

  test("the band wears the danger face for a non-shipping verdict and any failure", () => {
    const tones = withMarkup(render(DETAIL), (container) =>
      [...container.querySelectorAll('[data-slot="metric-value"]')].map((value) => value.getAttribute("data-tone")),
    );
    // Verdict (needs fixes) and failures (1) are alerts; the two counts are not.
    expect(tones).toEqual(["danger", null, "danger", null]);
  });

  test("the band and the timeline paint a verdict with the same rule", () => {
    // One rule, two surfaces: `ship it` is success, any other non-empty
    // verdict is danger. The band's figure and the timeline's dot must agree,
    // so a non-shipping verdict cannot read as an alarm in one and quiet in
    // the other.
    const dots = (detail: PullRequestDetail) =>
      withMarkup(render(detail), (container) =>
        [...container.querySelectorAll('[data-slot="activity-entry"] > span:first-child')].map(
          (dot) => dot.className,
        ),
      );
    const shipped: PullRequestDetail = {
      ...DETAIL,
      pull_request: {
        ...DETAIL.pull_request,
        latest_review: { verdict: "ship it", reviewed_at: "2026-11-01 08:00:00" },
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
    };
    // The review is the newest event on both faces.
    expect(dots(DETAIL)[0]).toContain("--tone-danger-fg");
    expect(dots(shipped)[0]).toContain("--tone-success-fg");
  });

  test("a must-fix finding opens the findings family, grouped by severity", () => {
    const markup = render(DETAIL);
    const tabs = withMarkup(render(DETAIL), familyTabs);
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

  test("an out-of-set severity lands in the `other` bucket, last, with its count", () => {
    const markup = render({
      ...DETAIL,
      findings: [
        ...DETAIL.findings,
        {
          finding_id: "f-4",
          severity: "blocker",
          title: "Drop the unsafe default",
          file_path: "",
          line: null,
          body: "The payload's severity is a free string; this one is outside the set.",
        },
      ],
    });
    const order = positions(markup, [
      t("en", "pullRequests.severityMustFix"),
      t("en", "pullRequests.severityShouldFix"),
      t("en", "pullRequests.severityNit"),
      t("en", "pullRequests.severityOther"),
    ]);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    // The bucket carries its own count, and its finding renders under it.
    const other = markup.slice(order[3] as number);
    expect(other).toMatch(new RegExp(`${t("en", "pullRequests.severityOther")}</span><span[^>]*>1</span>`));
    expect(other).toContain("Drop the unsafe default");
  });

  /**
   * Fold pairs read off the rendered container: each fold control's
   * `aria-expanded`, the body its `aria-controls` names, and whether that body
   * carries `hidden`. Bodies stay mounted, so the attribute — not presence — is
   * the fold.
   */
  const foldPairs = (container: HTMLElement) =>
    [...container.querySelectorAll<HTMLElement>("button[aria-expanded][aria-controls]")].map((control) => {
      const id = control.getAttribute("aria-controls") ?? "";
      return {
        expanded: control.getAttribute("aria-expanded") === "true",
        hidden: container.querySelector<HTMLElement>(`#${id}`)?.hidden,
      };
    });

  test("only the must-fix body opens; every other group starts folded", () => {
    const markup = render(DETAIL);
    // Fold order follows the group order: must-fix, should-fix, nit.
    const { pairs, labels } = withMarkup(render(DETAIL), (container) => ({
      pairs: foldPairs(container),
      labels: [...container.querySelectorAll("button[aria-expanded][aria-label]")].map(
        (control) => control.getAttribute("aria-label") ?? "",
      ),
    }));
    expect(pairs.map((pair) => pair.expanded)).toEqual([true, false, false]);
    // Every body is resolved by its control, and `hidden` is the fold — the
    // folded text stays in the DOM rather than dropping out of the markup.
    expect(pairs.map((pair) => pair.hidden)).toEqual([false, true, true]);
    expect(markup).toContain("String interpolation reaches the SQL engine.");
    expect(markup).toContain("The refresh cookie is set with secure only.");
    expect(markup).toContain("The variable holds the pending redirect target.");
    // One expanded control (the must-fix finding), two folded ones.
    expect(pairs.filter((pair) => pair.expanded)).toHaveLength(1);
    expect(pairs.filter((pair) => !pair.expanded)).toHaveLength(2);
    // Each toggle names the record it folds, so identical "Expand" labels do
    // not leave several controls indistinguishable.
    expect(labels).toEqual([
      `${t("en", "pullRequests.collapse")} — Use a parameterized query`,
      `${t("en", "pullRequests.expand")} — Session cookie lacks HttpOnly`,
      `${t("en", "pullRequests.expand")} — Rename tmp to pending`,
    ]);
  });

  test("a toggle whose record carries no identity text falls back to its position", () => {
    // A coerced-empty title leaves the finding with nothing to name itself by;
    // the position keeps the two toggles distinguishable.
    const untitled: PullRequestDetail = {
      ...DETAIL,
      findings: [
        { finding_id: "f-1", severity: "must-fix", title: "", file_path: "", line: null, body: "" },
        { finding_id: "f-2", severity: "should-fix", title: "", file_path: "", line: null, body: "" },
      ],
    };
    const findingLabels = withMarkup(render(untitled), (container) =>
      [...container.querySelectorAll('[data-slot="finding"] button[aria-label]')].map(
        (control) => control.getAttribute("aria-label") ?? "",
      ),
    );
    expect(findingLabels).toEqual([
      `${t("en", "pullRequests.collapse")} — #1`,
      `${t("en", "pullRequests.expand")} — #2`,
    ]);

    // The same case on the reviews family: no verdict and no head sha.
    const anonymous = (summary: string, reviewed_at: string): PullRequestDetail["reviews"][number] => ({
      verdict: "",
      summary_md: summary,
      model: "",
      provider: "",
      reviewed_at,
      head_sha: "",
    });
    const unattributed: PullRequestDetail = {
      ...DETAIL,
      findings: [],
      failures: [],
      reviews: [anonymous("", "2026-11-01 08:00:00"), anonymous("An older round.", "2026-10-30 08:00:00")],
    };
    expect(
      withMarkup(render(unattributed), (container) =>
        [...container.querySelectorAll("button[aria-expanded][aria-label]")].map(
          (control) => control.getAttribute("aria-label") ?? "",
        ),
      ),
    ).toEqual([
      `${t("en", "pullRequests.collapse")} — #1`,
      `${t("en", "pullRequests.expand")} — #2`,
    ]);
  });

  test("a should-fix finding alone opens the findings family", () => {
    // No must-fix anywhere: a requested change still outranks history, so the
    // face must open on the findings rather than the reviews.
    const shouldOnly: PullRequestDetail = {
      ...DETAIL,
      findings: [
        {
          finding_id: "f-2",
          severity: "should-fix",
          title: "Session cookie lacks HttpOnly",
          file_path: "src/auth/session.ts",
          line: 88,
          body: "The refresh cookie is set with secure only.",
        },
      ],
    };
    expect(withMarkup(render(shouldOnly), familyTabs).map((tab) => tab.selected)).toEqual([true, false, false]);
    expect(render(shouldOnly)).toContain("The refresh cookie is set with secure only.");
  });

  test("an empty verdict reads as no verdict: announced dash, no pill, no dangling separator", () => {
    // The parser coerces a nullable verdict to "": that is a review whose
    // verdict was never recorded, not the verdict "".
    const empty: PullRequestDetail = {
      ...DETAIL,
      pull_request: {
        ...DETAIL.pull_request,
        latest_review: { verdict: "", reviewed_at: "2026-11-01 08:00:00" },
      },
      reviews: [
        {
          verdict: "",
          summary_md: "The pipeline recorded no verdict.",
          // Provider-only attribution: the row must name the provider.
          model: "",
          provider: "openrouter",
          reviewed_at: "2026-11-01 08:00:00",
          head_sha: "aaa111b",
        },
      ],
      // No actionable finding and no failure: the face opens on the reviews,
      // which is where the coerced verdict renders.
      findings: [],
      failures: [],
    };
    const read = withMarkup(render(empty), (container) => {
      const verdict = container.querySelectorAll('[data-slot="metric-value"]')[0];
      // The timeline row still names the review, with no dangling separator
      // and the provider rather than an empty model.
      const entry = container.querySelector('[data-slot="activity-entry"]');
      return {
        verdictText: verdict?.textContent ?? "",
        verdictTone: verdict?.getAttribute("data-tone") ?? null,
        badges: container.querySelectorAll('[role="tabpanel"] [data-slot="status-badge"]').length,
        head: reviewHead(container, "The pipeline recorded no verdict."),
        label: entry?.querySelector("div > span")?.textContent ?? "",
        meta: entry?.querySelector("div > span + span")?.textContent ?? "",
      };
    });
    // Band: the same dash + screen-reader text the no-review case paints.
    expect(read.verdictText).toContain("—");
    expect(read.verdictText).toContain(t("en", "pullRequests.noVerdict"));
    // No recorded verdict is no alarm: the figure wears no danger hook.
    expect(read.verdictTone).toBeNull();
    // The review row paints no pill, and none of its head spans is empty.
    expect(read.badges).toBe(0);
    expect(read.head).toContain("openrouter");
    expect(read.head).not.toContain(" · ");
    expect(read.label).toBe(t("en", "pullRequests.timelineReviewNoVerdict"));
    expect(read.label).not.toMatch(/·\s*$/);
    expect(read.meta).toContain("openrouter");
    expect(read.meta).not.toContain(" · ·");
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
    const read = withMarkup(render(clean), (container) => ({
      selected: familyTabs(container).map((tab) => tab.selected),
      // The latest summary opens; older history is mounted but folded.
      pairs: foldPairs(container),
      // No provider means no dangling separator: the attributed row reads
      // `model · provider`, the unattributed one stops at its model.
      latestHead: reviewHead(container, "Everything the last round asked for is in."),
      olderHead: reviewHead(container, "An older round, folded by default."),
      // Review toggles name their verdict and short sha, so two "Collapse"s on
      // this face are distinguishable.
      labels: [...container.querySelectorAll("button[aria-expanded][aria-label]")].map(
        (control) => control.getAttribute("aria-label") ?? "",
      ),
    }));
    expect(read.selected).toEqual([false, true, false]);
    expect(markup).toContain("Everything the last round asked for is in.");
    expect(read.pairs).toEqual([
      { expanded: true, hidden: false },
      { expanded: false, hidden: true },
    ]);
    expect(read.latestHead).toContain(
      t("en", "pullRequests.reviewMeta", { model: "kimi-for-coding", provider: "openrouter" }),
    );
    expect(read.olderHead).toContain("kimi-for-coding");
    expect(read.olderHead).not.toContain(" · ");
    expect(read.labels).toEqual([
      `${t("en", "pullRequests.collapse")} — ship it · aaa111b`,
      `${t("en", "pullRequests.expand")} — ship it · bbb222c`,
    ]);
    expect(markup).not.toContain(t("en", "pullRequests.noReviews"));
  });

  test("an empty head sha renders neither chip nor aside row", () => {
    const emptySha: PullRequestDetail = {
      ...DETAIL,
      pull_request: { ...DETAIL.pull_request, head_sha: "", latest_review: null },
    };
    const markup = render(emptySha);
    // The PR-level chip disappears rather than rendering an empty one; its
    // tooltip and the aside's Head row go with it.
    expect(
      withMarkup(render(emptySha), (container) =>
        [...container.querySelectorAll<HTMLElement>('[data-slot="head-sha"]')].map((chip) => chip.textContent ?? ""),
      ),
    ).toEqual([]);
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
    const detail = {
      ...DETAIL,
      pull_request: {
        ...DETAIL.pull_request,
        latest_review: { verdict: "needs fixes", reviewed_at: history[0]?.reviewed_at ?? "" },
      },
      reviews: history,
    };
    const markup = render(detail);
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
    expect(markup.match(/data-slot="activity-entry"/g) ?? []).toHaveLength(8);
    // The dropped six are named, not silently swallowed: 12 reviews plus the
    // payload's one failure make 13 events, of which the cap shows seven. The
    // truncation row itself carries the count.
    expect(
      withMarkup(
        render(detail),
        (container) => container.querySelector('[data-slot="timeline-truncated"]')?.textContent ?? "",
      ),
    ).toBe(t("en", "pullRequests.timelineHidden", { count: 6 }));
  });

  test("a timeline that fits the cap renders no truncation row", () => {
    // Seven history entries is the cap: six shown plus the anchor, none dropped.
    const reviews = Array.from({ length: 6 }, (_, index) => ({
      verdict: "ship it",
      summary_md: `Round ${index}`,
      model: `model-${index}`,
      provider: "",
      reviewed_at: `2026-10-31 ${String(12 - index).padStart(2, "0")}:00:00`,
      head_sha: `sha${index}`,
    }));
    const markup = render({ ...DETAIL, reviews, failures: [] });
    expect(markup.match(/data-slot="activity-entry"/g) ?? []).toHaveLength(7);
    // Nothing was dropped, so the truncation row is absent rather than empty.
    expect(
      withMarkup(render({ ...DETAIL, reviews, failures: [] }), (container) =>
        container.querySelector('[data-slot="timeline-truncated"]'),
      ),
    ).toBeNull();
  });

  test("a failure's first line renders as escaped text and its full output stays in details", () => {
    const markup = render(FAILING);
    expect(withMarkup(render(FAILING), familyTabs).map((tab) => tab.selected)).toEqual([false, false, true]);
    expect(markup).toContain("sandbox");
    expect(markup).toContain("exit 1: &lt;script&gt;alert(1)&lt;/script&gt;");
    expect(markup).not.toContain("<script>");
    // The failure block carries its danger ruling as a semantic hook, so the
    // alarm is read from the DOM rather than from a generated class literal.
    expect(
      withMarkup(render(FAILING), (container) => {
        const block = container.querySelector('[role="tabpanel"] li[data-tone="danger"]');
        return block === null ? null : (block.textContent ?? "");
      }),
    ).toContain("sandbox");
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
    // And the view renders the coerced row: an unattributed review (both fields
    // coerced empty) renders no attribution span and no "Latest review" meta —
    // an empty value would read as a missing fact — and the empty finding path
    // renders no location at all, no bare `:line` (N12). Each negative is read
    // off the node that owns the field, so unrelated text cannot satisfy it.
    withMarkup(renderToStaticMarkup(createElement(PullRequestDetailView, { locale: "en", detail: parsed ?? DETAIL })), (container) => {
      const meta = container.querySelector('[data-slot="pr-meta"]');
      expect(meta?.textContent ?? "").not.toContain(t("en", "pullRequests.latestReview"));
      const finding = container.querySelector('[data-slot="finding"]');
      expect(finding, "the coerced finding row renders").not.toBeNull();
      expect(finding?.textContent ?? "").not.toContain(":42");
      expect(finding?.textContent ?? "").not.toContain("null");
    });
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

/**
 * Mount the tab with every fetch gated until the test resolves it by URL
 * suffix, so a transition frame is observable instead of raced. The mount of
 * `initialPr` is the helper's own first act; teardown restores `fetch` and the
 * DOM in one call.
 */
async function mountTabWithGatedFetch(initialPr: string) {
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
  await act(async () => root.render(tabElementFor(initialPr)));
  await act(async () => {});
  return {
    container,
    text: () => container.textContent ?? "",
    win,
    /** Re-render the tab for another pr — the switch the read stamp follows. */
    rerender: async (pr: string) => {
      await act(async () => root.render(tabElementFor(pr)));
      await act(async () => {});
    },
    resolve,
    unmount: async () => {
      await act(async () => root.unmount());
      globalThis.fetch = realFetch;
      cleanup();
    },
  };
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

  test("the family switch and a fold toggle act on the live tree", async () => {
    const { win, cleanup } = installDom("http://localhost/dashboard/apps/1");
    const host = win.document.createElement("div");
    win.document.body.appendChild(host);
    // happy-dom's nodes cross into lib.dom's here: the queries below read the
    // same roles, attributes and `hidden` the static tests do.
    const container = host as unknown as HTMLElement;
    const root = createRoot(host as unknown as Element);
    const press = async (target: Element | null | undefined) => {
      const pointer = (type: string) =>
        new win.MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }) as unknown as Event;
      await act(async () => {
        target?.dispatchEvent(pointer("mousedown"));
        target?.dispatchEvent(pointer("click"));
      });
      await act(async () => {});
    };
    const tabs = () => [...container.querySelectorAll<HTMLElement>('[role="tab"]')];
    const panels = () => [...container.querySelectorAll<HTMLElement>('[role="tabpanel"]')];
    const selected = () => tabs().map((tab) => tab.getAttribute("aria-selected") === "true");
    const visible = () => panels().map((panel) => panel.hidden === false);
    try {
      await act(async () => root.render(createElement(PullRequestDetailView, { locale: "en", detail: DETAIL })));
      await act(async () => {});
      // DETAIL carries a must-fix finding: findings first, its panel open.
      expect(selected()).toEqual([true, false, false]);
      expect(visible()).toEqual([true, false, false]);

      // The reviews family: the selection and the visible panel both move.
      await press(tabs()[1]);
      expect(selected()).toEqual([false, true, false]);
      expect(visible()).toEqual([false, true, false]);

      // And back — a one-way switch would pass the assertion above.
      await press(tabs()[0]);
      expect(selected()).toEqual([true, false, false]);
      expect(visible()).toEqual([true, false, false]);

      // A fold toggle flips its own `aria-expanded` and its body's `hidden`.
      // The second finding starts folded; the first starts open.
      const controls = () => [...container.querySelectorAll<HTMLElement>("button[aria-expanded][aria-controls]")];
      const bodyOf = (control: HTMLElement | undefined) =>
        control === undefined
          ? null
          : container.querySelector<HTMLElement>(`#${control.getAttribute("aria-controls") ?? ""}`);
      expect(controls()[1]?.getAttribute("aria-expanded")).toBe("false");
      expect(bodyOf(controls()[1])?.hidden).toBe(true);
      await press(controls()[1]);
      expect(controls()[1]?.getAttribute("aria-expanded")).toBe("true");
      expect(bodyOf(controls()[1])?.hidden).toBe(false);
    } finally {
      await act(async () => root.unmount());
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

  test("the copy action reports its outcome on the button and reverts", async () => {
    const { win, cleanup } = installDom("http://localhost/dashboard/apps/1");
    const host = win.document.createElement("div");
    win.document.body.appendChild(host);
    // happy-dom's nodes cross into lib.dom's here, as in the suites above.
    const container = host as unknown as HTMLElement;
    const root = createRoot(host as unknown as Element);
    // The clipboard is the one surface happy-dom does not script: the first
    // write resolves and the second rejects, so both branches are exercised.
    let writes = 0;
    Object.defineProperty(win.navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: () => {
          writes += 1;
          return writes === 1 ? Promise.resolve() : Promise.reject(new Error("denied"));
        },
      },
    });
    const press = async (target: Element | null | undefined) => {
      const pointer = (type: string) =>
        new win.MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }) as unknown as Event;
      await act(async () => {
        target?.dispatchEvent(pointer("mousedown"));
        target?.dispatchEvent(pointer("click"));
      });
      await act(async () => {});
    };
    // No actionable finding: the face opens on the failures family, whose one
    // control is the copy action.
    const copyButton = () => container.querySelector<HTMLElement>('[role="tabpanel"] button');
    const status = () => container.querySelector('[role="status"]')?.textContent ?? "";
    jest.useFakeTimers();
    try {
      await act(async () =>
        root.render(createElement(PullRequestDetailView, { locale: "en", detail: { ...DETAIL, findings: [] } })),
      );
      await act(async () => {});
      expect(copyButton()?.textContent).toBe(t("en", "pullRequests.copyError"));

      // Resolved write: the label reports the outcome and the live region
      // announces it.
      await press(copyButton());
      expect(copyButton()?.textContent).toBe(t("en", "pullRequests.copyCopied"));
      expect(status()).toBe(t("en", "pullRequests.copyCopied"));

      // ...and it reverts on its own, so a later paste is not misread.
      await act(async () => {
        jest.advanceTimersByTime(2000);
      });
      expect(copyButton()?.textContent).toBe(t("en", "pullRequests.copyError"));
      expect(status()).toBe("");

      // Rejected write: silence would leave the previous clipboard content in
      // place, so the failure is reported the same way.
      await press(copyButton());
      expect(copyButton()?.textContent).toBe(t("en", "pullRequests.copyFailed"));
      expect(status()).toBe(t("en", "pullRequests.copyFailed"));
    } finally {
      jest.useRealTimers();
      await act(async () => root.unmount());
      cleanup();
    }
  });

  test("copying a second error block does not cancel the first block's revert", async () => {
    const { win, cleanup } = installDom("http://localhost/dashboard/apps/1");
    const host = win.document.createElement("div");
    win.document.body.appendChild(host);
    const container = host as unknown as HTMLElement;
    const root = createRoot(host as unknown as Element);
    Object.defineProperty(win.navigator, "clipboard", {
      configurable: true,
      value: { writeText: () => Promise.resolve() },
    });
    const press = async (target: Element | null | undefined) => {
      const pointer = (type: string) =>
        new win.MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }) as unknown as Event;
      await act(async () => {
        target?.dispatchEvent(pointer("mousedown"));
        target?.dispatchEvent(pointer("click"));
      });
      await act(async () => {});
    };
    const copyButtons = () => [...container.querySelectorAll<HTMLElement>('[data-slot="copy-error"]')];
    jest.useFakeTimers();
    try {
      await act(async () =>
        root.render(
          createElement(PullRequestDetailView, {
            locale: "en",
            detail: {
              ...DETAIL,
              findings: [],
              failures: [
                { stage: "sandbox", error: "first block", created_at: "2026-10-31 23:00:00" },
                { stage: "review", error: "second block", created_at: "2026-10-30 23:00:00" },
              ],
            },
          }),
        ),
      );
      await act(async () => {});
      expect(copyButtons()).toHaveLength(2);

      // Copy A, then B one second later. B's press must not cancel A's revert.
      await press(copyButtons()[0]);
      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
      await press(copyButtons()[1]);
      expect(copyButtons()[0]?.textContent).toBe(t("en", "pullRequests.copyCopied"));
      expect(copyButtons()[1]?.textContent).toBe(t("en", "pullRequests.copyCopied"));

      // A's own two seconds are up; B's label is untouched.
      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
      expect(copyButtons()[0]?.textContent).toBe(t("en", "pullRequests.copyError"));
      expect(copyButtons()[1]?.textContent).toBe(t("en", "pullRequests.copyCopied"));

      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
      expect(copyButtons()[1]?.textContent).toBe(t("en", "pullRequests.copyError"));
    } finally {
      jest.useRealTimers();
      await act(async () => root.unmount());
      cleanup();
    }
  });

  test("without a Clipboard API the copy control stays and reports the failure", async () => {
    const { win, cleanup } = installDom("http://localhost/dashboard/apps/1");
    const host = win.document.createElement("div");
    win.document.body.appendChild(host);
    const container = host as unknown as HTMLElement;
    const root = createRoot(host as unknown as Element);
    // An insecure context offers no Clipboard API at all: the property reads
    // as absent, not as a rejecting write. happy-dom's own Clipboard lives on
    // the prototype, so the absent state is shadowed on the instance.
    Object.defineProperty(win.navigator, "clipboard", { configurable: true, value: undefined });
    const press = async (target: Element | null | undefined) => {
      const pointer = (type: string) =>
        new win.MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }) as unknown as Event;
      await act(async () => {
        target?.dispatchEvent(pointer("mousedown"));
        target?.dispatchEvent(pointer("click"));
      });
      await act(async () => {});
    };
    try {
      await act(async () =>
        root.render(
          createElement(PullRequestDetailView, { locale: "en", detail: { ...DETAIL, findings: [] } }),
        ),
      );
      await act(async () => {});
      const copyButton = container.querySelector<HTMLElement>('[data-slot="copy-error"]');
      const status = () => container.querySelector('[role="status"]')?.textContent ?? "";
      // The affordance is not hidden just because the API is missing.
      expect(copyButton).not.toBeNull();
      await press(copyButton);
      expect(copyButton?.textContent).toBe(t("en", "pullRequests.copyFailed"));
      expect(status()).toBe(t("en", "pullRequests.copyFailed"));
    } finally {
      await act(async () => root.unmount());
      cleanup();
    }
  });

  test("switching PRs never shows the previous PR's data; a failed fetch renders the error face with a retry (S2)", async () => {
    const { container, text, win, rerender, resolve, unmount } = await mountTabWithGatedFetch("acme/web/1");
    try {
      await act(async () => {
        resolve("/pull-requests/acme/web/1", jsonResponse(DETAIL));
      });
      await act(async () => {});
      expect(text()).toContain("Fix the login flow");

      // Switch to PR B: A's detail is retained in state but must NOT render.
      await rerender("acme/web/2");
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
      await unmount();
    }
  });

  test("a failed read for A leaves no error on B's transition frame (N1)", async () => {
    const { container, text, rerender, resolve, unmount } = await mountTabWithGatedFetch("acme/web/1");
    try {
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
      await rerender("acme/web/2");
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
      await unmount();
    }
  });

  test("a parent re-render for the same PR neither refetches nor re-flashes loading (S3)", async () => {
    const { win, cleanup } = installDom("http://localhost/dashboard/apps/1");
    const realFetch = globalThis.fetch;
    let reads = 0;
    globalThis.fetch = (async (input: unknown) => {
      if (String(input).endsWith("/pull-requests/acme/web/1")) reads += 1;
      return jsonResponse(DETAIL);
    }) as unknown as typeof fetch;
    const tabElementFor = () =>
      createElement(AppPullRequestsTab, {
        locale: "en",
        appId: "1",
        // A fresh search object each render, as the shell hands it over; the
        // pr VALUE is what stays put.
        search: { tab: "pull-requests", window: "30", repo: "", pr: "acme/web/1" },
        onSearch: noSearch,
      });
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const text = () => container.textContent ?? "";
    try {
      await act(async () => root.render(tabElementFor()));
      await act(async () => {});
      expect(reads).toBe(1);
      expect(text()).toContain("Fix the login flow");

      // The parent re-renders: `pullRequestRefOf` hands over a fresh ref object,
      // which must not count as a dependency change.
      await act(async () => root.render(tabElementFor()));
      await act(async () => {});
      expect(reads).toBe(1);
      expect(text()).toContain("Fix the login flow");
      expect(text()).not.toContain(t("en", "common.loading"));
    } finally {
      await act(async () => root.unmount());
      globalThis.fetch = realFetch;
      cleanup();
    }
  });

  test("a deep link reads only the detail; closing it issues the list read once (S4)", async () => {
    const { win, cleanup } = installDom("http://localhost/dashboard/apps/1");
    const realFetch = globalThis.fetch;
    const urls: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      urls.push(url);
      return url.endsWith("/pull-requests") ? jsonResponse({ pull_requests: [ROW_OPEN] }) : jsonResponse(DETAIL);
    }) as unknown as typeof fetch;
    const listReads = () => urls.filter((url) => url.endsWith("/pull-requests"));
    // The shell owns the search, so closing the detail commits `pr: ""` here
    // exactly as the real page's onSearch does.
    function Harness() {
      const [search, setSearch] = useState<AppDetailSearch>({
        tab: "pull-requests",
        window: "30",
        repo: "",
        pr: "acme/web/133",
      });
      return createElement(AppPullRequestsTab, { locale: "en", appId: "1", search, onSearch: setSearch });
    }
    const press = async (target: Element | null | undefined) => {
      const pointer = (type: string) =>
        new win.MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }) as unknown as Event;
      await act(async () => {
        target?.dispatchEvent(pointer("mousedown"));
        target?.dispatchEvent(pointer("click"));
      });
      await act(async () => {});
    };
    const host = win.document.createElement("div");
    win.document.body.appendChild(host);
    const container = host as unknown as HTMLElement;
    const root = createRoot(host as unknown as Element);
    const text = () => container.textContent ?? "";
    try {
      await act(async () => root.render(createElement(Harness)));
      await act(async () => {});
      // The detail is the whole face the deep link asked for: no list read.
      expect(text()).toContain("Fix the login flow");
      expect(listReads()).toHaveLength(0);

      // Closing the detail is the list's cue — exactly one read, whose rows
      // replace the unmounted detail.
      await press(
        [...container.querySelectorAll("button")].find(
          (button) => button.textContent === t("en", "pullRequests.backToList"),
        ),
      );
      expect(listReads()).toHaveLength(1);
      expect(text()).toContain("Add the export button");
    } finally {
      await act(async () => root.unmount());
      globalThis.fetch = realFetch;
      cleanup();
    }
  });
});
