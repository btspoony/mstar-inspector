/** note: I-000645: chain rows can be reordered. The stored order IS the chain string
 * (`bot_model_chains.chain`, no ordinal column), so a move is a pure swap in the
 * UNSAVED local array and the existing `chain.join(", ")` save persists it — no
 * route, no schema change, and the same local-edit-then-save rule 移除 follows.
 *
 * Pinned: a move-up followed by save posts the string in the NEW order, the
 * first row's up button and the last row's down button are disabled, focus stays
 * on the moved row's control, and the helper refuses to wrap at the ends.
 */
import { describe, expect, test } from "bun:test";
import { act, createElement, useState } from "react";
import { createRoot } from "react-dom/client";
import { t } from "../../src/i18n";
import { ChainsSection } from "../../src/spa/pages/SettingsPage";
import type { BotConfigSections, ModelOptionGroup } from "../../src/spa/pages/data";
import type { OpNotice } from "../../src/spa/pages/PageNotice";
import { installDom } from "./dom";

const groups: ModelOptionGroup[] = [
  { provider: "anthropic", source: "verified", selectors: ["anthropic/a", "anthropic/b", "anthropic/c"] },
];

function payload(modelChain: string | null): BotConfigSections {
  return {
    app: {
      github_app_id: 1,
      status: "active",
      last_webhook_at: null,
      scope: "owned",
      id: "app-test",
      sandbox_image_id: "omp",
      github_name: null,
      github_slug: null,
      github_description: null,
      github_html_url: null,
      github_avatar_url: null,
      github_metadata_synced_at: null,
    },
    keys: [],
    model_chain: modelChain,
    model_roles: {},
    model_chains: [],
    custom_providers: [],
    configured_providers: [],
    provider_catalog_version: "fixture-catalog",
    provider_eligibility: {},
    model_role_ids: [],
    custom_provider_api_ids: ["openai-completions"],
    sandbox_images: [{ id: "omp", enabled: true }],
    installations: [],
  };
}

async function mount(stored: string) {
  const { win, cleanup } = installDom("http://localhost/dashboard/ws/settings");
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  const saved: string[] = [];
  await act(async () => {
    root.render(
      createElement(ChainsSection, {
        locale: "en" as const,
        payload: payload(stored),
        groups,
        onSettings: async (fields: Record<string, string>) => {
          if (fields.op === "save-chain") saved.push(fields.model_chain ?? "");
          const notice: OpNotice = { kind: "success", message: "saved" };
          return notice;
        },
        onCreateDraft: async () => ({ kind: "success" as const, message: "" }),
        onRemoveChain: () => {},
        notice: null,
        onOutcome: () => {},
      }),
    );
  });
  await act(async () => {});
  const buttons = () => [...(container.querySelectorAll("button") as unknown as HTMLButtonElement[])];
  const labelled = (label: string) =>
    buttons().filter((button) => button.getAttribute("aria-label") === label);
  const rowSelectors = () => [...container.querySelectorAll("li .font-mono")].map((node) => node.textContent);
  const click = async (button: { click: () => void }) => {
    await act(async () => {
      button.click();
    });
    await act(async () => {});
  };
  return {
    win,
    container,
    saved,
    labelled,
    rowSelectors,
    click,
    save: async () => {
      const save = buttons().find((button) => button.textContent === t("en", "settings.saveChain"));
      if (save === undefined) throw new Error("save button is missing");
      await click(save);
    },
    cleanup: async () => {
      await act(async () => root.unmount());
      cleanup();
    },
  };
}

const UP = "settings.moveChainUp";
const DOWN = "settings.moveChainDown";

describe("chain row reordering (I-000645)", () => {
  test("a move-up followed by save posts the chain in the new order", async () => {
    const view = await mount("anthropic/a, anthropic/b, anthropic/c");
    try {
      expect(view.rowSelectors()).toEqual(["anthropic/a", "anthropic/b", "anthropic/c"]);

      // invariant: Move the SECOND row up: a local edit, nothing posted yet.
      await view.click(view.labelled(t("en", UP))[1]!);
      expect(view.rowSelectors()).toEqual(["anthropic/b", "anthropic/a", "anthropic/c"]);
      expect(view.saved).toEqual([]);

      await view.save();
      expect(view.saved).toEqual(["anthropic/b, anthropic/a, anthropic/c"]);
    } finally {
      await view.cleanup();
    }
  });

  test("a move-down swaps the other way and still saves the local order", async () => {
    const view = await mount("anthropic/a, anthropic/b, anthropic/c");
    try {
      await view.click(view.labelled(t("en", DOWN))[0]!);
      expect(view.rowSelectors()).toEqual(["anthropic/b", "anthropic/a", "anthropic/c"]);
      await view.save();
      expect(view.saved).toEqual(["anthropic/b, anthropic/a, anthropic/c"]);
    } finally {
      await view.cleanup();
    }
  });

  test("the first row's up and the last row's down are disabled; the others are not", async () => {
    const view = await mount("anthropic/a, anthropic/b, anthropic/c");
    try {
      const up = view.labelled(t("en", UP));
      const down = view.labelled(t("en", DOWN));
      expect(up).toHaveLength(3);
      expect(down).toHaveLength(3);
      const disabled = (nodes: HTMLButtonElement[]) => nodes.map((node) => node.disabled);
      expect(disabled(up)).toEqual([true, false, false]);
      expect(disabled(down)).toEqual([false, false, true]);
    } finally {
      await view.cleanup();
    }
  });

  test("a single-row chain disables both ends", async () => {
    const view = await mount("anthropic/a");
    try {
      expect(view.labelled(t("en", UP)).map((node) => node.disabled)).toEqual([true]);
      expect(view.labelled(t("en", DOWN)).map((node) => node.disabled)).toEqual([true]);
    } finally {
      await view.cleanup();
    }
  });

  test("focus stays on the moved row's own control after the swap", async () => {
    const view = await mount("anthropic/a, anthropic/b, anthropic/c");
    try {
      const control = view.labelled(t("en", UP))[1]!;
      control.focus();
      expect((view.win.document.activeElement as unknown) === control).toBe(true);
      await view.click(control);
      // note: The same DOM node still holds focus: the row is keyed by its selector,
      // so React moves the existing node instead of remounting it.
      const after = view.labelled(t("en", UP))[0]!;
      expect((view.win.document.activeElement as unknown) === after).toBe(true);
      expect(view.rowSelectors()).toEqual(["anthropic/b", "anthropic/a", "anthropic/c"]);
    } finally {
      await view.cleanup();
    }
  });
});
