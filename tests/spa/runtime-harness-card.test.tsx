/**
 * The runtime-harness settings card, asserted on the static markup in both
 * locales: the card names the runtime harness (never the image), the
 * description interpolates the persisted registry id, and the selector lists
 * the registry ids from the payload.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { SettingsManagePayload } from "../../src/spa/pages/data";
import { RuntimeHarnessCard } from "../../src/spa/pages/SettingsPage";

// The card reads only these three payload fields; the rest of the manage
// payload belongs to the sibling cards.
const payload = (sandboxImageId: string): SettingsManagePayload =>
  ({
    can_manage: true,
    app: { sandbox_image_id: sandboxImageId },
    sandbox_images: [
      { id: "omp", enabled: true },
      { id: "legacy", enabled: false },
    ],
  }) as unknown as SettingsManagePayload;

const noop = async () => ({ kind: "success" as const, message: "" });

const render = (locale: "en" | "zh_CN", sandboxImageId: string): string =>
  renderToStaticMarkup(
    createElement(RuntimeHarnessCard, { locale, payload: payload(sandboxImageId), onSettings: noop }),
  );

describe("runtime harness card (SSR)", () => {
  test("the English face names the runtime harness, not the image", () => {
    const html = render("en", "omp");
    expect(html).toContain("Runtime harness");
    expect(html).not.toContain("Runtime image");
    // The card copy keeps the true statement: model configuration is read at run time.
    expect(html).toContain("run time");
    // The description interpolates the persisted registry id.
    expect(html).toContain("The omp runtime harness mounted");
    // The selector shows the persisted registry id as its value (the closed
    // Radix listbox renders its items only on open, client-side).
    expect(html).toContain("omp");
  });

  test("the Chinese face names the runtime harness, not the image", () => {
    const html = render("zh_CN", "omp");
    expect(html).toContain("运行时 harness");
    expect(html).not.toContain("运行时镜像");
    expect(html).toContain("omp");
  });

  test("the description names the persisted id, never a hardcoded registry id", () => {
    const html = render("en", "other-runtime");
    expect(html).toContain("The other-runtime runtime harness mounted");
    expect(html).not.toContain("(omp)");
  });
});
