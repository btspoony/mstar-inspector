/**
 * Workspace settings tabs: the same header + tabs + content shell the App and
 * repository detail pages mount. Two faces — 额度 (the read-only spend of the
 * addressed workspace) and 配置 (the cards a manager may write).
 *
 * Mounted, because two contracts live only in the running tree: switching
 * faces (Radix selects on pointer/mouse down) and the quota card actually
 * rendering its figures — a static render stops at its loading face, so the
 * unit assertion below would pass over an empty card.
 */
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

/** Every read this page issues, settled — one quota-bearing month included. */
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

/** One press as the browser performs it — a Radix trigger selects on mousedown. */
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
      // The credit face really rendered — figures included, so the unit check
      // below measures a populated card rather than its loading state.
      expect(page.container.textContent).toContain("37.50 / 100.00");
      // The raw unit is the wire's, never the operator's.
      expect(page.container.textContent ?? "").not.toMatch(/\bRP\b/);
      await page.close();
    }
  });

  test("switching faces moves the active panel and keeps the other one mounted", async () => {
    const page = await mountPage("en");
    const [quotaTab, configurationTab] = pageTabs(page.container);
    const panels = () => [...page.container.querySelectorAll('[data-slot="tabs-content"]')];

    // Quota is the opening face.
    expect(panels().map((node) => node.getAttribute("data-state"))).toEqual(["active", "inactive"]);
    expect(panels()[0]!.textContent).toContain(t("en", "workspace.quotaCreditsLabel"));
    expect(panels()[1]!.textContent).toContain(t("en", "workspace.concurrencyHeading"));

    await click(page.win, configurationTab);
    // The SAME two nodes: forceMount keeps the quota card's loaded value.
    expect(panels().map((node) => node.getAttribute("data-state"))).toEqual(["inactive", "active"]);
    expect(panels()[1]!.textContent).toContain(t("en", "workspace.concurrencyHeading"));
    expect(panels()[1]!.textContent).toContain(t("en", "workspace.nameHeading"));
    // The quota figures survive the round trip in the hidden panel.
    expect(panels()[0]!.textContent).toContain("37.50 / 100.00");

    await click(page.win, quotaTab);
    expect(panels().map((node) => node.getAttribute("data-state"))).toEqual(["active", "inactive"]);
    await page.close();
  });
});
