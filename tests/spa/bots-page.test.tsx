/**
 * Task 9 — the /bots list (prototype screen 5): TWO sections instead of a
 * filter, the create action in the owned section only and only for a manager,
 * a dialog that POSTs the create route, the muted archived row with its pill,
 * and Credits at the payload's own rate.
 */
import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../../src/i18n";
import { BotsView, CreateBotDialog, type BotsReadState } from "../../src/spa/pages/BotsPage";
import { formatCredits, type UsableBotsPayload } from "../../src/spa/pages/data";
import { withLocation } from "./browser-stub";
import { installDom } from "./dom";

const OWNED = {
  id: "bot-owned",
  name: "Studio Reviewer",
  description: "Default code review bot",
  workspace_id: "acme",
  workspace_name: "Acme",
  owned: true,
  can_manage: true,
  scope: "owned" as const,
  multiplier: 1,
  month_used_rp: 1240,
  archived: false,
};

const SHARED = {
  id: "bot-shared",
  name: "Docs Scanner",
  description: null,
  workspace_id: "ws-platform",
  workspace_name: "Platform",
  owned: false,
  can_manage: false,
  scope: "shared" as const,
  multiplier: 4,
  month_used_rp: 90,
  archived: false,
};

const payload = (bots: UsableBotsPayload["bots"] = [OWNED, SHARED]): UsableBotsPayload => ({
  workspace_id: "acme",
  plan_monthly_rp: null,
  rp_per_credit: 1000,
  bots,
});

const render = (bots: UsableBotsPayload, canCreate = true): string =>
  withLocation("/dashboard/acme/bots", () =>
    renderToStaticMarkup(
      createElement(BotsView, {
        locale: "en",
        base: "/dashboard/acme",
        state: { kind: "ok", payload: bots } as BotsReadState,
        canCreate,
        onCreated: () => {},
      }),
    ),
  );

describe("two sections, not a filter", () => {
  test("owned and shared rows land in their own sections", () => {
    const html = render(payload());
    const ownedAt = html.indexOf(t("en", "bots.list.ownedSection"));
    const sharedAt = html.indexOf(t("en", "bots.list.sharedSection"));
    expect(ownedAt).toBeGreaterThanOrEqual(0);
    expect(sharedAt).toBeGreaterThan(ownedAt);
    const ownedRow = html.indexOf(OWNED.name);
    const sharedRow = html.indexOf(SHARED.name);
    expect(ownedRow).toBeGreaterThan(ownedAt);
    expect(ownedRow).toBeLessThan(sharedAt);
    expect(sharedRow).toBeGreaterThan(sharedAt);
    // No filter control: the split IS the two sections.
    expect(html).not.toContain('data-slot="bots-filter"');
  });

  test("the description rides the row and the name links to the detail page", () => {
    const html = render(payload());
    expect(html).toContain(OWNED.description);
    expect(html).toContain('href="/dashboard/acme/bots/bot-owned"');
  });

  test("the create action exists only for a manager, only in the owned section", () => {
    const manager = render(payload(), true);
    const member = render(payload(), false);
    expect(manager).toContain(t("en", "bots.create.open"));
    expect(member).not.toContain(t("en", "bots.create.open"));
    const ownedAt = manager.indexOf(t("en", "bots.list.ownedSection"));
    const createAt = manager.indexOf(t("en", "bots.create.open"));
    const sharedAt = manager.indexOf(t("en", "bots.list.sharedSection"));
    expect(createAt).toBeGreaterThan(ownedAt);
    expect(createAt).toBeLessThan(sharedAt);
  });
});

describe("row facts", () => {
  test("sharing state pill, multiplier and Credits at the payload rate", () => {
    const html = render(payload());
    expect(html).toContain(t("en", "bots.stateOwn"));
    expect(html).toContain(t("en", "bots.stateShared"));
    expect(html).toContain("×4");
    expect(html).toContain(formatCredits(SHARED.month_used_rp, 1000));
    // The unit is Credits, never RP.
    expect(html).not.toMatch(/\bRP\b/);
  });

  test("an archived row stays listed, muted, with 已归档 — and still links", () => {
    const archived = { ...SHARED, id: "bot-archived", name: "Security Scanner", archived: true };
    const html = render(payload([OWNED, archived]));
    expect(html).toContain("Security Scanner");
    expect(html).toContain(t("en", "bots.list.archived"));
    expect(html).toContain('href="/dashboard/acme/bots/bot-archived"');
    // The archived state replaces the sharing pill on that row only.
    const archivedRow = html.split("<tr ").find((part) => part.includes("Security Scanner")) ?? "";
    expect(archivedRow).toContain(t("en", "bots.list.archived"));
    expect(archivedRow).not.toContain(t("en", "bots.stateShared"));
  });

  test("an owned bot published as shared reads 共享, not 未共享", () => {
    const published = { ...OWNED, scope: "shared" as const };
    const html = render(payload([published, SHARED]));
    const row = html.split("<tr ").find((part) => part.includes(OWNED.name)) ?? "";
    expect(row).toContain(t("en", "bots.stateShared"));
    expect(row).not.toContain(t("en", "bots.stateOwn"));
    // Ownership still decides the section, not the pill.
    const ownedAt = html.indexOf(t("en", "bots.list.ownedSection"));
    const sharedAt = html.indexOf(t("en", "bots.list.sharedSection"));
    expect(html.indexOf(OWNED.name)).toBeGreaterThan(ownedAt);
    expect(html.indexOf(OWNED.name)).toBeLessThan(sharedAt);
  });

  test("an empty read offers each section its own empty face", () => {
    const html = render(payload([]));
    expect(html).toContain(t("en", "apps.bots.emptyMineTitle"));
    expect(html).toContain(t("en", "apps.bots.emptySharedTitle"));
  });
});

describe("the create dialog posts the create route", () => {
  test("a named bot POSTs to /api/review-bots and reloads", async () => {
    const { win, cleanup } = installDom("http://localhost/dashboard/acme/bots");
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const sent: Array<{ path: string; body: unknown }> = [];
    const originalFetch = globalThis.fetch;
    let reloads = 0;
    globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
      sent.push({
        path: new URL(String(input), "http://localhost").pathname,
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return Response.json({ id: "bot-new" }, { status: 201 });
    }) as unknown as typeof fetch;
    try {
      await act(async () => {
        root.render(
          createElement(CreateBotDialog, {
            locale: "en",
            base: "/dashboard/acme",
            onCreated: () => {
              reloads += 1;
            },
          }),
        );
      });
      const trigger = [...win.document.querySelectorAll("button")].find(
        (node) => node.textContent === t("en", "bots.create.open"),
      );
      await act(async () => {
        trigger?.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      });
      const name = win.document.querySelector("#create-bot-name") as HTMLInputElement | null;
      const description = win.document.querySelector("#create-bot-description") as HTMLInputElement | null;
      expect(name).not.toBeNull();
      expect(description).not.toBeNull();
      const setValue = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
      await act(async () => {
        setValue?.call(name, "  Nightly Bot  ");
        name!.dispatchEvent(
          new win.Event("input", { bubbles: true }) as unknown as Parameters<HTMLInputElement["dispatchEvent"]>[0],
        );
        setValue?.call(description, "Runs at night");
        description!.dispatchEvent(
          new win.Event("input", { bubbles: true }) as unknown as Parameters<HTMLInputElement["dispatchEvent"]>[0],
        );
      });
      await act(async () => {
        win.document
          .querySelector('[role="dialog"] form')
          ?.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
      });
      expect(sent).toHaveLength(1);
      expect(sent[0]!.path).toBe("/dashboard/acme/api/review-bots");
      expect(sent[0]!.body).toEqual({ name: "Nightly Bot", description: "Runs at night" });
      expect(reloads).toBe(1);
    } finally {
      globalThis.fetch = originalFetch;
      await act(async () => root.unmount());
      cleanup();
    }
  });

  test("an empty name is refused in place, with no request", async () => {
    const { win, cleanup } = installDom("http://localhost/dashboard/acme/bots");
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const originalFetch = globalThis.fetch;
    let calls = 0;
    globalThis.fetch = (async () => {
      calls += 1;
      return Response.json({ id: "never" }, { status: 201 });
    }) as unknown as typeof fetch;
    try {
      await act(async () => {
        root.render(createElement(CreateBotDialog, { locale: "en", base: "/dashboard/acme", onCreated: () => {} }));
      });
      await act(async () => {
        [...win.document.querySelectorAll("button")]
          .find((node) => node.textContent === t("en", "bots.create.open"))
          ?.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      });
      await act(async () => {
        win.document
          .querySelector('[role="dialog"] form')
          ?.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }));
      });
      expect(calls).toBe(0);
      expect(win.document.querySelector('[role="dialog"]')?.textContent).toContain(
        t("en", "bots.create.nameRequired"),
      );
    } finally {
      globalThis.fetch = originalFetch;
      await act(async () => root.unmount());
      cleanup();
    }
  });
});
