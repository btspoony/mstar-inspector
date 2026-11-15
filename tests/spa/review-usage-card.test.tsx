/**
 * The workspace usage card (spec bot-scope-and-claiming § Review usage).
 *
 * Mounted on its own — the card fetches its own payload — so the contract
 * under test is the card's: the month line, both counts (zero included), and
 * the three shared-bot states with the two unavailable ones carrying DIFFERENT
 * copy. `self-hosted` renders no status row at all.
 */
import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { t } from "../../src/i18n";
import { ReviewUsageCard } from "../../src/spa/pages/ReviewUsageCard";
import { installDom } from "./dom";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Mount the card with one stubbed read and return its rendered text. */
async function mountCard(
  respond: () => Response,
  deploymentMode?: "self-hosted" | "saas",
): Promise<{ text: () => string; close: () => Promise<void> }> {
  const { win, cleanup } = installDom("http://localhost/dashboard/ws_acme/settings");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async () => respond()) as unknown as typeof fetch;
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => root.render(createElement(ReviewUsageCard, { locale: "en", deploymentMode })));
  await act(async () => {});
  return {
    text: () => container.textContent ?? "",
    async close() {
      await act(async () => root.unmount());
      globalThis.fetch = realFetch;
      cleanup();
    },
  };
}

const AVAILABLE = { month: "2026-11", sharedReviews: 12, ownReviews: 0, sharedBot: "available" };

describe("workspace review usage card", () => {
  test("renders the month line, both counts (zero included) and the available state", async () => {
    const card = await mountCard(() => json(AVAILABLE));
    expect(card.text()).toContain(t("en", "workspace.usageWindow", { month: "2026-11" }));
    expect(card.text()).toContain(t("en", "workspace.usageSharedReviews"));
    expect(card.text()).toContain("12");
    expect(card.text()).toContain(t("en", "workspace.usageOwnReviews"));
    expect(card.text()).toContain("0");
    expect(card.text()).toContain(t("en", "workspace.usageAvailable"));
    // The available state offers no hint: nothing needs explaining.
    expect(card.text()).not.toContain(t("en", "workspace.usageNotInPlanHint"));
    await card.close();
  });

  test("a plan without the capability names the reader's own fix, and still shows the numbers", async () => {
    const card = await mountCard(() => json({ ...AVAILABLE, sharedBot: "not-in-plan" }));
    expect(card.text()).toContain(t("en", "workspace.usageNotInPlan"));
    expect(card.text()).toContain(t("en", "workspace.usageNotInPlanHint"));
    expect(card.text()).toContain("12");
    expect(card.text()).not.toContain(t("en", "workspace.usageAvailable"));
    await card.close();
  });

  test("no designated shared bot waits for an operator, with its own copy", async () => {
    const card = await mountCard(() => json({ ...AVAILABLE, sharedBot: "not-designated" }));
    expect(card.text()).toContain(t("en", "workspace.usageNotDesignated"));
    expect(card.text()).toContain(t("en", "workspace.usageNotDesignatedHint"));
    // The two unavailable states must not share copy: one is the reader's plan
    // to change, the other waits for a platform operator.
    expect(card.text()).not.toContain(t("en", "workspace.usageNotInPlanHint"));
    await card.close();
  });

  test("self-hosted renders no shared-bot row, and the own count is the whole card", async () => {
    const card = await mountCard(() => json({ ...AVAILABLE, ownReviews: 7 }), "self-hosted");
    expect(card.text()).toContain(t("en", "workspace.usageSharedReviews"));
    expect(card.text()).toContain("7");
    expect(card.text()).not.toContain(t("en", "workspace.usageSharedStatus"));
    await card.close();
  });

  test("a drifted payload fails the read instead of rendering a blank number", async () => {
    const card = await mountCard(() => json({ month: "2026-11", sharedReviews: "12" }));
    expect(card.text()).toContain(t("en", "common.loadFailed"));
    await card.close();
  });
});
