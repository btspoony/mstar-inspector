/**
 * I-000644: the sync dialog is the operator's way to replace a stale catalog
 * vocabulary with the list the provider actually serves. Three faces must stay
 * distinguishable — "not fetched", "the provider refuses / answered nothing",
 * and "fetched N, here is what the replace costs you" — and the confirm button is
 * unavailable until a count has been fetched, so a blind write is impossible.
 *
 * Mounted: the dialog is a Radix portal whose primary button only exists after a
 * preview lands.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { t } from "../../src/i18n";
import { ProviderSyncDialog } from "../../src/spa/pages/provider-sync-dialog";
import type { OpNotice } from "../../src/spa/pages/PageNotice";
import { installDom } from "./dom";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

async function mount(handler: (url: string, init?: RequestInit) => Promise<Response>) {
  const { win, cleanup } = installDom("http://localhost/dashboard/acme/apps");
  let open = true;
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  const outcomes: OpNotice[] = [];
  const reloads: number[] = [];
  globalThis.fetch = (async (input: string, init?: RequestInit) => handler(String(input), init)) as unknown as typeof fetch;
  const render = async () =>
    act(async () => {
      root.render(
        createElement(ProviderSyncDialog, {
          locale: "en" as const,
          open,
          onOpenChange: (next: boolean) => {
            open = next;
            void render();
          },
          appId: 1001,
          provider: "commandcode",
          label: "Command Code",
          onOutcome: (notice: OpNotice) => outcomes.push(notice),
          onReload: async () => {
            reloads.push(1);
          },
        }),
      );
    });
  await render();
  await act(async () => {});
  const buttons = () => [...container.ownerDocument.querySelectorAll("button")] as unknown as HTMLButtonElement[];
  const byText = (text: string) => buttons().find((button) => button.textContent === text);
  const click = async (button: HTMLButtonElement | undefined) => {
    if (button === undefined) throw new Error("button is missing");
    await act(async () => {
      button.click();
    });
    await act(async () => {});
  };
  return { win, container, outcomes, reloads, byText, click, cleanup: async () => {
    await act(async () => root.unmount());
    cleanup();
  } };
}

const previewBody = (preview: Record<string, number>): Response =>
  new Response(JSON.stringify({ ok: true, provider: "commandcode", ...preview }), {
    status: 200,
    headers: { "Content-Type": "application/json" },
  });

describe("the provider model sync dialog (I-000644)", () => {
  test("it starts 'not fetched', with confirmation unavailable and no count claimed", async () => {
    const view = await mount(async () => previewBody({ current: 50, fetched: 104, kept: 44, added: 60, dropped: 6 }));
    try {
      const document = view.container.ownerDocument;
      expect(document.body.textContent).toContain(t("en", "settings.providers.sync.notFetched"));
      const confirm = view.byText(t("en", "settings.providers.sync.confirm"));
      expect(confirm?.disabled).toBe(true);
      expect(document.body.textContent).not.toContain("104");
    } finally {
      await view.cleanup();
    }
  });

  test("a fetched list states the replace arithmetic before anything is written", async () => {
    const view = await mount(async (url) => {
      expect(url).toContain("/api/apps/1001/provider-models/preview?provider=commandcode");
      return previewBody({ current: 50, fetched: 104, kept: 44, added: 60, dropped: 6 });
    });
    try {
      await view.click(view.byText(t("en", "settings.providers.sync.action")));
      const document = view.container.ownerDocument;
      expect(document.body.textContent).toContain(
        t("en", "settings.providers.sync.summary", { fetched: 104, kept: 44, added: 60, dropped: 6 }),
      );
      expect(view.byText(t("en", "settings.providers.sync.confirm"))?.disabled).toBe(false);
      // Still nothing written: the count came from a read.
      expect(view.outcomes).toEqual([]);
    } finally {
      await view.cleanup();
    }
  });

  test("a refusal shows its own message and never enables the destructive confirm", async () => {
    const view = await mount(
      async () =>
        new Response(
          JSON.stringify({ key: "settings.error.providerModelsKeyRequired", message: "x", params: { provider: "deepseek" } }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        ),
    );
    try {
      await view.click(view.byText(t("en", "settings.providers.sync.action")));
      const document = view.container.ownerDocument;
      expect(document.body.textContent).toContain(
        t("en", "settings.error.providerModelsKeyRequired", { provider: "deepseek" }),
      );
      expect(view.byText(t("en", "settings.providers.sync.confirm"))?.disabled).toBe(true);
    } finally {
      await view.cleanup();
    }
  });

  test("confirming posts the op, reloads the card and reports the count that was fetched", async () => {
    const posted: Array<Record<string, string>> = [];
    const view = await mount(async (url, init) => {
      if (!url.includes("/provider-models/preview")) {
        posted.push(Object.fromEntries(new URLSearchParams(String(init?.body))));
        return new Response("Synced 104 models for commandcode from its endpoint.", { status: 200 });
      }
      return previewBody({ current: 50, fetched: 104, kept: 44, added: 60, dropped: 6 });
    });
    try {
      await view.click(view.byText(t("en", "settings.providers.sync.action")));
      await view.click(view.byText(t("en", "settings.providers.sync.confirm")));
      expect(posted).toEqual([{ op: "sync-provider-models", provider: "commandcode" }]);
      expect(view.reloads).toHaveLength(1);
      expect(view.outcomes).toEqual([
        { kind: "success", message: t("en", "settings.providers.sync.saved", { provider: "commandcode", count: 104 }) },
      ]);
    } finally {
      await view.cleanup();
    }
  });
});
