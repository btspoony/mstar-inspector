import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import type { Element as DomElement, Window } from "happy-dom";
import { t } from "../../src/i18n";
import type { SpaBoot } from "../../src/spa/boot";
import { WorkspaceSettingsPage } from "../../src/spa/pages/WorkspaceSettingsPage";
import { installDom } from "./dom";

const PATH = "/dashboard/ws_acme/settings";

const QUOTA = {
  usedRp: 750,
  limitRp: 2000,
  sharedRp: 620,
  byokRp: 130,
  rpPerCredit: 20,
  profileVersion: 2,
  profileFrom: "2026-11-01",
  resetOn: "2026-12-01",
};

const json = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });

const boot: SpaBoot = {
  locale: "en",
  login: "dana",
  name: "Dana",
  workspaceRef: "ws_acme",
  deploymentMode: "saas",
  memberships: [{ id: "ws_acme", slug: "acme", name: "Acme", role: "owner", plan: "Free" }],
};

function stubPageFetch(): typeof fetch {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.endsWith("/api/settings/review-usage")) {
      return json({
        month: "2026-11",
        sharedReviews: 12,
        ownReviews: 0,
        sharedBot: "available",
        quota: QUOTA,
      });
    }
    if (url.endsWith("/api/settings/concurrency")) {
      return json({ concurrency: 8, min: 1, max: 32, degraded: false });
    }
    if (url.endsWith("/api/settings/check-min-score")) {
      return json({ min_score: 60, min: 3, max: 100, degraded: false });
    }
    return json({ grants: [] });
  }) as unknown as typeof fetch;
  return realFetch;
}

async function click(win: Window, node: DomElement | null | undefined): Promise<void> {
  const pointer = (type: string) =>
    new win.PointerEvent(type, { bubbles: true, cancelable: true, button: 0 });
  const mouse = (type: string) => new win.MouseEvent(type, { bubbles: true, cancelable: true, button: 0 });
  await act(async () => {
    node?.dispatchEvent(pointer("pointerdown"));
    node?.dispatchEvent(mouse("mousedown"));
    node?.dispatchEvent(pointer("pointerup"));
    node?.dispatchEvent(mouse("mouseup"));
    node?.dispatchEvent(mouse("click"));
  });
  await act(async () => {});
}

const pageTabs = (container: DomElement): DomElement[] => [
  ...container.querySelectorAll('[role="tab"]'),
];

async function mountPage(locale: SpaBoot["locale"]) {
  const { win, cleanup } = installDom(`http://localhost${PATH}`);
  const realFetch = stubPageFetch();
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () =>
    root.render(createElement(WorkspaceSettingsPage, { boot: { ...boot, locale } })),
  );
  await act(async () => {});
  return {
    win,
    container: container as unknown as DomElement,
    async close() {
      await act(async () => root.unmount());
      globalThis.fetch = realFetch;
      cleanup();
    },
  };
}

describe("workspace settings tabs", () => {
  test("both faces are in the bar, quota first, and neither ever prints the wire's unit", async () => {
    for (const locale of ["en", "zh_CN"] as const) {
      const page = await mountPage(locale);
      expect(pageTabs(page.container).map((tab) => tab.textContent)).toEqual([
        t(locale, "workspace.tabQuota"),
        t(locale, "workspace.tabConfiguration"),
      ]);
      expect(page.container.textContent).toContain("37.50 / 100.00");
      expect(page.container.textContent ?? "").not.toMatch(/\bRP\b/);
      await page.close();
    }
  });

  test("switching faces moves the active panel and keeps the other one mounted", async () => {
    const page = await mountPage("en");
    const [quotaTab, configurationTab] = pageTabs(page.container);
    const panels = () => [...page.container.querySelectorAll('[data-slot="tabs-content"]')];

    expect(panels().map((node) => node.getAttribute("data-state"))).toEqual(["active", "inactive"]);
    expect(panels()[0]!.textContent).toContain(t("en", "workspace.quotaCreditsLabel"));
    expect(panels()[1]!.textContent).toContain(t("en", "workspace.concurrencyHeading"));

    await click(page.win, configurationTab);
    expect(panels().map((node) => node.getAttribute("data-state"))).toEqual(["inactive", "active"]);
    expect(panels()[1]!.textContent).toContain(t("en", "workspace.concurrencyHeading"));
    expect(panels()[1]!.textContent).toContain(t("en", "workspace.nameHeading"));
    expect(panels()[0]!.textContent).toContain("37.50 / 100.00");

    await click(page.win, quotaTab);
    expect(panels().map((node) => node.getAttribute("data-state"))).toEqual(["active", "inactive"]);
    await page.close();
  });

  test("switching the workspace reloads the quota face with the new workspace's spend", async () => {
    const betaQuota = {
      ...QUOTA,
      usedRp: 400,
      limitRp: 1000,
      sharedRp: 300,
      byokRp: 100,
      rpPerCredit: 10,
    };
    const { win, cleanup } = installDom(`http://localhost${PATH}`);
    const realFetch = globalThis.fetch;
    const calls: string[] = [];
    globalThis.fetch = (async (input: unknown) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/api/settings/review-usage")) {
        const beta = url.startsWith("/dashboard/ws_beta/");
        return json({
          month: "2026-11",
          sharedReviews: beta ? 3 : 12,
          ownReviews: 0,
          sharedBot: "available",
          quota: beta ? betaQuota : QUOTA,
        });
      }
      if (url.endsWith("/api/settings/concurrency")) {
        return json({ concurrency: 8, min: 1, max: 32, degraded: false });
      }
      if (url.endsWith("/api/settings/check-min-score")) {
        return json({ min_score: 60, min: 3, max: 100, degraded: false });
      }
      return json({ grants: [] });
    }) as unknown as typeof fetch;

    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const text = () => container.textContent ?? "";
    try {
      await act(async () =>
        root.render(
          createElement(WorkspaceSettingsPage, {
            boot: {
              ...boot,
              memberships: [
                ...(boot.memberships ?? []),
                { id: "ws_beta", slug: "beta", name: "Beta", role: "owner", plan: "Free" },
              ],
            },
          }),
        ),
      );
      await act(async () => {});
      expect(text()).toContain("37.50 / 100.00");
      expect(text()).toContain("31.00");

      await act(async () => {
        win.history.pushState(null, "", "/dashboard/ws_beta/settings");
        win.dispatchEvent(new win.Event("popstate"));
      });
      await act(async () => {});

      expect(calls).toContain("/dashboard/ws_beta/api/settings/review-usage");
      expect(text()).toContain("40.00 / 100.00");
      expect(text()).toContain("30.00");
      expect(text()).not.toContain("37.50 / 100.00");
      expect(text()).not.toContain("31.00");

      await act(async () => root.unmount());
    } finally {
      globalThis.fetch = realFetch;
      cleanup();
    }
  });
});
