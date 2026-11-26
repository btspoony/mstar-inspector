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
          botId: "bot-1001",
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
  const setOpen = async (next: boolean) => {
    open = next;
    await render();
    await act(async () => {});
  };
  return { win, container, outcomes, reloads, byText, click, setOpen, cleanup: async () => {
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
  test("closing and reopening discards the preview and requires a fresh successful fetch", async () => {
    let fetches = 0;
    const view = await mount(async () => {
      fetches++;
      return fetches === 2
        ? new Response("Provider unavailable", { status: 503 })
        : previewBody({ current: 50, fetched: 104, kept: 44, added: 60, dropped: 6 });
    });
    try {
      await view.click(view.byText(t("en", "settings.providers.sync.action")));
      expect(view.byText(t("en", "settings.providers.sync.confirm"))?.disabled).toBe(false);
      await view.click(view.byText(t("en", "common.cancel")));
      await view.setOpen(true);
      expect(view.container.ownerDocument.body.textContent).toContain(t("en", "settings.providers.sync.notFetched"));
      expect(view.container.ownerDocument.body.textContent).not.toContain(
        t("en", "settings.providers.sync.summary", { fetched: 104, kept: 44, added: 60, dropped: 6 }),
      );
      expect(view.byText(t("en", "settings.providers.sync.confirm"))?.disabled).toBe(true);
      await view.click(view.byText(t("en", "settings.providers.sync.action")));
      expect(view.byText(t("en", "settings.providers.sync.confirm"))?.disabled).toBe(true);
      expect(view.container.ownerDocument.body.textContent).toContain("Provider unavailable");
      await view.setOpen(false);
      await view.setOpen(true);
      expect(view.container.ownerDocument.body.textContent).not.toContain("Provider unavailable");
      await view.click(view.byText(t("en", "settings.providers.sync.action")));
      expect(view.byText(t("en", "settings.providers.sync.confirm"))?.disabled).toBe(false);
      expect(fetches).toBe(3);
      expect(view.outcomes).toEqual([]);
    } finally {
      await view.cleanup();
    }
  });

  test("a preview that finishes after closing cannot enable confirmation after reopening", async () => {
    let resolve!: (response: Response) => void;
    const pending = new Promise<Response>((done) => { resolve = done; });
    const view = await mount(async () => pending);
    try {
      await view.click(view.byText(t("en", "settings.providers.sync.action")));
      await view.click(view.byText("Close"));
      expect(view.container.ownerDocument.querySelector('[role="dialog"]')).toBeNull();
      await view.setOpen(true);
      await act(async () => {
        resolve(previewBody({ current: 50, fetched: 104, kept: 44, added: 60, dropped: 6 }));
        await pending;
      });
      expect(view.container.ownerDocument.body.textContent).toContain(t("en", "settings.providers.sync.notFetched"));
      expect(view.byText(t("en", "settings.providers.sync.confirm"))?.disabled).toBe(true);
      expect(view.container.ownerDocument.body.textContent).not.toContain(
        t("en", "settings.providers.sync.summary", { fetched: 104, kept: 44, added: 60, dropped: 6 }),
      );
    } finally {
      resolve(previewBody({}));
      await view.cleanup();
    }
  });

  test.each(["refusal", "network failure"])("dismiss requests during a write preserve its %s notice", async (failure) => {
    let resolve!: (response: Response) => void;
    let reject!: (reason: Error) => void;
    const pending = new Promise<Response>((done, fail) => { resolve = done; reject = fail; });
    const view = await mount(async (url) => url.includes("/provider-models/preview")
      ? previewBody({ current: 50, fetched: 104, kept: 44, added: 60, dropped: 6 })
      : pending);
    try {
      await view.click(view.byText(t("en", "settings.providers.sync.action")));
      await view.click(view.byText(t("en", "settings.providers.sync.confirm")));
      expect(view.byText(t("en", "common.cancel"))?.disabled).toBe(true);
      await act(async () => {
        view.win.document.dispatchEvent(new view.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      expect(view.container.ownerDocument.querySelector('[role="dialog"]')).not.toBeNull();
      await view.click(view.byText("Close"));
      expect(view.container.ownerDocument.querySelector('[role="dialog"]')).not.toBeNull();
      await act(async () => {
        if (failure === "refusal") resolve(new Response("Sync refused", { status: 503 }));
        else reject(new Error("offline"));
      });
      expect(view.container.ownerDocument.body.textContent).toContain(
        failure === "refusal" ? "Sync refused" : t("en", "common.saveFailed"),
      );
      expect(view.outcomes).toEqual([]);
      expect(view.reloads).toEqual([]);
      expect(view.byText(t("en", "common.cancel"))?.disabled).toBe(false);
      await view.click(view.byText("Close"));
      expect(view.container.ownerDocument.querySelector('[role="dialog"]')).toBeNull();
    } finally {
      resolve(new Response("", { status: 500 }));
      await view.cleanup();
    }
  });

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
      expect(url).toContain("/api/review-bots/bot-1001/provider-models/preview?provider=commandcode");
      return previewBody({ current: 50, fetched: 104, kept: 44, added: 60, dropped: 6 });
    });
    try {
      await view.click(view.byText(t("en", "settings.providers.sync.action")));
      const document = view.container.ownerDocument;
      expect(document.body.textContent).toContain(
        t("en", "settings.providers.sync.summary", { fetched: 104, kept: 44, added: 60, dropped: 6 }),
      );
      expect(view.byText(t("en", "settings.providers.sync.confirm"))?.disabled).toBe(false);
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
