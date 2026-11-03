/**
 * Payloads and the gated-fetch mount shared by the pull-requests suites.
 *
 * The list/detail split imports the same PR payloads; keeping them here means
 * neither file pins its own copy of the data the other one asserts on.
 */
import { act, createElement, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import type { Window } from "happy-dom";
import { AppPullRequestsTab } from "../../src/spa/pages/AppPullRequestsTab";
import { PullRequestDetailView } from "../../src/spa/pages/PullRequestDetail";
import type { AppDetailSearch, PullRequestDetail, PullRequestRow } from "../../src/spa/pages/data";
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

export const DETAIL: PullRequestDetail = {
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
    await act(async () => {});
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
 * Mount the detail face, optionally inside a wrapper (StrictMode), and hand
 * back the container plus the window the clipboard stubs hang off.
 */
export async function mountDetailView(
  detail: PullRequestDetail,
  wrap?: (view: ReactElement) => ReactElement,
) {
  const view = createElement(PullRequestDetailView, { locale: "en", detail });
  return mountView(wrap === undefined ? view : wrap(view));
}

/**
 * Mount the tab with every fetch gated until the test resolves it by URL
 * suffix, so a transition frame is observable instead of raced. The mount of
 * `initialPr` is the helper's own first act; teardown restores `fetch` and the
 * DOM in one call. `switchApp` moves the SAME tab instance to another App, the
 * way the shell does when the route's appId changes in place.
 */
export async function mountTabWithGatedFetch(initialPr: string) {
  // One gate per REQUEST, not per URL: a retry re-reads a URL that was already
  // read, and a URL-keyed gate would replace the request still pending.
  type Gate = { url: string; promise: Promise<Response>; resolve: (response: Response) => void };
  const gates: Gate[] = [];
  // Every URL the tab asked for, so a test can prove a read was (or was not)
  // issued without keeping its own stub.
  const fetches: string[] = [];
  const gatedFetch = (async (input: unknown) => {
    const url = String(input);
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
