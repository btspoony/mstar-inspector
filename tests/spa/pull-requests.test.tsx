/**
 * Pull requests tab: the scoped PR ledger (one repository target, or the whole
 * workspace), its list face and the routing/deep-link contract.
 *
 * Static-SSR pins over the pure faces (the InsightsRecordsView idiom): the
 * manage-gated tab trigger, the list table (title / state / verdict / last
 * seen / failure count) and the empty state. Mounted (happy-dom) pins cover
 * what only real effects and events prove: the manage-gated click-through to
 * the ledger, the failures-column cell content, and the S2 switching contract
 * — a retained detail from PR A must never render while PR B loads, a failed
 * fetch for the new PR renders the error face with a retry, and a switch to
 * another target never paints the previous target's rows. The detail face
 * itself lives in `pull-request-detail-static.test.tsx` and
 * `pull-request-detail-interaction.test.tsx`; payloads every suite reads live
 * in `pull-request-fixtures.ts`.
 */
import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../../src/i18n";
import { formatRelativeTime } from "../../src/spa/relative-time";
import {
  parsePullRequestList,
  pullRequestRefOf,
  scopedPullRequestsUrl,
  type PullRequestDetail,
  type PullRequestReviewing,
  type PullRequestRow,
  type SettingsManagePayload,
  type SettingsPayload,
} from "../../src/spa/pages/data";
import { AppDetailView } from "../../src/spa/pages/AppDetailPage";
import {
  AppPullRequestsTab,
  PullRequestsListView,
  currentListRead,
  type ListRead,
} from "../../src/spa/pages/AppPullRequestsTab";
import { withMarkup } from "./dom";
import {
  DETAIL,
  ROW_HEAD,
  ROW_OPEN,
  jsonResponse,
  mountTabWithGatedFetch,
  mountView,
  press,
} from "./pull-request-fixtures";

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
  target_id: "rt-501",
  blocked: false as const,
  blocked_reason: null,
  app: IDENTITY_APP,
};

const managePayload: SettingsManagePayload = {
  ...identityPayload,
  can_manage: true,
  blocked: false,
  blocked_reason: null,
  target_id: "rt-501",
  installation: null,
  pending_installations: [],
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

const ROW_CLOSED: PullRequestRow = {
  number: 7,
  owner: "acme",
  repo: "api",
  title: "Revert the cache change",
  state: "closed",
  head_sha: "ccc333ddd444",
  first_seen_at: "2026-10-20 08:00:00",
  last_seen_at: "2026-10-25 10:00:00",
  reviewing: { state: "none" },
  latest_review: null,
  failure_count: 2,
};

/** A second PR's detail payload — the switch target in the S2 test. */
const DETAIL_B: PullRequestDetail = {
  pull_request: { ...ROW_HEAD, number: 9, title: "Bump the dependencies" },
  counts: { findings: 0, reviews: 0, failures: 0, must_fix: 0 },
  latest_review: null,
};

describe("tab shell rendering (static SSR)", () => {
  test("the App detail hosts neither the ledger nor its trigger — the repository detail owns them", async () => {
    // The App detail's two faces are 应用设置 and 已安装: the PR ledger moved to
    // the repository surface, so no payload makes it appear here.
    for (const payload of [managePayload, identityPayload]) {
      const tabNames = await withMarkup(renderDetail(payload), (container) =>
        [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent ?? ""),
      );
      expect(tabNames).not.toContain(t("en", "targets.tabPullRequests"));
      expect(renderDetail(payload)).not.toContain(t("en", "pullRequests.columnPr"));
    }
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

  test("the empty state renders when the scope has seen no PR yet", () => {
    const markup = renderToStaticMarkup(
      createElement(PullRequestsListView, { locale: "en", rows: [], onOpen: noSearch }),
    );
    expect(markup).toContain(t("en", "pullRequests.emptyTitle"));
    expect(markup).toContain(t("en", "pullRequests.emptyDescription"));
    // No table shell leaks through the empty state.
    expect(markup).not.toContain("<table");
  });
});

/**
 * The reviewing-now badge on a LIST row (compass D11). The projection is the
 * server's: `live` paints the badge with the holding attempt's head sha (or
 * its acquisition time when a comment trigger carried none), `none` paints no
 * label at all, and `unknown` paints a note that is neither of those.
 *
 * Asserted through the rendered status badges, not the markup text: `none`
 * must leave exactly the row's state pill, which is what "no queued /
 * superseded / abandoned label of its own" means.
 */
describe("reviewing-now badge on the list row (D11)", () => {
  const ACQUIRED_AT = new Date(Date.now() - 5 * 60_000).toISOString();

  const replay = (reviewing: PullRequestReviewing): string =>
    renderToStaticMarkup(
      createElement(PullRequestsListView, {
        locale: "en",
        rows: [{ ...ROW_OPEN, reviewing }],
        onOpen: noSearch,
      }),
    );

  const badges = (markup: string): Promise<string[]> =>
    withMarkup(markup, (container) =>
      [...container.querySelectorAll('[data-slot="status-badge"]')].map((badge) => badge.textContent ?? ""),
    );

  test("a live lock paints the badge carrying the attempt's head sha", async () => {
    const texts = await badges(replay({ state: "live", head_sha: "abc1234def567", acquired_at: ACQUIRED_AT }));
    expect(texts).toEqual([
      t("en", "pullRequests.state.open"),
      t("en", "pullRequests.reviewingHead", { head: "abc1234" }),
    ]);
  });

  test("a live lock with no head sha carries its acquisition time instead", async () => {
    const texts = await badges(replay({ state: "live", head_sha: "", acquired_at: ACQUIRED_AT }));
    expect(texts[1]).toBe(
      t("en", "pullRequests.reviewingSince", { time: formatRelativeTime(ACQUIRED_AT, "en") }),
    );
  });

  test("no live lock leaves the state pill alone — no badge, no label of its own", async () => {
    // The one shape every non-reviewing disposition (no row, expired,
    // released, queued without a lock, superseded before admission, abandoned
    // after release) renders as.
    const texts = await badges(replay({ state: "none" }));
    expect(texts).toEqual([t("en", "pullRequests.state.open")]);
  });

  test("an unreadable inflight read paints unknown — not reviewing, not idle", async () => {
    const texts = await badges(replay({ state: "unknown" }));
    expect(texts).toEqual([
      t("en", "pullRequests.state.open"),
      t("en", "pullRequests.reviewingUnknown"),
    ]);
    expect(texts.join(" ")).not.toContain(t("en", "pullRequests.reviewingHead", { head: "abc1234" }));
  });
});

describe("pull requests data plane (pure helpers)", () => {
  test("the list URL is base-prefixed and addresses the scope, not an App", () => {
    // One repository: the target-addressed family, its id encoded.
    expect(scopedPullRequestsUrl("/dashboard", { kind: "target", targetId: "1" })).toBe(
      "/dashboard/api/targets/1/pull-requests",
    );
    expect(scopedPullRequestsUrl("/dashboard/acme", { kind: "target", targetId: "12345" })).toBe(
      "/dashboard/acme/api/targets/12345/pull-requests",
    );
    // Every repository: the workspace's own ledger, no target segment.
    expect(scopedPullRequestsUrl("/dashboard", { kind: "workspace" })).toBe(
      "/dashboard/api/pull-requests",
    );
    // The removed App-addressed family is never emitted.
    for (const url of [
      scopedPullRequestsUrl("/dashboard", { kind: "target", targetId: "1" }),
      scopedPullRequestsUrl("/dashboard", { kind: "workspace" }),
    ]) {
      expect(url).not.toContain("/api/apps/");
    }
  });

  test("a selected repository becomes a request parameter, encoded", () => {
    expect(scopedPullRequestsUrl("/dashboard", { kind: "target", targetId: "1" }, "acme/web")).toBe(
      "/dashboard/api/targets/1/pull-requests?repo=acme%2Fweb",
    );
    // No selection is exactly the unfiltered URL.
    expect(scopedPullRequestsUrl("/dashboard", { kind: "target", targetId: "1" })).toBe(
      "/dashboard/api/targets/1/pull-requests",
    );
  });

  test("a ledger read stamped for another scope derives to a clean loading face", () => {
    // Target 1's answered read: rows, option list, ok state, target 1's stamp.
    const targetOne: ListRead = {
      scope: "target:1",
      rows: [ROW_OPEN],
      repos: ["acme/web"],
      kind: "ok",
    };
    // Under target 2 the rows, the option list and the ok state are gone —
    // nothing survives the switch, so the operator's first frame cannot be
    // another scope's ledger.
    expect(currentListRead(targetOne, "target:2")).toEqual({
      scope: "target:2",
      rows: null,
      repos: null,
      kind: "loading",
    });
    // The same stamp under its own scope passes through untouched.
    expect(currentListRead(targetOne, "target:1")).toBe(targetOne);
    // The workspace scope is a different read from any target's.
    expect(currentListRead(targetOne, "workspace").rows).toBeNull();
    // An error is scope-scoped too: target 1's failure must not announce on 2.
    expect(currentListRead({ scope: "target:1", rows: null, repos: null, kind: "error" }, "target:2")).toEqual({
      scope: "target:2",
      rows: null,
      repos: null,
      kind: "loading",
    });
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
    expect(parsePullRequestList({ pull_requests: [ROW_OPEN] })).toEqual({
      rows: [ROW_OPEN],
      repos: [],
    });
    // Nullable display fields coerce to ""; an unknown state clamps to open.
    const drifted = { ...ROW_OPEN, title: null, head_sha: undefined, state: "draft" };
    expect(parsePullRequestList({ pull_requests: [drifted] })).toEqual({
      rows: [{ ...ROW_OPEN, title: "", head_sha: "", state: "open" }],
      repos: [],
    });
    // A row without its address is dropped individually — the rest stay.
    const noAddress = { ...ROW_OPEN, owner: null };
    expect(parsePullRequestList({ pull_requests: [noAddress, ROW_CLOSED] })).toEqual({
      rows: [ROW_CLOSED],
      repos: [],
    });
    // A malformed latest_review coerces to null, not a failed row.
    expect(
      parsePullRequestList({ pull_requests: [{ ...ROW_OPEN, latest_review: "ship it" }] }),
    ).toEqual({ rows: [{ ...ROW_OPEN, latest_review: null }], repos: [] });
    // The envelope keeps its shape.
    expect(parsePullRequestList({})).toBeNull();
  });

  test("the list parser carries the payload's repository option set, strings only", () => {
    const parsed = parsePullRequestList({
      pull_requests: [ROW_OPEN],
      repos: ["acme/web", "acme/api", 7, null, { owner: "x" }],
    });
    expect(parsed?.repos).toEqual(["acme/web", "acme/api"]);
    // An absent repos field (an older payload) yields an empty option set —
    // the toolbar then offers just the all option, never a re-derivation
    // from the loaded rows.
    expect(parsePullRequestList({ pull_requests: [ROW_OPEN] })?.repos).toEqual([]);
  });

  test("a null title on one row still returns the other rows", () => {
    const parsed = parsePullRequestList({ pull_requests: [{ ...ROW_OPEN, title: null }, ROW_CLOSED] });
    expect(parsed?.rows).toHaveLength(2);
    expect(parsed?.rows[0]?.title).toBe("");
    expect(parsed?.rows[1]).toEqual(ROW_CLOSED);
  });
});

describe("pull requests tab (mounted)", () => {
  test("the workspace scope reads every repository and an empty workspace is the empty state, not an error", async () => {
    // Zero live targets → the server answers `{ pull_requests: [], repos: [] }`.
    // That is the product's 暂无拉取请求 empty state (J4), never an error face or
    // a request naming a target that does not exist.
    const calls: string[] = [];
    const { container, unmount } = await mountView(
      createElement(AppPullRequestsTab, {
        locale: "en",
        scope: { kind: "workspace" },
        search: { tab: "settings", window: "30", repo: "", pr: "" },
        onSearch: () => {},
      }),
      {
        fetch: (async (input: unknown) => {
          calls.push(String(input));
          return jsonResponse({ pull_requests: [], repos: [] });
        }) as unknown as typeof fetch,
      },
    );
    try {
      expect(calls).toEqual(["/dashboard/api/pull-requests"]);
      expect(container.textContent ?? "").toContain(t("en", "pullRequests.emptyTitle"));
      expect(container.querySelector('[role="alert"]')).toBeNull();
    } finally {
      await unmount();
    }
  });

  test("the failures column carries the row's failure count", async () => {
    const { container, unmount } = await mountView(
      createElement(PullRequestsListView, { locale: "en", rows: [ROW_OPEN, ROW_CLOSED], onOpen: noSearch }),
    );
    try {
      const headers = [...container.querySelectorAll("th")].map((th) => th.textContent ?? "");
      const failuresAt = headers.indexOf(t("en", "pullRequests.columnFailures"));
      expect(failuresAt).toBeGreaterThan(-1);
      const row = [...container.querySelectorAll("tr")].find((tr) =>
        (tr.textContent ?? "").includes("Revert the cache change"),
      );
      const cells = [...(row?.querySelectorAll("td") ?? [])];
      expect(cells[failuresAt]?.textContent?.trim()).toBe("2");
    } finally {
      await unmount();
    }
  });

  test("a press on a PR's title opens it once; the rest of the row still opens it", async () => {
    const opened: PullRequestRow[] = [];
    const { container, win, unmount } = await mountView(
      createElement(PullRequestsListView, {
        locale: "en",
        rows: [ROW_OPEN],
        onOpen: (row) => opened.push(row),
      }),
    );
    try {
      const title = [...container.querySelectorAll("tbody button")].find(
        (button) => button.textContent === ROW_OPEN.title,
      );
      await press(win, title);
      // The button's click must not bubble into the row handler: one press,
      // one open — two would open the same PR twice.
      expect(opened).toEqual([ROW_OPEN]);
      // The rest of the row is still the row's own click target.
      await press(win, container.querySelector("tbody td:last-child"));
      expect(opened).toEqual([ROW_OPEN, ROW_OPEN]);
    } finally {
      await unmount();
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
      await press(win, retry);
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
    const { fetches, text, rerender, resolve, unmount } = await mountTabWithGatedFetch("acme/web/1");
    try {
      await act(async () => resolve("/pull-requests/acme/web/1", jsonResponse(DETAIL)));
      await act(async () => {});
      expect(fetches).toHaveLength(1);
      expect(text()).toContain("Fix the login flow");

      // The parent re-renders: `pullRequestRefOf` hands over a fresh ref object,
      // which must not count as a dependency change.
      await rerender("acme/web/1");
      expect(fetches).toHaveLength(1);
      expect(text()).toContain("Fix the login flow");
      expect(text()).not.toContain(t("en", "common.loading"));
    } finally {
      await unmount();
    }
  });

  test("a deep link reads only the detail; closing it issues the list read once (S4)", async () => {
    const { container, fetches, text, win, resolve, unmount } = await mountTabWithGatedFetch("acme/web/133");
    const listReads = () => fetches.filter((url) => url.endsWith("/pull-requests"));
    try {
      await act(async () => resolve("/pull-requests/acme/web/133", jsonResponse(DETAIL)));
      await act(async () => {});
      // The detail is the whole face the deep link asked for: no list read.
      expect(text()).toContain("Fix the login flow");
      expect(listReads()).toHaveLength(0);

      // Closing the detail is the list's cue — exactly one read, whose rows
      // replace the unmounted detail.
      await press(
        win,
        [...container.querySelectorAll("button")].find(
          (button) => button.textContent === t("en", "pullRequests.backToList"),
        ),
      );
      expect(listReads()).toHaveLength(1);
      await act(async () => resolve("/pull-requests", jsonResponse({ pull_requests: [ROW_OPEN] })));
      await act(async () => {});
      expect(text()).toContain("Add the export button");
    } finally {
      await unmount();
    }
  });

  test("switching targets never paints the previous target's ledger while the new read is pending", async () => {
    // The tab instance survives a target switch (the repository page keeps it
    // mounted across a sibling navigation), so the ledger is stamped with its
    // scope: target 1's row must be gone the instant the tab belongs to 2.
    const { container, fetches, text, switchTarget, resolve, unmount } = await mountTabWithGatedFetch("");
    try {
      await act(async () =>
        resolve("/targets/1/pull-requests", jsonResponse({ pull_requests: [ROW_OPEN] })),
      );
      await act(async () => {});
      expect(text()).toContain("Add the export button");

      // Target 2's read is issued but not answered: the loading face stands
      // in, with neither target 1's row nor its empty/error state.
      await switchTarget("2");
      const listReads = () => fetches.filter((url) => url.endsWith("/pull-requests"));
      expect(listReads()).toHaveLength(2);
      expect(listReads()[1]).toContain("/targets/2/");
      expect(text()).not.toContain("Add the export button");
      expect(text()).toContain(t("en", "common.loading"));
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(container.querySelector("table")).toBeNull();

      // Target 2's own ledger replaces the loading face.
      await act(async () =>
        resolve("/targets/2/pull-requests", jsonResponse({ pull_requests: [ROW_CLOSED] })),
      );
      await act(async () => {});
      expect(text()).toContain("Revert the cache change");
      expect(text()).not.toContain("Add the export button");
    } finally {
      await unmount();
    }
  });

  test("the toolbar offers payload repos absent from the window; a selection drives the request, all returns to it, refresh keeps the filter", async () => {
    const { container, fetches, win, resolve, unmount } = await mountTabWithGatedFetch("");
    const repoParamReads = () => fetches.filter((url) => url.includes("repo=acme%2Fapi"));
    const unfilteredReads = () => fetches.filter((url) => url.endsWith("/pull-requests"));
    const openOptions = async () => {
      await press(win, container.querySelector('[role="combobox"]'));
      return [...win.document.querySelectorAll('[role="option"]')];
    };
    const payload = { pull_requests: [ROW_OPEN], repos: ["acme/api", "acme/web"] };
    try {
      await act(async () => resolve("/pull-requests", jsonResponse(payload)));
      await act(async () => {});
      expect(unfilteredReads()).toHaveLength(1);

      // acme/api has NO rows in the current window — it is still an option,
      // proving the option set comes from the payload, not the rows.
      const options = await openOptions();
      expect(options.map((option) => option.textContent)).toEqual([
        t("en", "pullRequests.filterRepoAll"),
        "acme/api",
        "acme/web",
      ]);

      // Selecting it issues the filtered request and renders the rows it
      // returns — the filter is server-side, not a local array filter.
      await press(win, options.find((option) => option.textContent === "acme/api") as unknown as Element);
      expect(repoParamReads()).toHaveLength(1);
      await act(async () =>
        resolve("repo=acme%2Fapi", jsonResponse({ pull_requests: [ROW_CLOSED], repos: ["acme/api", "acme/web"] })),
      );
      await act(async () => {});
      expect(container.textContent ?? "").toContain("Revert the cache change");
      expect(container.textContent ?? "").not.toContain("Add the export button");

      // Refresh re-reads WITH the current filter.
      await press(
        win,
        [...container.querySelectorAll("button")].find(
          (button) => button.getAttribute("aria-label") === t("en", "pullRequests.refreshAria"),
        ),
      );
      expect(repoParamReads()).toHaveLength(2);
      await act(async () =>
        resolve("repo=acme%2Fapi", jsonResponse({ pull_requests: [ROW_CLOSED], repos: ["acme/api", "acme/web"] })),
      );
      await act(async () => {});
      expect(container.textContent ?? "").toContain("Revert the cache change");

      // Back to the all option: the unfiltered URL is requested again.
      const allOptions = await openOptions();
      await press(win, allOptions[0] as unknown as Element);
      expect(unfilteredReads()).toHaveLength(2);
      await act(async () => resolve("/pull-requests", jsonResponse(payload)));
      await act(async () => {});
      expect(container.textContent ?? "").toContain("Add the export button");
    } finally {
      await unmount();
    }
  });

  test("a failed filtered read keeps the toolbar reachable; choosing all re-reads unfiltered", async () => {
    const { container, fetches, win, resolve, unmount } = await mountTabWithGatedFetch("");
    const repoParamReads = () => fetches.filter((url) => url.includes("repo=acme%2Fapi"));
    const unfilteredReads = () => fetches.filter((url) => url.endsWith("/pull-requests"));
    const payload = { pull_requests: [ROW_OPEN], repos: ["acme/api", "acme/web"] };
    try {
      await act(async () => resolve("/pull-requests", jsonResponse(payload)));
      await act(async () => {});
      expect(unfilteredReads()).toHaveLength(1);

      // Select acme/api: the filtered read is issued…
      await press(win, container.querySelector('[role="combobox"]'));
      const option = [...win.document.querySelectorAll('[role="option"]')].find(
        (row) => row.textContent === "acme/api",
      );
      await press(win, option as unknown as Element);
      expect(repoParamReads()).toHaveLength(1);
      // …and fails. The error face owns the content area, but the toolbar
      // must not disappear with it: the operator is stranded otherwise,
      // and ErrorState's retry would only re-issue the same failing URL.
      await act(async () => resolve("repo=acme%2Fapi", new Response("boom", { status: 500 })));
      await act(async () => {});
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
      expect(container.querySelector('[role="combobox"]')).not.toBeNull();
      const refresh = [...container.querySelectorAll("button")].find(
        (button) => button.getAttribute("aria-label") === t("en", "pullRequests.refreshAria"),
      );
      expect(refresh).toBeDefined();
      expect((refresh as HTMLButtonElement | undefined)?.disabled).toBe(false);

      // The carried option list still names the selection — no dead entry —
      // and choosing the all option issues the unfiltered URL.
      await press(win, container.querySelector('[role="combobox"]'));
      const options = [...win.document.querySelectorAll('[role="option"]')];
      expect(options.map((row) => row.textContent)).toEqual([
        t("en", "pullRequests.filterRepoAll"),
        "acme/api",
        "acme/web",
      ]);
      await press(win, options[0] as unknown as Element);
      expect(unfilteredReads()).toHaveLength(2);
      await act(async () => resolve("/pull-requests", jsonResponse(payload)));
      await act(async () => {});
      expect(container.textContent ?? "").toContain("Add the export button");
    } finally {
      await unmount();
    }
  });

  test("the repo filter resets to all when the tab switches targets (I-001)", async () => {
    const { container, fetches, win, switchTarget, resolve, unmount } = await mountTabWithGatedFetch("");
    const payload = { pull_requests: [ROW_OPEN, ROW_CLOSED], repos: ["acme/api", "acme/web"] };
    try {
      await act(async () => resolve("/pull-requests", jsonResponse(payload)));
      await act(async () => {});
      // Select a repo: the ledger is re-read with the repo request parameter.
      await press(win, container.querySelector('[role="combobox"]'));
      const option = [...win.document.querySelectorAll('[role="option"]')].find(
        (row) => row.textContent === "acme/api",
      );
      await press(win, option as unknown as Element);
      expect(fetches.filter((url) => url.includes("repo=acme%2Fapi"))).toHaveLength(1);
      await act(async () =>
        resolve("repo=acme%2Fapi", jsonResponse({ pull_requests: [ROW_CLOSED], repos: ["acme/api", "acme/web"] })),
      );
      await act(async () => {});
      expect(container.textContent ?? "").toContain("Revert the cache change");
      expect(container.textContent ?? "").not.toContain("Add the export button");

      // The tab instance survives the target switch, but the filter does not:
      // the new target's ledger is read unfiltered and the select is back on
      // the all option.
      await switchTarget("2");
      const targetTwoReads = fetches.filter((url) => url.includes("/targets/2/"));
      expect(targetTwoReads).toHaveLength(1);
      expect(targetTwoReads[0]).not.toContain("repo=");
      await act(async () => resolve("/targets/2/pull-requests", jsonResponse(payload)));
      await act(async () => {});
      expect(container.textContent ?? "").toContain("Add the export button");
      expect(container.querySelector('[role="combobox"]')?.textContent ?? "").toContain(
        t("en", "pullRequests.filterRepoAll"),
      );
    } finally {
      await unmount();
    }
  });

  test("the refresh button re-reads the list and is disabled while the read is in flight", async () => {
    const { container, fetches, win, resolve, unmount } = await mountTabWithGatedFetch("");
    const listReads = () => fetches.filter((url) => url.endsWith("/pull-requests"));
    const refreshButton = () =>
      [...container.querySelectorAll("button")].find(
        (button) => button.getAttribute("aria-label") === t("en", "pullRequests.refreshAria"),
      ) as HTMLButtonElement | undefined;
    try {
      await act(async () => resolve("/pull-requests", jsonResponse({ pull_requests: [ROW_OPEN] })));
      await act(async () => {});
      expect(listReads()).toHaveLength(1);
      expect(refreshButton()?.disabled).toBe(false);

      await press(win, refreshButton());
      expect(listReads()).toHaveLength(2);
      // The second read is gated: the control reports the in-flight read.
      expect(refreshButton()?.disabled).toBe(true);

      await act(async () => resolve("/pull-requests", jsonResponse({ pull_requests: [ROW_CLOSED] })));
      await act(async () => {});
      expect(refreshButton()?.disabled).toBe(false);
      expect(container.textContent ?? "").toContain("Revert the cache change");
    } finally {
      await unmount();
    }
  });

  test("a list read that fails after closing the detail shows the error face, and retry re-reads", async () => {
    const { container, fetches, text, win, rerender, resolve, unmount } = await mountTabWithGatedFetch("");
    const listReads = () => fetches.filter((url) => url.endsWith("/pull-requests"));
    try {
      // The ledger loads, so a later failure has stale rows to hide.
      await act(async () => resolve("/pull-requests", jsonResponse({ pull_requests: [ROW_OPEN] })));
      await act(async () => {});
      expect(text()).toContain("Add the export button");

      // Open a PR, then close it: the close re-reads the list, and that read
      // fails. The stale row must not stand in for the current ledger.
      await rerender("acme/web/133");
      await act(async () => resolve("/pull-requests/acme/web/133", jsonResponse(DETAIL)));
      await act(async () => {});
      expect(text()).toContain("Fix the login flow");
      await press(
        win,
        [...container.querySelectorAll("button")].find(
          (button) => button.textContent === t("en", "pullRequests.backToList"),
        ),
      );
      expect(listReads()).toHaveLength(2);
      await act(async () => resolve("/pull-requests", new Response("boom", { status: 500 })));
      await act(async () => {});
      expect(container.querySelector('[role="alert"]')).not.toBeNull();
      expect(text()).toContain(t("en", "common.loadFailed"));
      expect(text()).not.toContain("Add the export button");

      // Retry re-reads; the ledger it returns replaces the error face.
      const retry = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === t("en", "common.retry"),
      );
      expect(retry).toBeDefined();
      await press(win, retry);
      expect(listReads()).toHaveLength(3);
      await act(async () => resolve("/pull-requests", jsonResponse({ pull_requests: [ROW_CLOSED] })));
      await act(async () => {});
      expect(text()).toContain("Revert the cache change");
      expect(container.querySelector('[role="alert"]')).toBeNull();
    } finally {
      await unmount();
    }
  });
});
