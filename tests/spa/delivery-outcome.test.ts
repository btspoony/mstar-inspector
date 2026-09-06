/**
 * Plan 45 T2 / F-05: the delivery `outcome` vocabulary is localized on both
 * health surfaces. Pins the shared label map (known values →
 * apps.health.outcome.*, unknown → raw fail-visible), the both-locale
 * dictionary copy, and the source contract on each surface (no raw outcome
 * interpolation left). No DOM runner — same source-scan contract as the
 * other plan 45 SPA pins.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deliveryOutcomeLabel } from "../../src/spa/delivery-outcome";

const appsPage = readFileSync(join(import.meta.dir, "../../src/spa/pages/AppsPage.tsx"), "utf8");
const settingsPage = readFileSync(join(import.meta.dir, "../../src/spa/pages/SettingsPage.tsx"), "utf8");

describe("deliveryOutcomeLabel (plan 45 T2)", () => {
  test("the four producer-vocabulary outcomes resolve in both locales", () => {
    expect(deliveryOutcomeLabel("ok", "en")).toBe("OK");
    expect(deliveryOutcomeLabel("paused", "en")).toBe("Paused");
    expect(deliveryOutcomeLabel("ignored", "en")).toBe("Ignored");
    expect(deliveryOutcomeLabel("rejected", "en")).toBe("Rejected");
    expect(deliveryOutcomeLabel("ok", "zh_CN")).toBe("正常");
    expect(deliveryOutcomeLabel("paused", "zh_CN")).toBe("已暂停");
    expect(deliveryOutcomeLabel("ignored", "zh_CN")).toBe("已忽略");
    expect(deliveryOutcomeLabel("rejected", "zh_CN")).toBe("已拒绝");
  });

  test("an off-vocabulary outcome falls back to the raw value (fail-visible, never blank)", () => {
    expect(deliveryOutcomeLabel("deployed", "en")).toBe("deployed");
    expect(deliveryOutcomeLabel("deployed", "zh_CN")).toBe("deployed");
  });
});

describe("outcome surfaces (plan 45 T2 / F-05)", () => {
  test("AppsPage labels the latest delivery outcome through the shared map", () => {
    expect(appsPage).toContain("deliveryOutcomeLabel(latest.outcome, locale)");
    // The raw interpolation this task replaced must not come back.
    expect(appsPage).not.toContain("${latest.outcome}");
    expect(appsPage).toContain('../delivery-outcome');
  });

  test("SettingsPage labels recent-delivery outcomes through the shared map", () => {
    expect(settingsPage).toContain("deliveryOutcomeLabel(delivery.outcome, locale)");
    expect(settingsPage).not.toContain("{delivery.outcome}");
    expect(settingsPage).toContain('../delivery-outcome');
  });
});
