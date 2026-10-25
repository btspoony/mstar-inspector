/**
 * Support page — the platform operator's read-only face.
 *
 * Rendered in a real DOM (happy-dom) because the page's contract lives in its
 * effect: ONE read of the workspace's support view, and the rendered face
 * carries no control over that data. The page is deliberately control-free —
 * every App read, credential, settings write and role change 403s to a granted
 * operator, so a button here could only render something that cannot work. The
 * logout anchor is navigation, not a control on the support data, so the
 * absence pin covers the widget classes (button / form / field) rather than
 * every focusable element.
 *
 * The composition pins live where the faces now live (PageHeader owns the
 * page-title step, DataTable the table shell + header band, SectionCard the
 * card faces) and assert the page keeps no second spelling of them.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { Window } from "happy-dom";
import { SupportPage } from "../../src/spa/pages/SupportPage";

const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SupportPage.tsx"), "utf8");
const realFetch = globalThis.fetch;

/** The support view's exact AC2 field set (parseSupportView). */
const VIEW = {
  workspace: { id: "ws_1", name: "Acme", slug: "acme", created_at: "2026-01-01 00:00:00" },
  members: [
    { github_login: "octocat", role: "admin" },
    { github_login: "hubot", role: "member" },
  ],
  grants: [{ operator_login: "operator", reason: "incident 42", expires_at: "2026-11-01 00:00:00" }],
};

/** Installs the browser globals a mounted render needs (support-notice precedent). */
function installDom(url: string) {
  const win = new Window({ url });
  const scope = globalThis as unknown as Record<string, unknown>;
  const installed = {
    window: win,
    // The page derives its API base from `location.pathname`, so the location
    // must ride the stub — not just `window`.
    location: win.location,
    document: win.document,
    navigator: win.navigator,
    HTMLElement: win.HTMLElement,
    Element: win.Element,
    Node: win.Node,
    Event: win.Event,
    MutationObserver: win.MutationObserver,
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  Object.assign(scope, installed);
  return {
    win,
    cleanup: () => {
      for (const key of Object.keys(installed)) delete scope[key];
      win.close();
    },
  };
}

describe("support page", () => {
  test("issues exactly one read and renders the whole view with no control on it", async () => {
    const calls: string[] = [];
    globalThis.fetch = (async (input: string | URL | Request) => {
      calls.push(String(input));
      return new Response(JSON.stringify(VIEW), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as unknown as typeof fetch;
    const { win, cleanup } = installDom("http://localhost/dashboard/acme/apps");
    try {
      // Imported only once the browser globals exist: React DOM caches its
      // `canUseDOM` answer at evaluation time.
      const { createRoot } = await import("react-dom/client");
      const container = win.document.createElement("div");
      win.document.body.appendChild(container);
      const root = createRoot(container as unknown as Element);

      await act(async () =>
        root.render(
          createElement(SupportPage, { boot: { locale: "en", login: "operator", name: null } }),
        ),
      );

      // One read, under the addressed workspace's own base.
      expect(calls).toEqual(["/dashboard/acme/api/support/workspace"]);
      // The identity card, the grants card and the member table all render.
      expect(container.textContent).toContain("Acme");
      expect(container.textContent).toContain("ws_1");
      expect(container.textContent).toContain("incident 42");
      expect(container.textContent).toContain("octocat");
      expect(container.textContent).toContain("hubot");
      // Read-only by contract: no button, no form, no field.
      expect(container.innerHTML).not.toMatch(/<(button|form|input|select|textarea)[\s>]/);
      expect(container.querySelector('[data-slot="error-state"]')).toBeNull();

      await act(async () => root.unmount());
    } finally {
      globalThis.fetch = realFetch;
      cleanup();
    }
  });

  test("the failure face is an error with retry, not an empty view", async () => {
    globalThis.fetch = (async () => new Response("boom", { status: 500 })) as unknown as typeof fetch;
    const { win, cleanup } = installDom("http://localhost/dashboard/acme/apps");
    try {
      const { createRoot } = await import("react-dom/client");
      const container = win.document.createElement("div");
      win.document.body.appendChild(container);
      const root = createRoot(container as unknown as Element);

      await act(async () =>
        root.render(
          createElement(SupportPage, { boot: { locale: "en", login: "operator", name: null } }),
        ),
      );

      expect(container.querySelector('[data-slot="error-state"]')).not.toBeNull();

      await act(async () => root.unmount());
    } finally {
      globalThis.fetch = realFetch;
      cleanup();
    }
  });
});

describe("support page composition", () => {
  test("composes the shared header, card and table primitives", () => {
    expect(source).toContain("<PageHeader");
    expect(source).toContain("<SectionCard");
    expect(source).toContain("<SectionCardTitle");
    expect(source).toContain("<DataTable");
    // The faces moved into the primitives: no second spelling survives here.
    expect(source).not.toContain("text-(length:--typo-heading-24-size)");
    expect(source).not.toContain("text-(length:--typo-heading-16-size)");
    expect(source).not.toContain("bg-(--background-200)");
    expect(source).not.toContain('from "@/components/ui/table"');
  });

  test("zero raw hex and zero inline styles", () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toContain("style={{");
  });
});
