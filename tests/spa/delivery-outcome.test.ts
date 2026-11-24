import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deliveryOutcomeLabel } from "../../src/spa/delivery-outcome";

const appsPage = readFileSync(join(import.meta.dir, "../../src/spa/pages/AppsPage.tsx"), "utf8");
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
  test("AppsPage never interpolates the raw latest outcome", () => {
    expect(appsPage).not.toContain("${latest.outcome}");
  });

  test("the delivery tab never interpolates a raw row outcome", () => {
    expect(deliveryTab).not.toContain("{row.outcome}");
  });
});
