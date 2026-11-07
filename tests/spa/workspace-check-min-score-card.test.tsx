/**
 * The workspace default review-gate floor card.
 *
 * Mounted on its own (the card fetches its own payload), so the contract under
 * test is exactly the card's: `GET`/`PUT …/api/settings/check-min-score`, the
 * stored value is the server's answer, and a degraded read never presents the
 * platform fallback as a stored value.
 */
import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { t } from "../../src/i18n";
import { WorkspaceCheckMinScoreCard } from "../../src/spa/pages/SettingsPage";
import { installDom } from "./dom";

type Call = { url: string; method: string; body: string };

function stubFetch(handler: (call: Call) => Response): Call[] {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const call: Call = {
      url: String(input),
      method: init?.method ?? "GET",
      body: String(init?.body ?? ""),
    };
    calls.push(call);
    return handler(call);
  }) as unknown as typeof fetch;
  return calls;
}

const json = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

describe("workspace default review-gate floor card", () => {
  test("shows the stored floor and settles on the server's answer after a save", async () => {
    const { win, cleanup } = installDom("http://localhost/dashboard/ws_acme/settings");
    const realFetch = globalThis.fetch;
    // The PUT answers a normalized 40 for a typed 45, so the field can only
    // settle on 40 by reading the server's body — echoing the draft cannot.
    // A non-zero payload floor: a copy string carrying its own lower bound
    // cannot match the rendered sentence.
    const bounds = { min: 3, max: 100 };
    const calls = stubFetch((call) =>
      call.method === "PUT" ? json(200, { min_score: 40 }) : json(200, { min_score: 60, ...bounds, degraded: false }),
    );
    try {
      const container = win.document.createElement("div");
      win.document.body.appendChild(container);
      const root = createRoot(container as unknown as Element);
      await act(async () => root.render(createElement(WorkspaceCheckMinScoreCard, { locale: "en" })));

      const input = win.document.querySelector("#workspace-check-min-score") as unknown as HTMLInputElement;
      expect(input.value).toBe("60");
      expect(container.textContent).toContain(t("en", "workspace.checkMinScoreRange", bounds));

      const setValue = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
      await act(async () => {
        setValue?.call(input, "45");
        input.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
      });
      const form = input.closest("form");
      await act(async () => {
        form?.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
      });

      expect(calls.filter((call) => call.method === "PUT")).toEqual([
        { url: "/dashboard/ws_acme/api/settings/check-min-score", method: "PUT", body: JSON.stringify({ min_score: 45 }) },
      ]);
      expect(container.textContent).toContain(t("en", "workspace.checkMinScoreSaved"));
      // The server's stored answer, not the typed draft (45).
      expect((win.document.querySelector("#workspace-check-min-score") as unknown as HTMLInputElement).value).toBe("40");

      await act(async () => root.unmount());
    } finally {
      globalThis.fetch = realFetch;
      cleanup();
    }
  });

  test("a degraded read warns and never submits the fallback as a stored value", async () => {
    const { win, cleanup } = installDom("http://localhost/dashboard/ws_acme/settings");
    const realFetch = globalThis.fetch;
    const calls = stubFetch(() => json(200, { min_score: 60, min: 5, max: 100, degraded: true }));
    try {
      const container = win.document.createElement("div");
      win.document.body.appendChild(container);
      const root = createRoot(container as unknown as Element);
      await act(async () => root.render(createElement(WorkspaceCheckMinScoreCard, { locale: "en" })));

      const input = win.document.querySelector("#workspace-check-min-score") as unknown as HTMLInputElement;
      expect(input.value).toBe("");
      expect(container.textContent).toContain(t("en", "workspace.checkMinScoreUnreadable", { min: 5, max: 100 }));

      await act(async () => {
        input.closest("form")?.dispatchEvent(
          new win.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event,
        );
      });
      expect(calls.filter((call) => call.method === "PUT")).toEqual([]);

      await act(async () => root.unmount());
    } finally {
      globalThis.fetch = realFetch;
      cleanup();
    }
  });
});
