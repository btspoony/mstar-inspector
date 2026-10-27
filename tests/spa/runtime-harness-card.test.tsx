/**
 * The runtime-harness settings card, asserted on the static markup in both
 * locales: the card names the runtime harness (never the image) and the
 * selector lists the registry ids from the payload.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SettingsManagePayload } from "../../src/spa/pages/data";
import { RuntimeHarnessCard } from "../../src/spa/pages/SettingsPage";

// The card reads only these three payload fields; the rest of the manage
// payload belongs to the sibling cards.
const payload = {
  can_manage: true,
  app: { sandbox_image_id: "omp" },
  sandbox_images: [
    { id: "omp", enabled: true },
    { id: "legacy", enabled: false },
  ],
} as unknown as SettingsManagePayload;

const noop = async () => ({ kind: "success" as const, message: "" });

const render = (locale: "en" | "zh_CN"): string =>
  renderToStaticMarkup(createElement(RuntimeHarnessCard, { locale, payload, onSettings: noop }));

describe("runtime harness card (SSR)", () => {
  test("the English face names the runtime harness, not the image", () => {
    const html = render("en");
    expect(html).toContain("Runtime harness");
    expect(html).not.toContain("Runtime image");
    // The card copy keeps the true statement: model configuration is read at run time.
    expect(html).toContain("run time");
    // The selector shows the persisted registry id as its value (the closed
    // Radix listbox renders its items only on open, client-side).
    expect(html).toContain("omp");
  });

  test("the Chinese face names the runtime harness, not the image", () => {
    const html = render("zh_CN");
    expect(html).toContain("运行时 harness");
    expect(html).not.toContain("运行时镜像");
    expect(html).toContain("omp");
  });
});
