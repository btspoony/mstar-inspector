/**
 * I-000647: the chain editor's action row anchored left, so it drifted away
 * from the panel's trailing edge and could run past the container.
 *
 * Pinned structurally over the rendered panel: the picker, 加入模型链, 保存模型链
 * and the draft's caller action share ONE wrapping row whose alignment is the
 * trailing edge, and 保存模型链 stays that row's primary face.
 */
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
      // The row is the container the save button sits in; the picker (inside
      // its own width clamp) and the add button must be its direct children
      // too, or the save has drifted into a row of its own.
      const shared = save!.parentElement!;
      expect(add!.parentElement).toBe(shared);
      expect(picker!.parentElement!.parentElement).toBe(shared);
      return { classes: [...shared.classList], label: save!.textContent };
    });

    // Trailing-edge anchor + wrapping: every wrapped line stays right-aligned,
    // so the controls cannot start at the left edge or pass the container.
    expect(row.classes).toContain("justify-end");
    expect(row.classes).toContain("flex-wrap");
    // 保存模型链 remains the row's primary face.
    expect(row.label).toBe(t("en", "settings.saveChain"));
  });
});
