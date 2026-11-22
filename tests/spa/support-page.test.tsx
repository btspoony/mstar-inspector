import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { SupportPage } from "../../src/spa/pages/SupportPage";
import { installDom } from "./dom";

const source = readFileSync(join(import.meta.dir, "../../src/spa/pages/SupportPage.tsx"), "utf8");
const realFetch = globalThis.fetch;

const VIEW = {
  workspace: { id: "ws_1", name: "Acme", slug: "acme", created_at: "2026-01-01 00:00:00" },
  members: [
    { github_login: "octocat", role: "admin" },
    { github_login: "hubot", role: "member" },
  ],
  grants: [{ operator_login: "operator", reason: "incident 42", expires_at: "2026-11-01 00:00:00" }],
};

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
      const container = win.document.createElement("div");
      win.document.body.appendChild(container);
      const root = createRoot(container as unknown as Element);

      await act(async () =>
        root.render(
          createElement(SupportPage, { boot: { locale: "en", login: "operator", name: null } }),
        ),
      );

      expect(calls).toEqual(["/dashboard/acme/api/support/workspace"]);
      expect(container.textContent).toContain("Acme");
      expect(container.textContent).toContain("ws_1");
      expect(container.textContent).toContain("incident 42");
      expect(container.textContent).toContain("octocat");
      expect(container.textContent).toContain("hubot");
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
  test("composes the shared header, flow and table primitives", () => {
    expect(source).toContain("<PageHeader");
    expect(source).toContain("<FlowSection");
    expect(source).toContain("<DataTable");
    expect(source).not.toContain("text-(length:--typo-heading-24-size)");
    expect(source).not.toContain("text-(length:--typo-heading-16-size)");
    expect(source).not.toContain("bg-(--background-200)");
    expect(source).not.toContain("<Table");
  });

  test("zero raw hex and zero inline styles", () => {
    expect(source).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    expect(source).not.toContain("style={{");
  });
});
