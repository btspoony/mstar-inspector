import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { t } from "../../src/i18n";
import { AppChainSection } from "../../src/spa/pages/AppDetailPage";
import type { AppChainEntry } from "../../src/spa/pages/data";
import { installDom } from "./dom";

const realFetch = globalThis.fetch;

const CHAIN: AppChainEntry[] = [
  {
    position: 1,
    bot_id: "bot-a",
    name: "Alpha",
    description: null,
    provider_workspace: "provider",
    owned: false,
    available: true,
    multiplier: 1.5,
    month_used_rp: 0,
    monthly_rp: null,
    effective_monthly_rp: null,
    archived: false,
    default_chain: null,
    runtime: "omp",
  },
  {
    position: 2,
    bot_id: "bot-b",
    name: "Beta",
    description: null,
    provider_workspace: "default",
    owned: true,
    available: true,
    multiplier: 1,
    month_used_rp: 0,
    monthly_rp: null,
    effective_monthly_rp: null,
    archived: false,
    default_chain: null,
    runtime: "omp",
  },
];

type Sent = { url: string; method: string; body: unknown };

async function mount(input: { canManage: boolean; chain?: AppChainEntry[]; mountableBots?: Array<{ id: string; name: string }> }) {
  const { win, cleanup } = installDom("http://localhost/dashboard/ws/apps/app-1");
  const sent: Sent[] = [];
  globalThis.fetch = (async (target: RequestInfo | URL, init?: RequestInit) => {
    sent.push({
      url: String(target),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    });
    return new Response(JSON.stringify({ chain: [] }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as typeof fetch;

  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  let reloads = 0;
  await act(async () => {
    root.render(
      createElement(AppChainSection, {
        locale: "en" as const,
        appId: "app-1",
        chain: input.chain ?? CHAIN,
        mountableBots: input.mountableBots ?? [],
        canManage: input.canManage,
        onReordered: async () => {
          reloads += 1;
        },
      }),
    );
  });
  await act(async () => {});

  const buttons = () => [...(container.querySelectorAll("button") as unknown as HTMLButtonElement[])];
  const labelled = (label: string) => buttons().filter((button) => button.getAttribute("aria-label") === label);
  const click = async (button: { click: () => void }) => {
    await act(async () => {
      button.click();
    });
    await act(async () => {});
  };

  return {
    sent,
    labelled,
    click,
    reloads: () => reloads,
    text: () => container.textContent ?? "",
    async close() {
      await act(async () => root.unmount());
      globalThis.fetch = realFetch;
      cleanup();
    },
  };
}

describe("the bot chain editor", () => {
  test("a manager sees the reorder controls; a reader sees none", async () => {
    const manager = await mount({ canManage: true });
    expect(manager.labelled(t("en", "apps.chain.moveUp", { bot: "Alpha" }))).toHaveLength(1);
    await manager.close();

    const reader = await mount({ canManage: false });
    expect(reader.labelled(t("en", "apps.chain.moveUp", { bot: "Alpha" }))).toHaveLength(0);
    await reader.close();
  });

  test("moving a bot down PATCHes the WHOLE order and re-reads the chain", async () => {
    const surface = await mount({ canManage: true });
    await surface.click(surface.labelled(t("en", "apps.chain.moveDown", { bot: "Alpha" }))[0]!);

    const patch = surface.sent.find((request) => request.method === "PATCH");
    expect(patch?.url).toContain("/api/apps/app-1/chain");
    // The whole order, not a single position: the store rewrites every position.
    expect(patch?.body).toEqual({ botIds: ["bot-b", "bot-a"] });
    // Re-read the chain, not the page.
    expect(surface.reloads()).toBe(1);
    await surface.close();
  });

  test("the first row cannot move up and the last cannot move down", async () => {
    const surface = await mount({ canManage: true });
    expect(surface.labelled(t("en", "apps.chain.moveUp", { bot: "Alpha" }))[0]!.hasAttribute("disabled")).toBe(true);
    expect(surface.labelled(t("en", "apps.chain.moveDown", { bot: "Beta" }))[0]!.hasAttribute("disabled")).toBe(true);
    await surface.close();
  });

  test("a single-row chain disables both directions", async () => {
    const surface = await mount({ canManage: true, chain: [CHAIN[0]!] });
    expect(surface.labelled(t("en", "apps.chain.moveUp", { bot: "Alpha" }))[0]!.hasAttribute("disabled")).toBe(true);
    expect(surface.labelled(t("en", "apps.chain.moveDown", { bot: "Alpha" }))[0]!.hasAttribute("disabled")).toBe(true);
    await surface.close();
  });

  test("adding a bot appends it to the full order and re-reads the chain", async () => {
    const surface = await mount({
      canManage: true,
      mountableBots: [
        { id: "bot-c", name: "Gamma" },
        { id: "bot-a", name: "Alpha" }, // already mounted: filtered out by the view
      ],
    });
    // The view subtracts what the chain already carries, so only Gamma is offered.
    const offered = surface.labelled(t("en", "apps.chain.addNamed", { bot: "Gamma" }));
    expect(offered).toHaveLength(1);
    expect(surface.labelled(t("en", "apps.chain.addNamed", { bot: "Alpha" }))).toHaveLength(0);

    await surface.click(offered[0]!);
    const patch = surface.sent.find((request) => request.method === "PATCH");
    expect(patch?.body).toEqual({ botIds: ["bot-a", "bot-b", "bot-c"] });
    expect(surface.reloads()).toBe(1);
    await surface.close();
  });

  test("removing a bot rewrites the order without it; the LAST row cannot be removed", async () => {
    const surface = await mount({ canManage: true });
    await surface.click(surface.labelled(t("en", "apps.chain.removeBot", { bot: "Alpha" }))[0]!);
    const patch = surface.sent.find((request) => request.method === "PATCH");
    expect(patch?.body).toEqual({ botIds: ["bot-b"] });
    await surface.close();

    // D27: one row left — its remove control is present but disabled.
    const single = await mount({ canManage: true, chain: [CHAIN[0]!] });
    const remove = single.labelled(t("en", "apps.chain.removeBot", { bot: "Alpha" }))[0]!;
    expect(remove.hasAttribute("disabled")).toBe(true);
    await single.close();
  });

  test("an EMPTY chain still offers the add affordance to a manager", async () => {
    const surface = await mount({
      canManage: true,
      chain: [],
      mountableBots: [{ id: "bot-c", name: "Gamma" }],
    });
    expect(surface.text()).toContain(t("en", "apps.chain.empty"));
    await surface.click(surface.labelled(t("en", "apps.chain.addNamed", { bot: "Gamma" }))[0]!);
    const patch = surface.sent.find((request) => request.method === "PATCH");
    // The FIRST bot: an empty list becomes one id.
    expect(patch?.body).toEqual({ botIds: ["bot-c"] });
    await surface.close();
  });

  test("an empty chain offers nothing to a reader", async () => {
    const surface = await mount({ canManage: false, chain: [], mountableBots: [{ id: "bot-c", name: "Gamma" }] });
    expect(surface.labelled(t("en", "apps.chain.addNamed", { bot: "Gamma" }))).toHaveLength(0);
    await surface.close();
  });

  test("a refused reorder says so and re-reads nothing", async () => {
    const { win, cleanup } = installDom("http://localhost/dashboard/ws/apps/app-1");
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "unknown app" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    let reloads = 0;
    await act(async () => {
      root.render(
        createElement(AppChainSection, {
          locale: "en" as const,
          appId: "app-1",
          chain: CHAIN,
          canManage: true,
          mountableBots: [],
          onReordered: async () => {
            reloads += 1;
          },
        }),
      );
    });
    await act(async () => {});
    const button = [...(container.querySelectorAll("button") as unknown as HTMLButtonElement[])].find(
      (candidate) => candidate.getAttribute("aria-label") === t("en", "apps.chain.moveDown", { bot: "Alpha" }),
    );
    await act(async () => button?.click());
    await act(async () => {});

    expect(container.textContent).toContain(t("en", "apps.chain.reorderFailed"));
    expect(reloads).toBe(0);
    await act(async () => root.unmount());
    globalThis.fetch = realFetch;
    cleanup();
  });
});
