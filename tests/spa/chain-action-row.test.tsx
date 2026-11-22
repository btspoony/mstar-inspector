import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../../src/i18n";
import { DraftChainPanel } from "../../src/spa/pages/SettingsPage";
import type { OpNotice } from "../../src/spa/pages/PageNotice";
import { withMarkup } from "./dom";

describe("I-000647: the chain editor's action row hangs off the trailing edge", () => {
  const panelHtml = (): string =>
    renderToStaticMarkup(
      createElement(DraftChainPanel, {
        locale: "en",
        groups: [],
        name: "",
        onNameChange: () => {},
        onCreate: () => Promise.resolve<OpNotice>({ kind: "success", message: "saved" }),
        onOutcome: () => {},
        onDiscard: () => {},
        onCreated: () => {},
      }),
    );

  test("the picker, add, save and caller actions share one wrapping, right-aligned row", async () => {
    const row = await withMarkup(panelHtml(), (container) => {
      const find = (label: string) =>
        [...container.querySelectorAll("button")].find((node) => node.textContent === label) ?? null;
      const save = find(t("en", "settings.saveChain"));
      const add = find(t("en", "settings.addToChain"));
      const picker = container.querySelector('[role="combobox"]');
      expect(save).not.toBeNull();
      expect(add).not.toBeNull();
      expect(picker).not.toBeNull();
      const shared = save!.parentElement!;
      expect(add!.parentElement).toBe(shared);
      expect(picker!.parentElement!.parentElement).toBe(shared);
      return { classes: [...shared.classList], label: save!.textContent };
    });

    expect(row.classes).toContain("justify-end");
    expect(row.classes).toContain("flex-wrap");
    expect(row.label).toBe(t("en", "settings.saveChain"));
  });
});
