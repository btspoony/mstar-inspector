import { Window } from "happy-dom";

const scope = globalThis as unknown as Record<string, unknown>;

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

function globalsOf(win: Window): Record<string, unknown> {
  const dom = win as unknown as Record<string, unknown>;
  const installed: Record<string, unknown> = {
    window: win,
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

/**
 * Parse static markup into a throwaway document and hand the container to
 * `read`. The window is closed on the way out — including when an assertion
 * fails — so a parse never outlives its test; return plain values, not nodes,
 * because the document is gone once `read` returns. The close settles
 * asynchronously, so it is awaited: a failed teardown fails the test instead
 * of vanishing behind a discarded promise.
 *
 * `read` must be synchronous: the window closes before any `await` inside it
 * could run, so an async read is a compile error rather than a parse that
 * resolves against a closed document.
 */
export async function withMarkup<T>(
  markup: string,
  read: (container: HTMLElement) => T,
  ...sync: T extends PromiseLike<unknown> ? [error: "read must be synchronous"] : []
): Promise<T> {
  void sync;
  const win = new Window();
  try {
    win.document.body.innerHTML = markup;
    return read(win.document.body as unknown as HTMLElement);
  } finally {
    await win.happyDOM.close();
  }
}

/** Evaluate the DOM-latching modules once, with a throwaway window in place. */
export async function warmDom(): Promise<void> {
  const { cleanup } = installDom("http://localhost/");
  try {
    await import("react-dom/client");
    await import("@design-system");
  } finally {
    cleanup();
  }
}
