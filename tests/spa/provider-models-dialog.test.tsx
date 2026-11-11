/**
 * The model picker dialog: one checkbox per catalog model (stored ids
 * checked), stored ids the catalog no longer lists stay listed and checked,
 * case-insensitive filtering keeps checked state, the selected / max counter
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
import { MAX_CUSTOM_PROVIDER_MODEL_IDS } from "../../src/contracts/provider-models";
import { ProviderModelsDialog } from "../../src/spa/pages/provider-models-dialog";
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
  storedModelsMeta?: Record<string, { contextWindow?: number; maxTokens?: number; name?: string; reasoning?: boolean; input?: string[] }>;
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
  const renderTree = (storedModelIds: string[]) =>
    createElement(Opener, {
      factory: (open, onOpenChange) =>
        createElement(ProviderModelsDialog, {
          locale,
          open,
          onOpenChange,
          provider: "my-gateway",
          label: "My Gateway",
          storedModelIds,
          storedModelsMeta: overrides.storedModelsMeta,
          catalogModelIds: overrides.catalogModelIds ?? [],
          onSettings,
          onOutcome: (outcome) => {
            outcomes.push(outcome);
            overrides.onOutcome?.(outcome);
          },
        }),
    });
  await act(async () => root.render(renderTree(overrides.storedModelIds ?? [])));
  // Simulate a background reload: a fresh array identity, equal contents.
  const reload = async (storedModelIds: string[]) => {
    await act(async () => root.render(renderTree(storedModelIds)));
  };
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

  const FIELD_KEYS = {
    contextWindow: "settings.providers.models.fields.contextWindow",
    maxTokens: "settings.providers.models.fields.maxTokens",
    name: "settings.providers.models.fields.name",
    input: "settings.providers.models.fields.input",
    reasoning: "settings.providers.models.fields.reasoning",
  } as const;

  /** One per-model fact input, found by its model-scoped label. */
  const field = (modelId: string, key: keyof typeof FIELD_KEYS) =>
    dialog()?.querySelector(
      `[aria-label="${t(locale, FIELD_KEYS[key], { model: modelId })}"]`,
    ) as unknown as HTMLInputElement | null;

  return {
    win,
    dialog,
    checkboxes,
    saveButton,
    buttonByLabel,
    click,
    type,
    search,
    field,
    calls,
    outcomes,
    reload,
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
      // The overlay is ALWAYS posted (one entry per selected id, blanks
      // absent) so the server can refuse an incomplete statement instead of
      // reading an omitted field as "no statement".
      expect(view.calls).toEqual([
        {
          op: "update-provider-models",
          provider: "my-gateway",
          model_ids: "m-1,legacy-model",
          models_meta: JSON.stringify({ "m-1": {}, "legacy-model": {} }),
        },
      ]);
    } finally {
      await view.cleanup();
    }
  });

  test("a legacy id-only declaration shows the not-usable note and blank size fields", async () => {
    const view = await mount({ catalogModelIds: CATALOG, storedModelIds: ["m-1"] });
    try {
      // The sentence is a DATA statement about the declaration, never a
      // runtime promise: the pinned registry back-fills its own defaults for
      // an id-only model, so claiming the file blocks failover would be false.
      const sizesUnstated = t(locale, "settings.providers.models.sizesUnstated");
      expect(view.dialog()?.textContent).toContain(sizesUnstated);
      expect(sizesUnstated).toContain("unstated");
      expect(sizesUnstated).toContain("incomplete");
      expect(sizesUnstated).not.toMatch(/not usable|failover/i);
      expect(view.field("m-1", "contextWindow")?.value).toBe("");
      expect(view.field("m-1", "maxTokens")?.value).toBe("");
      expect(view.field("m-1", "name")?.value).toBe("");
    } finally {
      await view.cleanup();
    }
  });

  test("stated per-model facts are seeded from the store and posted back verbatim", async () => {
    const stored = {
      "m-1": { contextWindow: 128000, maxTokens: 8192, name: "Model One", reasoning: true, input: ["text"] },
    };
    const view = await mount({ catalogModelIds: CATALOG, storedModelIds: ["m-1"], storedModelsMeta: stored });
    try {
      // Round-trip: the stored values are the seed, so an untouched save
      // re-sends exactly what the owner stated.
      expect(view.field("m-1", "contextWindow")?.value).toBe("128000");
      expect(view.field("m-1", "maxTokens")?.value).toBe("8192");
      expect(view.field("m-1", "name")?.value).toBe("Model One");
      // A legacy row is not shown as usable: the note disappears once stated.
      expect(view.dialog()?.textContent).not.toContain(t(locale, "settings.providers.models.sizesUnstated"));
      await view.click(view.saveButton());
      expect(view.calls).toEqual([
        {
          op: "update-provider-models",
          provider: "my-gateway",
          model_ids: "m-1",
          models_meta: JSON.stringify(stored),
        },
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

  test("the counter states the cap; at the cap an unchecked box is disabled", async () => {
    const catalog = Array.from({ length: MAX_CUSTOM_PROVIDER_MODEL_IDS + 1 }, (_, index) => `m-${index + 1}`);
    const stored = catalog.slice(0, MAX_CUSTOM_PROVIDER_MODEL_IDS);
    const view = await mount({ catalogModelIds: catalog, storedModelIds: stored });
    try {
      expect(view.dialog()?.textContent).toContain(
        t(locale, "settings.providers.models.counter", { selected: MAX_CUSTOM_PROVIDER_MODEL_IDS, max: MAX_CUSTOM_PROVIDER_MODEL_IDS }),
      );
      expect(view.dialog()?.textContent).toContain(
        t(locale, "settings.providers.models.capReached", { max: MAX_CUSTOM_PROVIDER_MODEL_IDS }),
      );
      const unchecked = view.checkboxes().filter((box) => !box.checked);
      expect(unchecked).toHaveLength(1);
      expect(unchecked[0]?.disabled).toBe(true);
      // Select-all reflects the visible list, so the cap alone does not
      // disable it — and it cannot push the selection past the bound.
      const selectAll = view.buttonByLabel("settings.providers.models.selectAll");
      expect(selectAll?.disabled).toBe(false);
      await view.click(selectAll);
      expect(view.dialog()?.textContent).toContain(
        t(locale, "settings.providers.models.counter", {
          selected: MAX_CUSTOM_PROVIDER_MODEL_IDS,
          max: MAX_CUSTOM_PROVIDER_MODEL_IDS,
        }),
      );
      // Unchecking one re-enables the unchecked box and drops the cap note.
      await view.click(view.checkboxes()[0]);
      expect(view.checkboxes().at(-1)?.disabled).toBe(false);
      expect(view.dialog()?.textContent).not.toContain(
        t(locale, "settings.providers.models.capReached", { max: MAX_CUSTOM_PROVIDER_MODEL_IDS }),
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
        t(locale, "settings.providers.models.counter", { selected: 0, max: MAX_CUSTOM_PROVIDER_MODEL_IDS }),
      );
      await view.click(view.buttonByLabel("settings.providers.models.selectAll"));
      expect(view.checkboxes().every((box) => box.checked)).toBe(true);
      expect(view.saveButton()?.disabled).toBe(false);
    } finally {
      await view.cleanup();
    }
  });

  test("select-all acts on the rendered list, never on ids the filter hides", async () => {
    const view = await mount({
      catalogModelIds: ["alpha-1", "beta-2", "alpha-3"],
      storedModelIds: [],
    });
    try {
      await view.type(view.search(), "alpha");
      expect(view.checkboxes()).toHaveLength(2);

      await view.click(view.buttonByLabel("settings.providers.models.selectAll"));
      expect(view.checkboxes().every((box) => box.checked)).toBe(true);
      // What the operator saw is what got selected: the hidden id stays out.
      expect(view.dialog()?.textContent).toContain(
        t(locale, "settings.providers.models.counter", { selected: 2, max: MAX_CUSTOM_PROVIDER_MODEL_IDS }),
      );
      await view.type(view.search(), "");
      expect(view.checkboxes().map((box) => box.checked)).toEqual([true, false, true]);
    } finally {
      await view.cleanup();
    }
  });

  test("a duplicated stored id renders one row, not two rows sharing one checkbox", async () => {
    const view = await mount({
      catalogModelIds: CATALOG,
      storedModelIds: ["legacy-model", "legacy-model"],
    });
    try {
      expect(view.checkboxes().map((box) => box.nextElementSibling?.textContent)).toEqual([
        ...CATALOG,
        "legacy-model",
      ]);
      expect(view.dialog()?.textContent).toContain(
        t(locale, "settings.providers.models.counter", { selected: 1, max: MAX_CUSTOM_PROVIDER_MODEL_IDS }),
      );
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
        {
          op: "update-provider-models",
          provider: "my-gateway",
          model_ids: "m-1,m-4",
          models_meta: JSON.stringify({ "m-1": {}, "m-4": {} }),
        },
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

  test("a background reload with equal stored ids does not wipe the in-progress selection", async () => {
    const view = await mount({ catalogModelIds: CATALOG, storedModelIds: ["m-1"] });
    try {
      await view.click(view.checkboxes()[1]); // select m-2
      expect(view.checkboxes()[1]?.checked).toBe(true);
      // The settings page reloads in the background: same ids, new array identity.
      await view.reload(["m-1"]);
      expect(view.checkboxes()[1]?.checked).toBe(true); // m-2 stays selected
      expect(view.checkboxes()[0]?.checked).toBe(true);
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
