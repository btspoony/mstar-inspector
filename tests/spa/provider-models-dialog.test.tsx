/**
 * The model picker dialog: one checkbox per catalog model (stored ids
 * checked), stored ids the catalog no longer lists stay listed and checked,
 * case-insensitive filtering keeps checked state, the selected / 32 counter
 * states the cap and an unchecked box is unavailable at the cap, select-none
 * empties the selection and disables save, select-all checks everything, and
 * save posts the `update-provider-models` op and reports its success.
 *
 * Mounted, because the panel lives in a Radix portal and the selection is
 * stateful. Assertions observe checkbox state, the counter, the disabled save
 * and the POST body — not class names.
 */
import { describe, expect, test } from "bun:test";
import { act, createElement, useState, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { t, type DictionaryKey } from "../../src/i18n";
import type { SpaBoot } from "../../src/spa/boot";
import type { OpNotice } from "../../src/spa/pages/PageNotice";
import { MAX_PROVIDER_MODEL_IDS, ProviderModelsDialog } from "../../src/spa/pages/provider-models-dialog";
import { installDom } from "./dom";

const locale: SpaBoot["locale"] = "en";
const notice = (kind: OpNotice["kind"], message: string): OpNotice => ({ kind, message });

function Opener({ factory }: { factory: (open: boolean, onOpenChange: (open: boolean) => void) => ReactElement }) {
  const [open, setOpen] = useState(true);
  return (
    <>
      <button type="button" data-testid="reopen" onClick={() => setOpen(true)}>
        reopen
      </button>
      {factory(open, setOpen)}
    </>
  );
}

async function mount(overrides: {
  storedModelIds?: string[];
  catalogModelIds?: string[];
  onSettings?: (fields: Record<string, string>) => Promise<OpNotice>;
  onOutcome?: (outcome: OpNotice) => void;
}) {
  const { win, cleanup: cleanupDom } = installDom("http://localhost/dashboard/acme/apps");
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const calls: Array<Record<string, string>> = [];
  const outcomes: OpNotice[] = [];
  const root = createRoot(container as unknown as Element);
  const onSettings =
    overrides.onSettings ??
    (async (fields: Record<string, string>) => {
      calls.push(fields);
      return notice("success", "stored");
    });
  await act(async () =>
    root.render(
      createElement(Opener, {
        factory: (open, onOpenChange) =>
          createElement(ProviderModelsDialog, {
            locale,
            open,
            onOpenChange,
            provider: "my-gateway",
            label: "My Gateway",
            storedModelIds: overrides.storedModelIds ?? [],
            catalogModelIds: overrides.catalogModelIds ?? [],
            onSettings,
            onOutcome: (outcome) => {
              outcomes.push(outcome);
              overrides.onOutcome?.(outcome);
            },
          }),
      }),
    ),
  );
  await act(async () => {});

  const dialog = (): HTMLElement | null => win.document.querySelector('[role="dialog"]') as unknown as HTMLElement | null;
  const checkboxes = (): HTMLInputElement[] =>
    [...(dialog()?.querySelectorAll('input[type="checkbox"]') ?? [])] as unknown as HTMLInputElement[];
  const saveButton = (): HTMLButtonElement | null =>
    (dialog()?.querySelector('button[type="submit"]') as unknown as HTMLButtonElement | null) ?? null;
  const buttonByLabel = (key: DictionaryKey): HTMLButtonElement | null =>
    [...(dialog()?.querySelectorAll("button") ?? [])].find(
      (button) => button.textContent === t(locale, key),
    ) as unknown as HTMLButtonElement | null;

  const click = async (target: Element | null | undefined) => {
    await act(async () => {
      target?.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }) as unknown as Event);
    });
  };

  const type = async (target: Element | null | undefined, value: string) => {
    const setValue = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
    await act(async () => {
      setValue?.call(target, value);
      target?.dispatchEvent(new win.Event("input", { bubbles: true }) as unknown as Event);
    });
  };

  const search = () => dialog()?.querySelector('input[type="search"]') as unknown as HTMLInputElement | null;

  return {
    win,
    dialog,
    checkboxes,
    saveButton,
    buttonByLabel,
    click,
    type,
    search,
    calls,
    outcomes,
    cleanup: async () => {
      await act(async () => root.unmount());
      cleanupDom();
    },
  };
}

const CATALOG = ["m-1", "m-2", "m-3", "m-4"];

describe("ProviderModelsDialog", () => {
  test("renders one checkbox per catalog model, checked for every stored id", async () => {
    const view = await mount({ catalogModelIds: CATALOG, storedModelIds: ["m-1", "m-3"] });
    try {
      const boxes = view.checkboxes();
      expect(boxes).toHaveLength(4);
      expect(boxes.map((box) => [box.nextElementSibling?.textContent, box.checked])).toEqual([
        ["m-1", true],
        ["m-2", false],
        ["m-3", true],
        ["m-4", false],
      ]);
      expect(view.saveButton()?.disabled).toBe(false);
    } finally {
      await view.cleanup();
    }
  });

  test("a stored id absent from the catalog is listed and checked, never dropped", async () => {
    const view = await mount({ catalogModelIds: CATALOG, storedModelIds: ["m-1", "legacy-model"] });
    try {
      const boxes = view.checkboxes();
      expect(boxes).toHaveLength(5);
      const legacy = boxes.find((box) => box.nextElementSibling?.textContent === "legacy-model");
      expect(legacy?.checked).toBe(true);
      // Saving keeps the orphan id in the POST body.
      await view.click(view.saveButton());
      expect(view.calls).toEqual([
        { op: "update-provider-models", provider: "my-gateway", model_ids: "m-1,legacy-model" },
      ]);
    } finally {
      await view.cleanup();
    }
  });

  test("the search field filters case-insensitively and keeps checked state", async () => {
    const view = await mount({ catalogModelIds: ["GPT-4o", "claude-4", "gpt-4o-mini"], storedModelIds: ["GPT-4o"] });
    try {
      await view.type(view.search(), "gpt-4");
      const visible = view.checkboxes();
      expect(visible.map((box) => box.nextElementSibling?.textContent)).toEqual(["GPT-4o", "gpt-4o-mini"]);
      expect(visible[0]?.checked).toBe(true);
      expect(visible[1]?.checked).toBe(false);
      // Clearing the filter brings everything back with state intact.
      await view.type(view.search(), "");
      expect(view.checkboxes()).toHaveLength(3);
    } finally {
      await view.cleanup();
    }
  });

  test("no match states the query and lists nothing", async () => {
    const view = await mount({ catalogModelIds: CATALOG, storedModelIds: ["m-1"] });
    try {
      await view.type(view.search(), "zzz");
      expect(view.checkboxes()).toHaveLength(0);
      expect(view.dialog()?.textContent).toContain(t(locale, "settings.providers.models.noMatch", { query: "zzz" }));
    } finally {
      await view.cleanup();
    }
  });

  test("the counter states the cap; at 32 an unchecked box is disabled", async () => {
    const catalog = Array.from({ length: MAX_PROVIDER_MODEL_IDS + 1 }, (_, index) => `m-${index + 1}`);
    const stored = catalog.slice(0, MAX_PROVIDER_MODEL_IDS);
    const view = await mount({ catalogModelIds: catalog, storedModelIds: stored });
    try {
      expect(view.dialog()?.textContent).toContain(
        t(locale, "settings.providers.models.counter", { selected: MAX_PROVIDER_MODEL_IDS, max: MAX_PROVIDER_MODEL_IDS }),
      );
      expect(view.dialog()?.textContent).toContain(
        t(locale, "settings.providers.models.capReached", { max: MAX_PROVIDER_MODEL_IDS }),
      );
      const unchecked = view.checkboxes().filter((box) => !box.checked);
      expect(unchecked).toHaveLength(1);
      expect(unchecked[0]?.disabled).toBe(true);
      expect(view.buttonByLabel("settings.providers.models.selectAll")?.disabled).toBe(true);
      // Unchecking one re-enables the unchecked box and drops the cap note.
      await view.click(view.checkboxes()[0]);
      expect(view.checkboxes().at(-1)?.disabled).toBe(false);
      expect(view.dialog()?.textContent).not.toContain(
        t(locale, "settings.providers.models.capReached", { max: MAX_PROVIDER_MODEL_IDS }),
      );
    } finally {
      await view.cleanup();
    }
  });

  test("select-none clears every box and disables save; select-all checks everything", async () => {
    const view = await mount({ catalogModelIds: CATALOG, storedModelIds: ["m-1", "m-2"] });
    try {
      await view.click(view.buttonByLabel("settings.providers.models.selectNone"));
      expect(view.checkboxes().every((box) => !box.checked)).toBe(true);
      expect(view.saveButton()?.disabled).toBe(true);
      expect(view.dialog()?.textContent).toContain(
        t(locale, "settings.providers.models.counter", { selected: 0, max: MAX_PROVIDER_MODEL_IDS }),
      );
      await view.click(view.buttonByLabel("settings.providers.models.selectAll"));
      expect(view.checkboxes().every((box) => box.checked)).toBe(true);
      expect(view.saveButton()?.disabled).toBe(false);
    } finally {
      await view.cleanup();
    }
  });

  test("save posts the op and the joined ids, reports success and closes", async () => {
    const view = await mount({ catalogModelIds: CATALOG, storedModelIds: ["m-1"] });
    try {
      await view.click(view.checkboxes()[3]); // m-4
      await view.click(view.saveButton());
      expect(view.calls).toEqual([
        { op: "update-provider-models", provider: "my-gateway", model_ids: "m-1,m-4" },
      ]);
      expect(view.outcomes).toEqual([notice("success", "stored")]);
      expect(view.dialog()).toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  test("a rejected submit stays open with the selection intact", async () => {
    const view = await mount({
      catalogModelIds: CATALOG,
      storedModelIds: ["m-1"],
      onSettings: async () => notice("error", "The provider rejected the rewrite."),
    });
    try {
      await view.click(view.saveButton());
      expect(view.dialog()).not.toBeNull();
      expect(view.dialog()?.textContent).toContain("The provider rejected the rewrite.");
      expect(view.checkboxes()[0]?.checked).toBe(true);
      expect(view.calls).toHaveLength(0); // the rejecting stub records nothing
    } finally {
      await view.cleanup();
    }
  });

  test("reopening re-seeds from the stored list — a cancelled edit leaves no trace", async () => {
    const view = await mount({ catalogModelIds: CATALOG, storedModelIds: ["m-1"] });
    try {
      await view.click(view.checkboxes()[1]); // select m-2
      expect(view.checkboxes()[1]?.checked).toBe(true);
      // Cancel closes without saving; the harness's reopen control opens it again.
      await view.click(view.buttonByLabel("common.cancel"));
      expect(view.dialog()).toBeNull();
      await view.click(view.win.document.querySelector("[data-testid=reopen]") as unknown as Element);
      expect(view.checkboxes()[1]?.checked).toBe(false);
      expect(view.checkboxes()[0]?.checked).toBe(true);
    } finally {
      await view.cleanup();
    }
  });
});
