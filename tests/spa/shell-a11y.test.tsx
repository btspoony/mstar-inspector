import { describe, expect, test } from "bun:test";
import { act, createElement, StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { t } from "../../src/i18n";
import type { SpaBoot } from "../../src/spa/boot";
import { Layout } from "../../src/spa/Layout";
import { installDom } from "./dom";

const boot: SpaBoot = {
  locale: "en",
  login: "dana",
  name: "Dana",
  workspaceRef: "ws_acme",
  deploymentMode: "self-hosted",
  memberships: [{ id: "ws_acme", slug: "acme", name: "Acme", role: "owner", plan: "Free" }],
};

const shell = (pathname: string) =>
  createElement(Layout, {
    boot,
    pathname,
    flash: null,
    children: createElement("p", null, "Page"),
  });

type DomWindow = { document: { getElementById(id: string): unknown } };

const mainOf = (win: DomWindow): unknown => win.document.getElementById("main");

const title = (page: string) =>
  t("en", "common.pageTitle", { page, brand: t("en", "nav.brand") });

describe("dashboard shell accessibility", () => {
  test("the sidebar is a named navigation landmark and a skip link targets the content region", async () => {
    const { win, cleanup } = installDom("http://localhost/dashboard/acme/apps");
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(shell("/dashboard/acme/apps")));

      const landmarks = win.document.querySelectorAll('[role="navigation"]');
      expect(landmarks).toHaveLength(1);
      expect(landmarks[0]?.getAttribute("aria-label")).toBe(t("en", "nav.primary"));

      const focusables = container.querySelectorAll('a[href], button, [tabindex]:not([tabindex="-1"])');
      expect((focusables[0] as unknown as Element | undefined)?.getAttribute("href")).toBe("#content");
      expect(focusables[0]?.textContent).toBe(t("en", "nav.skipToContent"));

      const content = win.document.getElementById("content");
      expect(content).not.toBeNull();
      expect(content?.getAttribute("tabindex")).toBe("-1");
      const main = mainOf(win) as { tagName: string; getAttribute(name: string): string | null } | null;
      expect(main).not.toBeNull();
      expect(main?.tagName).toBe("MAIN");
      expect(main?.getAttribute("tabindex")).toBe("-1");
      expect((main as unknown as { contains(node: unknown): boolean }).contains(content)).toBe(true);
    } finally {
      await act(async () => root.unmount());
      cleanup();
    }
  });

  test("a client-side navigation names the destination and moves focus into it", async () => {
    const { win, cleanup } = installDom("http://localhost/dashboard/acme/apps");
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(shell("/dashboard/acme/apps")));
      expect(win.document.title).toBe("");
      expect(win.document.activeElement === mainOf(win)).toBe(false);

      await act(async () => root.render(shell("/dashboard/acme/members")));
      expect(win.document.title).toBe(title(t("en", "nav.members")));
      expect(win.document.activeElement === mainOf(win)).toBe(true);

      await act(async () => root.render(shell("/dashboard/acme/settings")));
      expect(win.document.title).toBe(title(t("en", "nav.settings")));
      expect(win.document.activeElement === mainOf(win)).toBe(true);
    } finally {
      await act(async () => root.unmount());
      cleanup();
    }
  });

  test("the login face carries neither the shell landmark nor a skip link", async () => {
    const { win, cleanup } = installDom("http://localhost/dashboard/login");
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(shell("/dashboard/login")));
      expect(win.document.querySelector('[role="navigation"]')).toBeNull();
      expect(win.document.querySelector('a[href="#content"]')).toBeNull();
      expect(win.document.getElementById("main")).toBeNull();
      expect(win.document.getElementById("content")).toBeNull();
    } finally {
      await act(async () => root.unmount());
      cleanup();
    }
  });

  test("StrictMode's development double mount still leaves the first paint alone", async () => {
    const { win, cleanup } = installDom("http://localhost/dashboard/acme/apps");
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () =>
        root.render(createElement(StrictMode, null, shell("/dashboard/acme/apps"))),
      );
      expect(win.document.title).toBe("");
      expect(win.document.activeElement === mainOf(win)).toBe(false);

      await act(async () =>
        root.render(createElement(StrictMode, null, shell("/dashboard/acme/members"))),
      );
      expect(win.document.title).toBe(title(t("en", "nav.members")));
      expect(win.document.activeElement === mainOf(win)).toBe(true);
    } finally {
      await act(async () => root.unmount());
      cleanup();
    }
  });

  test("a page rendered instead of the route's own names itself in the title", async () => {
    const supportBoot: SpaBoot = { ...boot, login: null, supportOnly: true, memberships: undefined };
    const faceShell = (pathname: string) =>
      createElement(Layout, {
        boot: supportBoot,
        pathname,
        flash: null,
        children: createElement("p", null, "Support"),
      });
    const { win, cleanup } = installDom("http://localhost/dashboard/ws_acme/apps");
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    try {
      await act(async () => root.render(faceShell("/dashboard/ws_acme/apps")));
      await act(async () => root.render(faceShell("/dashboard/ws_acme/members")));
      expect(win.document.title).toBe(title(t("en", "support.heading")));
    } finally {
      await act(async () => root.unmount());
      cleanup();
    }
  });
});
