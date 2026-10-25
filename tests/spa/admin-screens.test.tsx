/**
 * The console's flags and workspaces screens: each screen's loading, error,
 * empty and populated states, plus the writes they own — the flag toggle and
 * the per-row plan picker (exactly ONE PATCH).
 *
 * Mounted in happy-dom (support-notice / create-workspace precedents) because
 * the states live in effects and both controls are Radix widgets that only
 * answer real events. The screen modules are imported AFTER the browser globals
 * exist: React DOM and Radix read DOM availability at module-evaluation time.
 */
import { describe, expect, test } from "bun:test";
import { act, createElement, type ReactElement } from "react";
import { Window, type Element as DomElement } from "happy-dom";

const realFetch = globalThis.fetch;

/**
 * Installs the browser globals a mounted console needs. The Radix Select
 * mounts a portalled listbox that reads form and element constructors, so the
 * set is wider than the dropdown-menu precedent's.
 */
function installDom(url: string) {
  const win = new Window({ url });
  const scope = globalThis as unknown as Record<string, unknown>;
  const dom = win as unknown as Record<string, unknown>;
  const installed: Record<string, unknown> = {
    window: win,
    document: win.document,
    navigator: win.navigator,
    ...Object.fromEntries(
      [
        "HTMLElement",
        "Element",
        "Node",
        "Event",
        "CustomEvent",
        "MouseEvent",
        "KeyboardEvent",
        "PointerEvent",
        "FocusEvent",
        "HTMLInputElement",
        "HTMLFormElement",
        "HTMLButtonElement",
        "HTMLSelectElement",
        "HTMLDivElement",
        "HTMLSpanElement",
        "SVGElement",
        "DocumentFragment",
        "Text",
        "Document",
        "NodeFilter",
        "MutationObserver",
        "ResizeObserver",
      ].map((name) => [name, dom[name]]),
    ),
    getComputedStyle: win.getComputedStyle.bind(win),
    requestAnimationFrame: win.requestAnimationFrame.bind(win),
    cancelAnimationFrame: win.cancelAnimationFrame.bind(win),
    IS_REACT_ACT_ENVIRONMENT: true,
  };
  Object.assign(scope, installed);
  return {
    win,
    cleanup: () => {
      for (const key of Object.keys(installed)) delete scope[key];
      win.close();
    },
  };
}

type Sent = { url: string; method: string; body: unknown };
type Respond = (request: Sent) => Response | Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** The mounted screen a test drives: wire log, DOM text and the event helpers. */
type Surface = {
  win: Window;
  container: DomElement;
  sent: Sent[];
  text: () => string;
  click: (node: DomElement | null) => Promise<void>;
  openSelect: (trigger: DomElement | null) => Promise<void>;
  pickOption: (label: string) => Promise<DomElement | null>;
  type: (selector: string, value: string) => Promise<void>;
  close: () => Promise<void>;
};

/**
 * Mount one screen with a stubbed console API and settle its first read.
 *
 * `create` runs only after the happy-dom globals exist: Radix's packages decide
 * DOM availability at module-evaluation time, so a screen imported earlier
 * mounts a select whose portal never opens.
 */
async function mount(create: () => Promise<ReactElement>, respond: Respond): Promise<Surface> {
  const { win, cleanup } = installDom("http://localhost/_internal_admin");
  const sent: Sent[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const request: Sent = {
      url: String(input),
      method: init?.method ?? "GET",
      body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
    };
    sent.push(request);
    return respond(request);
  }) as typeof fetch;

  // Literal path, not a runtime choice: React DOM caches DOM availability at
  // evaluation time, so this import has to follow the happy-dom globals.
  const { createRoot } = await import("react-dom/client");
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  const element = await create();
  await act(async () => root.render(element));
  // One extra flush drains the read's own continuation (its .then setState).
  await act(async () => {});

  return {
    win,
    container,
    sent,
    text: () => container.textContent ?? "",
    /** Click a node, then drain the write and its continuation. */
    async click(node: DomElement | null) {
      await act(async () => {
        node?.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      });
      await act(async () => {});
    },
    /** Open a Radix Select trigger (pointerdown is what Radix listens for). */
    async openSelect(trigger: DomElement | null) {
      await act(async () => {
        trigger?.dispatchEvent(
          new win.PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }),
        );
        trigger?.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      });
    },
    /** Choose the portalled option whose text is exactly `label`. */
    async pickOption(label: string) {
      const option = [...win.document.querySelectorAll('[role="option"]')].find(
        (node) => node.textContent === label,
      );
      await act(async () => {
        option?.dispatchEvent(
          new win.PointerEvent("pointerup", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }),
        );
        option?.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      });
      await act(async () => {});
      return option ?? null;
    },
    /** Type into a controlled input the way React's value tracker expects. */
    async type(selector: string, value: string) {
      const input = container.querySelector(selector);
      const setValue = Object.getOwnPropertyDescriptor(win.HTMLInputElement.prototype, "value")?.set;
      await act(async () => {
        setValue?.call(input, value);
        input?.dispatchEvent(new win.Event("input", { bubbles: true }));
      });
    },
    async close() {
      await act(async () => root.unmount());
      globalThis.fetch = realFetch;
      cleanup();
    },
  };
}

async function flagsScreen(respond: Respond): Promise<Surface> {
  return mount(async () => {
    const { FlagsPage } = await import("../../src/spa/admin/FlagsPage");
    return createElement(FlagsPage);
  }, respond);
}

async function workspacesScreen(respond: Respond): Promise<Surface> {
  return mount(async () => {
    const { WorkspacesPage } = await import("../../src/spa/admin/WorkspacesPage");
    return createElement(WorkspacesPage);
  }, respond);
}

const never = () => new Promise<Response>(() => {});
const failed = () => new Response("boom", { status: 500 });

/** The table row that carries `needle`, so a control is located by its row. */
function rowContaining(surface: Surface, needle: string): DomElement | null {
  return [...surface.container.querySelectorAll("tr")].find((row) => row.textContent?.includes(needle)) ?? null;
}

const FLAGS = [
  { key: "review_global", enabled: true },
  { key: "signup_open", enabled: true },
  { key: "workspace_creation_open", enabled: false },
];

const WORKSPACES = [
  {
    id: "ws_1",
    name: "Acme",
    slug: "acme",
    ownerLogin: "octocat",
    memberCount: 3,
    pendingInviteCount: 1,
    planId: "free",
    createdAt: "2026-10-02T09:00:00.000Z",
  },
  {
    id: "ws_2",
    name: "Guild",
    slug: "guild",
    ownerLogin: null,
    memberCount: 5,
    pendingInviteCount: 0,
    planId: "pro",
    createdAt: "2026-09-18T09:00:00.000Z",
  },
];

describe("Flags screen", () => {
  test("loading renders the table skeleton", async () => {
    const surface = await flagsScreen(never);
    expect(surface.container.querySelector('[data-slot="page-skeleton"]')).not.toBeNull();
    await surface.close();
  });

  test("a failed read renders the error with a retry that reloads", async () => {
    let failing = true;
    const surface = await flagsScreen(() => (failing ? failed() : json({ flags: FLAGS })));
    expect(surface.container.querySelector('[data-slot="error-state"]')?.textContent).toContain(
      "Could not load the server flags.",
    );

    failing = false;
    await surface.click(surface.container.querySelector('[data-slot="error-state"] button'));
    expect(surface.text()).toContain("review_global");
    await surface.close();
  });

  test("an empty list renders the empty state", async () => {
    const surface = await flagsScreen(() => json({ flags: [] }));
    expect(surface.container.querySelector('[data-slot="empty-state"]')?.textContent).toContain("No flags");
    await surface.close();
  });

  test("rows show each flag, its effect and its state", async () => {
    const surface = await flagsScreen(() => json({ flags: FLAGS }));
    expect(surface.text()).toContain("review_global");
    expect(surface.text()).toContain("signup_open");
    expect(surface.text()).toContain("workspace_creation_open");
    // The spec's cancellation note belongs to review_global only.
    expect(surface.text()).toContain("Queued work is not cancelled.");
    expect(rowContaining(surface, "review_global")?.querySelector('[data-slot="toggle"]')?.textContent).toBe("On");
    expect(
      rowContaining(surface, "workspace_creation_open")?.querySelector('[data-slot="toggle"]')?.textContent,
    ).toBe("Off");
    await surface.close();
  });

  test("a toggle writes exactly one PATCH and applies the new value", async () => {
    const surface = await flagsScreen((request) =>
      request.method === "PATCH" ? json({ key: "review_global", enabled: false }) : json({ flags: FLAGS }),
    );
    const toggle = rowContaining(surface, "review_global")?.querySelector('[data-slot="toggle"]') ?? null;
    await surface.click(toggle);

    const patches = surface.sent.filter((request) => request.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]?.url).toBe("/_internal_admin/api/flags");
    expect(patches[0]?.body).toEqual({ key: "review_global", enabled: false });
    expect(rowContaining(surface, "review_global")?.querySelector('[data-slot="toggle"]')?.textContent).toBe("Off");
    await surface.close();
  });
});

describe("Workspaces screen", () => {
  test("loading renders the table skeleton", async () => {
    const surface = await workspacesScreen(never);
    expect(surface.container.querySelector('[data-slot="page-skeleton"]')).not.toBeNull();
    await surface.close();
  });

  test("a failed read renders the error state", async () => {
    const surface = await workspacesScreen(failed);
    expect(surface.container.querySelector('[data-slot="error-state"]')?.textContent).toContain(
      "Could not load the workspace list.",
    );
    await surface.close();
  });

  test("an empty list renders the empty state", async () => {
    const surface = await workspacesScreen(() => json({ workspaces: [] }));
    expect(surface.container.querySelector('[data-slot="empty-state"]')?.textContent).toContain("No workspaces");
    await surface.close();
  });

  test("rows show owner, counts, plan and creation date", async () => {
    const surface = await workspacesScreen(() => json({ workspaces: WORKSPACES }));
    const acme = rowContaining(surface, "Acme");
    expect(acme?.textContent).toContain("ws_1");
    expect(acme?.textContent).toContain("octocat");
    expect(acme?.textContent).toContain("3");
    expect(acme?.textContent).toContain("1 pending");
    expect(acme?.textContent).toContain("2026-10-02");
    expect(acme?.querySelector('[data-slot="select-trigger"]')?.textContent).toBe("free");
    // An owner-less row reads as "—" rather than blank.
    expect(rowContaining(surface, "Guild")?.textContent).toContain("—");
    await surface.close();
  });

  test("the plan picker issues exactly one PATCH for the chosen plan", async () => {
    const surface = await workspacesScreen((request) =>
      request.method === "PATCH" ? json({ workspaceId: "ws_1", planId: "pro" }) : json({ workspaces: WORKSPACES }),
    );
    const row = rowContaining(surface, "Acme");
    const trigger = row?.querySelector('[data-slot="select-trigger"]') ?? null;
    await surface.openSelect(trigger);
    const picked = await surface.pickOption("pro");
    expect(picked).not.toBeNull();

    const patches = surface.sent.filter((request) => request.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]?.url).toBe("/_internal_admin/api/workspaces/ws_1/plan");
    expect(patches[0]?.body).toEqual({ planId: "pro" });
    // The accepted plan is what the row now shows.
    expect(rowContaining(surface, "Acme")?.textContent).toContain("pro");
    await surface.close();
  });
});
