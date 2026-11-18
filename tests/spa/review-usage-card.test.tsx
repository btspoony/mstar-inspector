/**
 * The workspace usage card (spec bot-scope-and-claiming § Review usage).
 *
 * Mounted on its own — the card fetches its own payload — so the contract
 * under test is the card's: the credit block (credits primary, RP detail, the
 * source split, the judging profile), the over-ceiling banner at and past the
 * ceiling, the published-review counts that stay beneath it, and the three
 * shared-bot states with the two unavailable ones carrying DIFFERENT copy.
 *
 * `self-hosted` renders no quota block at all (no ceiling to report), so the
 * own-bot count is the whole card there — exactly as before this change.
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

/** The credit block under the ceiling: 750 of 2000 RP, both sources spending. */
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

const SAAS = { month: "2026-11", sharedReviews: 12, ownReviews: 0, sharedBot: "available", quota: QUOTA };

describe("workspace review usage card", () => {
  test("credits are primary, RP is the detail, and both carry the judging profile", async () => {
    const card = await mountCard(() => json(SAAS));
    expect(card.text()).toContain(t("en", "workspace.quotaWindow", { month: "2026-11" }));
    expect(card.text()).toContain(t("en", "workspace.quotaCreditsLabel"));
    // 750 / 20 and 2000 / 20, two decimals — the value is the bare pair.
    expect(card.text()).toContain("37.50 / 100.00");
    expect(card.text()).toContain(t("en", "workspace.quotaRpLabel", { rpPerCredit: 20 }));
    expect(card.text()).toContain("750 / 2000");
    expect(card.text()).toContain(t("en", "workspace.quotaSplitLabel"));
    expect(card.text()).toContain(t("en", "workspace.quotaSharedBot"));
    expect(card.text()).toContain("620 RP");
    expect(card.text()).toContain(t("en", "workspace.quotaByok"));
    expect(card.text()).toContain("130 RP");
    expect(card.text()).toContain(
      t("en", "workspace.quotaVersion", { version: "v2", date: "2026-11-01" }),
    );
    // The two-counter statement is on the surface, and under the ceiling there
    // is no banner to explain.
    expect(card.text()).toContain(t("en", "workspace.quotaBasis"));
    expect(card.text()).not.toContain(
      t("en", "workspace.quotaOverCeiling", { month: "2026-11", reset: "2026-12-01" }),
    );
    await card.close();
  });

  test("the published-review counts stay, with the available state", async () => {
    const card = await mountCard(() => json(SAAS));
    expect(card.text()).toContain(t("en", "workspace.usageSharedReviews"));
    expect(card.text()).toContain("12");
    expect(card.text()).toContain(t("en", "workspace.usageOwnReviews"));
    expect(card.text()).toContain("0");
    expect(card.text()).toContain(t("en", "workspace.usageAvailable"));
    // The available state offers no hint: nothing needs explaining.
    expect(card.text()).not.toContain(t("en", "workspace.usageNotInPlanHint"));
    await card.close();
  });

  for (const [label, usedRp] of [
    ["at", 2000],
    ["over", 2100],
  ] as const) {
    test("exactly at and past the ceiling render one identical state: pair kept, one banner", async () => {
      const card = await mountCard(() => json({ ...SAAS, quota: { ...QUOTA, usedRp } }));
      const banner = t("en", "workspace.quotaOverCeiling", { month: "2026-11", reset: "2026-12-01" });
      expect(card.text()).toContain(banner);
      // The measurement is never hidden: a workspace over its ceiling can see
      // by how much.
      expect(card.text()).toContain(`${usedRp} / 2000`);
      await card.close();
      expect(label === "at" || label === "over").toBe(true);
    });
  }

  test("an unlimited plan shows the no-limit faces, never 0 or an empty limit", async () => {
    const card = await mountCard(() =>
      json({ ...SAAS, quota: { ...QUOTA, limitRp: null, usedRp: 620 } }),
    );
    expect(card.text()).toContain(t("en", "workspace.quotaNoLimit"));
    expect(card.text()).toContain(t("en", "workspace.quotaRpNoLimit", { used: 620 }));
    expect(card.text()).not.toContain("620 / 0");
    expect(card.text()).not.toContain(t("en", "workspace.quotaRpLabel", { rpPerCredit: 20 }) + "0");
    // No ceiling means no over-ceiling state to report.
    expect(card.text()).not.toContain(t("en", "workspace.quotaOverCeiling", { month: "2026-11", reset: "2026-12-01" }));
    await card.close();
  });

  test("a plan without the shared bot names the reader's own fix, and still shows the numbers", async () => {
    const card = await mountCard(() => json({ ...SAAS, sharedBot: "not-in-plan" }));
    expect(card.text()).toContain(t("en", "workspace.usageNotInPlan"));
    expect(card.text()).toContain(t("en", "workspace.usageNotInPlanHint"));
    expect(card.text()).toContain("37.50 / 100.00");
    expect(card.text()).not.toContain(t("en", "workspace.usageAvailable"));
    await card.close();
  });

  test("no designated shared bot waits for an operator, with its own copy", async () => {
    const card = await mountCard(() => json({ ...SAAS, sharedBot: "not-designated" }));
    expect(card.text()).toContain(t("en", "workspace.usageNotDesignated"));
    expect(card.text()).toContain(t("en", "workspace.usageNotDesignatedHint"));
    // The two unavailable states must not share copy: one is the reader's plan
    // to change, the other waits for a platform operator.
    expect(card.text()).not.toContain(t("en", "workspace.usageNotInPlanHint"));
    await card.close();
  });

  test("self-hosted renders no quota card: no credits, no split, no banner — the own count stays", async () => {
    const card = await mountCard(
      () => json({ month: "2026-11", sharedReviews: 3, ownReviews: 7, sharedBot: "available", quota: null }),
      "self-hosted",
    );
    expect(card.text()).toContain(t("en", "workspace.usageOwnReviews"));
    expect(card.text()).toContain("7");
    expect(card.text()).not.toContain(t("en", "workspace.usageSharedStatus"));
    // No quota block at all: there is no ceiling to report in this mode.
    expect(card.text()).not.toContain(t("en", "workspace.quotaHeading"));
    expect(card.text()).not.toContain(t("en", "workspace.quotaCreditsLabel"));
    expect(card.text()).not.toContain(t("en", "workspace.quotaSplitLabel"));
    expect(card.text()).not.toContain(t("en", "workspace.quotaBasis"));
    await card.close();
  });

  test("a drifted payload fails the read instead of rendering a blank number", async () => {
    const card = await mountCard(() => json({ month: "2026-11", sharedReviews: "12" }));
    expect(card.text()).toContain(t("en", "common.loadFailed"));
    await card.close();
  });

  test("a drifted quota block is a failed read, not a half-rendered card", async () => {
    const card = await mountCard(() => json({ ...SAAS, quota: { ...QUOTA, usedRp: "750" } }));
    expect(card.text()).toContain(t("en", "common.loadFailed"));
    await card.close();
  });
});
