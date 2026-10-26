/**
 * The one happy-dom install for the SPA suites.
 *
 * `react-dom/client` latches `canUseDOM` when it is evaluated, and Radix latches
 * the same answer in `@radix-ui/primitive`. Module evaluated while no DOM exists
 * → React's event plugins never register (a controlled input's `onChange` never
 * fires) and Radix portals never open. Which module evaluates first depends on
 * the order the runner discovered FILES, not on the test, so no test file can
 * fix this on its own: a single file that imports `react-dom/client` at module
 * scope poisons every mount-based test after it.
 *
 * `warmDom()` evaluates both under a throwaway window and is called by the test
 * preload, which runs before any test module. Every later static import is then
 * a cache hit answered `true`, so a test file may import in any order and needs
 * no dynamic `import()`.
 */
import { Window } from "happy-dom";

const scope = globalThis as unknown as Record<string, unknown>;

/** happy-dom constructors the mounted React tree and Radix widgets read. */
const DOM_CONSTRUCTORS = [
  "HTMLElement",
  "HTMLInputElement",
  "HTMLFormElement",
  "HTMLButtonElement",
  "HTMLSelectElement",
  "HTMLDivElement",
  "HTMLSpanElement",
  "SVGElement",
  "Element",
  "Document",
  "DocumentFragment",
  "Text",
  "Node",
  "NodeFilter",
  "Event",
  "CustomEvent",
  "MouseEvent",
  "KeyboardEvent",
  "PointerEvent",
  "FocusEvent",
  "MutationObserver",
  "ResizeObserver",
] as const;

/** The globals a window contributes, installed by name so teardown is exact. */
function globalsOf(win: Window): Record<string, unknown> {
  const dom = win as unknown as Record<string, unknown>;
  const installed: Record<string, unknown> = {
    window: win,
    // Pages derive their API base and workspace ref from the location, so it
    // rides the stub rather than only `window`.
    location: win.location,
    document: win.document,
    navigator: win.navigator,
    getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  for (const name of DOM_CONSTRUCTORS) installed[name] = dom[name];
  return installed;
}

/**
 * Install `url`'s window as the browser globals.
 *
 * Each mount gets its own window, so tests stay isolated; teardown restores
 * whatever each name held before (Bun's own `navigator`, a test's location
 * stub) instead of leaving a hole for the next file to trip over.
 */
export function installDom(url: string): { win: Window; cleanup: () => void } {
  const win = new Window({ url });
  const installed = globalsOf(win);
  const previous = new Map<string, PropertyDescriptor | undefined>();
  for (const [key, value] of Object.entries(installed)) {
    previous.set(key, Object.getOwnPropertyDescriptor(scope, key));
    scope[key] = value;
  }
  return {
    win,
    cleanup: () => {
      for (const [key, descriptor] of previous) {
        if (descriptor === undefined) delete scope[key];
        else Object.defineProperty(scope, key, descriptor);
      }
      win.close();
    },
  };
}

/** Evaluate the DOM-latching modules once, with a throwaway window in place. */
export async function warmDom(): Promise<void> {
  const { cleanup } = installDom("http://localhost/");
  try {
    // Dynamic by necessity, not preference: a static import is hoisted above
    // the install and would latch `canUseDOM` false — the exact bug this file
    // exists to prevent. `@radix-ui/primitive` is the answer every Radix
    // package reads, so one dialog import loads it.
    await import("react-dom/client");
    await import("../../src/spa/components/ui/dialog");
  } finally {
    cleanup();
  }
}
