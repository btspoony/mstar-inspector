/**
 * Pull requests tab (App detail IA): the per-App PR ledger, its list face and
 * the routing/deep-link contract.
 *
 * Static-SSR pins over the pure faces (the InsightsRecordsView idiom): the
 * manage-gated tab trigger, the list table (title / state / verdict / last
 * seen / failure count) and the empty state. Mounted (happy-dom) pins cover
 * what only real effects and events prove: the manage-gated click-through to
 * the ledger, the failures-column cell content, and the S2 switching contract
 * — a retained detail from PR A must never render while PR B loads, and a
 * failed fetch for the new PR renders the error face with a retry. The detail
 * face itself lives in `pull-request-detail.test.tsx`; payloads both suites
 * read live in `pull-request-fixtures.ts`.
 */
import { describe, expect, test } from "bun:test";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
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
import { AppPullRequestsTab, PullRequestsListView } from "../../src/spa/pages/AppPullRequestsTab";
import { installDom, withMarkup } from "./dom";
import { DETAIL, ROW_OPEN, jsonResponse, mountTabWithGatedFetch, press } from "./pull-request-fixtures";

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
  test("the Pull requests trigger appears ONLY on the manage face", () => {
    const tabNames = (payload: SettingsPayload) =>
      withMarkup(renderDetail(payload), (container) =>
        [...container.querySelectorAll('[role="tab"]')].map((tab) => tab.textContent ?? ""),
      );
    expect(tabNames(managePayload)).toContain(t("en", "appDetail.tabPullRequests"));
    expect(tabNames(identityPayload)).not.toContain(t("en", "appDetail.tabPullRequests"));
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
        win,
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
