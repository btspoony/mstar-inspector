/**
 * StepDialog — DESIGN.md v0.4 `step-dialog`: the multi-step entry shell on
 * ui/dialog's DialogContent (radius, elevation, `sm:max-w-lg` and `p-6` are the
 * primitive's), title on heading-16, description on label-12 in gray-700, a
 * label-12 step indicator rendered only past one step — current step on
 * brand-700, the rest on gray-700 — and a caller-owned right-aligned footer on
 * the spacing-2 gap.
 *
 * Mounted, because Radix renders the panel through a portal. The shell holds no
 * busy state: a footer action cannot close it; only the caller's `open` does.
 */
import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { StepDialog } from "../../../src/spa/components/StepDialog";
import { installDom } from "../dom";

type Props = Parameters<typeof StepDialog>[0];

async function mount(props: Props) {
  const { win, cleanup: cleanupDom } = installDom("http://localhost/dashboard/acme/apps");
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  await act(async () => root.render(createElement(StepDialog, props)));
  await act(async () => {});
  return {
    win,
    dialog: () => win.document.querySelector('[role="dialog"]'),
    slot: (name: string) => win.document.querySelector(`[data-slot="${name}"]`),
    steps: () => [...win.document.querySelectorAll('[data-slot="step-dialog-step"]')],
    click: async (target: unknown) => {
      await act(async () => {
        (target as { dispatchEvent(event: Event): boolean } | undefined)?.dispatchEvent(
          new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }) as unknown as Event,
        );
      });
    },
    cleanup: async () => {
      await act(async () => root.unmount());
      cleanupDom();
    },
  };
}

const base: Props = {
  open: true,
  onOpenChange: () => {},
  title: "Connect provider",
  description: "Two steps: endpoint, then key.",
  footer: createElement("button", { type: "button" }, "Save"),
  children: createElement("p", null, "Endpoint form"),
};

describe("StepDialog", () => {
  test("open renders title, description and children on the dialog panel", async () => {
    const view = await mount({ ...base, steps: ["Endpoint", "Key"], currentStep: 0 });
    try {
      const panel = view.dialog();
      expect(panel).not.toBeNull();
      expect(panel?.textContent).toContain("Connect provider");
      expect(panel?.textContent).toContain("Two steps: endpoint, then key.");
      expect(panel?.textContent).toContain("Endpoint form");
      const title = view.slot("dialog-title");
      expect(title?.className).toContain("text-(length:--typo-heading-16-size)");
      const description = view.slot("dialog-description");
      expect(description?.className).toContain("text-(length:--typo-label-12-size)");
      expect(description?.className).toContain("text-(--gray-700)");
    } finally {
      await view.cleanup();
    }
  });

  test("closed renders no panel", async () => {
    const view = await mount({ ...base, open: false });
    try {
      expect(view.dialog()).toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  test("every step labels itself; the current one is brand-700, the rest gray-700", async () => {
    const view = await mount({ ...base, steps: ["Endpoint", "Key", "Verify"], currentStep: 1 });
    try {
      const items = view.steps();
      expect(items.map((item) => item.textContent)).toEqual(["Endpoint", "Key", "Verify"]);
      expect(view.slot("step-dialog-steps")?.className).toContain("text-(length:--typo-label-12-size)");
      expect(items[1]?.className).toContain("text-(--brand-700)");
      expect(items[1]?.getAttribute("aria-current")).toBe("step");
      expect(items[0]?.className).toContain("text-(--gray-700)");
      expect(items[0]?.getAttribute("aria-current")).toBeNull();
      expect(items[2]?.className).toContain("text-(--gray-700)");
    } finally {
      await view.cleanup();
    }
  });

  test("no steps, or a single step, renders no indicator", async () => {
    const none = await mount(base);
    try {
      expect(none.slot("step-dialog-steps")).toBeNull();
    } finally {
      await none.cleanup();
    }
    const single = await mount({ ...base, steps: ["Only"] });
    try {
      expect(single.slot("step-dialog-steps")).toBeNull();
    } finally {
      await single.cleanup();
    }
  });

  test("the footer is the caller's group, right-aligned on the spacing-2 gap", async () => {
    const view = await mount({
      ...base,
      footer: [
        createElement("button", { key: "cancel", type: "button" }, "Cancel"),
        createElement("button", { key: "save", type: "button" }, "Save"),
      ],
    });
    try {
      const footer = view.slot("dialog-footer");
      expect(footer?.textContent).toBe("CancelSave");
      expect(footer?.className).toContain("justify-end");
      expect(footer?.className).toContain("gap-2");
    } finally {
      await view.cleanup();
    }
  });

  test("a footer action does not close the shell — only the caller's open can", async () => {
    const changes: boolean[] = [];
    const view = await mount({
      ...base,
      onOpenChange: (next) => changes.push(next),
      footer: createElement("button", { type: "button" }, "Submit"),
    });
    try {
      const submit = [...view.win.document.querySelectorAll('[role="dialog"] button')].find(
        (button) => button.textContent === "Submit",
      );
      await view.click(submit);
      expect(changes).toEqual([]);
      expect(view.dialog()).not.toBeNull();
    } finally {
      await view.cleanup();
    }
  });
});
