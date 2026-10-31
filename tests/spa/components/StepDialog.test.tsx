/**
 * StepDialog — DESIGN.md v0.5 `step-dialog`: the multi-step entry shell on
 * ui/dialog's DialogContent (radius, `shadow-pop` elevation, `sm:max-w-lg`,
 * the spacing-6 padding and the heading-16 / label-12 title and description
 * faces are the primitive's), a label-12 step indicator rendered only past
 * one step with exactly the current step marked, and a caller-owned
 * right-aligned footer on the primitive's spacing-2 gap.
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
  test("open renders the primitive's title and description faces, plus the children", async () => {
    const view = await mount({ ...base, steps: ["Endpoint", "Key"], currentStep: 0 });
    try {
      const panel = view.dialog();
      expect(panel).not.toBeNull();
      expect(panel?.textContent).toContain("Connect provider");
      expect(panel?.textContent).toContain("Two steps: endpoint, then key.");
      expect(panel?.textContent).toContain("Endpoint form");
      // The shell composes the primitive's faces instead of re-spelling them.
      expect(view.slot("dialog-title")?.textContent).toBe("Connect provider");
      expect(view.slot("dialog-description")?.textContent).toBe(
        "Two steps: endpoint, then key.",
      );
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

  test("every step labels itself and exactly the current one is current", async () => {
    const view = await mount({ ...base, steps: ["Endpoint", "Key", "Verify"], currentStep: 1 });
    try {
      const items = view.steps();
      expect(items.map((item) => item.textContent)).toEqual(["Endpoint", "Key", "Verify"]);
      expect(view.slot("step-dialog-steps")).not.toBeNull();
      expect(items[1]?.getAttribute("aria-current")).toBe("step");
      expect(items[0]?.getAttribute("aria-current")).toBeNull();
      expect(items[2]?.getAttribute("aria-current")).toBeNull();
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

  test("the footer is the primitive's group holding the caller's actions, right-aligned", async () => {
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
      // The shell states the alignment; the spacing rhythm is the primitive's.
      expect(footer?.className).toContain("justify-end");
    } finally {
      await view.cleanup();
    }
  });

  test("two steps may share a label: both render and only the index is current", async () => {
    const original = console.error;
    const errors: string[] = [];
    console.error = (...args: unknown[]) => {
      errors.push(args.map(String).join(" "));
    };
    try {
      const view = await mount({ ...base, steps: ["Verify", "Verify"], currentStep: 1 });
      try {
        const items = view.steps();
        expect(items.map((item) => item.textContent)).toEqual(["Verify", "Verify"]);
        expect(items[1]?.getAttribute("aria-current")).toBe("step");
        expect(items[0]?.getAttribute("aria-current")).toBeNull();
        expect(errors.filter((error) => error.includes("same key"))).toEqual([]);
      } finally {
        await view.cleanup();
      }
    } finally {
      console.error = original;
    }
  });

  test("an out-of-range currentStep clamps: exactly one step stays current", async () => {
    const high = await mount({ ...base, steps: ["Endpoint", "Key", "Verify"], currentStep: 9 });
    try {
      const items = high.steps();
      expect(items[2]?.getAttribute("aria-current")).toBe("step");
      expect(items.filter((item) => item.getAttribute("aria-current") === "step")).toHaveLength(1);
    } finally {
      await high.cleanup();
    }
    const low = await mount({ ...base, steps: ["Endpoint", "Key", "Verify"], currentStep: -4 });
    try {
      const items = low.steps();
      expect(items[0]?.getAttribute("aria-current")).toBe("step");
      expect(items.filter((item) => item.getAttribute("aria-current") === "step")).toHaveLength(1);
    } finally {
      await low.cleanup();
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
