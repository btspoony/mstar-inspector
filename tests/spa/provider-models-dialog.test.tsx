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
  catalogLimits?: Record<string, { contextWindow: number; maxTokens: number }>;
  limitsSnapshot?: string;
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
          catalogLimits: overrides.catalogLimits ?? {},
          limitsSnapshot: overrides.limitsSnapshot ?? "2026-01-01",
          onSettings,
          onOutcome: (outcome) => {
            outcomes.push(outcome);
            overrides.onOutcome?.(outcome);
          },
        }),
    });
  await act(async () => root.render(renderTree(overrides.storedModelIds ?? [])));
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

  const detailsToggle = (): HTMLButtonElement | null =>
    buttonByLabel("settings.providers.models.detailsToggle");
  const detailSelect = (): HTMLSelectElement | null =>
    (dialog()?.querySelector("#provider-models-details select") as unknown as HTMLSelectElement | null) ?? null;
  const choose = async (target: Element | null | undefined, value: string) => {
    const setValue = Object.getOwnPropertyDescriptor(win.HTMLSelectElement.prototype, "value")?.set;
    await act(async () => {
      setValue?.call(target, value);
      target?.dispatchEvent(new win.Event("change", { bubbles: true }) as unknown as Event);
    });
  };

  const FIELD_KEYS = {
    contextWindow: "settings.providers.models.fields.contextWindow",
    maxTokens: "settings.providers.models.fields.maxTokens",
    name: "settings.providers.models.fields.name",
    input: "settings.providers.models.fields.input",
    reasoning: "settings.providers.models.fields.reasoning",
  } as const;

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
    detailsToggle,
    detailSelect,
    choose,
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
      await view.click(view.saveButton());
      expect(view.calls).toEqual([
        {
          op: "update-provider-models",
          provider: "my-gateway",
          model_ids: "m-1,legacy-model",
          models_meta: JSON.stringify({}),
        },
      ]);
    } finally {
      await view.cleanup();
    }
  });

  test("a legacy id-only declaration shows the unstated note and blank size fields", async () => {
    const view = await mount({
      catalogModelIds: CATALOG,
      storedModelIds: ["m-1"],
      catalogLimits: { "m-2": { contextWindow: 1, maxTokens: 1 } },
    });
    try {
      await view.click(view.detailsToggle());
      const sizesUnstated = t(locale, "settings.providers.models.sizesUnstated");
      expect(view.dialog()?.textContent).toContain(sizesUnstated);
      expect(sizesUnstated).toContain("unstated");
      expect(sizesUnstated).toMatch(/runtime/i);
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
      await view.click(view.detailsToggle());
      expect(view.field("m-1", "contextWindow")?.value).toBe("128000");
      expect(view.field("m-1", "maxTokens")?.value).toBe("8192");
      expect(view.field("m-1", "name")?.value).toBe("Model One");
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

  test("a catalog-supplied size is pre-filled, labelled with its snapshot, and NOT posted back", async () => {
    const view = await mount({
      catalogModelIds: CATALOG,
      storedModelIds: ["m-1"],
      catalogLimits: { "m-1": { contextWindow: 111, maxTokens: 22 } },
      limitsSnapshot: "2026-11-13",
    });
    try {
      await view.click(view.detailsToggle());
      expect(view.field("m-1", "contextWindow")?.value).toBe("111");
      expect(view.field("m-1", "maxTokens")?.value).toBe("22");
      expect(view.dialog()?.textContent).toContain(
        t(locale, "settings.providers.models.sizesFromCatalog", { snapshot: "2026-11-13" }),
      );
      expect(view.dialog()?.textContent).not.toContain(t(locale, "settings.providers.models.sizesUnstated"));
      await view.click(view.saveButton());
      expect(view.calls).toEqual([
        {
          op: "update-provider-models",
          provider: "my-gateway",
          model_ids: "m-1",
          models_meta: JSON.stringify({}),
        },
      ]);
    } finally {
      await view.cleanup();
    }
  });

  test("a typed size beside a catalog-seeded one is labelled mixed, not catalog", async () => {
    const view = await mount({
      catalogModelIds: CATALOG,
      storedModelIds: ["m-1"],
      catalogLimits: { "m-1": { contextWindow: 111, maxTokens: 22 } },
      limitsSnapshot: "2026-11-13",
    });
    try {
      await view.click(view.detailsToggle());
      await view.type(view.field("m-1", "contextWindow"), "999");
      const text = view.dialog()?.textContent ?? "";
      expect(text).toContain(
        t(locale, "settings.providers.models.sizesFromMixed", { snapshot: "2026-11-13" }),
      );
      expect(text).not.toContain(
        t(locale, "settings.providers.models.sizesFromCatalog", { snapshot: "2026-11-13" }),
      );
      expect(text).not.toContain(t(locale, "settings.providers.models.sizesFromDeclaration"));
    } finally {
      await view.cleanup();
    }
  });

  test("editing a catalog-supplied size posts only that override; the untouched one stays out", async () => {
    const view = await mount({
      catalogModelIds: CATALOG,
      storedModelIds: ["m-1"],
      catalogLimits: { "m-1": { contextWindow: 111, maxTokens: 22 } },
    });
    try {
      await view.click(view.detailsToggle());
      await view.type(view.field("m-1", "contextWindow"), "999");
      await view.click(view.saveButton());
      expect(view.calls).toEqual([
        {
          op: "update-provider-models",
          provider: "my-gateway",
          model_ids: "m-1",
          models_meta: JSON.stringify({ "m-1": { contextWindow: 999 } }),
        },
      ]);
    } finally {
      await view.cleanup();
    }
  });

  test("only a part of the catalog value stated still sends just the stated side", async () => {
    const view = await mount({
      catalogModelIds: CATALOG,
      storedModelIds: ["m-1"],
      storedModelsMeta: { "m-1": { contextWindow: 111 } },
      catalogLimits: { "m-1": { contextWindow: 111, maxTokens: 22 } },
    });
    try {
      await view.click(view.detailsToggle());
      expect(view.field("m-1", "contextWindow")?.value).toBe("111");
      expect(view.field("m-1", "maxTokens")?.value).toBe("22");
      await view.click(view.saveButton());
      expect(view.calls).toEqual([
        {
          op: "update-provider-models",
          provider: "my-gateway",
          model_ids: "m-1",
          models_meta: JSON.stringify({ "m-1": { contextWindow: 111 } }),
        },
      ]);
    } finally {
      await view.cleanup();
    }
  });

  test("the detail editor is folded away by default — no detail field is in the markup", async () => {
    const view = await mount({
      catalogModelIds: CATALOG,
      storedModelIds: ["m-1", "m-2"],
      catalogLimits: { "m-3": { contextWindow: 1, maxTokens: 1 } },
    });
    try {
      const toggle = view.detailsToggle();
      expect(toggle).not.toBeNull();
      expect(toggle?.getAttribute("aria-expanded")).toBe("false");
      expect(view.field("m-1", "contextWindow")).toBeNull();
      expect(view.detailSelect()).toBeNull();
      const closed = view.dialog()?.textContent ?? "";
      expect(closed).not.toContain(t(locale, "settings.providers.models.requirements"));
      expect(closed).not.toContain(t(locale, "settings.providers.models.sizesUnstated"));

      await view.click(toggle);
      expect(view.detailsToggle()?.getAttribute("aria-expanded")).toBe("true");
      expect(view.detailSelect()?.value).toBe("m-1");
      expect([...(view.detailSelect()?.options ?? [])].map((option) => option.value)).toEqual(["m-1", "m-2"]);
      expect(view.dialog()?.textContent).toContain(t(locale, "settings.providers.models.requirements"));
      expect(view.field("m-1", "contextWindow")).not.toBeNull();
      expect(view.field("m-2", "contextWindow")).toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  test("one picker swaps a single model's fields and keeps what was typed for the others", async () => {
    const stored = {
      "m-1": { contextWindow: 128000, maxTokens: 8192, name: "Model One" },
      "m-2": { contextWindow: 4000, maxTokens: 512 },
    };
    const view = await mount({ catalogModelIds: CATALOG, storedModelIds: ["m-1", "m-2"], storedModelsMeta: stored });
    try {
      await view.click(view.detailsToggle());
      expect(view.field("m-1", "name")?.value).toBe("Model One");
      await view.type(view.field("m-1", "name"), "Model One Edited");

      await view.choose(view.detailSelect(), "m-2");
      expect(view.field("m-2", "contextWindow")?.value).toBe("4000");
      expect(view.field("m-1", "contextWindow")).toBeNull();
      await view.type(view.field("m-2", "name"), "Model Two");

      await view.choose(view.detailSelect(), "m-1");
      expect(view.field("m-1", "name")?.value).toBe("Model One Edited");

      await view.click(view.checkboxes()[1]);
      expect([...(view.detailSelect()?.options ?? [])].map((option) => option.value)).toEqual(["m-1"]);
      await view.click(view.saveButton());
      expect(view.calls).toEqual([
        {
          op: "update-provider-models",
          provider: "my-gateway",
          model_ids: "m-1",
          models_meta: JSON.stringify({
            "m-1": { contextWindow: 128000, maxTokens: 8192, name: "Model One Edited" },
          }),
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
      const selectAll = view.buttonByLabel("settings.providers.models.selectAll");
      expect(selectAll?.disabled).toBe(false);
      await view.click(selectAll);
      expect(view.dialog()?.textContent).toContain(
        t(locale, "settings.providers.models.counter", {
          selected: MAX_CUSTOM_PROVIDER_MODEL_IDS,
          max: MAX_CUSTOM_PROVIDER_MODEL_IDS,
        }),
      );
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
      await view.click(view.checkboxes()[3]);
      await view.click(view.saveButton());
      expect(view.calls).toEqual([
        {
          op: "update-provider-models",
          provider: "my-gateway",
          model_ids: "m-1,m-4",
          models_meta: JSON.stringify({}),
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
      expect(view.calls).toHaveLength(0);
    } finally {
      await view.cleanup();
    }
  });

  test("a background reload with equal stored ids does not wipe the in-progress selection", async () => {
    const view = await mount({ catalogModelIds: CATALOG, storedModelIds: ["m-1"] });
    try {
      await view.click(view.checkboxes()[1]);
      expect(view.checkboxes()[1]?.checked).toBe(true);
      await view.reload(["m-1"]);
      expect(view.checkboxes()[1]?.checked).toBe(true);
      expect(view.checkboxes()[0]?.checked).toBe(true);
    } finally {
      await view.cleanup();
    }
  });

  test("the copy states the fact and the next step — never a policy disclaimer", () => {
    for (const loc of ["en", "zh_CN"] as const) {
      for (const key of [
        "settings.providers.models.requirements",
        "settings.providers.models.sizesUnstated",
        "settings.providers.models.sizesFromCatalog",
      ] as const) {
        const copy = t(loc, key, { model: "m-1", snapshot: "2026-11-13" });
        expect(copy.toLowerCase()).not.toContain("guess");
        expect(copy).not.toContain("猜测");
      }
    }
    expect(t(locale, "settings.providers.models.requirements")).toMatch(/compacted/);
    expect(t(locale, "settings.providers.models.requirements")).toMatch(/reply/);
    expect(t(locale, "settings.providers.models.requirements")).toContain("unstated");
    const unstated = t(locale, "settings.providers.models.sizesUnstated");
    expect(unstated).toContain("unstated");
    expect(unstated).toMatch(/runtime/i);
    expect(unstated).not.toMatch(/not usable|failover/i);
    expect(t("zh_CN", "settings.providers.models.sizesUnstated")).toContain("未声明");
    expect(t("zh_CN", "settings.providers.models.sizesUnstated")).toContain("运行时");
    expect(t("zh_CN", "settings.providers.models.requirements")).toContain("未声明");
    expect(t("zh_CN", "settings.providers.models.requirements")).not.toMatch(/都需要|必须填写/);
    expect(t(locale, "settings.providers.models.sizesFromCatalog", { snapshot: "2026-11-13" })).toContain("2026-11-13");
  });

  test("reopening re-seeds from the stored list — a cancelled edit leaves no trace", async () => {
    const view = await mount({ catalogModelIds: CATALOG, storedModelIds: ["m-1"] });
    try {
      await view.click(view.checkboxes()[1]);
      expect(view.checkboxes()[1]?.checked).toBe(true);
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

describe("ProviderModelsDialog — sizes no catalogue states", () => {
  test("renders the unknown-provider sentence and no catalogue-provenance line", async () => {
    const view = await mount({ catalogModelIds: CATALOG, storedModelIds: ["m-1"], catalogLimits: {} });
    try {
      await view.click(view.detailsToggle());
      const text = view.dialog()?.textContent ?? "";
      expect(text).toContain(t(locale, "settings.providers.models.sizesUnknownProvider"));
      expect(text).not.toContain(t(locale, "settings.providers.models.requirements"));
      expect(text).not.toContain(t(locale, "settings.providers.models.sizesUnstated"));
      expect(text).not.toContain("2026-11-13");
    } finally {
      await view.cleanup();
    }
  });

  test("both size fields start blank and neither is a save precondition", async () => {
    const view = await mount({ catalogModelIds: CATALOG, storedModelIds: ["m-1"], catalogLimits: {} });
    try {
      await view.click(view.detailsToggle());
      expect(view.field("m-1", "contextWindow")?.value).toBe("");
      expect(view.field("m-1", "maxTokens")?.value).toBe("");
      expect(view.field("m-1", "contextWindow")?.required).toBe(false);
      expect(view.field("m-1", "maxTokens")?.required).toBe(false);
      expect(view.saveButton()?.disabled).toBe(false);
    } finally {
      await view.cleanup();
    }
  });

  test("a blank pair saves a declaration with no size entry at all", async () => {
    const view = await mount({ catalogModelIds: CATALOG, storedModelIds: ["m-1"], catalogLimits: {} });
    try {
      await view.click(view.detailsToggle());
      await view.click(view.saveButton());
      expect(view.calls).toEqual([
        {
          op: "update-provider-models",
          provider: "my-gateway",
          model_ids: "m-1",
          models_meta: JSON.stringify({}),
        },
      ]);
    } finally {
      await view.cleanup();
    }
  });

  test("typing ONE size stores that one alone and leaves the other absent", async () => {
    const view = await mount({ catalogModelIds: CATALOG, storedModelIds: ["m-1"], catalogLimits: {} });
    try {
      await view.click(view.detailsToggle());
      await view.type(view.field("m-1", "contextWindow"), "200000");
      await view.click(view.saveButton());
      expect(view.calls).toEqual([
        {
          op: "update-provider-models",
          provider: "my-gateway",
          model_ids: "m-1",
          models_meta: JSON.stringify({ "m-1": { contextWindow: 200000 } }),
        },
      ]);
    } finally {
      await view.cleanup();
    }
  });

  test("the round-trip: a partial set posts as-is and re-seeds as stored", async () => {
    const view = await mount({
      catalogModelIds: CATALOG,
      storedModelIds: ["m-1"],
      storedModelsMeta: { "m-1": { contextWindow: 200000 } },
      catalogLimits: {},
    });
    try {
      await view.click(view.detailsToggle());
      expect(view.field("m-1", "contextWindow")?.value).toBe("200000");
      expect(view.field("m-1", "maxTokens")?.value).toBe("");
      await view.click(view.saveButton());
      expect(view.calls).toEqual([
        {
          op: "update-provider-models",
          provider: "my-gateway",
          model_ids: "m-1",
          models_meta: JSON.stringify({ "m-1": { contextWindow: 200000 } }),
        },
      ]);
    } finally {
      await view.cleanup();
    }
  });

  test("a catalogue that exists says 'unstated', not 'no catalog sizes'", async () => {
    const view = await mount({
      catalogModelIds: CATALOG,
      storedModelIds: ["m-1"],
      catalogLimits: { "m-2": { contextWindow: 111, maxTokens: 22 } },
    });
    try {
      await view.click(view.detailsToggle());
      const text = view.dialog()?.textContent ?? "";
      expect(text).toContain(t(locale, "settings.providers.models.sizesUnstated"));
      expect(text).not.toContain(t(locale, "settings.providers.models.sizesUnknownProvider"));
    } finally {
      await view.cleanup();
    }
  });
});
