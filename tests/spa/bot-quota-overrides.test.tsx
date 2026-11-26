import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { t } from "../../src/i18n";
import { BotQuotaOverridesEditor } from "../../src/spa/pages/BotDetailPage";
import { installDom } from "./dom";

const realFetch = globalThis.fetch;

type Sent = { method: string; body: unknown };

async function mount(initial: Array<{ workspaceId: string; monthlyRp: number }>) {
  const { win, cleanup } = installDom("http://localhost/dashboard/ws/bots/bot-1");
  const sent: Sent[] = [];
  let reply = initial;
  globalThis.fetch = (async (_input: RequestInfo | URL, init?: RequestInit) => {
    sent.push({ method: init?.method ?? "GET", body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined });
    return new Response(JSON.stringify({ overrides: reply }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;

  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => {
    root.render(createElement(BotQuotaOverridesEditor, { locale: "en" as const, botId: "bot-1", initial }));
  });
  await act(async () => {});

  const input = (label: string) =>
    container.querySelector(`input[aria-label="${label}"]`) as HTMLInputElement | null;
  const setValue = (node: HTMLInputElement | null, value: string) => {
    const setter = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
    setter?.call(node, value);
    node?.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
  };
  const button = (label: string) =>
    [...(container.querySelectorAll("button") as unknown as HTMLButtonElement[])].find(
      (candidate) => candidate.textContent === label || candidate.getAttribute("aria-label") === label,
    );
  return {
    sent,
    input,
    setValue,
    button,
    text: () => container.textContent ?? "",
    setReply: (next: Array<{ workspaceId: string; monthlyRp: number }>) => {
      reply = next;
    },
    async click(node: HTMLButtonElement | null) {
      await act(async () => node?.click());
      await act(async () => {});
    },
    async type(label: string, value: string) {
      await act(async () => setValue(input(label), value));
    },
    async close() {
      await act(async () => root.unmount());
      globalThis.fetch = realFetch;
      cleanup();
    },
  };
}

describe("the per-workspace ceiling editor", () => {
  test("lists existing overrides and clears one", async () => {
    const surface = await mount([{ workspaceId: "ws-a", monthlyRp: 500 }]);
    expect(surface.text()).toContain("ws-a");
    expect(surface.text()).toContain(t("en", "bots.overrideValue", { rp: 500 }));

    surface.setReply([]);
    await surface.click(surface.button(t("en", "bots.overrideClear", { workspace: "ws-a" }))!);
    expect(surface.sent.at(-1)).toEqual({ method: "PATCH", body: { workspaceId: "ws-a", monthlyRp: null } });
    // Re-read from the response, not optimistic state.
    expect(surface.text()).toContain(t("en", "bots.overridesEmpty"));
    await surface.close();
  });

  test("saves a new ceiling for a workspace", async () => {
    const surface = await mount([]);
    surface.setReply([{ workspaceId: "ws-b", monthlyRp: 900 }]);
    await surface.type(t("en", "bots.overrideWorkspace"), "ws -b".replace(" ", ""));
    await surface.type(t("en", "bots.overrideCeiling"), "900");
    await surface.click(surface.button(t("en", "bots.overrideSave"))!);
    expect(surface.sent.at(-1)).toEqual({ method: "PATCH", body: { workspaceId: "ws-b", monthlyRp: 900 } });
    expect(surface.text()).toContain("ws-b");
    await surface.close();
  });

  test("a blank ceiling clears, and a fractional one is refused before any request", async () => {
    const surface = await mount([{ workspaceId: "ws-c", monthlyRp: 100 }]);
    await surface.type(t("en", "bots.overrideWorkspace"), "ws-c");
    await surface.click(surface.button(t("en", "bots.overrideSave"))!);
    expect(surface.sent.at(-1)).toEqual({ method: "PATCH", body: { workspaceId: "ws-c", monthlyRp: null } });

    const before = surface.sent.length;
    await surface.type(t("en", "bots.overrideWorkspace"), "ws-d");
    await surface.type(t("en", "bots.overrideCeiling"), "1.5");
    await surface.click(surface.button(t("en", "bots.overrideSave"))!);
    expect(surface.sent.length).toBe(before);
    expect(surface.text()).toContain(t("en", "bots.overrideInvalid"));
    await surface.close();
  });
});
