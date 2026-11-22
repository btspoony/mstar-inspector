/** note: The sandbox-image section — the bot page's runtime-harness face — asserted on
 * the static markup in both locales: the section names the runtime harness
 * (never the image), and a manager gets the registry selector the save uses.
 * The review trigger control is TARGET-scoped and stayed on the target detail,
 * so this section carries the image alone.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../../src/i18n";
import type { BotConfigSections } from "../../src/spa/pages/data";
import { SandboxSection } from "../../src/spa/pages/BotSettingsPage";

// invariant: The section reads only these payload fields; the rest of the bot payload
// belongs to the sibling sections.
const payload = (
  sandboxImageId: string,
  canManage: boolean,
): BotConfigSections & { can_manage: boolean } =>
  ({
    can_manage: canManage,
    app: { sandbox_image_id: sandboxImageId, github_slug: "acme" },
    sandbox_images: [
      { id: "omp", enabled: true },
      { id: "legacy", enabled: false },
    ],
  }) as unknown as BotConfigSections & { can_manage: boolean };

const noop = async () => ({ kind: "success" as const, message: "" });

const render = (locale: "en" | "zh_CN", sandboxImageId: string, canManage = true): string =>
  renderToStaticMarkup(
    createElement(SandboxSection, { locale, payload: payload(sandboxImageId, canManage), onSettings: noop }),
  );

describe("sandbox image section (SSR)", () => {
  test("the English face names the runtime harness, not the image", () => {
    const html = render("en", "omp");
    expect(html).toContain(t("en", "settings.runtimeHarness"));
    expect(html).not.toContain("Runtime image");
    // note: The copy keeps the owner: the bot's reviews all run under this harness.
    expect(html).toContain(t("en", "botSettings.sandboxCopy"));
    expect(html).toContain(t("en", "settings.saveRuntimeHarness"));
    // note: The selector shows the persisted registry id as its value (the closed
    // Radix listbox renders its items only on open, client-side).
    expect(html).toContain("omp");
  });

  test("the Chinese face names the runtime harness, not the image", () => {
    const html = render("zh_CN", "omp");
    expect(html).toContain("运行时 harness");
    expect(html).not.toContain("运行时镜像");
    expect(html).toContain("omp");
  });

  test("the read-only face names the stored id and offers no save control", () => {
    const html = render("en", "other-runtime", false);
    expect(html).toContain(t("en", "settings.runtimeHarnessValue", { id: "other-runtime" }));
    expect(html).not.toContain(t("en", "settings.saveRuntimeHarness"));
  });
});
