/**
 * The workspace-name card.
 *
 * Mounted, because the contract lives across two surfaces: the card submits
 * `PUT /dashboard/<id>/api/settings/name` and the top-bar switcher — rendered by
 * the Layout provider above it — must show the new label without a reload. The
 * URL is the workspace's immutable id, so nothing rewrites the path.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { t } from "../../src/i18n";
import type { SpaBoot } from "../../src/spa/boot";
import { Layout } from "../../src/spa/Layout";
import { WorkspaceSettingsPage } from "../../src/spa/pages/WorkspaceSettingsPage";
import { withLocation } from "./browser-stub";
import { installDom } from "./dom";

const boot: SpaBoot = {
  locale: "en",
  login: "dana",
  name: "Dana",
  workspaceRef: "ws_acme",
  deploymentMode: "self-hosted",
  memberships: [{ id: "ws_acme", slug: "acme", name: "Acme", role: "owner", plan: "Free" }],
};

const PATH = "/dashboard/ws_acme/settings";

type Call = { url: string; method: string; body: string };

describe("workspace name card", () => {
  test("submit renames the workspace and relabels the switcher without touching the path", async () => {
    const { win, cleanup } = installDom(`http://localhost${PATH}`);
    const calls: Call[] = [];
    const replaces: unknown[][] = [];
    const pushes: unknown[][] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const call: Call = {
        url: String(input),
        method: init?.method ?? "GET",
        body: String(init?.body ?? ""),
      };
      calls.push(call);
      if (call.method === "PUT") {
        return new Response(JSON.stringify({ name: "Acme Labs" }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      // The shell's support-grant read — no active grant here.
      return new Response(JSON.stringify({ grants: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    // No navigation may happen: the new name is a label, not a URL.
    (win.history as unknown as Record<string, unknown>).replaceState = (...args: unknown[]) => {
      replaces.push(args);
    };
    (win.history as unknown as Record<string, unknown>).pushState = (...args: unknown[]) => {
      pushes.push(args);
    };
    try {
      const container = win.document.createElement("div");
      win.document.body.appendChild(container);
      const root = createRoot(container as unknown as Element);
      await act(async () =>
        root.render(
          createElement(Layout, {
            boot,
            pathname: PATH,
            flash: null,
            children: createElement(WorkspaceSettingsPage, { boot }),
          }),
        ),
      );

      expect(container.querySelector('[data-slot="dropdown-menu-trigger"]')?.textContent).toContain("Acme");

      const input = win.document.querySelector("#workspace-name") as unknown as HTMLInputElement;
      expect(input.value).toBe("Acme");
      const setValue = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
      await act(async () => {
        setValue?.call(input, "Acme Labs");
        input.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
      });

      // The card's own form — the shell's locale toggle is a form too.
      const form = input.closest("form");
      await act(async () => {
        form?.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
      });

      expect(calls.filter((call) => call.method === "PUT")).toEqual([
        { url: "/dashboard/ws_acme/api/settings/name", method: "PUT", body: JSON.stringify({ name: "Acme Labs" }) },
      ]);
      // The live membership list was patched, so the top-bar label followed.
      expect(container.querySelector('[data-slot="dropdown-menu-trigger"]')?.textContent).toContain("Acme Labs");
      expect(container.textContent).toContain(t("en", "workspace.nameSaved"));
      // The URL is the id: no history entry, no path rewrite.
      expect(win.location.pathname).toBe(PATH);
      expect(replaces).toEqual([]);
      expect(pushes).toEqual([]);

      await act(async () => root.unmount());
    } finally {
      globalThis.fetch = realFetch;
      cleanup();
    }
  });

  test("a 409 refusal leaves the switcher at the stored name and writes no history entry", async () => {
    const { win, cleanup } = installDom(`http://localhost${PATH}`);
    const replaces: unknown[][] = [];
    const pushes: unknown[][] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "PUT") {
        return new Response(JSON.stringify({ message: "name taken" }), {
          status: 409,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ grants: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    (win.history as unknown as Record<string, unknown>).replaceState = (...args: unknown[]) => {
      replaces.push(args);
    };
    (win.history as unknown as Record<string, unknown>).pushState = (...args: unknown[]) => {
      pushes.push(args);
    };
    try {
      const container = win.document.createElement("div");
      win.document.body.appendChild(container);
      const root = createRoot(container as unknown as Element);
      await act(async () =>
        root.render(
          createElement(Layout, {
            boot,
            pathname: PATH,
            flash: null,
            children: createElement(WorkspaceSettingsPage, { boot }),
          }),
        ),
      );

      const input = win.document.querySelector("#workspace-name") as unknown as HTMLInputElement;
      const setValue = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
      await act(async () => {
        setValue?.call(input, "Taken Name");
        input.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
      });
      const form = input.closest("form");
      await act(async () => {
        form?.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
      });

      // Nothing landed: the switcher keeps the stored name and no history moves.
      expect(container.querySelector('[data-slot="dropdown-menu-trigger"]')?.textContent).toContain("Acme");
      expect(container.textContent).not.toContain("Taken Name");
      expect(container.textContent).toContain("name taken");
      expect(win.location.pathname).toBe(PATH);
      expect(replaces).toEqual([]);
      expect(pushes).toEqual([]);

      await act(async () => root.unmount());
    } finally {
      globalThis.fetch = realFetch;
      cleanup();
    }
  });

  test("zh-CN renders the card in Chinese", () => {
    const html = withLocation(PATH, () =>
      renderToStaticMarkup(
        createElement(WorkspaceSettingsPage, { boot: { ...boot, locale: "zh_CN" } }),
      ),
    );
    expect(html).toContain(t("zh_CN", "workspace.nameHeading"));
    expect(html).toContain(t("zh_CN", "workspace.nameSave"));
    expect(html).toContain("Acme");
  });

  test("the concurrency card reads the stored cap and submits it", async () => {
    const { win, cleanup } = installDom(`http://localhost${PATH}`);
    const calls: { method: string; url: string; body: string }[] = [];
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      const url = String(input);
      calls.push({ method, url, body: String(init?.body ?? "") });
      if (method === "PUT") {
        return new Response(JSON.stringify({ concurrency: 4 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      if (url.endsWith("/api/settings/concurrency")) {
        return new Response(JSON.stringify({ concurrency: 8, system: 32, min: 1, max: 250 }), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        });
      }
      return new Response(JSON.stringify({ grants: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    try {
      const container = win.document.createElement("div");
      win.document.body.appendChild(container);
      const root = createRoot(container as unknown as Element);
      await act(async () =>
        root.render(
          createElement(Layout, {
            boot,
            pathname: PATH,
            flash: null,
            children: createElement(WorkspaceSettingsPage, { boot }),
          }),
        ),
      );
      // The read lands the stored value, not the documented default.
      const input = win.document.querySelector("#workspace-concurrency") as unknown as HTMLInputElement;
      expect(input.value).toBe("8");
      expect(container.textContent).toContain(t("en", "workspace.concurrencySystemCap", { system: 32 }));

      const setValue = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
      await act(async () => {
        setValue?.call(input, "4");
        input.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
      });
      await act(async () => {
        input
          .closest("form")
          ?.dispatchEvent(new win.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event);
      });

      expect(calls.filter((call) => call.method === "PUT")).toEqual([
        {
          method: "PUT",
          url: "/dashboard/ws_acme/api/settings/concurrency",
          body: JSON.stringify({ concurrency: 4 }),
        },
      ]);
      expect(container.textContent).toContain(t("en", "workspace.concurrencySaved"));

      await act(async () => root.unmount());
    } finally {
      globalThis.fetch = realFetch;
      cleanup();
    }
  });

  test("an admin gets the concurrency card but no name form; a plain member gets the refusal copy", () => {
    // The name is owner-only; the review concurrency is owner-or-admin — the
    // page mirrors the two routes rather than the stricter gate alone.
    const asAdmin = withLocation(PATH, () =>
      renderToStaticMarkup(
        createElement(WorkspaceSettingsPage, {
          boot: {
            ...boot,
            memberships: boot.memberships?.map((m) => ({ ...m, role: "admin" as const })),
          },
        }),
      ),
    );
    expect(asAdmin).toContain(t("en", "workspace.concurrencyHeading"));
    expect(asAdmin).not.toContain('id="workspace-name"');

    const asMember = withLocation(PATH, () =>
      renderToStaticMarkup(
        createElement(WorkspaceSettingsPage, {
          boot: {
            ...boot,
            memberships: boot.memberships?.map((m) => ({ ...m, role: "member" as const })),
          },
        }),
      ),
    );
    expect(asMember).toContain(t("en", "workspace.settingsOwnerOnly"));
    expect(asMember).not.toContain('id="workspace-name"');
    expect(asMember).not.toContain('id="workspace-concurrency"');
  });
});
