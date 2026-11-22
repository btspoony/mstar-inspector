/** note: F-05: the delivery `outcome` vocabulary is localized on both
 * health surfaces. Pins the shared label map (known values →
 * apps.health.outcome.*, unknown → raw fail-visible), the both-locale
 * dictionary copy, and the source contract on each surface (no raw outcome
 * interpolation left). No DOM runner — same source-scan contract as the
 * other SPA pins.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deliveryOutcomeLabel } from "../../src/spa/delivery-outcome";

const appsPage = readFileSync(join(import.meta.dir, "../../src/spa/pages/AppsPage.tsx"), "utf8");
// note: The delivery log moved off the bot settings page into the App detail's
// 投递状态 tab, so the tab is the second reader that must label through the map.
const deliveryTab = readFileSync(join(import.meta.dir, "../../src/spa/pages/AppDeliveryTab.tsx"), "utf8");

describe("deliveryOutcomeLabel", () => {
  test("the producer-vocabulary outcomes resolve in both locales", () => {
    expect(deliveryOutcomeLabel("ok", "en")).toBe("OK");
    expect(deliveryOutcomeLabel("paused", "en")).toBe("Paused");
    expect(deliveryOutcomeLabel("ignored", "en")).toBe("Ignored");
    expect(deliveryOutcomeLabel("rejected", "en")).toBe("Rejected");
    expect(deliveryOutcomeLabel("skipped", "en")).toBe("Skipped");
    expect(deliveryOutcomeLabel("ok", "zh_CN")).toBe("正常");
    expect(deliveryOutcomeLabel("paused", "zh_CN")).toBe("已暂停");
    expect(deliveryOutcomeLabel("ignored", "zh_CN")).toBe("已忽略");
    expect(deliveryOutcomeLabel("rejected", "zh_CN")).toBe("已拒绝");
    expect(deliveryOutcomeLabel("skipped", "zh_CN")).toBe("已跳过");
  });

  test("an off-vocabulary outcome falls back to the raw value (fail-visible, never blank)", () => {
    expect(deliveryOutcomeLabel("deployed", "en")).toBe("deployed");
    expect(deliveryOutcomeLabel("deployed", "zh_CN")).toBe("deployed");
  });
});

describe("outcome surfaces (F-05)", () => {
  test("AppsPage labels the latest delivery outcome through the shared map", () => {
    expect(appsPage).toContain("deliveryOutcomeLabel(latest.outcome, locale)");
    // invariant: The raw interpolation this task replaced must not come back.
    expect(appsPage).not.toContain("${latest.outcome}");
    expect(appsPage).toContain('../delivery-outcome');
  });

  test("the delivery tab labels every row's outcome through the shared map", () => {
    expect(deliveryTab).toContain("deliveryOutcomeLabel(row.outcome, locale)");
    expect(deliveryTab).not.toContain("{row.outcome}");
    expect(deliveryTab).toContain('../delivery-outcome');
  });
});
