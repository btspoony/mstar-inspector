/**
 * SupportNotice — the grant read and its two failure shapes.
 *
 * Rendered in a real DOM (happy-dom) because the whole contract lives in an
 * effect: one read per workspace, reused across navigations, and an inline
 * error with retry when the read fails instead of a silent "no grants".
 *
 * Every test uses its own workspace ref: the fetch-once cache is module-level
 * and keyed by the workspace base, so distinct refs keep the tests independent
 * without a test-only reset hook.
 */
import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import type { Window } from "happy-dom";
import { createRoot } from "react-dom/client";
import { SupportNotice } from "../../src/spa/components/SupportNotice";
import { installDom } from "./dom";

const GRANT = {
  operator_login: "octocat",
  reason: "incident 42",
  expires_at: "2026-11-01 00:00:00",
};

const realFetch = globalThis.fetch;

const grantsBody = () =>
  new Response(JSON.stringify({ grants: [GRANT] }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

/** Mounts the notice and returns the render + unmount drivers. */
async function mountNotice(win: Window) {
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  // happy-dom's element is structurally the DOM Element React DOM accepts.
  const host = container as unknown as Element;
  const root = createRoot(host);
  const boot = { locale: "en" as const, login: "member", name: null };
  return {
    container,
    render: (pathname: string) =>
      act(async () => root.render(createElement(SupportNotice, { boot, pathname }))),
    unmount: () => act(async () => root.unmount()),
  };
}

describe("SupportNotice", () => {
  test("renders the live grant after one read", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return grantsBody();
    }) as unknown as typeof fetch;
    const { win, cleanup } = installDom("http://localhost/dashboard");
    try {
      const notice = await mountNotice(win);
      await notice.render("/dashboard/alpha/apps");

      expect(calls).toEqual(["/dashboard/alpha/api/support/grants"]);
      expect(notice.container.textContent).toContain("Support access is active");
      expect(notice.container.textContent).toContain("octocat");
      expect(notice.container.textContent).toContain("incident 42");
      // The notice itself carries no control: no dismiss, no end, no edit.
      expect(notice.container.querySelector("button")).toBeNull();
      await notice.unmount();
    } finally {
      globalThis.fetch = realFetch;
      cleanup();
    }
  });

  test("a failed read renders the error with retry, which reads again", async () => {
    let offline = true;
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      if (offline) throw new Error("offline");
      return grantsBody();
    }) as unknown as typeof fetch;
    const { win, cleanup } = installDom("http://localhost/dashboard");
    try {
      const notice = await mountNotice(win);
      await notice.render("/dashboard/beta/apps");

      // Not silently "no grants": the failure is stated and retryable.
      expect(notice.container.querySelector('[data-slot="error-state"]')).not.toBeNull();
      expect(notice.container.textContent).toContain("Could not check for active support access.");
      const retry = notice.container.querySelector("button");
      if (!(retry instanceof win.HTMLElement)) throw new Error("retry button is missing");
      expect(retry.textContent).toBe("Retry");
      expect(calls.length).toBe(1);

      offline = false;
      await act(async () => {
        retry.click();
      });

      expect(calls.length).toBe(2);
      expect(notice.container.querySelector('[data-slot="error-state"]')).toBeNull();
      expect(notice.container.textContent).toContain("octocat");
      await notice.unmount();
    } finally {
      globalThis.fetch = realFetch;
      cleanup();
    }
  });

  test("navigating within the workspace does not read again", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return grantsBody();
    }) as unknown as typeof fetch;
    const { win, cleanup } = installDom("http://localhost/dashboard");
    try {
      const notice = await mountNotice(win);
      await notice.render("/dashboard/gamma/apps");
      expect(calls.length).toBe(1);

      await notice.render("/dashboard/gamma/members");
      expect(calls.length).toBe(1);
      expect(notice.container.textContent).toContain("octocat");
      await notice.unmount();
    } finally {
      globalThis.fetch = realFetch;
      cleanup();
    }
  });
});
