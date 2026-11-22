/** note: I-000649: the 投递状态 tab painted its empty state under the in-flight line,
 * so an operator opening the tab was told the bot had received no matching
 * webhook while the first read was still in flight — and the pager claimed
 * `0–0 / 0`. A false negative, corrected here from the rendered behaviour of
 * the stateful tab with its read held open.
 *
 * The empty state is only truthful once a page resolves; the in-flight frame
 * carries the loading line alone.
 */
import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { t } from "../../src/i18n";
import { AppDeliveryTab } from "../../src/spa/pages/AppDeliveryTab";
import { installDom } from "./dom";

const EMPTY_PAGE = { deliveries: [], total: 0, repos: [], types: [] };

describe("I-000649: the delivery tab has a real loading face", () => {
  /** note: Mount the tab with its read held until `resolve` supplies the page. */
  async function mountHeldDelivery() {
    const { win, cleanup } = installDom("http://localhost/dashboard/apps/1");
    const realFetch = globalThis.fetch;
    const held = Promise.withResolvers<unknown>();
    globalThis.fetch = (async () => {
      const body = await held.promise;
      return new Response(JSON.stringify(body), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    await act(async () =>
      root.render(
        createElement(AppDeliveryTab, {
          locale: "en",
          appId: "1",
          summary: { last_webhook_at: null, rejected24h: 0 },
        }),
      ),
    );
    return {
      text: () => container.textContent ?? "",
      resolve: async (body: unknown) => {
        held.resolve(body);
        for (let flush = 0; flush < 4; flush += 1) await act(async () => {});
      },
      unmount: async () => {
        await act(async () => root.unmount());
        globalThis.fetch = realFetch;
        cleanup();
      },
    };
  }

  test("in flight: loading and no emptiness; after the read: the empty state", async () => {
    const tab = await mountHeldDelivery();
    try {
      // note: In flight: the loading line, and NOT the false negative.
      expect(tab.text()).toContain(t("en", "common.loading"));
      expect(tab.text()).not.toContain(t("en", "appDetail.delivery.emptyTitle"));
      expect(tab.text()).not.toContain(t("en", "appDetail.delivery.emptyDescription"));
      // note: The pager makes no claim about a window it has not read yet.
      expect(tab.text()).not.toContain(
        t("en", "appDetail.delivery.pageRange", { from: 0, to: 0, total: 0 }),
      );

      // invariant: The read resolves with zero rows: now — and only now — the empty state.
      await tab.resolve(EMPTY_PAGE);
      expect(tab.text()).not.toContain(t("en", "common.loading"));
      expect(tab.text()).toContain(t("en", "appDetail.delivery.emptyTitle"));
      expect(tab.text()).toContain(t("en", "appDetail.delivery.emptyDescription"));
      expect(tab.text()).toContain(
        t("en", "appDetail.delivery.pageRange", { from: 0, to: 0, total: 0 }),
      );
    } finally {
      await tab.unmount();
    }
  });
});
