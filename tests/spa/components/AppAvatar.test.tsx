/**
 * AppAvatar — the App's brand mark on both dashboard surfaces.
 *
 * The icon URL is derived from the GitHub App id, so it is a plain CDN object
 * that can 404. The contract pinned here is the FALLBACK, which only a DOM
 * mount can exercise: a load error swaps in the default octocat mark at the
 * same box classes (no broken image, no layout jump) — and a null URL renders
 * the same mark without ever mounting an <img>.
 */
import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { appAvatarUrl } from "../../../src/contracts/app-avatar";
import { AppAvatar } from "../../../src/spa/components/AppAvatar";
import { installDom } from "../dom";

const BOX = "h-9 w-9 shrink-0 rounded-full border object-cover";
const ICON = "https://avatars.githubusercontent.com/in/1234?s=120&v=4";

async function mount(
  src: string | null,
  appId?: number,
): Promise<{
  container: Element;
  rerender: (next: string | null) => Promise<void>;
  fireError: () => Promise<void>;
  cleanup: () => Promise<void>;
}> {
  const { win, cleanup: cleanupDom } = installDom("http://localhost/dashboard/acme/apps");
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => root.render(createElement(AppAvatar, { src, appId, className: BOX })));
  return {
    container: container as unknown as Element,
    rerender: async (next: string | null) => {
      await act(async () =>
        root.render(createElement(AppAvatar, { src: next, appId, className: BOX })),
      );
    },
    fireError: async () => {
      const img = container.querySelector("img");
      expect(img).not.toBeNull();
      await act(async () => {
        img!.dispatchEvent(new win.Event("error"));
      });
    },
    cleanup: async () => {
      await act(async () => root.unmount());
      cleanupDom();
    },
  };
}

describe("AppAvatar", () => {
  test("renders the image for a synced App, falling back to the default mark on a load error", async () => {
    const mounted = await mount(ICON);
    try {
      const img = mounted.container.querySelector("img");
      expect(img?.getAttribute("src")).toBe(ICON);
      expect(img?.className).toBe(BOX);
      await mounted.fireError();
      const svg = mounted.container.querySelector("svg");
      expect(mounted.container.querySelector("img")).toBeNull();
      expect(svg).not.toBeNull();
      // Same box, so the row height never changes across the swap.
      expect(mounted.container.firstElementChild?.className).toContain(BOX);
    } finally {
      await mounted.cleanup();
    }
  });

  test("a new src after a failure is attempted again (the mark is not sticky)", async () => {
    const mounted = await mount(ICON);
    try {
      await mounted.fireError();
      expect(mounted.container.querySelector("img")).toBeNull();
      await mounted.rerender(appAvatarUrl(4321));
      const img = mounted.container.querySelector("img");
      expect(img?.getAttribute("src")).toBe(appAvatarUrl(4321));
    } finally {
      await mounted.cleanup();
    }
  });

  test("a NULL cached avatar is derived from the App id — a real icon on the first load", async () => {
    // The column is empty (never synced, or synced by a version that could not
    // derive the URL), so the mark comes from the numeric App id on read.
    const mounted = await mount(null, 1234);
    try {
      const img = mounted.container.querySelector("img");
      expect(img?.getAttribute("src")).toBe(appAvatarUrl(1234));
    } finally {
      await mounted.cleanup();
    }
  });

  test("a cached src wins over the derived URL", async () => {
    const mounted = await mount(ICON, 1234);
    try {
      expect(mounted.container.querySelector("img")?.getAttribute("src")).toBe(ICON);
    } finally {
      await mounted.cleanup();
    }
  });

  test("neither src nor appId → the default mark, no <img> at all", async () => {
    const mounted = await mount(null);
    try {
      expect(mounted.container.querySelector("img")).toBeNull();
      expect(mounted.container.querySelector("svg")).not.toBeNull();
      expect(mounted.container.firstElementChild?.className).toContain(BOX);
    } finally {
      await mounted.cleanup();
    }
  });
});
