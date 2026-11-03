/**
 * Pull requests tab (App detail IA): the per-App PR ledger, its list face and
 * the routing/deep-link contract.
 *
 * Static-SSR pins over the pure faces (the InsightsRecordsView idiom): the
 * manage-gated tab trigger, the list table (title / state / verdict / last
 * seen / failure count) and the empty state. Mounted (happy-dom) pins cover
 * what only real effects and events prove: the manage-gated click-through to
 * the ledger, the failures-column cell content, and the S2 switching contract
 * — a retained detail from PR A must never render while PR B loads, a failed
 * fetch for the new PR renders the error face with a retry, and a switch to
 * another App never paints the previous App's rows. The detail face
 * itself lives in `pull-request-detail-static.test.tsx` and
 * `pull-request-detail-interaction.test.tsx`; payloads every suite reads live
 * in `pull-request-fixtures.ts`.
 */
import { describe, expect, test } from "bun:test";
import { act, createElement, useState } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../../src/i18n";
import {
  appPullRequestsUrl,
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
  PullRequestsListView,
  currentListRead,
  type ListRead,
} from "../../src/spa/pages/AppPullRequestsTab";
import { withMarkup } from "./dom";
import {
  DETAIL,
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

describe("tab shell rendering (static SSR)", () => {
  test("the Pull requests trigger appears ONLY on the manage face", async () => {
    const tabNames = async (payload: SettingsPayload) =>
      withMarkup(renderDetail(payload), (container) =>
        [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent ?? ""),
      );
    expect(await tabNames(managePayload)).toContain(t("en", "appDetail.tabPullRequests"));
    expect(await tabNames(identityPayload)).not.toContain(t("en", "appDetail.tabPullRequests"));
    // The ledger itself is absent too, not only its trigger.
    expect(renderDetail(identityPayload)).not.toContain(t("en", "pullRequests.columnPr"));
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

describe("pull requests data plane (pure helpers)", () => {
  test("the list URL is base-prefixed and encodes the appId", () => {
    expect(appPullRequestsUrl("/dashboard", "1")).toBe("/dashboard/api/apps/1/pull-requests");
    expect(appPullRequestsUrl("/dashboard/acme", "12345")).toBe(
      "/dashboard/acme/api/apps/12345/pull-requests",
    );
  });

  test("a ledger read stamped for another App derives to a clean loading face", () => {
    // App 1's answered read: rows, ok state, App 1's stamp.
    const appOne: ListRead = { app: "1", rows: [ROW_OPEN], kind: "ok" };
    // Under App 2 the rows and the ok state are gone — nothing survives the
    // switch, so the operator's first frame cannot be another App's ledger.
    expect(currentListRead(appOne, "2")).toEqual({ app: "2", rows: null, kind: "loading" });
    // The same stamp under its own App passes through untouched.
    expect(currentListRead(appOne, "1")).toBe(appOne);
    // An error is App-scoped too: App 1's failure must not announce on App 2.
    expect(currentListRead({ app: "1", rows: null, kind: "error" }, "2")).toEqual({
      app: "2",
      rows: null,
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
});

describe("pull requests tab (mounted)", () => {
  test("clicking the Pull requests tab on the manage face opens the ledger", async () => {
    // Every read answers the same empty ledger.
    const { container, win, unmount } = await mountView(createElement(DetailHarness), {
      fetch: (async () => jsonResponse({ pull_requests: [] })) as unknown as typeof fetch,
    });
    try {
      const trigger = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === t("en", "appDetail.tabPullRequests"),
      );
      expect(trigger).toBeDefined();
      await press(win, trigger as unknown as Element);
      // The ledger's empty state is the opened tab's face.
      expect(container.textContent ?? "").toContain(t("en", "pullRequests.emptyTitle"));
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

  test("switching Apps never paints the previous App's ledger while the new read is pending", async () => {
    // The tab instance survives an App switch (the shell keeps it mounted for
    // `/dashboard/apps/:appId`), so the ledger is stamped with its App: App 1's
    // row must be gone the instant the tab belongs to App 2.
    const { container, fetches, text, switchApp, resolve, unmount } = await mountTabWithGatedFetch("");
    try {
      await act(async () => resolve("/apps/1/pull-requests", jsonResponse({ pull_requests: [ROW_OPEN] })));
      await act(async () => {});
      expect(text()).toContain("Add the export button");

      // App 2's read is issued but not answered: the loading face stands in,
      // with neither App 1's row nor App 1's empty/error state.
      await switchApp("2");
      const listReads = () => fetches.filter((url) => url.endsWith("/pull-requests"));
      expect(listReads()).toHaveLength(2);
      expect(listReads()[1]).toContain("/apps/2/");
      expect(text()).not.toContain("Add the export button");
      expect(text()).toContain(t("en", "common.loading"));
      expect(container.querySelector('[role="alert"]')).toBeNull();
      expect(container.querySelector("table")).toBeNull();

      // App 2's own ledger replaces the loading face.
      await act(async () => resolve("/apps/2/pull-requests", jsonResponse({ pull_requests: [ROW_CLOSED] })));
      await act(async () => {});
      expect(text()).toContain("Revert the cache change");
      expect(text()).not.toContain("Add the export button");
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
