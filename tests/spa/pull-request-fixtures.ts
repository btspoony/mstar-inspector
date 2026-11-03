/**
 * Payloads and the gated-fetch mount shared by the pull-requests suites.
 *
 * The list/detail split imports the same PR payloads; keeping them here means
 * neither file pins its own copy of the data the other one asserts on. The
 * detail split is head + counts (one read) plus three record pages (one read
 * each) — `DETAIL` is the head, `RECORDS` the first page of every family.
 */
import { act, createElement, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type { Window } from "happy-dom";
import { AppPullRequestsTab } from "../../src/spa/pages/AppPullRequestsTab";
import {
  PullRequestDetail,
  type RecordSections,
  type SectionState,
} from "../../src/spa/pages/PullRequestDetail";
import type {
  AppDetailSearch,
  PullRequestDetail as PullRequestDetailPayload,
  PullRequestFailure,
  PullRequestFinding,
  PullRequestReview,
  PullRequestRow,
  RecordPage,
  RecordPageItems,
  RecordSection,
} from "../../src/spa/pages/data";
import { installDom } from "./dom";

export const ROW_OPEN: PullRequestRow = {
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

/** The three findings, as the findings section orders them (newest first). */
export const FINDINGS: PullRequestFinding[] = [
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
];

/** Newest first, as the store orders them: the first row is the latest verdict. */
export const REVIEWS: PullRequestReview[] = [
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
];

export const FAILURES: PullRequestFailure[] = [
  {
    stage: "sandbox",
    // Model/runtime output — must render escaped, never as HTML.
    error: "exit 1: <script>alert(1)</script>",
    created_at: "2026-10-31 23:00:00",
  },
];

/** Every section's first page — the detail head's counts follow these totals. */
export type RecordPages = { [K in RecordSection]: RecordPage<RecordPageItems[K]> };

export const RECORDS: RecordPages = {
  findings: { items: FINDINGS, total: FINDINGS.length },
  reviews: { items: REVIEWS, total: REVIEWS.length },
  failures: { items: FAILURES, total: FAILURES.length },
};

/** The detail head for `RECORDS`: the same PR, its totals derived from the pages. */
export const DETAIL: PullRequestDetailPayload = {
  pull_request: {
    ...ROW_OPEN,
    number: 133,
    title: "Fix the login flow",
    state: "merged",
    latest_review: { verdict: "needs fixes", reviewed_at: "2026-11-01 08:00:00" },
    failure_count: FAILURES.length,
  },
  counts: { findings: FINDINGS.length, reviews: REVIEWS.length, failures: FAILURES.length },
};

/** A head and the pages it describes, as both mount helpers take them. */
export type DetailScene = { detail: PullRequestDetailPayload; pages: RecordPages };

/**
 * A detail scene: `over` replaces a family's page, and every count follows the
 * supplied totals — so a scene's head can never claim more records than the
 * stub will serve.
 */
export function scene(over: Partial<RecordPages> = {}, row: Partial<PullRequestRow> = {}): DetailScene {
  const pages: RecordPages = { ...RECORDS, ...over };
  return {
    detail: {
      pull_request: { ...DETAIL.pull_request, failure_count: pages.failures.total, ...row },
      counts: { findings: pages.findings.total, reviews: pages.reviews.total, failures: pages.failures.total },
    },
    pages,
  };
}

/** Static props for the pure view: every section loaded at `pages`' first page. */
export function recordsOf(pages: RecordPages = RECORDS, offset = 0): RecordSections {
  const section = <K extends RecordSection>(page: RecordPage<RecordPageItems[K]>): SectionState<K> => ({
    offset,
    severity: "",
    status: "ok",
    page,
  });
  return {
    findings: section(pages.findings),
    reviews: section(pages.reviews),
    failures: section(pages.failures),
  };
}

export const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/**
 * One press as the browser performs it: pointerdown, mousedown, pointerup,
 * mouseup, then click — the sequence a Radix trigger's pointer listeners and a
 * plain button's click both act on — followed by a flush so the state the
 * press caused has settled. Shared by every mounted suite, so none of them
 * spells this sequence again.
 */
export async function press(win: Window, target: Element | null | undefined): Promise<void> {
  const pointer = (type: string) =>
    new win.PointerEvent(type, { bubbles: true, cancelable: true, button: 0 }) as unknown as Event;
  const mouse = (type: string) =>
    new win.MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }) as unknown as Event;
  await act(async () => {
    target?.dispatchEvent(pointer("pointerdown"));
    target?.dispatchEvent(mouse("mousedown"));
    target?.dispatchEvent(pointer("pointerup"));
    target?.dispatchEvent(mouse("mouseup"));
    target?.dispatchEvent(mouse("click"));
  });
  await act(async () => {});
}

/**
 * Mount one element on its own window with a settled render, and hand back the
 * container plus that window. Teardown unmounts and restores the DOM in one
 * call; a `fetch` stub passed here is installed before the mount and restored
 * on the way out, including when the mount throws.
 */
export async function mountView(
  element: ReactElement,
  { fetch: fetchImpl = globalThis.fetch }: { fetch?: typeof globalThis.fetch } = {},
) {
  const { win, cleanup } = installDom("http://localhost/dashboard/apps/1");
  const realFetch = globalThis.fetch;
  globalThis.fetch = fetchImpl;
  const host = win.document.createElement("div");
  win.document.body.appendChild(host);
  // happy-dom's nodes cross into lib.dom's here: the queries read the same
  // roles, attributes and `hidden` the static tests do.
  const container = host as unknown as HTMLElement;
  const root = createRoot(container as unknown as Element);
  let mounted = true;
  try {
    await act(async () => root.render(element));
    // A mounted face can chain reads (head → first section): a few empty
    // flushes drain those microtasks, so the mount lands settled.
    for (let flush = 0; flush < 3; flush += 1) await act(async () => {});
  } catch (error) {
    mounted = false;
    globalThis.fetch = realFetch;
    cleanup();
    throw error;
  }
  return {
    container,
    win,
    unmount: async () => {
      // A test may unmount mid-body (the late-write case) and again on the way
      // out; the window is restored once.
      if (!mounted) return;
      mounted = false;
      await act(async () => root.unmount());
      globalThis.fetch = realFetch;
      cleanup();
    },
  };
}

/**
 * A fetch stub for the detail host: the head read answers that App's `detail`,
 * and each record read pages that App's family — `offset`/`limit` slice its
 * rows and `severity` filters findings, so a mounted test sees a real page
 * swap. `sceneFor` receives the App the URL names, so one stub can serve
 * different Apps. Every request is recorded for the "one read per switch"
 * assertions.
 */
function detailFetch(sceneFor: (appId: string) => DetailScene): { fetch: typeof globalThis.fetch; fetches: string[] } {
  const fetches: string[] = [];
  const impl = (async (input: unknown) => {
    const url = new URL(String(input), "http://localhost");
    fetches.push(url.pathname + url.search);
    // `/api/apps/<appId>/pull-requests/...`: the App the read answers for.
    const sceneValue = sceneFor(/\/apps\/([^/]+)\//.exec(url.pathname)?.[1] ?? "");
    const severity = url.searchParams.get("severity");
    for (const section of ["findings", "reviews", "failures"] as const) {
      if (!url.pathname.endsWith(`/${section}`)) continue;
      const rows =
        section === "findings"
          ? sceneValue.pages.findings.items.filter(
              (finding) => severity === null || finding.severity === severity,
            )
          : section === "reviews"
            ? sceneValue.pages.reviews.items
            : sceneValue.pages.failures.items;
      const offset = Number(url.searchParams.get("offset") ?? "0");
      const limit = Number(url.searchParams.get("limit") ?? "10");
      return jsonResponse({ items: rows.slice(offset, offset + limit), total: rows.length });
    }
    return jsonResponse(sceneValue.detail);
  }) as unknown as typeof fetch;
  return { fetch: impl, fetches };
}

/**
 * Mount the detail FACE (host + view) over a scene, optionally inside a
 * wrapper (StrictMode), and hand back the container, the window the clipboard
 * stubs hang off, and every request the reads issued.
 */
export async function mountDetailView(sceneValue: DetailScene, wrap?: (view: ReactElement) => ReactElement) {
  const stub = detailFetch(() => sceneValue);
  const pr = sceneValue.detail.pull_request;
  const view = createElement(PullRequestDetail, {
    locale: "en",
    appId: "1",
    prKey: `${pr.owner}/${pr.repo}/${pr.number}`,
    prRef: { owner: pr.owner, repo: pr.repo, number: pr.number },
    onBack: () => {},
  });
  const mounted = await mountView(wrap === undefined ? view : wrap(view), { fetch: stub.fetch });
  return { ...mounted, fetches: stub.fetches };
}

/**
 * Mount the tab with every fetch gated until the test resolves it by URL
 * suffix, so a transition frame is observable instead of raced. The mount of
 * `initialPr` is the helper's own first act; teardown restores `fetch` and the
 * DOM in one call. `switchApp` moves the SAME tab instance to another App, the
 * way the shell does when the route's appId changes in place.
 *
 * A detail's record sections are NOT gated: they are an implementation of the
 * face under test, and a pending section read would hold the transition frame
 * the tests assert. They answer an empty page at once and stay out of
 * `fetches`, whose counts are about the list/head reads.
 */
export async function mountTabWithGatedFetch(initialPr: string) {
  // One gate per REQUEST, not per URL: a retry re-reads a URL that was already
  // read, and a URL-keyed gate would replace the request still pending.
  type Gate = { url: string; promise: Promise<Response>; resolve: (response: Response) => void };
  const gates: Gate[] = [];
  // Every list/head URL the tab asked for, so a test can prove a read was (or
  // was not) issued without keeping its own stub.
  const fetches: string[] = [];
  const gatedFetch = (async (input: unknown) => {
    const url = String(input);
    if (/\/(findings|reviews|failures)\?/.test(url)) {
      return jsonResponse({ items: [], total: 0 });
    }
    fetches.push(url);
    const gate: Gate = { url, ...Promise.withResolvers<Response>() };
    gates.push(gate);
    return gate.promise;
  }) as unknown as typeof fetch;
  const resolve = (suffix: string, response: Response) => {
    const gate = [...gates].reverse().find((candidate) => candidate.url.endsWith(suffix));
    if (gate === undefined) throw new Error(`no fetch issued for ${suffix}`);
    gates.splice(gates.indexOf(gate), 1);
    gate.resolve(response);
  };
  // The helper owns the shell's search state, so a close (`onSearch`) commits
  // exactly as the real page's does — the deep-link test needs no harness.
  let setSearch: (next: (previous: AppDetailSearch) => AppDetailSearch) => void = () => {};
  let setApp: (next: string) => void = () => {};
  function Harness() {
    const [search, set] = useState<AppDetailSearch>({
      tab: "pull-requests",
      window: "30",
      repo: "",
      pr: initialPr,
    });
    const [appId, setAppId] = useState("1");
    setSearch = set;
    setApp = setAppId;
    return createElement(AppPullRequestsTab, { locale: "en", appId, search, onSearch: set });
  }
  const mounted = await mountView(createElement(Harness), { fetch: gatedFetch });
  return {
    ...mounted,
    fetches,
    text: () => mounted.container.textContent ?? "",
    /**
     * Re-render for `pr` through a fresh search object — the shell's own
     * re-sync always hands over a new object with the same value.
     */
    rerender: async (pr: string) => {
      await act(async () => setSearch((previous) => ({ ...previous, pr })));
      await act(async () => {});
    },
    /** Move the tab to another App, keeping the same `search` (and PR). */
    switchApp: async (appId: string) => {
      await act(async () => setApp(appId));
      await act(async () => {});
    },
    resolve,
  };
}

/**
 * Mount the TAB over per-App detail scenes, then move it to another App in
 * place — the shell's own appId change with the PR retained. The tab is the
 * detail host's call site, so what an App switch does to the open PR's head
 * and section pages is what this mount observes; `sceneFor` is asked for the
 * App the request names, and every request is recorded.
 */
export async function mountTabAcrossApps(initialPr: string, sceneFor: (appId: string) => DetailScene) {
  const stub = detailFetch(sceneFor);
  let setApp: (next: string) => void = () => {};
  function Harness() {
    const [search, setSearch] = useState<AppDetailSearch>({
      tab: "pull-requests",
      window: "30",
      repo: "",
      pr: initialPr,
    });
    const [appId, set] = useState("1");
    setApp = set;
    return createElement(AppPullRequestsTab, { locale: "en", appId, search, onSearch: setSearch });
  }
  const mounted = await mountView(createElement(Harness), { fetch: stub.fetch });
  return {
    ...mounted,
    fetches: stub.fetches,
    text: () => mounted.container.textContent ?? "",
    /** Move the tab to another App, keeping the same search (and PR). */
    switchApp: async (appId: string) => {
      await act(async () => setApp(appId));
      await act(async () => {});
    },
  };
}

/** One record-section page (the total defaults to the row count). */
export function page<T>(items: T[], total = items.length): RecordPage<T> {
  return { items, total };
}
