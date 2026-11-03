/**
 * Payloads and the gated-fetch mount shared by the pull-requests suites.
 *
 * The list/detail split imports the same PR payloads; keeping them here means
 * neither file pins its own copy of the data the other one asserts on.
 */
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import type { Window } from "happy-dom";
import { AppPullRequestsTab } from "../../src/spa/pages/AppPullRequestsTab";
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
 * One press as the browser performs it — the pointer events Radix listens for,
 * then a flush so the state the press caused has settled. Shared by every
 * mounted suite, so none of them spells this sequence again.
 */
export async function press(win: Window, target: Element | null | undefined): Promise<void> {
  const pointer = (type: string) =>
    new win.MouseEvent(type, { bubbles: true, cancelable: true, button: 0 }) as unknown as Event;
  await act(async () => {
    target?.dispatchEvent(pointer("mousedown"));
    target?.dispatchEvent(pointer("click"));
  });
  await act(async () => {});
}

/**
 * Mount the tab with every fetch gated until the test resolves it by URL
 * suffix, so a transition frame is observable instead of raced. The mount of
 * `initialPr` is the helper's own first act; teardown restores `fetch` and the
 * DOM in one call.
 */
export async function mountTabWithGatedFetch(initialPr: string) {
  const { win, cleanup } = installDom("http://localhost/dashboard/apps/1");
  const realFetch = globalThis.fetch;
  type Gate = { promise: Promise<Response>; resolve: (response: Response) => void };
  const gates = new Map<string, Gate>();
  // Every URL the tab asked for, so a test can prove a read was (or was not)
  // issued without keeping its own stub.
  const fetches: string[] = [];
  globalThis.fetch = (async (input: unknown) => {
    fetches.push(String(input));
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
  // The helper owns the shell's search state, so a close (`onSearch`) commits
  // exactly as the real page's does — the deep-link test needs no harness.
  let setSearch: (next: (previous: AppDetailSearch) => AppDetailSearch) => void = () => {};
  function Harness() {
    const [search, set] = useState<AppDetailSearch>({
      tab: "pull-requests",
      window: "30",
      repo: "",
      pr: initialPr,
    });
    setSearch = set;
    return createElement(AppPullRequestsTab, { locale: "en", appId: "1", search, onSearch: set });
  }
  const host = win.document.createElement("div");
  win.document.body.appendChild(host);
  // happy-dom's nodes cross into lib.dom's here, as in the suites above.
  const container = host as unknown as HTMLElement;
  const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(createElement(Harness)));
    await act(async () => {});
  } catch (error) {
    // A mount that throws never reaches `unmount()`: the stub `fetch` and the
    // installed window are restored here, so one broken test cannot leak
    // either into the next one.
    globalThis.fetch = realFetch;
    cleanup();
    throw error;
  }
  return {
    container,
    fetches,
    text: () => container.textContent ?? "",
    win,
    /**
     * Re-render for `pr` through a fresh search object — the shell's own
     * re-sync always hands over a new object with the same value.
     */
    rerender: async (pr: string) => {
      await act(async () => setSearch((previous) => ({ ...previous, pr })));
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
