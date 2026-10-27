/**
 * The console's four screens: each screen's loading, error,
 * empty and populated states, plus the writes they own — the flag toggle, the
 * per-row plan picker (exactly ONE PATCH) and the support-grant create/revoke.
 *
 * Mounted in happy-dom because the states live in effects and both controls
 * are Radix widgets that only answer real events.
 */
import { describe, expect, test } from "bun:test";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { type Element as DomElement, type Window } from "happy-dom";
import { FlagsPage } from "../../src/spa/admin/FlagsPage";
import { SupportGrantsPage } from "../../src/spa/admin/SupportGrantsPage";
import { UsersPage } from "../../src/spa/admin/UsersPage";
import { WorkspacesPage } from "../../src/spa/admin/WorkspacesPage";
import { installDom } from "./dom";

const realFetch = globalThis.fetch;

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

/** Mount one screen with a stubbed console API and settle its first read. */
async function mount(element: ReactElement, respond: Respond): Promise<Surface> {
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

  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
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
      // A Radix dialog portals outside the mount container, so fall back to the document.
      const input = container.querySelector(selector) ?? win.document.querySelector(selector);
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

async function flagsScreen(respond: Respond, locale: "en" | "zh_CN" = "en"): Promise<Surface> {
  return mount(createElement(FlagsPage, { locale }), respond);
}

async function workspacesScreen(respond: Respond, locale: "en" | "zh_CN" = "en"): Promise<Surface> {
  return mount(createElement(WorkspacesPage, { locale }), respond);
}

async function usersScreen(respond: Respond, locale: "en" | "zh_CN" = "en"): Promise<Surface> {
  return mount(createElement(UsersPage, { locale }), respond);
}

async function supportScreen(respond: Respond, locale: "en" | "zh_CN" = "en"): Promise<Surface> {
  return mount(createElement(SupportGrantsPage, { locale }), respond);
}

const never = () => new Promise<Response>(() => {});
const failed = () => new Response("boom", { status: 500 });

/** A held-response latch: the test resolves it when the in-flight write may land. */
type Gate = { promise: Promise<Response>; resolve: (value: Response) => void };

/** The table row that carries `needle`, so a control is located by its row. */
function rowContaining(surface: Surface, needle: string): DomElement | null {
  return [...surface.container.querySelectorAll("tr")].find((row) => row.textContent?.includes(needle)) ?? null;
}

const FLAGS = [
  { key: "review_global", enabled: true },
  { key: "signup_open", enabled: true },
  { key: "workspace_creation_open", enabled: false },
];

/** The seats cell: column 4 of Workspace | Owner | Members | Seats | Plan | Created. */
function seatsCell(surface: Surface, needle: string): string {
  const cells = rowContaining(surface, needle)?.querySelectorAll("td") ?? [];
  return cells[3]?.textContent ?? "";
}

const WORKSPACES = [
  {
    id: "ws_1",
    name: "Acme",
    slug: "acme",
    ownerLogin: "octocat",
    memberCount: 3,
    pendingInviteCount: 1,
    planId: "free",
    planName: "Free",
    includedMembers: 5,
    createdAt: "2026-10-02T09:00:00.000Z",
  },
  {
    id: "ws_2",
    name: "Guild",
    slug: "guild",
    ownerLogin: null,
    memberCount: 5,
    pendingInviteCount: 0,
    planId: "unlimited",
    planName: "Unlimited",
    // NULL is no seat cap: the cell must read "—", never "5 / 0".
    includedMembers: null,
    createdAt: "2026-09-18T09:00:00.000Z",
  },
];

const USERS = [
  {
    login: "octocat",
    createdAt: "2026-08-26T09:00:00.000Z",
    workspaceCount: 2,
    activeGrantCount: 0,
    isOperator: true,
  },
  {
    login: "ops",
    createdAt: "2026-08-30T09:00:00.000Z",
    workspaceCount: 1,
    activeGrantCount: 2,
    isOperator: false,
  },
  { login: "yuki", createdAt: "2026-09-18T09:00:00.000Z", workspaceCount: 1, activeGrantCount: 0, isOperator: false },
];

const GRANT = {
  id: "g1",
  workspace_id: "ws_1",
  operator_login: "ops",
  reason: "incident 42",
  granted_by: "octocat",
  created_at: "2026-10-25T09:00:00.000Z",
  expires_at: "2026-10-26T09:00:00.000Z",
};

const GRANT2 = { ...GRANT, id: "g2", operator_login: "yuki", reason: "incident 43" };

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

  test("rows show each flag, its effect and its state as ON/OFF", async () => {
    const surface = await flagsScreen(() => json({ flags: FLAGS }));
    expect(surface.text()).toContain("review_global");
    expect(surface.text()).toContain("signup_open");
    expect(surface.text()).toContain("workspace_creation_open");
    // The spec's cancellation note belongs to review_global only.
    expect(surface.text()).toContain("Queued work is not cancelled.");
    expect(rowContaining(surface, "review_global")?.querySelector('[data-slot="toggle"]')?.textContent).toBe("ON");
    expect(
      rowContaining(surface, "workspace_creation_open")?.querySelector('[data-slot="toggle"]')?.textContent,
    ).toBe("OFF");
    await surface.close();
  });

  test("a toggle asks first: control click opens the dialog without a request", async () => {
    const surface = await flagsScreen(() => json({ flags: FLAGS }));
    const toggle = rowContaining(surface, "review_global")?.querySelector('[data-slot="toggle"]') ?? null;
    await surface.click(toggle);

    expect(surface.sent.filter((request) => request.method === "PATCH")).toHaveLength(0);
    const dialog = surface.win.document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain("Turn review_global from ON to OFF?");
    expect(dialog?.textContent).toContain("No new review is enqueued.");
    await surface.close();
  });

  test("confirm fires exactly one PATCH with {key, enabled} and shows ON/OFF plus saved", async () => {
    const surface = await flagsScreen((request) =>
      request.method === "PATCH" ? json({ key: "review_global", enabled: false }) : json({ flags: FLAGS }),
    );
    const toggle = rowContaining(surface, "review_global")?.querySelector('[data-slot="toggle"]') ?? null;
    await surface.click(toggle);
    const confirm = [...surface.win.document.querySelectorAll("button")].find(
      (node) => node.textContent === "Confirm",
    );
    await surface.click(confirm as unknown as DomElement);

    const patches = surface.sent.filter((request) => request.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]?.url).toBe("/_internal_admin/api/flags");
    expect(patches[0]?.body).toEqual({ key: "review_global", enabled: false });
    const row = rowContaining(surface, "review_global");
    expect(row?.querySelector('[data-slot="toggle"]')?.textContent).toBe("OFF");
    expect(row?.textContent).toContain("Saved.");
    await surface.close();
  });

  test("a non-AdminWriteError failure names the flag, not a literal {flag}", async () => {
    const surface = await flagsScreen((request) => {
      if (request.method === "PATCH") throw new Error("network down");
      return json({ flags: FLAGS });
    });
    const toggle = rowContaining(surface, "review_global")?.querySelector('[data-slot="toggle"]') ?? null;
    await surface.click(toggle);
    const confirm = [...surface.win.document.querySelectorAll("button")].find(
      (node) => node.textContent === "Confirm",
    );
    await surface.click(confirm as unknown as DomElement);

    const alert = surface.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Could not change review_global.");
    expect(alert?.textContent).not.toContain("{flag}");
    await surface.close();
  });

  test("Escape closes the dialog without a write", async () => {
    const surface = await flagsScreen(() => json({ flags: FLAGS }));
    const toggle = rowContaining(surface, "review_global")?.querySelector('[data-slot="toggle"]') ?? null;
    await surface.click(toggle);
    expect(surface.win.document.querySelector('[role="alertdialog"]')).not.toBeNull();

    await act(async () => {
      surface.win.document.dispatchEvent(new surface.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    });
    await act(async () => {});
    expect(surface.win.document.querySelector('[role="alertdialog"]')).toBeNull();
    expect(surface.sent.filter((request) => request.method === "PATCH")).toHaveLength(0);
    await surface.close();
  });

  test("a zh_CN render shows Chinese copy and ON/OFF state", async () => {
    const surface = await flagsScreen(() => json({ flags: FLAGS }), "zh_CN");
    expect(surface.text()).toContain("服务器开关");
    expect(surface.text()).toContain("关闭时的影响");
    expect(surface.text()).not.toContain("Effect when off");
    const toggle = rowContaining(surface, "review_global")?.querySelector('[data-slot="toggle"]') ?? null;
    await surface.click(toggle);
    const dialog = surface.win.document.querySelector('[role="alertdialog"]');
    expect(dialog?.textContent).toContain("将 review_global 从 ON 切换为 OFF？");
    expect(rowContaining(surface, "review_global")?.querySelector('[data-slot="toggle"]')?.textContent).toBe("ON");
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

  test("rows show owner, counts, seat headroom, plan name and creation date", async () => {
    const surface = await workspacesScreen(() => json({ workspaces: WORKSPACES }));
    const acme = rowContaining(surface, "Acme");
    expect(acme?.textContent).toContain("ws_1");
    expect(acme?.textContent).toContain("octocat");
    expect(acme?.textContent).toContain("3");
    expect(acme?.textContent).toContain("1 pending");
    expect(acme?.textContent).toContain("2026-10-02");
    // The picker labels the tier with the catalogue's display name.
    expect(acme?.querySelector('[data-slot="select-trigger"]')?.textContent).toBe("Free");
    // Headroom is used/cap, and an owner-less row reads "—" rather than blank.
    expect(seatsCell(surface, "Acme")).toBe("3 / 5");
    expect(rowContaining(surface, "Guild")?.textContent).toContain("—");
    await surface.close();
  });

  test("an unlimited seat cap renders as —, never 0", async () => {
    const surface = await workspacesScreen(() => json({ workspaces: WORKSPACES }));
    // Guild holds the NULL-cap tier at 5 members: "5 / 0" would be the defect.
    expect(seatsCell(surface, "Guild")).toBe("—");
    expect(surface.text()).not.toContain("/ 0");
    await surface.close();
  });

  test("the plan picker issues exactly one PATCH for the chosen plan", async () => {
    const after = { ...WORKSPACES[0]!, planId: "pro", planName: "Pro" };
    let written = false;
    const surface = await workspacesScreen((request) => {
      if (request.method === "PATCH") {
        written = true;
        return json({ workspaceId: "ws_1", planId: "pro" });
      }
      // The accepted write re-reads, so the cap follows the server.
      return json({ workspaces: written ? [after] : WORKSPACES });
    });
    const row = rowContaining(surface, "Acme");
    const trigger = row?.querySelector('[data-slot="select-trigger"]') ?? null;
    await surface.openSelect(trigger);
    const picked = await surface.pickOption("Pro");
    expect(picked).not.toBeNull();

    const patches = surface.sent.filter((request) => request.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]?.url).toBe("/_internal_admin/api/workspaces/ws_1/plan");
    expect(patches[0]?.body).toEqual({ planId: "pro" });
    // The accepted plan is what the row now shows.
    expect(rowContaining(surface, "Acme")?.querySelector('[data-slot="select-trigger"]')?.textContent).toBe("Pro");
    await surface.close();
  });

  test("search filters the loaded rows and shows the N / M counter", async () => {
    const surface = await workspacesScreen(() => json({ workspaces: WORKSPACES }));
    expect(surface.text()).toContain("2 / 2");
    // "guild" matches the name (and the slug) but not the other row.
    await surface.type('input[type="search"]', "guild");
    expect(surface.container.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(surface.text()).toContain("Guild");
    expect(surface.text()).not.toContain("Acme");
    expect(surface.text()).toContain("1 / 2");
    // A query matching only the owner login keeps the matching row.
    await surface.type('input[type="search"]', "octocat");
    expect(surface.container.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(surface.text()).toContain("Acme");
    expect(surface.text()).toContain("1 / 2");
    await surface.close();
  });

  test("a non-matching search shows the shared empty state, not the page one", async () => {
    const surface = await workspacesScreen(() => json({ workspaces: WORKSPACES }));
    await surface.type('input[type="search"]', "zzz");
    expect(surface.container.querySelector('[data-slot="empty-state"]')?.textContent).toContain("No matches");
    expect(surface.container.querySelector('[data-slot="empty-state"]')?.textContent).not.toContain("No workspaces");
    await surface.close();
  });

  test("an empty list with no query still shows the page empty state", async () => {
    const surface = await workspacesScreen(() => json({ workspaces: [] }));
    expect(surface.container.querySelector('[data-slot="empty-state"]')?.textContent).toContain("No workspaces");
    await surface.close();
  });

  test("a zh_CN render shows Chinese copy for the page and the search control", async () => {
    const surface = await workspacesScreen(() => json({ workspaces: WORKSPACES }), "zh_CN");
    expect(surface.text()).toContain("所有在线工作区。");
    const input = surface.container.querySelector('input[type="search"]');
    expect(input?.getAttribute("placeholder")).toBe("搜索");
    expect(surface.text()).toContain("2 / 2");
    await surface.type('input[type="search"]', "zzz");
    expect(surface.container.querySelector('[data-slot="empty-state"]')?.textContent).toContain("无匹配结果");
    await surface.close();
  });

  test("a plan id outside the catalogue keeps the server's name", async () => {
    const legacy = [{ ...WORKSPACES[0]!, planId: "legacy-tier", planName: "Legacy Tier" }];
    const surface = await workspacesScreen(() => json({ workspaces: legacy }), "zh_CN");
    const trigger = rowContaining(surface, "Acme")?.querySelector('[data-slot="select-trigger"]') ?? null;
    await surface.openSelect(trigger);
    const labels = [...surface.win.document.querySelectorAll('[role="option"]')].map(
      (node) => node.textContent,
    );
    // Only the unknown id falls back to the server-provided English name.
    expect(labels).toContain("Legacy Tier");
    expect(labels).toContain("专业版");
    expect(labels).toContain("无限版");
    await surface.close();
  });

  test("a zh_CN render localises the plan picker's catalogue labels", async () => {
    const surface = await workspacesScreen(() => json({ workspaces: WORKSPACES }), "zh_CN");
    const trigger = rowContaining(surface, "Acme")?.querySelector('[data-slot="select-trigger"]') ?? null;
    // The selected row's own plan renders the zh catalogue label, not the server's English name.
    expect(trigger?.textContent).toBe("免费版");
    await surface.openSelect(trigger);
    const labels = [...surface.win.document.querySelectorAll('[role="option"]')].map(
      (node) => node.textContent,
    );
    // The row's own option is the zh catalogue label; the rest of the catalogue is Chinese too.
    expect(labels).toContain("免费版");
    expect(labels).toContain("专业版");
    expect(labels).toContain("无限版");
    await surface.close();
  });

  test("a refused plan change in zh_CN keeps a localised primary message with the server detail secondary", async () => {
    const surface = await workspacesScreen(
      (request) =>
        request.method === "PATCH"
          ? json({ error: "seat limit reached" }, 403)
          : json({ workspaces: WORKSPACES }),
      "zh_CN",
    );
    const row = rowContaining(surface, "Acme");
    await surface.openSelect(row?.querySelector('[data-slot="select-trigger"]') ?? null);
    await surface.pickOption("专业版");

    const alert = surface.container.querySelector('[role="alert"]');
    // The generic zh failure is primary; the server's English `{error}` is detail only.
    expect(alert?.textContent).toContain("无法更改 Acme 的套餐。");
    expect(alert?.textContent).toContain("服务器返回：seat limit reached");
    // The refused optimistic change is rolled back.
    expect(rowContaining(surface, "Acme")?.querySelector('[data-slot="select-trigger"]')?.textContent).toBe("免费版");
    await surface.close();
  });

  test("the slug dialog starts at the current slug, submits one PATCH and updates the row", async () => {
    const after = { ...WORKSPACES[0]!, slug: "acme-hq" };
    let written = false;
    const surface = await workspacesScreen((request) => {
      if (request.method === "PATCH") {
        written = true;
        return json({ workspaceId: "ws_1", slug: "acme-hq" });
      }
      return json({ workspaces: written ? [after, WORKSPACES[1]!] : WORKSPACES });
    });
    expect(rowContaining(surface, "Acme")?.textContent).toContain("acme");

    const action = [...surface.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Edit slug",
    );
    await surface.click(action ?? null);
    // The dialog opens with the row's current slug, and opening it writes nothing.
    const input = surface.win.document.querySelector('[data-slot="dialog-content"] input') as DomElement | null;
    expect((input as unknown as HTMLInputElement | null)?.value).toBe("acme");
    expect(surface.sent.filter((request) => request.method === "PATCH")).toHaveLength(0);

    await surface.type('[data-slot="dialog-content"] input', "acme-hq");
    await act(async () => {
      surface.win.document
        .querySelector('[data-slot="dialog-content"] form')
        ?.dispatchEvent(new surface.win.Event("submit", { bubbles: true, cancelable: true }));
    });
    await act(async () => {});

    const patches = surface.sent.filter((request) => request.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]?.url).toBe("/_internal_admin/api/workspaces/ws_1/slug");
    expect(patches[0]?.body).toEqual({ slug: "acme-hq" });
    // The dialog closes and the row shows the accepted slug.
    expect(surface.win.document.querySelector('[data-slot="dialog-content"]')).toBeNull();
    expect(rowContaining(surface, "Acme")?.textContent).toContain("acme-hq");
    await surface.close();
  });

  test("a refused slug write keeps the dialog open with the localised primary message", async () => {
    const surface = await workspacesScreen(
      (request) => (request.method === "PATCH" ? json({ error: "slug is reserved" }, 409) : json({ workspaces: WORKSPACES })),
      "zh_CN",
    );
    const action = [...surface.container.querySelectorAll("button")].find(
      (button) => button.textContent === "编辑 slug",
    );
    await surface.click(action ?? null);
    await surface.type('[data-slot="dialog-content"] input', "members");
    await act(async () => {
      surface.win.document
        .querySelector('[data-slot="dialog-content"] form')
        ?.dispatchEvent(new surface.win.Event("submit", { bubbles: true, cancelable: true }));
    });
    await act(async () => {});

    const dialog = surface.win.document.querySelector('[data-slot="dialog-content"]');
    expect(dialog).not.toBeNull();
    // The refusal must live INSIDE the dialog: the modal overlay covers the
    // page-level notice, so a page notice is unreadable while it stays open.
    const alert = dialog?.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("无法更改 Acme 的 slug。");
    expect(alert?.textContent).toContain("服务器返回：slug is reserved");
    expect(surface.container.querySelector('[role="alert"]')).toBeNull();
    expect(rowContaining(surface, "Acme")?.textContent).toContain("acme");
    await surface.close();
  });
});

describe("Users screen", () => {
  test("loading renders the table skeleton", async () => {
    const surface = await usersScreen(never);
    expect(surface.container.querySelector('[data-slot="page-skeleton"]')).not.toBeNull();
    await surface.close();
  });

  test("a failed read renders the error state", async () => {
    const surface = await usersScreen(failed);
    expect(surface.container.querySelector('[data-slot="error-state"]')?.textContent).toContain(
      "Could not load the user list.",
    );
    await surface.close();
  });

  test("an empty list renders the empty state", async () => {
    const surface = await usersScreen(() => json({ users: [] }));
    expect(surface.container.querySelector('[data-slot="empty-state"]')?.textContent).toContain("No users");
    await surface.close();
  });

  test("rows separate operator status from live support access", async () => {
    const surface = await usersScreen(() => json({ users: USERS }));
    expect(surface.container.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(rowContaining(surface, "octocat")?.textContent).toContain("Operator");
    expect(rowContaining(surface, "octocat")?.textContent).toContain("2026-08-26");
    expect(rowContaining(surface, "ops")?.textContent).toContain("Support (2)");
    expect(rowContaining(surface, "yuki")?.textContent).toContain("User");
    await surface.close();
  });

  test("search filters on the GitHub login with the N / M counter", async () => {
    const surface = await usersScreen(() => json({ users: USERS }));
    expect(surface.text()).toContain("3 / 3");
    await surface.type('input[type="search"]', "yuki");
    expect(surface.container.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(surface.text()).toContain("1 / 3");
    // Case-insensitive: the query matches the login in another case.
    await surface.type('input[type="search"]', "OCTO");
    expect(surface.container.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(rowContaining(surface, "octocat")).not.toBeNull();
    await surface.close();
  });

  test("a non-matching search shows the shared empty state", async () => {
    const surface = await usersScreen(() => json({ users: USERS }));
    await surface.type('input[type="search"]', "zzz");
    expect(surface.container.querySelector('[data-slot="empty-state"]')?.textContent).toContain("No matches");
    expect(surface.container.querySelector('[data-slot="empty-state"]')?.textContent).not.toContain("No users");
    await surface.close();
  });

  test("a zh_CN render shows Chinese copy for the page and the search control", async () => {
    const surface = await usersScreen(() => json({ users: USERS }), "zh_CN");
    expect(surface.text()).toContain("此平台上的所有账号。");
    const input = surface.container.querySelector('input[type="search"]');
    expect(input?.getAttribute("placeholder")).toBe("搜索");
    await surface.type('input[type="search"]', "yuki");
    expect(surface.text()).toContain("1 / 3");
    await surface.close();
  });
});

describe("Support access screen", () => {
  const respondWith =
    (grants: () => unknown): Respond =>
    (request) => {
      if (request.method !== "GET") return json({}, 201);
      return json(
        request.url.endsWith("/support-grants") ? { grants: grants() } : { workspaces: WORKSPACES },
      );
    };

  test("loading renders the table skeleton", async () => {
    const surface = await supportScreen(never);
    expect(surface.container.querySelector('[data-slot="page-skeleton"]')).not.toBeNull();
    await surface.close();
  });

  test("a failed read renders the error state", async () => {
    const surface = await supportScreen(failed);
    expect(surface.container.querySelector('[data-slot="error-state"]')?.textContent).toContain(
      "Could not load the support grants.",
    );
    await surface.close();
  });

  test("no open window renders the empty state beside the create form", async () => {
    const surface = await supportScreen(respondWith(() => []));
    expect(surface.container.querySelector('[data-slot="empty-state"]')?.textContent).toContain(
      "No open support windows",
    );
    expect(surface.container.querySelector("#grant-operator")).not.toBeNull();
    await surface.close();
  });

  test("rows name the operator, workspace, reason and expiry in UTC", async () => {
    const surface = await supportScreen(respondWith(() => [GRANT]));
    const row = rowContaining(surface, "incident 42");
    expect(row?.textContent).toContain("ops");
    expect(row?.textContent).toContain("Acme");
    // The stamp is UTC (the column is `toISOString`), so it says so — a bare
    // `2026-10-26 09:00` reads as local time to an operator outside UTC.
    expect(row?.textContent).toContain("2026-10-26 09:00 UTC");
    await surface.close();
  });

  test("the form creates one grant and the row revokes it", async () => {
    let created = false;
    const surface = await supportScreen((request) => {
      if (request.method === "POST") {
        created = true;
        return json({ grant: GRANT }, 201);
      }
      if (request.method === "DELETE") return json({ id: GRANT.id, workspaceId: GRANT.workspace_id });
      return json(
        request.url.endsWith("/support-grants") ? { grants: created ? [GRANT] : [] } : { workspaces: WORKSPACES },
      );
    });

    await surface.openSelect(surface.container.querySelector("#grant-workspace"));
    await surface.pickOption("Acme");
    await surface.type("#grant-operator", "ops");
    await surface.type("#grant-reason", "incident 42");
    await act(async () => {
      surface.container
        .querySelector("form")
        ?.dispatchEvent(new surface.win.Event("submit", { bubbles: true, cancelable: true }));
    });
    await act(async () => {});

    const posts = surface.sent.filter((request) => request.method === "POST");
    expect(posts).toHaveLength(1);
    expect(posts[0]?.url).toBe("/_internal_admin/api/support-grants");
    expect(posts[0]?.body).toEqual({
      workspaceId: "ws_1",
      operatorLogin: "ops",
      reason: "incident 42",
      ttlHours: 24,
    });

    // The list is the server's answer, so the created row arrives by re-read.
    expect(rowContaining(surface, "incident 42")?.textContent).toContain("Acme");

    const revoke = [...surface.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Revoke",
    );
    await surface.click(revoke ?? null);

    const deletes = surface.sent.filter((request) => request.method === "DELETE");
    expect(deletes).toHaveLength(1);
    expect(deletes[0]?.url).toBe("/_internal_admin/api/support-grants/g1");
    expect(surface.container.querySelector('[data-slot="empty-state"]')?.textContent).toContain(
      "No open support windows",
    );
    await surface.close();
  });

  test("the form renders inside CardContent under a CardHeader title", async () => {
    const surface = await supportScreen(respondWith(() => []));
    const header = surface.container.querySelector('[data-slot="card-header"]');
    expect(header?.textContent).toContain("New support window");
    const content = surface.container.querySelector('[data-slot="card-content"]');
    expect(content).not.toBeNull();
    expect(content?.querySelector("#grant-operator")).not.toBeNull();
    await surface.close();
  });

  test("revoking one row leaves the other revoke buttons enabled", async () => {
    const deleteGate = Promise.withResolvers<Response>();
    const surface = await supportScreen((request) => {
      if (request.method === "DELETE") return deleteGate.promise;
      return json(
        request.url.endsWith("/support-grants") ? { grants: [GRANT, GRANT2] } : { workspaces: WORKSPACES },
      );
    });

    const inFlightButton = rowContaining(surface, "incident 42")?.querySelector("button");
    await surface.click(inFlightButton ?? null);
    expect(inFlightButton?.disabled).toBe(true);

    const otherButton = rowContaining(surface, "incident 43")?.querySelector("button");
    expect(otherButton?.disabled).toBe(false);

    deleteGate.resolve(json({ id: GRANT.id, workspaceId: GRANT.workspace_id }));
    await act(async () => {});
    expect(rowContaining(surface, "incident 42")).toBeNull();
    await surface.close();
  });

  test("a second submit while the create flies sends no second POST", async () => {
    const createGate = Promise.withResolvers<Response>();
    const surface = await supportScreen((request) => {
      if (request.method === "POST") return createGate.promise;
      return json(
        request.url.endsWith("/support-grants") ? { grants: [] } : { workspaces: WORKSPACES },
      );
    });

    await surface.openSelect(surface.container.querySelector("#grant-workspace"));
    await surface.pickOption("Acme");
    await surface.type("#grant-operator", "ops");
    await surface.type("#grant-reason", "incident 42");
    const submitButton = surface.container.querySelector("button[type=submit]");

    await surface.click(submitButton ?? null);
    expect((submitButton as unknown as HTMLButtonElement | null)?.disabled).toBe(true);
    await surface.click(submitButton ?? null);
    expect(surface.sent.filter((request) => request.method === "POST")).toHaveLength(1);

    createGate.resolve(json({ grant: GRANT }, 201));
    await act(async () => {});
    expect((submitButton as unknown as HTMLButtonElement | null)?.disabled).toBe(false);
    await surface.close();
  });

  test("two concurrent revokes keep both rows disabled independently", async () => {
    const gates = new Map<string, Gate>();
    const surface = await supportScreen((request) => {
      if (request.method === "DELETE") {
        const gate = Promise.withResolvers<Response>();
        gates.set(request.url, gate);
        return gate.promise;
      }
      return json(
        request.url.endsWith("/support-grants") ? { grants: [GRANT, GRANT2] } : { workspaces: WORKSPACES },
      );
    });

    const firstButton = rowContaining(surface, "incident 42")?.querySelector("button");
    const secondButton = rowContaining(surface, "incident 43")?.querySelector("button");
    await surface.click(firstButton ?? null);
    await surface.click(secondButton ?? null);
    expect(firstButton?.disabled).toBe(true);
    expect(secondButton?.disabled).toBe(true);

    gates.get("/_internal_admin/api/support-grants/g1")?.resolve(json({ id: GRANT.id, workspaceId: GRANT.workspace_id }));
    await act(async () => {});
    expect(rowContaining(surface, "incident 42")).toBeNull();
    // Row B is still flying: its freshly rendered button stays disabled.
    expect(rowContaining(surface, "incident 43")?.querySelector("button")?.disabled).toBe(true);

    gates.get("/_internal_admin/api/support-grants/g2")?.resolve(json({ id: GRANT2.id, workspaceId: GRANT2.workspace_id }));
    await act(async () => {});
    expect(surface.container.querySelector('[data-slot="empty-state"]')?.textContent).toContain(
      "No open support windows",
    );
    await surface.close();
  });

  test("a zh_CN render shows the page's dictionary copy", async () => {
    const surface = await supportScreen(respondWith(() => []), "zh_CN");
    expect(surface.text()).toContain("支持访问");
    expect(surface.container.querySelector('[data-slot="card-header"]')?.textContent).toContain("新建支持窗口");
    expect(surface.container.querySelector('[data-slot="card-content"] #grant-operator')).not.toBeNull();
    expect(surface.container.querySelector("button[type=submit]")?.textContent).toContain("授予访问");
    expect(surface.container.querySelector('[data-slot="empty-state"]')?.textContent).toContain(
      "没有开放的支持窗口",
    );
    await surface.close();
  });
});
