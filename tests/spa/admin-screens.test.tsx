import { RECONCILE_DEFAULTS, RECONCILE_LIMITS } from "../../src/contracts/reconcile-settings";
import { describe, expect, jest, test } from "bun:test";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { type Element as DomElement, type Window } from "happy-dom";
import { BotsPage } from "../../src/spa/admin/BotsPage";
import { FlagsPage } from "../../src/spa/admin/FlagsPage";
import { RuntimePage } from "../../src/spa/admin/RuntimePage";
import { SupportGrantsPage } from "../../src/spa/admin/SupportGrantsPage";
import { UsagePage } from "../../src/spa/admin/UsagePage";
import { UsersPage } from "../../src/spa/admin/UsersPage";
import { WorkspacesPage } from "../../src/spa/admin/WorkspacesPage";
import { installDom } from "./dom";

const realFetch = globalThis.fetch;

type Sent = { url: string; method: string; body: unknown };
type Respond = (request: Sent) => Response | Promise<Response>;

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

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
  await act(async () => {});

  return {
    win,
    container,
    sent,
    text: () => container.textContent ?? "",
    async click(node: DomElement | null) {
      await act(async () => {
        node?.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      });
      await act(async () => {});
    },
    async openSelect(trigger: DomElement | null) {
      await act(async () => {
        trigger?.dispatchEvent(
          new win.PointerEvent("pointerdown", { bubbles: true, cancelable: true, button: 0, pointerType: "mouse" }),
        );
        trigger?.dispatchEvent(new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }));
      });
    },
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
    async type(selector: string, value: string) {
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

const DURATION_REPORT = {
  window: { days: 30, startMs: 0, endMs: 1 },
  sampleSize: 0,
  total: null,
  phases: { queueWait: null, execution: null, publication: null },
  excluded: { "check-open-at-settle": 0, "no-settlement-record": 0, "no-boundary": 0, unsettled: 0, "pre-prepare": 0 },
  cutoff: null,
};

async function runtimeScreen(
  respond: Respond,
  locale: "en" | "zh_CN" = "en",
  report: unknown = DURATION_REPORT,
): Promise<Surface> {
  return mount(createElement(RuntimePage, { locale }), (request) =>
    request.url.startsWith("/_internal_admin/api/runtime/duration-report")
      ? json(report)
      : respond(request),
  );
}

const RUNTIME = {
  concurrency: 2,
  min: 1,
  max: 250,
  degraded: false,
  officialWorkspaceId: null as string | null,
};

async function workspacesScreen(respond: Respond, locale: "en" | "zh_CN" = "en"): Promise<Surface> {
  return mount(createElement(WorkspacesPage, { locale }), (request) =>
    request.url.endsWith("/api/runtime") ? json(RUNTIME) : respond(request),
  );
}

async function botsScreen(respond: Respond, locale: "en" | "zh_CN" = "en"): Promise<Surface> {
  return mount(createElement(BotsPage, { locale }), respond);
}

async function usersScreen(respond: Respond, locale: "en" | "zh_CN" = "en"): Promise<Surface> {
  return mount(createElement(UsersPage, { locale }), respond);
}

async function supportScreen(respond: Respond, locale: "en" | "zh_CN" = "en"): Promise<Surface> {
  return mount(createElement(SupportGrantsPage, { locale }), respond);
}

async function usageScreen(respond: Respond, locale: "en" | "zh_CN" = "en"): Promise<Surface> {
  return mount(createElement(UsagePage, { locale }), respond);
}

const never = () => new Promise<Response>(() => {});
const failed = () => new Response("boom", { status: 500 });

type Gate = { promise: Promise<Response>; resolve: (value: Response) => void };

function rowContaining(surface: Surface, needle: string): DomElement | null {
  return [...surface.container.querySelectorAll("tr")].find((row) => row.textContent?.includes(needle)) ?? null;
}

const FLAGS = [
  { key: "review_global", enabled: true },
  { key: "signup_open", enabled: true },
  { key: "workspace_creation_open", enabled: false },
];

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
    includedMembers: null,
    createdAt: "2026-09-18T09:00:00.000Z",
  },
];

const BOTS = [
  {
    botId: "bot-1",
    name: "mstar-inspector",
    githubAppId: 4803300,
    workspaceId: "ws_1",
    workspaceName: "Acme",
    isOfficial: true,
    scope: "shared",
    sharedAt: "2026-11-15T12:03:00.000Z",
    installationCount: 2,
    liveTargetCount: 5,
  },
  {
    botId: "bot-2",
    name: "team-a-reviewer",
    githubAppId: 4803422,
    workspaceId: "ws_2",
    workspaceName: "Guild",
    isOfficial: false,
    scope: "owned",
    sharedAt: null,
    installationCount: 0,
    liveTargetCount: 0,
  },
  {
    botId: "bot-3",
    name: "acme-bot",
    githubAppId: 4803550,
    workspaceId: "ws_1",
    workspaceName: "Acme",
    isOfficial: true,
    scope: "owned",
    sharedAt: null,
    installationCount: 1,
    liveTargetCount: 2,
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

  test("the Saved. note clears itself 3s after the write lands", async () => {
    jest.useFakeTimers();
    const surface = await flagsScreen((request) =>
      request.method === "PATCH" ? json({ key: "review_global", enabled: false }) : json({ flags: FLAGS }),
    );
    try {
      await surface.click(rowContaining(surface, "review_global")?.querySelector('[data-slot="toggle"]') ?? null);
      await surface.click(
        [...surface.win.document.querySelectorAll("button")].find(
          (node) => node.textContent === "Confirm",
        ) as unknown as DomElement,
      );
      expect(rowContaining(surface, "review_global")?.textContent).toContain("Saved.");

      await act(async () => {
        jest.advanceTimersByTime(2999);
      });
      expect(rowContaining(surface, "review_global")?.textContent).toContain("Saved.");

      await act(async () => {
        jest.advanceTimersByTime(1);
      });
      expect(rowContaining(surface, "review_global")?.textContent).not.toContain("Saved.");
    } finally {
      jest.useRealTimers();
      await surface.close();
    }
  });

  test("unmounting the screen cancels the note's pending auto-clear", async () => {
    jest.useFakeTimers();
    const surface = await flagsScreen((request) =>
      request.method === "PATCH" ? json({ key: "review_global", enabled: false }) : json({ flags: FLAGS }),
    );
    try {
      await surface.click(rowContaining(surface, "review_global")?.querySelector('[data-slot="toggle"]') ?? null);
      await surface.click(
        [...surface.win.document.querySelectorAll("button")].find(
          (node) => node.textContent === "Confirm",
        ) as unknown as DomElement,
      );
      const armed = jest.getTimerCount();
      await surface.close();
      expect(jest.getTimerCount()).toBe(armed - 1);
    } finally {
      jest.useRealTimers();
    }
  });

  test("the confirmation dialog opens with focus on Cancel, never Confirm", async () => {
    const surface = await flagsScreen(() => json({ flags: FLAGS }));
    try {
      await surface.click(rowContaining(surface, "review_global")?.querySelector('[data-slot="toggle"]') ?? null);
      const dialog = surface.win.document.querySelector('[role="alertdialog"]');
      const focused = surface.win.document.activeElement;
      expect(focused?.textContent).toBe("Cancel");
      expect(focused !== null && dialog?.contains(focused)).toBe(true);
    } finally {
      await surface.close();
    }
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

describe("Runtime screen", () => {
  const CHECK_BUDGETS = {
    terminalizeMs: 10_000,
    updateMs: 5_000,
    terminalizeMin: 1_000,
    terminalizeMax: 30_000,
    updateMin: 500,
    updateMax: 15_000,
    degraded: false,
  };
  const COMMENT_CLAIM = {
    retryMs: 300_000,
    maxAttempts: 3,
    outboxCap: 20,
    retryMin: 30_000,
    retryMax: 3_600_000,
    attemptsMin: 1,
    attemptsMax: 10,
    outboxMin: 1,
    outboxMax: 100,
    degraded: false,
  };
  const RUNTIME = {
    concurrency: 24,
    min: 1,
    max: 256,
    degraded: false,
    checkBudgets: CHECK_BUDGETS,
    commentClaim: COMMENT_CLAIM,
  };

  test("reconciler fields save all settings and show persisted overrides after remount", async () => {
    let values = { ...RECONCILE_DEFAULTS };
    const respond: Respond = (request) => {
      if (request.method === "PATCH") {
        values = (request.body as { reconcile: typeof values }).reconcile;
        return json({ reconcile: values });
      }
      return json({ ...RUNTIME, reconcile: { values, limits: RECONCILE_LIMITS, degraded: false } });
    };
    const surface = await runtimeScreen(respond);
    expect((surface.container.querySelector("#reconcile-checkSelectLimit") as unknown as HTMLInputElement).value).toBe(String(RECONCILE_DEFAULTS.checkSelectLimit));
    await surface.type("#reconcile-checkSelectLimit", "1");
    await surface.click(surface.container.querySelector("#reconcile-checkSelectLimit")!.closest("form")!.querySelector('button[type="submit"]'));
    expect(surface.sent.filter((request) => request.method === "PATCH")).toEqual([
      { url: "/_internal_admin/api/runtime", method: "PATCH", body: { reconcile: { ...RECONCILE_DEFAULTS, checkSelectLimit: 1 } } },
    ]);
    await surface.close();
    const refreshed = await runtimeScreen(respond);
    expect((refreshed.container.querySelector("#reconcile-checkSelectLimit") as unknown as HTMLInputElement).value).toBe("1");
    await refreshed.close();
  });

  const SWEEP_LIMITS = {
    failureThreshold: { min: 1, max: 10_000 },
    windowHours: { min: 1, max: 168 },
    webhookTimeoutMs: { min: 100, max: 15_000 },
    retentionDays: { min: 1, max: 365 },
    retentionCap: { min: 1, max: 500 },
    inviteLapseCap: { min: 1, max: 500 },
    pullRequestRetentionDays: { min: 1, max: 365 },
    pullRequestRetentionCap: { min: 1, max: 500 },
  };
  const SWEEP_STORED = {
    failureThreshold: 7,
    windowHours: 48,
    webhookTimeoutMs: 3_000,
    retentionDays: 30,
    retentionCap: 200,
    inviteLapseCap: 100,
    pullRequestRetentionDays: 60,
    pullRequestRetentionCap: 250,
  };
  const sweepInput = (surface: Surface, field: string) =>
    surface.container.querySelector(`#sweep-${field}`) as unknown as HTMLInputElement;
  const sweepCard = (surface: Surface) => surface.container.querySelector("#sweep-windowHours")!.closest("form")!.parentElement!;

  test("an invalid sweep row keeps the valid stored values and marks only the invalid field", async () => {
    const surface = await runtimeScreen((request) =>
      request.method === "PATCH"
        ? json({ sweep: (request.body as { sweep: unknown }).sweep })
        : json({ ...RUNTIME, sweep: { values: SWEEP_STORED, limits: SWEEP_LIMITS, degraded: true, invalid: ["retentionDays"] } }),
    );
    expect(sweepInput(surface, "windowHours").value).toBe("48");
    expect(sweepInput(surface, "retentionCap").value).toBe("200");
    expect(sweepInput(surface, "inviteLapseCap").value).toBe("100");
    expect(sweepInput(surface, "retentionDays").value).toBe("");
    expect(sweepInput(surface, "retentionDays").getAttribute("aria-invalid")).toBe("true");
    expect(sweepInput(surface, "windowHours").getAttribute("aria-invalid")).toBeNull();
    const card = sweepCard(surface);
    expect(card.textContent).toContain("Stored value invalid for: Webhook retention (days).");
    expect(card.textContent).not.toContain("Retry");

    await surface.type("#sweep-retentionDays", "45");
    await surface.click(card.querySelector('button[type="submit"]'));
    expect(surface.sent.filter((request) => request.method === "PATCH")).toEqual([
      { url: "/_internal_admin/api/runtime", method: "PATCH", body: { sweep: { ...SWEEP_STORED, retentionDays: 45 } } },
    ]);
    expect(sweepInput(surface, "retentionDays").getAttribute("aria-invalid")).toBeNull();
    expect(sweepCard(surface).textContent).not.toContain("Stored value invalid");
    await surface.close();
  });

  test("an unreadable sweep settings read blanks every field and offers Retry", async () => {
    const surface = await runtimeScreen(() =>
      json({ ...RUNTIME, sweep: { values: SWEEP_STORED, limits: SWEEP_LIMITS, degraded: true, invalid: [] } }),
    );
    for (const field of Object.keys(SWEEP_STORED)) expect(sweepInput(surface, field).value).toBe("");
    const card = sweepCard(surface);
    expect(card.textContent).toContain("Some sweep settings could not be read.");
    expect([...card.querySelectorAll("button")].some((button) => button.textContent === "Retry")).toBe(true);
    await surface.close();
  });

  test("a failed read renders the error with a retry that reloads", async () => {
    let failing = true;
    const surface = await runtimeScreen(() => (failing ? failed() : json(RUNTIME)));
    expect(surface.container.querySelector('[data-slot="error-state"]')?.textContent).toContain(
      "Could not load the runtime parameters.",
    );

    failing = false;
    await surface.click(surface.container.querySelector('[data-slot="error-state"] button'));
    expect(surface.text()).toContain("Effective on the next review: 24.");
    await surface.close();
  });

  test("the field shows the stored cap and one save fires exactly one PATCH", async () => {
    const surface = await runtimeScreen((request) =>
      request.method === "PATCH" ? json({ concurrency: 40 }) : json(RUNTIME),
    );
    const input = surface.container.querySelector("#system-concurrency") as unknown as HTMLInputElement;
    expect(input.value).toBe("24");

    await surface.type("#system-concurrency", "40");
    await surface.click(surface.container.querySelector('button[type="submit"]'));

    expect(surface.sent.filter((request) => request.method === "PATCH")).toEqual([
      { url: "/_internal_admin/api/runtime", method: "PATCH", body: { concurrency: 40 } },
    ]);
    expect((surface.container.querySelector("#system-concurrency") as unknown as HTMLInputElement).value).toBe(
      "40",
    );
    expect(
      surface.sent.filter(
        (request) => request.method === "GET" && request.url === "/_internal_admin/api/runtime",
      ),
    ).toHaveLength(1);
    expect(surface.text()).toContain("Saved.");
    await surface.close();
  });

  test("a refusal reports the generic failure plus the server's detail", async () => {
    const surface = await runtimeScreen((request) =>
      request.method === "PATCH"
        ? new Response(JSON.stringify({ error: "body must be { concurrency: <integer in 1..256> }" }), {
            status: 400,
            headers: { "Content-Type": "application/json" },
          })
        : json(RUNTIME),
    );
    await surface.type("#system-concurrency", "20");
    await surface.click(surface.container.querySelector('button[type="submit"]'));

    expect(surface.text()).toContain("Could not change the system concurrency.");
    expect(surface.text()).toContain("body must be { concurrency: <integer in 1..256> }");
    expect(surface.text()).toContain("Effective on the next review: 24.");
    await surface.close();
  });

  test("a degraded read warns instead of presenting the fallback as the stored cap", async () => {
    let degraded = true;
    const surface = await runtimeScreen(() =>
      json({ concurrency: 1, min: 1, max: 256, degraded, checkBudgets: CHECK_BUDGETS }),
    );
    expect(surface.text()).toContain(
      "The stored system concurrency could not be read, so every workspace is running one review at a time. Entering a value in range saves a new one, and retrying the read re-checks the stored row.",
    );
    const input = surface.container.querySelector("#system-concurrency") as unknown as HTMLInputElement;
    expect(input).not.toBeNull();
    expect(input.value).toBe("");
    expect(surface.text()).not.toContain("Effective on the next review: 1.");

    degraded = false;
    const retry = [...surface.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Retry",
    );
    expect(retry).toBeDefined();
    await surface.click(retry!);
    expect(surface.text()).toContain("Effective on the next review: 1.");
    expect(surface.text()).not.toContain("could not be read");
    await surface.close();
  });

  test("a typed value repairs a degraded read; an empty submit writes nothing", async () => {
    const surface = await runtimeScreen((request) =>
      request.method === "PATCH"
        ? json({ concurrency: 41 })
        : json({ concurrency: 1, min: 1, max: 256, degraded: true, checkBudgets: CHECK_BUDGETS }),
    );
    expect(surface.text()).toContain("could not be read");
    expect(
      (surface.container.querySelector('button[type="submit"]') as unknown as HTMLButtonElement).disabled,
    ).toBe(false);

    const form = surface.container.querySelector("form")!;
    await act(async () => {
      form.dispatchEvent(new surface.win.Event("submit", { bubbles: true, cancelable: true }));
    });
    expect(surface.sent.filter((request) => request.method === "PATCH")).toEqual([]);

    await surface.type("#system-concurrency", "41");
    await surface.click(surface.container.querySelector('button[type="submit"]'));
    expect(surface.sent.filter((request) => request.method === "PATCH")).toEqual([
      { url: "/_internal_admin/api/runtime", method: "PATCH", body: { concurrency: 41 } },
    ]);
    expect(surface.text()).toContain("Saved.");
    expect(surface.text()).toContain("Effective on the next review: 41.");
    await surface.close();
  });

  test("an older server without checkBudgets still renders the concurrency card", async () => {
    const surface = await runtimeScreen(() =>
      json({ concurrency: 24, min: 1, max: 256, degraded: false }),
    );
    expect(surface.text()).toContain("Effective on the next review: 24.");
    expect(surface.container.querySelector("#check-terminalize-budget")).toBeNull();
    expect(surface.container.querySelector("#system-concurrency")).not.toBeNull();
    await surface.close();
  });

  test("the runtime page carries no review-depth control", async () => {
    const surface = await runtimeScreen(() =>
      json({
        ...RUNTIME,
        reviewLevel: { value: "default", levels: ["quick", "default", "deep"], degraded: false },
      }),
    );
    expect(surface.container.querySelector("#default-review-level")).toBeNull();
    expect(surface.text()).not.toContain("Default review depth");
    expect(surface.text()).not.toContain("Review depth");
    expect(surface.container.querySelector("#system-concurrency")).not.toBeNull();
    expect(surface.container.querySelector("#check-terminalize-budget")).not.toBeNull();
    await surface.close();
  });

  test("a zh_CN render shows the page's dictionary copy", async () => {
    const surface = await runtimeScreen(() => json(RUNTIME), "zh_CN");
    expect(surface.text()).toContain("运行时参数");
    expect(surface.text()).toContain("下一次审查生效值：24。");
    await surface.close();
  });

  test("the Check budgets card shows both stored values and one save fires exactly one PATCH", async () => {
    const surface = await runtimeScreen((request) =>
      request.method === "PATCH"
        ? json({ checkBudgets: { terminalizeMs: 12_000, updateMs: 7_000 } })
        : json(RUNTIME),
    );
    const terminalize = surface.container.querySelector("#check-terminalize-budget") as unknown as HTMLInputElement;
    expect(terminalize.value).toBe("10000");

    await surface.type("#check-terminalize-budget", "12000");
    await surface.type("#check-update-budget", "7000");
    const budgetForm = surface.container.querySelector("#check-terminalize-budget")!.closest("form")!;
    await surface.click(budgetForm.querySelector('button[type="submit"]'));

    expect(surface.sent.filter((request) => request.method === "PATCH")).toEqual([
      {
        url: "/_internal_admin/api/runtime",
        method: "PATCH",
        body: { checkBudgets: { terminalizeMs: 12_000, updateMs: 7_000 } },
      },
    ]);
    expect(
      (surface.container.querySelector("#check-terminalize-budget") as unknown as HTMLInputElement).value,
    ).toBe("12000");
    expect(surface.text()).toContain("Saved.");
    await surface.close();
  });

  test("a refused budget pair reports the server's relation text inside the budget card", async () => {
    const surface = await runtimeScreen((request) =>
      request.method === "PATCH"
        ? new Response(
            JSON.stringify({
              error: "the terminalize timeout must be greater than the check update budget",
            }),
            { status: 400, headers: { "Content-Type": "application/json" } },
          )
        : json(RUNTIME),
    );
    await surface.type("#check-terminalize-budget", "4000");
    await surface.type("#check-update-budget", "5000");
    const budgetForm = surface.container.querySelector("#check-terminalize-budget")!.closest("form")!;
    await surface.click(budgetForm.querySelector('button[type="submit"]'));

    expect(surface.text()).toContain("Could not change the check budgets.");
    expect(surface.text()).toContain("the terminalize timeout must be greater than the check update budget");
    expect(surface.text()).toContain("Effective on the next review: terminalize 10000 ms, update 5000 ms.");
    await surface.close();
  });

  test("the comment-trigger card shows the stored trio and one save fires exactly one PATCH", async () => {
    const surface = await runtimeScreen((request) =>
      request.method === "PATCH"
        ? json({ commentClaim: { retryMs: 60_000, maxAttempts: 5, outboxCap: 10 } })
        : json(RUNTIME),
    );
    const retry = surface.container.querySelector("#claim-retry-budget") as unknown as HTMLInputElement;
    expect(retry.value).toBe("300000");

    await surface.type("#claim-retry-budget", "60000");
    await surface.type("#claim-attempts-budget", "5");
    await surface.type("#claim-outbox-budget", "10");
    const claimForm = surface.container.querySelector("#claim-retry-budget")!.closest("form")!;
    await surface.click(claimForm.querySelector('button[type="submit"]'));

    expect(surface.sent.filter((request) => request.method === "PATCH")).toEqual([
      {
        url: "/_internal_admin/api/runtime",
        method: "PATCH",
        body: { commentClaim: { retryMs: 60_000, maxAttempts: 5, outboxCap: 10 } },
      },
    ]);
    expect(
      (surface.container.querySelector("#claim-retry-budget") as unknown as HTMLInputElement).value,
    ).toBe("60000");
    expect(surface.text()).toContain("Saved.");
    await surface.close();
  });

  test("the attempt-cap card calls an absent row a default, never a saved value", async () => {
    const surface = await runtimeScreen(() =>
      json({
        ...RUNTIME,
        attemptCap: { capMs: 1_200_000, saved: false, min: 900_000, max: 3_600_000, degraded: false },
      }),
    );
    const field = surface.container.querySelector("#attempt-cap-ms") as unknown as HTMLInputElement;
    expect(field).not.toBeNull();
    expect(field.value).toBe("1200000");
    expect(surface.container.querySelector('[data-attempt-cap="range"]')?.textContent).toContain(
      "900000–3600000 ms (15–60 minutes)",
    );
    expect(surface.container.querySelector('[data-attempt-cap="effective"]')?.textContent).toBe(
      "Effective on the next review: 1200000 ms (platform default — no value is saved).",
    );
    await surface.close();
  });

  test("the attempt-cap card reports a saved value as saved, and one save fires one PATCH", async () => {
    let stored = { capMs: 1_800_000, saved: true, min: 900_000, max: 3_600_000, degraded: false };
    const surface = await runtimeScreen((request) => {
      if (request.method !== "PATCH") return json({ ...RUNTIME, attemptCap: stored });
      stored = { ...stored, capMs: 2_400_000 };
      return json({ attemptCap: { capMs: 2_400_000 } });
    });
    expect(surface.container.querySelector('[data-attempt-cap="effective"]')?.textContent).toBe(
      "Effective on the next review: 1800000 ms (saved value).",
    );
    await surface.type("#attempt-cap-ms", "2400000");
    const form = surface.container.querySelector("#attempt-cap-ms")!.closest("form")!;
    await surface.click(form.querySelector('button[type="submit"]'));

    expect(surface.sent.filter((request) => request.method === "PATCH")).toEqual([
      {
        url: "/_internal_admin/api/runtime",
        method: "PATCH",
        body: { attemptCap: { capMs: 2_400_000 } },
      },
    ]);
    expect((surface.container.querySelector("#attempt-cap-ms") as unknown as HTMLInputElement).value).toBe(
      "2400000",
    );
    expect(surface.container.querySelector('[data-attempt-cap="effective"]')?.textContent).toBe(
      "Effective on the next review: 2400000 ms (saved value).",
    );
    await surface.close();
  });

  test("a save shows the store's value, not its echo, when the row changed elsewhere", async () => {
    let serverCap = 1_200_000;
    let patches = 0;
    const capGroup = () => ({
      ...RUNTIME,
      attemptCap: { capMs: serverCap, saved: true, min: 900_000, max: 3_600_000, degraded: false },
    });
    const surface = await runtimeScreen((request) => {
      if (request.method !== "PATCH") return json(capGroup());
      patches += 1;
      if (patches === 1) {
        serverCap = 3_000_000;
        return json({ attemptCap: { capMs: 1_800_000 } });
      }
      serverCap = 2_400_000;
      return json({ attemptCap: { capMs: 2_400_000 } });
    });
    await surface.type("#attempt-cap-ms", "1800000");
    const form = surface.container.querySelector("#attempt-cap-ms")!.closest("form")!;
    await surface.click(form.querySelector('button[type="submit"]'));

    expect(surface.container.querySelector('[data-attempt-cap="effective"]')?.textContent).toBe(
      "Effective on the next review: 3000000 ms (saved value).",
    );
    expect(surface.container.querySelector('[data-attempt-cap="changed-elsewhere"]')?.textContent).toBe(
      "Another save changed the stored value while this page was open; the effective value is now 3000000 ms, which is what the store holds.",
    );
    expect((surface.container.querySelector("#attempt-cap-ms") as unknown as HTMLInputElement).value).toBe(
      "3000000",
    );

    await surface.type("#attempt-cap-ms", "2400000");
    await surface.click(form.querySelector('button[type="submit"]'));
    expect((surface.container.querySelector("#attempt-cap-ms") as unknown as HTMLInputElement).value).toBe(
      "2400000",
    );
    expect(surface.container.querySelector('[data-attempt-cap="effective"]')?.textContent).toBe(
      "Effective on the next review: 2400000 ms (saved value).",
    );
    expect(surface.container.querySelector('[data-attempt-cap="changed-elsewhere"]')).toBeNull();
    expect(surface.sent.filter((request) => request.method === "PATCH")).toHaveLength(2);
    await surface.close();
  });

  test("the card stops showing a number while the save request is in flight", async () => {
    let releasePatch: ((response: Response) => void) | null = null;
    let stored = false;
    const surface = await runtimeScreen((request) => {
      if (request.method === "PATCH") {
        const gate = Promise.withResolvers<Response>();
        releasePatch = gate.resolve;
        return gate.promise;
      }
      return json({
        ...RUNTIME,
        attemptCap: stored
          ? { capMs: 1_800_000, saved: true, min: 900_000, max: 3_600_000, degraded: false }
          : { capMs: 1_200_000, saved: false, min: 900_000, max: 3_600_000, degraded: false },
      });
    });
    expect(surface.container.querySelector('[data-attempt-cap="effective"]')?.textContent).toBe(
      "Effective on the next review: 1200000 ms (platform default — no value is saved).",
    );
    await surface.type("#attempt-cap-ms", "1800000");
    const form = surface.container.querySelector("#attempt-cap-ms")!.closest("form")!;
    await surface.click(form.querySelector('button[type="submit"]'));

    expect(surface.container.querySelector('[data-attempt-cap="confirming"]')?.textContent).toContain(
      "A save was sent and the stored value is being confirmed.",
    );
    expect(surface.container.querySelector('[data-attempt-cap="effective"]')).toBeNull();
    const field = surface.container.querySelector("#attempt-cap-ms") as unknown as HTMLInputElement;
    expect(field.value).toBe("");
    expect(field.disabled).toBe(true);

    stored = true;
    await act(async () => {
      releasePatch?.(json({ attemptCap: { capMs: 1_800_000 } }));
    });
    await act(async () => {});
    expect(surface.container.querySelector('[data-attempt-cap="confirming"]')).toBeNull();
    expect(surface.container.querySelector('[data-attempt-cap="effective"]')?.textContent).toBe(
      "Effective on the next review: 1800000 ms (saved value).",
    );
    await surface.close();
  });

  test("a definite refusal shows the value a fresh read returns, never the pre-save number", async () => {
    let serverCap = 1_200_000;
    let reads = 0;
    const surface = await runtimeScreen((request) => {
      if (request.method === "PATCH") {
        serverCap = 3_000_000;
        return new Response(
          JSON.stringify({ error: "the attempt cap must be an integer in 900000..3600000 ms" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      reads += 1;
      return json({
        ...RUNTIME,
        attemptCap: { capMs: serverCap, saved: true, min: 900_000, max: 3_600_000, degraded: false },
      });
    });
    await surface.type("#attempt-cap-ms", "1800000");
    const form = surface.container.querySelector("#attempt-cap-ms")!.closest("form")!;
    await surface.click(form.querySelector('button[type="submit"]'));

    expect(surface.text()).toContain("Could not change the maximum review duration.");
    expect(surface.text()).toContain("must be an integer in 900000..3600000 ms");
    expect(reads).toBe(2);
    expect(surface.container.querySelector('[data-attempt-cap="effective"]')?.textContent).toBe(
      "Effective on the next review: 3000000 ms (saved value).",
    );
    expect(surface.container.querySelector('[data-attempt-cap="changed-elsewhere"]')).toBeNull();
    const field = surface.container.querySelector("#attempt-cap-ms") as unknown as HTMLInputElement;
    expect(field.disabled).toBe(false);
    expect(field.value).toBe("1800000");
    await surface.close();
  });

  test("a definite refusal whose re-read fails leaves the value unknown and offers Retry", async () => {
    let reads = 0;
    let readsFail = true;
    const surface = await runtimeScreen((request) => {
      if (request.method === "PATCH") {
        return new Response(
          JSON.stringify({ error: "the attempt cap must be an integer in 900000..3600000 ms" }),
          { status: 400, headers: { "Content-Type": "application/json" } },
        );
      }
      reads += 1;
      if (reads > 1 && readsFail) return new Response("unavailable", { status: 503 });
      return json({
        ...RUNTIME,
        attemptCap: { capMs: 1_200_000, saved: false, min: 900_000, max: 3_600_000, degraded: false },
      });
    });
    await surface.type("#attempt-cap-ms", "1800000");
    const form = surface.container.querySelector("#attempt-cap-ms")!.closest("form")!;
    await surface.click(form.querySelector('button[type="submit"]'));

    expect(surface.text()).toContain("Could not change the maximum review duration.");
    expect(surface.container.querySelector('[data-attempt-cap="effective"]')).toBeNull();
    expect(surface.container.querySelector('[data-attempt-cap="unknown"]')).toBeNull();
    expect(surface.container.querySelector('[data-attempt-cap="confirming"]')).not.toBeNull();
    expect(surface.container.querySelector('[data-attempt-cap="retry"]')).not.toBeNull();

    readsFail = false;
    await surface.click(surface.container.querySelector('[data-attempt-cap="retry"]'));
    expect(surface.container.querySelector('[data-attempt-cap="confirming"]')).toBeNull();
    expect(surface.container.querySelector('[data-attempt-cap="effective"]')?.textContent).toBe(
      "Effective on the next review: 1200000 ms (platform default — no value is saved).",
    );
    await surface.close();
  });

  test("an uncertain save (5xx) stays unknown, and the retry reads the store back", async () => {
    let stored = false;
    const surface = await runtimeScreen((request) =>
      request.method === "PATCH"
        ? new Response(JSON.stringify({ error: "upstream timeout" }), {
            status: 500,
            headers: { "Content-Type": "application/json" },
          })
        : json({
            ...RUNTIME,
            attemptCap: {
              capMs: stored ? 1_800_000 : 1_200_000,
              saved: stored,
              min: 900_000,
              max: 3_600_000,
              degraded: false,
            },
          }),
    );
    await surface.type("#attempt-cap-ms", "1800000");
    const form = surface.container.querySelector("#attempt-cap-ms")!.closest("form")!;
    await surface.click(form.querySelector('button[type="submit"]'));

    expect(surface.container.querySelector('[data-attempt-cap="confirming"]')).not.toBeNull();
    expect(surface.container.querySelector('[data-attempt-cap="unknown"]')?.textContent).toBe(
      "The save's outcome is unknown: the request did not answer, so it may or may not have been stored. Retry reads the stored value back; no number is shown until it does.",
    );
    expect(surface.container.querySelector('[data-attempt-cap="effective"]')).toBeNull();
    expect(surface.text()).not.toContain("Could not change the maximum review duration.");
    const field = surface.container.querySelector("#attempt-cap-ms") as unknown as HTMLInputElement;
    expect(field.disabled).toBe(true);

    stored = true;
    await surface.click(surface.container.querySelector('[data-attempt-cap="retry"]'));
    expect(surface.container.querySelector('[data-attempt-cap="unknown"]')).toBeNull();
    expect(surface.container.querySelector('[data-attempt-cap="confirming"]')).toBeNull();
    expect(surface.container.querySelector('[data-attempt-cap="effective"]')?.textContent).toBe(
      "Effective on the next review: 1800000 ms (saved value).",
    );
    expect(surface.container.querySelector('[data-attempt-cap="changed-elsewhere"]')).toBeNull();
    expect(field.disabled).toBe(false);
    await surface.close();
  });

  test("a network error leaves the save's outcome unknown", async () => {
    const surface = await runtimeScreen((request) => {
      if (request.method === "PATCH") throw new TypeError("network down");
      return json({
        ...RUNTIME,
        attemptCap: { capMs: 1_200_000, saved: false, min: 900_000, max: 3_600_000, degraded: false },
      });
    });
    await surface.type("#attempt-cap-ms", "1800000");
    const form = surface.container.querySelector("#attempt-cap-ms")!.closest("form")!;
    await surface.click(form.querySelector('button[type="submit"]'));

    expect(surface.container.querySelector('[data-attempt-cap="unknown"]')).not.toBeNull();
    expect(surface.container.querySelector('[data-attempt-cap="effective"]')).toBeNull();
    expect(surface.container.querySelector('[data-attempt-cap="retry"]')).not.toBeNull();
    expect(surface.text()).not.toContain("Could not change the maximum review duration.");
    expect((surface.container.querySelector("#attempt-cap-ms") as unknown as HTMLInputElement).disabled).toBe(
      true,
    );
    await surface.close();
  });

  test("a save whose re-read fails shows no number, and a retry returns to one", async () => {
    let reads = 0;
    let readsFail = true;
    const surface = await runtimeScreen((request) => {
      if (request.method === "PATCH") return json({ attemptCap: { capMs: 1_800_000 } });
      reads += 1;
      if (reads > 1 && readsFail) return new Response("unavailable", { status: 503 });
      return json({
        ...RUNTIME,
        attemptCap: { capMs: 1_800_000, saved: true, min: 900_000, max: 3_600_000, degraded: false },
      });
    });
    await surface.type("#attempt-cap-ms", "1800000");
    const form = surface.container.querySelector("#attempt-cap-ms")!.closest("form")!;
    await surface.click(form.querySelector('button[type="submit"]'));

    expect(surface.container.querySelector('[data-attempt-cap="confirming"]')?.textContent).toContain(
      "A save was sent and the stored value is being confirmed.",
    );
    expect(surface.container.querySelector('[data-attempt-cap="effective"]')).toBeNull();
    const field = surface.container.querySelector("#attempt-cap-ms") as unknown as HTMLInputElement;
    expect(field.value).toBe("");
    expect(field.disabled).toBe(true);
    expect((form.querySelector('button[type="submit"]') as unknown as HTMLButtonElement).disabled).toBe(true);
    expect(surface.text()).toContain("Saved.");

    readsFail = false;
    await surface.click(surface.container.querySelector('[data-attempt-cap="retry"]'));
    expect(surface.container.querySelector('[data-attempt-cap="confirming"]')).toBeNull();
    expect(surface.container.querySelector('[data-attempt-cap="effective"]')?.textContent).toBe(
      "Effective on the next review: 1800000 ms (saved value).",
    );
    const confirmed = surface.container.querySelector("#attempt-cap-ms") as unknown as HTMLInputElement;
    expect(confirmed.value).toBe("1800000");
    expect(confirmed.disabled).toBe(false);
    await surface.close();
  });

  test("an unreadable cap claims no effective value and starts the field empty", async () => {
    const surface = await runtimeScreen(() =>
      json({
        ...RUNTIME,
        attemptCap: { capMs: 1_200_000, saved: false, min: 900_000, max: 3_600_000, degraded: true },
      }),
    );
    expect(surface.container.querySelector('[data-attempt-cap="effective"]')).toBeNull();
    expect((surface.container.querySelector("#attempt-cap-ms") as unknown as HTMLInputElement).value).toBe("");
    expect(surface.text()).toContain("no new review is admitted until it is readable again");
    await surface.close();
  });

  test("the route card calls an untrusted row off and names its raw value", async () => {
    const surface = await runtimeScreen(() =>
      json({
        ...RUNTIME,
        routeWorkflow: {
          mode: "off",
          saved: false,
          degraded: true,
          reason: "untrusted",
          rejected: '"ON"',
        },
      }),
    );
    expect(surface.container.querySelector('[data-route-workflow="stored"]')?.textContent).toBe(
      'off — untrusted (stored value "ON")',
    );
    expect(surface.container.querySelector('[data-route-workflow="effective"]')?.textContent).toBe(
      "off — deliveries are refused and nothing is created",
    );
    await surface.close();
  });

  test("an older server without a routeWorkflow field hides only that card", async () => {
    const surface = await runtimeScreen(() => json(RUNTIME));
    expect(surface.container.querySelector('[data-route-workflow="stored"]')).toBeNull();
    expect(surface.container.querySelector("#system-concurrency")).not.toBeNull();
    await surface.close();
  });

  test("the admission-drop card renders all four reasons and their 24h counts", async () => {
    const surface = await runtimeScreen(() =>
      json({
        ...RUNTIME,
        admissionDrops24h: { "pr-held": 3, "system-cap": 1, "workspace-cap": 2, error: 0 },
      }),
    );
    expect(surface.text()).toContain("Admission drops (last 24 hours)");
    const rendered = Object.fromEntries(
      [...surface.container.querySelectorAll("[data-admission-drops]")].map((node) => [
        node.getAttribute("data-admission-drops"),
        node.textContent,
      ]),
    );
    expect(rendered).toEqual({ "pr-held": "3", "system-cap": "1", "workspace-cap": "2", error: "0" });
    for (const label of ["PR in flight", "System cap", "Workspace cap", "Storage error"]) {
      expect(surface.text()).toContain(label);
    }
    await surface.close();
  });

  function queueCells(surface: Surface): Record<string, string | null> {
    return Object.fromEntries(
      [...surface.container.querySelectorAll("[data-queue]")].map((node) => [
        node.getAttribute("data-queue"),
        node.textContent,
      ]),
    );
  }

  test("the queue card renders the backlog depth and how long the oldest message has waited", async () => {
    const oldest = new Date(Date.now() - 2 * 3_600_000).toISOString();
    const surface = await runtimeScreen(() =>
      json({
        ...RUNTIME,
        queue: { backlogCount: 12, backlogBytes: 4096, oldestMessageTimestamp: oldest },
      }),
    );
    expect(surface.text()).toContain("Queue backlog and GitHub rate limits");
    expect(queueCells(surface)).toEqual({ backlog: "12", oldest: "2 hours ago", "rate-limited": "0" });
    await surface.close();
  });

  test("an unreadable queue gauge reads as not readable and never hides the rate-limit count", async () => {
    const surface = await runtimeScreen(() => json({ ...RUNTIME, queue: null, githubRateLimited24h: 4 }));
    expect(queueCells(surface)).toEqual({
      backlog: "Not readable",
      oldest: "Not readable",
      "rate-limited": "4",
    });
    await surface.close();
  });

  test("a non-zero 24 h GitHub secondary-rate-limit count renders in the queue card", async () => {
    const surface = await runtimeScreen(() =>
      json({
        ...RUNTIME,
        queue: { backlogCount: 0, backlogBytes: 0, oldestMessageTimestamp: null },
        githubRateLimited24h: 7,
      }),
    );
    expect(surface.text()).toContain("GitHub secondary limits (24 h)");
    expect(queueCells(surface)["rate-limited"]).toBe("7");
    expect(queueCells(surface).oldest).toBe("Empty");
    await surface.close();
  });

  test("a populated window renders the sample, the phase rows and the tail", async () => {
    const report = {
      ...DURATION_REPORT,
      sampleSize: 4,
      total: { p50Ms: 30_000, p90Ms: 40_000, maxMs: 50_000 },
      phases: {
        queueWait: { p50Ms: 1_000, p90Ms: 2_000, maxMs: 3_000 },
        execution: { p50Ms: 20_000, p90Ms: 30_000, maxMs: 40_000 },
        publication: { p50Ms: 8_000, p90Ms: 9_000, maxMs: 10_000 },
      },
      excluded: { "check-open-at-settle": 3, "no-settlement-record": 4, "no-boundary": 2, unsettled: 1, "pre-prepare": 1 },
    };
    const surface = await runtimeScreen(() => json(RUNTIME), "en", report);
    expect(surface.text()).toContain("4 complete attempts");
    expect(surface.container.querySelector('[data-duration="queue-wait-p50"]')?.textContent).toBe("1000 ms");
    expect(surface.container.querySelector('[data-duration="total-max"]')?.textContent).toBe("50000 ms");
    expect(surface.text()).toContain("Every attempt's interval splits into these three phases.");
    expect(surface.container.querySelector('[data-duration="excluded"]')?.textContent).toBe(
      "Excluded from the percentiles: 3 with a Check not proven closed at settlement, 4 with no settlement record, 2 without a measurable boundary, 1 unsettled, 1 stopped before prepare.",
    );
    expect(surface.container.querySelector('[data-duration="failure-tail"]')?.textContent).toBe(
      "An attempt whose paid step failed without a durable result has no execution end and is excluded before its duration is measured: while its settlement is still owed it counts as unsettled; once settled, a frozen Check not proven closed at settlement is counted before the missing result; otherwise the missing result reads as a missing boundary. A durable result does not by itself make an attempt measurable — a later failure still excludes it when the settlement, the queue stamp, the boundary order or the settlement record is missing, or when the attempt froze a Check that was not proven closed at settlement.",
    );
    expect(surface.container.querySelector('[data-duration="settlement-basis"]')?.textContent).toBe(
      "A sample is measured because its settlement recorded the publication obligation as discharged; where the attempt has a frozen Check, that Check concluded no later than the settlement instant. Delivery idempotency is not part of the interval.",
    );
    expect(surface.container.querySelector('[data-duration="description"]')?.textContent).toBe(
      "Attempts admitted in the last 30 days. Percentiles use only intervals whose settlement instant is written and whose settlement recorded the publication obligation as discharged; where the attempt has a frozen Check, that Check concluded no later than that instant. An empty window stays empty — it never reads as a zero.",
    );
    await surface.close();
  });

  test("an out-of-range candidate shows the analysis range and keeps the report rendered", async () => {
    const report = {
      ...DURATION_REPORT,
      sampleSize: 2,
      total: { p50Ms: 30_000, p90Ms: 40_000, maxMs: 50_000 },
      phases: {
        queueWait: { p50Ms: 1_000, p90Ms: 2_000, maxMs: 3_000 },
        execution: { p50Ms: 20_000, p90Ms: 30_000, maxMs: 40_000 },
        publication: { p50Ms: 8_000, p90Ms: 9_000, maxMs: 10_000 },
      },
    };
    const surface = await runtimeScreen(() => json(RUNTIME), "en", report);
    const form = surface.container.querySelector("#duration-candidate-cap")!.closest("form")!;
    await surface.type("#duration-candidate-cap", "86400001");

    expect(surface.container.querySelector('[data-duration="candidate-range"]')?.textContent).toBe(
      "The analysis accepts an integer from 1 to 86400000 ms.",
    );
    expect((form.querySelector('button[type="submit"]') as unknown as HTMLButtonElement).disabled).toBe(true);
    expect(surface.container.querySelector('[data-duration="sample"]')?.textContent).toBe("2 complete attempts");
    expect(surface.text()).not.toContain("Could not load this page.");
    expect(surface.sent.filter((request) => request.url.includes("duration-report")).length).toBe(1);

    await surface.type("#duration-candidate-cap", "60000");
    expect(surface.container.querySelector('[data-duration="candidate-range"]')).toBeNull();
    await surface.click(form.querySelector('button[type="submit"]'));
    expect(surface.sent.at(-1)?.url).toBe("/_internal_admin/api/runtime/duration-report?capMs=60000");
    expect(surface.container.querySelector('[data-duration="sample"]')?.textContent).toBe("2 complete attempts");
    await surface.close();
  });

  test("an excluded-but-completed window names itself as unmeasured in both locales", async () => {
    const none = await runtimeScreen(() => json(RUNTIME));
    expect(none.text()).toContain("No attempt was admitted in this window.");
    await none.close();

    const report = {
      ...DURATION_REPORT,
      excluded: { "check-open-at-settle": 2, "no-settlement-record": 1, "no-boundary": 1, unsettled: 1, "pre-prepare": 0 },
    };
    const excluded = await runtimeScreen(() => json(RUNTIME), "en", report);
    expect(excluded.text()).toContain("No attempt was measured: all 5 admitted attempts were excluded");
    expect(excluded.text()).toContain("2 with a Check not proven closed at settlement");
    expect(excluded.text()).toContain("1 with no settlement record");
    expect(excluded.text()).toContain("1 without a measurable boundary");
    expect(excluded.text()).not.toContain("No attempt was admitted in this window.");
    await excluded.close();

    const chinese = await runtimeScreen(() => json(RUNTIME), "zh_CN", report);
    expect(chinese.text()).toContain("此窗口内没有可测量的尝试");
    expect(chinese.text()).toContain("2 个结算时 Check 未被证明关闭");
    expect(chinese.text()).toContain("1 个没有结算记录");
    expect(chinese.container.querySelector('[data-duration="failure-tail"]')?.textContent).toBe(
      "付费步骤失败且没有产出持久结果的尝试没有执行终点，因此在测量时长之前就被排除：结算时点尚未写入的计入「未结算」；已结算的，先按冻结的 Check 在结算时未被证明关闭计数；两者都不成立时，缺结果才计入「没有可测量的边界」。已经产出结果也不会让尝试自动可测：后续失败仍可能让它在结算时点、队列发送时间戳、边界顺序或结算记录缺失时被排除，或在其冻结的 Check 于结算时未被证明关闭时被排除。",
    );
    expect(chinese.container.querySelector('[data-duration="settlement-basis"]')?.textContent).toBe(
      "样本之所以可测，是因为它的这次结算把发布义务记为已解除；尝试若有冻结的 Check，该 Check 不晚于结算时点得出结论。投递幂等性不属于该区间。",
    );
    expect(chinese.container.querySelector('[data-duration="description"]')?.textContent).toBe(
      "最近 30 天内被准入的尝试。百分位只统计已写入结算时点、且该次结算把发布义务记为已解除的区间；尝试若有冻结的 Check，该 Check 须不晚于结算时点得出结论。空窗口就显示为空，绝不当作 0。",
    );
    await chinese.close();
  });

  function maintenanceCells(surface: Surface): Record<string, string | null> {
    return Object.fromEntries(
      [...surface.container.querySelectorAll("[data-maintenance]")].map((node) => [
        node.getAttribute("data-maintenance"),
        node.textContent,
      ]),
    );
  }

  test("the maintenance card renders an open window from /api/runtime", async () => {
    const surface = await runtimeScreen(() =>
      json({ ...RUNTIME, maintenance: { enabled: false, reason: null, since: null } }),
    );
    expect(surface.text()).toContain("Maintenance mode");
    expect(maintenanceCells(surface)).toEqual({ state: "Off — the platform is serving" });
    expect(surface.container.querySelector("#maintenance-reason")).not.toBeNull();
    expect(
      (surface.container.querySelector("#maintenance-reason") as unknown as HTMLInputElement).disabled,
    ).toBe(true);
    await surface.close();
  });

  test("a closed window shows its state, the operator's reason and the start time", async () => {
    const since = new Date(Date.now() - 3 * 3_600_000).toISOString();
    const surface = await runtimeScreen(() =>
      json({ ...RUNTIME, maintenance: { enabled: true, reason: "repository backfill", since } }),
    );
    expect(maintenanceCells(surface)).toEqual({
      state: "On — the platform is closed",
      since: "3 hours ago",
      reason: "repository backfill",
    });
    await surface.close();
  });

  test("closing the platform fires exactly one PATCH with the typed reason", async () => {
    const since = "2026-11-17T09:00:00.000Z";
    const surface = await runtimeScreen((request) =>
      request.method === "PATCH"
        ? json({ maintenance: { enabled: true, reason: "repository backfill", since } })
        : json({ ...RUNTIME, maintenance: { enabled: false, reason: null, since: null } }),
    );
    await surface.click(surface.container.querySelector('button[aria-label="Maintenance mode Off — the platform is serving"]'));
    await surface.type("#maintenance-reason", "repository backfill");
    await surface.click(
      [...surface.container.querySelectorAll("form")]
        .find((form) => form.querySelector("#maintenance-reason"))
        ?.querySelector('button[type="submit"]') ?? null,
    );

    expect(surface.sent.filter((request) => request.method === "PATCH")).toEqual([
      {
        url: "/_internal_admin/api/runtime",
        method: "PATCH",
        body: { maintenance: { enabled: true, reason: "repository backfill" } },
      },
    ]);
    const cells = maintenanceCells(surface);
    expect(cells.state).toBe("On — the platform is closed");
    expect(cells.reason).toBe("repository backfill");
    expect(cells.since).not.toBeNull();
    expect(
      surface.sent.filter(
        (request) => request.method === "GET" && request.url === "/_internal_admin/api/runtime",
      ),
    ).toHaveLength(1);
    expect(surface.text()).toContain("Saved.");
    await surface.close();
  });

  test("an older server without a maintenance field hides only that card", async () => {
    const surface = await runtimeScreen(() => json(RUNTIME));
    expect(surface.container.querySelector("#maintenance-reason")).toBeNull();
    expect(surface.container.querySelector("#system-concurrency")).not.toBeNull();
    await surface.close();
  });

  const reviews = (over: Record<string, unknown>) => ({
    ...RUNTIME,
    routeWorkflow: { mode: "on", saved: true, degraded: false, reason: null, rejected: null },
    reviewsRunning: {
      answer: "running",
      platform: { enabled: true, unreadable: false },
      pausedApps: 0,
      appsHref: "/dashboard/acme/apps",
      ...over,
    },
  });

  test("the reviews card states the running answer with its three gate facts", async () => {
    const surface = await runtimeScreen(() =>
      json(reviews({ pausedApps: 2, platform: { enabled: true, unreadable: false } })),
    );
    expect(surface.container.querySelector('[data-reviews-running="answer"]')?.textContent).toBe(
      "Reviews are running.",
    );
    expect(surface.container.querySelector('[data-reviews-running="platform"]')?.textContent).toBe(
      "on — reviews are allowed",
    );
    expect(surface.container.querySelector('[data-reviews-running="route"]')?.textContent).toBe(
      "on — deliveries create a Workflow instance",
    );
    expect(surface.container.querySelector('[data-reviews-running="paused-apps"]')?.textContent).toBe("2");
    expect(
      (surface.container.querySelector('a[href="/dashboard/acme/apps"]') as unknown as Element | null)
        ?.textContent,
    ).toBe("Pause or resume a single App in the App settings");
    expect(surface.container.querySelector('[data-reviews-running="precedence"]')?.textContent).toBe(
      "A read fault outranks both causes and concludes nothing. Otherwise the deployment gate is checked first: when it is not on, queued deliveries are settled as blocked, and that is the answer named here even if the platform switch is also off.",
    );
    await surface.close();
  });

  test("no workspace ref means no App link, but the answer still renders", async () => {
    const surface = await runtimeScreen(() => json(reviews({ appsHref: null })));
    expect(surface.container.querySelector("[data-reviews-running] a")).toBeNull();
    expect(surface.container.querySelector('[data-reviews-running="answer"]')?.textContent).toBe(
      "Reviews are running.",
    );
    await surface.close();
  });

  test("a platform-paused answer names the switch as the cause", async () => {
    const surface = await runtimeScreen(() =>
      json({
        ...reviews({ answer: "paused-platform", platform: { enabled: false, unreadable: false } }),
      }),
    );
    expect(surface.container.querySelector('[data-reviews-running="answer"]')?.textContent).toBe(
      "Reviews are paused by the platform switch: new deliveries are refused and queued ones end as paused.",
    );
    expect(surface.container.querySelector('[data-reviews-running="platform"]')?.textContent).toBe(
      "off — reviews are paused",
    );
    await surface.close();
  });

  test("a blocked answer states the deployment gate and never reads as running", async () => {
    const surface = await runtimeScreen(() =>
      json({
        ...reviews({ answer: "blocked-deployment-gate" }),
        routeWorkflow: { mode: "off", saved: false, degraded: false, reason: null, rejected: null },
      }),
    );
    expect(surface.container.querySelector('[data-reviews-running="answer"]')?.textContent).toBe(
      "Reviews are blocked by the deployment gate: the routing gate is not on for this deployment, so queued deliveries end as blocked.",
    );
    expect(surface.container.querySelector('[data-reviews-running="route"]')?.textContent).toBe(
      "off — queued deliveries end as blocked",
    );
    await surface.close();
  });

  test("a failed gate READ concludes nothing — it never reads as blocked or settled", async () => {
    // reason: read-failed — the row could not be asked, so no cause is provable.
    const surface = await runtimeScreen(() =>
      json({
        ...reviews({
          answer: "unreadable-state",
          platform: { enabled: true, unreadable: false },
          pausedApps: null,
        }),
        routeWorkflow: {
          mode: "off",
          saved: false,
          degraded: true,
          reason: "read-failed",
          rejected: null,
        },
      }),
    );
    const answer = surface.container.querySelector('[data-reviews-running="answer"]')?.textContent ?? "";
    expect(answer).toBe(
      "The review state could not be read: the platform switch or the routing gate did not answer, so this page concludes nothing. Queued deliveries are not settled — the queue retries them within its bounded attempts, and a batch that exhausts them lands in the dead-letter queue instead of running.",
    );
    // The read fault must not be presented as either proven cause.
    expect(answer.toLowerCase()).not.toContain("blocked by the deployment gate");
    expect(answer).not.toContain("end as blocked");
    expect(answer).toContain("not settled");
    expect(answer).toContain("bounded attempts");
    expect(surface.container.querySelector('[data-reviews-running="route"]')?.textContent).toBe(
      "unreadable — the review state cannot be concluded",
    );
    expect(surface.container.querySelector('[data-reviews-running="paused-apps"]')?.textContent).toBe(
      "not readable",
    );
    await surface.close();
  });

  test("a readable but untrusted gate reads as closed, and the answer says blocked", async () => {
    // The row WAS read: closed is the gate's documented safe default and the
    // queue settles it, so this must not borrow the unknowable state's copy.
    const surface = await runtimeScreen(() =>
      json({
        ...reviews({ answer: "blocked-deployment-gate", pausedApps: null }),
        routeWorkflow: {
          mode: "off",
          saved: false,
          degraded: true,
          reason: "untrusted",
          rejected: '"ON"',
        },
      }),
    );
    expect(surface.container.querySelector('[data-reviews-running="answer"]')?.textContent).toBe(
      "Reviews are blocked by the deployment gate: the routing gate is not on for this deployment, so queued deliveries end as blocked.",
    );
    expect(surface.container.querySelector('[data-reviews-running="route"]')?.textContent).toBe(
      'off — the stored value is not on or off, so deliveries end as blocked',
    );
    await surface.close();
  });

  test("the Chinese face states the unreadable answer without claiming a settlement", async () => {
    const surface = await runtimeScreen(
      () =>
        json({
          ...reviews({
            answer: "unreadable-state",
            platform: { enabled: false, unreadable: true },
            pausedApps: null,
          }),
          routeWorkflow: { mode: "off", saved: false, degraded: true, reason: "read-failed", rejected: null },
        }),
      "zh_CN",
    );
    const answer = surface.container.querySelector('[data-reviews-running="answer"]')?.textContent ?? "";
    expect(answer).toContain("无法读取审查状态");
    expect(answer).not.toContain("以阻塞结束");
    expect(answer).toContain("不会被结算");
    await surface.close();
  });

  test("an older server without a reviewsRunning block hides only that card", async () => {
    const surface = await runtimeScreen(() => json(RUNTIME));
    expect(surface.container.querySelector('[data-reviews-running="answer"]')).toBeNull();
    expect(surface.container.querySelector("#system-concurrency")).not.toBeNull();
    await surface.close();
  });

  test("the Chinese face states the same answer and gate detail", async () => {
    const surface = await runtimeScreen(
      () => json(reviews({ answer: "blocked-deployment-gate" })),
      "zh_CN",
    );
    expect(surface.container.querySelector('[data-reviews-running="answer"]')?.textContent).toBe(
      "审查被部署门禁阻塞：本次部署的路由门禁未开启，队列中的投递会以阻塞结束。",
    );
    expect(surface.container.querySelector('[data-reviews-running="platform"]')?.textContent).toBe(
      "on — 允许审查",
    );
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
    expect(acme?.querySelector('[data-slot="select-trigger"]')?.textContent).toBe("Free");
    expect(seatsCell(surface, "Acme")).toBe("3 / 5");
    expect(rowContaining(surface, "Guild")?.textContent).toContain("—");
    await surface.close();
  });

  test("an unlimited seat cap renders as —, never 0", async () => {
    const surface = await workspacesScreen(() => json({ workspaces: WORKSPACES }));
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
    expect(rowContaining(surface, "Acme")?.querySelector('[data-slot="select-trigger"]')?.textContent).toBe("Pro");
    await surface.close();
  });

  test("search filters the loaded rows and shows the N / M counter", async () => {
    const surface = await workspacesScreen(() => json({ workspaces: WORKSPACES }));
    expect(surface.text()).toContain("2 / 2");
    await surface.type('input[type="search"]', "guild");
    expect(surface.container.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(surface.text()).toContain("Guild");
    expect(surface.container.querySelector("tbody")?.textContent).not.toContain("Acme");
    expect(surface.text()).toContain("1 / 2");
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

  test("an empty list plus a typed query keeps the page empty state", async () => {
    const surface = await workspacesScreen(() => json({ workspaces: [] }));
    await surface.type('input[type="search"]', "zzz");
    const empty = surface.container.querySelector('[data-slot="empty-state"]');
    expect(empty?.textContent).toContain("No workspaces");
    expect(empty?.textContent).not.toContain("No matches");
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
    expect(labels).toContain("Legacy Tier");
    expect(labels).toContain("专业版");
    expect(labels).toContain("无限版");
    await surface.close();
  });

  test("a zh_CN render localises the plan picker's catalogue labels", async () => {
    const surface = await workspacesScreen(() => json({ workspaces: WORKSPACES }), "zh_CN");
    const trigger = rowContaining(surface, "Acme")?.querySelector('[data-slot="select-trigger"]') ?? null;
    expect(trigger?.textContent).toBe("免费版");
    await surface.openSelect(trigger);
    const labels = [...surface.win.document.querySelectorAll('[role="option"]')].map(
      (node) => node.textContent,
    );
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
    expect(alert?.textContent).toContain("无法更改 Acme 的套餐。");
    expect(alert?.textContent).toContain("服务器返回：seat limit reached");
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
    expect(surface.win.document.querySelector('[data-slot="dialog-content"]')).toBeNull();
    expect(rowContaining(surface, "Acme")?.textContent).toContain("acme-hq");
    await surface.close();
  });

  test("the save button is disabled while the draft equals the stored slug", async () => {
    const surface = await workspacesScreen(() => json({ workspaces: WORKSPACES }));
    const action = [...surface.container.querySelectorAll("button")].find(
      (button) => button.textContent === "Edit slug",
    );
    await surface.click(action ?? null);

    const save = () =>
      [...surface.win.document.querySelectorAll('[data-slot="dialog-content"] button')].find(
        (button) => button.textContent === "Save slug",
      ) as unknown as HTMLButtonElement | undefined;
    expect(save()?.disabled).toBe(true);
    await surface.type('[data-slot="dialog-content"] input', "acme-hq");
    expect(save()?.disabled).toBe(false);
    await surface.type('[data-slot="dialog-content"] input', "acme");
    expect(save()?.disabled).toBe(true);
    expect(surface.sent.filter((request) => request.method === "PATCH")).toHaveLength(0);
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
    const alert = dialog?.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("无法更改 Acme 的 slug。");
    expect(alert?.textContent).toContain("服务器返回：slug is reserved");
    expect(surface.container.querySelector('[role="alert"]')).toBeNull();
    expect(rowContaining(surface, "Acme")?.textContent).toContain("acme");
    await surface.close();
  });
});

describe("Workspaces screen — official workspace card", () => {
  const runtimeWith = (officialWorkspaceId: string | null) => ({ ...RUNTIME, officialWorkspaceId });

  async function page(
    runtime: "ok" | "failed",
    officialWorkspaceId: string | null,
    respond: Respond = () => json({ workspaces: WORKSPACES }),
    locale: "en" | "zh_CN" = "en",
  ): Promise<Surface> {
    return mount(createElement(WorkspacesPage, { locale }), (request) =>
      request.url.endsWith("/api/runtime") && request.method === "GET"
        ? runtime === "ok"
          ? json(runtimeWith(officialWorkspaceId))
          : failed()
        : respond(request),
    );
  }

  const designation = (surface: Surface): string =>
    surface.container.querySelector("[data-official-workspace]")?.textContent ?? "";

  const button = (surface: Surface, label: string): DomElement | null =>
    [...surface.container.querySelectorAll("button")].find((node) => node.textContent === label) ?? null;

  test("the card names the designated workspace and its id", async () => {
    const surface = await page("ok", "ws_1");
    expect(surface.text()).toContain("Official workspace");
    expect(designation(surface)).toBe("Acme");
    expect(
      surface.container.querySelector('[data-official-workspace="ws_1"]')?.parentElement?.textContent,
    ).toContain("ws_1");
    await surface.close();
  });

  test("no designation reads as the empty state and withholds Clear", async () => {
    const surface = await page("ok", null);
    expect(
      surface.container.querySelector('[data-official-workspace="none"]')?.textContent,
    ).toBe("Not specified");
    expect((button(surface, "Clear") as unknown as HTMLButtonElement | null)?.disabled).toBe(true);
    await surface.close();
  });

  test("Save writes the selected workspace with one PATCH and updates the card", async () => {
    const surface = await page("ok", "ws_1");
    expect((button(surface, "Save") as unknown as HTMLButtonElement | null)?.disabled).toBe(true);

    await surface.openSelect(surface.container.querySelector("#official-workspace"));
    await surface.pickOption("Guild");
    await surface.click(button(surface, "Save"));

    const patches = surface.sent.filter((request) => request.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]?.url).toBe("/_internal_admin/api/official-workspace");
    expect(patches[0]?.body).toEqual({ workspaceId: "ws_2" });
    expect(designation(surface)).toBe("Guild");
    expect(surface.container.querySelector('[role="status"]')?.textContent).toContain(
      "Official workspace saved.",
    );
    await surface.close();
  });

  test("Clear writes null — an explicit action, never an empty save", async () => {
    const surface = await page("ok", "ws_1");
    await surface.click(button(surface, "Clear"));

    const patches = surface.sent.filter((request) => request.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]?.url).toBe("/_internal_admin/api/official-workspace");
    expect(patches[0]?.body).toEqual({ workspaceId: null });
    expect(
      surface.container.querySelector('[data-official-workspace="none"]')?.textContent,
    ).toBe("Not specified");
    expect(surface.container.querySelector('[role="status"]')?.textContent).toContain(
      "Shares already granted stay revocable.",
    );
    await surface.close();
  });

  test("a refused write keeps the localised primary message with the server detail secondary", async () => {
    const surface = await page("ok", "ws_1", (request) =>
      request.method === "PATCH"
        ? json({ error: "workspace not found" }, 400)
        : json({ workspaces: WORKSPACES }),
    );
    await surface.click(button(surface, "Clear"));

    const alert = surface.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Could not change the official workspace.");
    expect(alert?.textContent).toContain("Server: workspace not found");
    expect(designation(surface)).toBe("Acme");
    await surface.close();
  });

  test("a failed runtime read states it inside the card and keeps the table", async () => {
    const surface = await page("failed", null);
    expect(surface.container.querySelector('[role="alert"]')?.textContent).toContain(
      "Could not load the official workspace.",
    );
    expect(surface.container.querySelectorAll("tbody tr")).toHaveLength(2);
    await surface.close();
  });
});


describe("Bots screen", () => {
  const rowAction = (surface: Surface, needle: string, label: string): DomElement | null =>
    [...(rowContaining(surface, needle)?.querySelectorAll("button") ?? [])].find(
      (node) => node.textContent === label,
    ) ?? null;

  const confirmButton = (surface: Surface): DomElement | null =>
    [...surface.win.document.querySelectorAll('[data-slot="dialog-content"] button')].find(
      (node) => node.textContent === "Confirm",
    ) ?? null;

  test("loading renders the table skeleton", async () => {
    const surface = await botsScreen(never);
    expect(surface.container.querySelector('[data-slot="page-skeleton"]')).not.toBeNull();
    await surface.close();
  });

  test("a failed read renders the error state", async () => {
    const surface = await botsScreen(failed);
    expect(surface.container.querySelector('[data-slot="error-state"]')?.textContent).toContain(
      "Could not load the bot list.",
    );
    await surface.close();
  });

  test("an empty list renders the empty state", async () => {
    const surface = await botsScreen(() => json({ bots: [] }));
    expect(surface.container.querySelector('[data-slot="empty-state"]')?.textContent).toContain("No bots");
    await surface.close();
  });

  test("rows carry the bot, its workspace, scope, stamp and counts", async () => {
    const surface = await botsScreen(() => json({ bots: BOTS }));
    expect(surface.container.querySelectorAll("tbody tr")).toHaveLength(3);

    const shared = rowContaining(surface, "mstar-inspector");
    expect(shared?.textContent).toContain("app 4803300");
    expect(shared?.textContent).toContain("Acme");
    expect(shared?.querySelector('[data-slot="status-badge"]')?.textContent).toBe("official");
    expect(shared?.textContent).toContain("shared");
    expect(shared?.textContent).toContain("2026-11-15 12:03");
    expect(shared?.textContent).toContain("2");
    expect(
      [...(rowContaining(surface, "team-a-reviewer")?.querySelectorAll('[data-slot="status-badge"]') ?? [])].map(
        (node) => node.textContent,
      ),
    ).toEqual(["owned"]);
    expect(rowContaining(surface, "acme-bot")?.textContent).toContain("—");
    await surface.close();
  });

  test("the action is disabled with the reason outside the official workspace", async () => {
    const surface = await botsScreen(() => json({ bots: BOTS }));
    const action = rowAction(surface, "team-a-reviewer", "Sharing unavailable");
    expect(action).not.toBeNull();
    expect((action as unknown as HTMLButtonElement).disabled).toBe(true);
    expect(rowContaining(surface, "team-a-reviewer")?.textContent).toContain(
      "Only bots in the official workspace can be shared.",
    );
    await surface.close();
  });

  test("a share that outlived the designation stays revocable", async () => {
    const stale = [{ ...BOTS[1]!, scope: "shared", sharedAt: "2026-11-01T09:00:00.000Z" }];
    const surface = await botsScreen(() => json({ bots: stale }));
    const action = rowAction(surface, "team-a-reviewer", "Unshare");
    expect(action).not.toBeNull();
    expect((action as unknown as HTMLButtonElement).disabled).toBe(false);
    await surface.close();
  });

  test("sharing writes one PATCH and re-reads the list", async () => {
    const surface = await botsScreen((request) =>
      request.method === "PATCH" ? json({ botId: "bot-3", scope: "shared", sharedAt: "x" }) : json({ bots: BOTS }),
    );
    await surface.click(rowAction(surface, "acme-bot", "Share"));

    const dialog = surface.win.document.querySelector('[data-slot="dialog-content"]');
    expect(dialog?.textContent).toContain("Share acme-bot platform-wide?");
    expect(surface.sent.filter((request) => request.method === "PATCH")).toHaveLength(0);
    await surface.click(confirmButton(surface));

    const patches = surface.sent.filter((request) => request.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]?.url).toBe("/_internal_admin/api/bots/bot-3/scope");
    expect(patches[0]?.body).toEqual({ scope: "shared" });
    expect(surface.sent.filter((request) => request.method === "GET")).toHaveLength(2);
    await surface.close();
  });

  test("unsharing asks first and names the consequence before writing", async () => {
    const surface = await botsScreen((request) =>
      request.method === "PATCH" ? json({ botId: "bot-1", scope: "owned", sharedAt: null }) : json({ bots: BOTS }),
    );
    await surface.click(rowAction(surface, "mstar-inspector", "Unshare"));

    const dialog = surface.win.document.querySelector('[data-slot="dialog-content"]');
    expect(dialog?.textContent).toContain("Stop sharing mstar-inspector?");
    expect(dialog?.textContent).toContain(
      "Targets in other workspaces become Blocked until the bot is shared again.",
    );
    await surface.click(confirmButton(surface));

    const patches = surface.sent.filter((request) => request.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0]?.body).toEqual({ scope: "owned", confirm: true });
    await surface.close();
  });

  test("search filters on the bot name with the N / M counter", async () => {
    const surface = await botsScreen(() => json({ bots: BOTS }));
    expect(surface.text()).toContain("3 / 3");
    await surface.type('input[type="search"]', "team");
    expect(surface.container.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(rowContaining(surface, "team-a-reviewer")).not.toBeNull();
    expect(surface.text()).toContain("1 / 3");

    await surface.type('input[type="search"]', "zzz");
    expect(surface.container.querySelector('[data-slot="empty-state"]')?.textContent).toContain(
      "No matches",
    );
    await surface.close();
  });

  test("a refused share keeps the localised primary message with the server detail", async () => {
    const surface = await botsScreen((request) =>
      request.method === "PATCH"
        ? json({ error: "bot is outside the official workspace" }, 409)
        : json({ bots: BOTS }),
    );
    await surface.click(rowAction(surface, "acme-bot", "Share"));
    await surface.click(confirmButton(surface));

    const alert = surface.container.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain("Could not change the sharing of acme-bot.");
    expect(alert?.textContent).toContain("Server: bot is outside the official workspace");
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
    expect(surface.container.querySelectorAll('[data-tone="accent"]')).toHaveLength(1);
    expect(
      rowContaining(surface, "octocat")?.querySelector('[data-slot="status-badge"]')?.getAttribute("data-tone"),
    ).toBe("accent");
    await surface.close();
  });

  test("search filters on the GitHub login with the N / M counter", async () => {
    const surface = await usersScreen(() => json({ users: USERS }));
    expect(surface.text()).toContain("3 / 3");
    await surface.type('input[type="search"]', "yuki");
    expect(surface.container.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(surface.text()).toContain("1 / 3");
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

  test("an empty list plus a typed query keeps the page empty state", async () => {
    const surface = await usersScreen(() => json({ users: [] }));
    await surface.type('input[type="search"]', "zzz");
    const empty = surface.container.querySelector('[data-slot="empty-state"]');
    expect(empty?.textContent).toContain("No users");
    expect(empty?.textContent).not.toContain("No matches");
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

const USAGE = {
  month: "2026-11",
  workspaces: [
    { workspaceId: "ws-alpha", workspaceName: "Alpha", workspaceSlug: "acme", sharedReviews: 12, ownReviews: 4 },
    { workspaceId: "ws-gamma", workspaceName: "Gamma", workspaceSlug: "guild", sharedReviews: 0, ownReviews: 9 },
    { workspaceId: "ws-beta", workspaceName: "Beta", workspaceSlug: "beta", sharedReviews: 0, ownReviews: 0 },
  ],
};

function usageCells(surface: Surface, needle: string): [string, string] {
  const cells = rowContaining(surface, needle)?.querySelectorAll("td") ?? [];
  return [cells[1]?.textContent ?? "", cells[2]?.textContent ?? ""];
}

describe("Usage screen", () => {
  test("the heading names the window the read answered for", async () => {
    const surface = await usageScreen(() => json(USAGE));
    expect(surface.text()).toContain("Reviews per workspace · 2026-11 (UTC)");
    await surface.close();
  });

  test("rows carry the workspace and the two counts, zeros included", async () => {
    const surface = await usageScreen(() => json(USAGE));
    expect([...surface.container.querySelectorAll("th")].map((th) => th.textContent)).toEqual([
      "Workspace",
      "Shared bot",
      "Own bots",
    ]);
    expect(surface.container.querySelectorAll("tbody tr")).toHaveLength(3);
    expect(rowContaining(surface, "Alpha")?.textContent).toContain("acme");
    expect(usageCells(surface, "Alpha")).toEqual(["12", "4"]);
    expect(usageCells(surface, "Gamma")).toEqual(["0", "9"]);
    expect(usageCells(surface, "Beta")).toEqual(["0", "0"]);
    await surface.close();
  });

  test("search filters the loaded rows with the N / M counter", async () => {
    const surface = await usageScreen(() => json(USAGE));
    expect(surface.text()).toContain("3 / 3");
    await surface.type('input[type="search"]', "guild");
    expect(surface.container.querySelectorAll("tbody tr")).toHaveLength(1);
    expect(surface.text()).toContain("1 / 3");
    expect(rowContaining(surface, "Gamma")).not.toBeNull();
    await surface.close();
  });

  test("a non-matching search and an empty deployment borrow the existing empty states", async () => {
    const surface = await usageScreen(() => json(USAGE));
    await surface.type('input[type="search"]', "zzz");
    expect(surface.container.querySelector('[data-slot="empty-state"]')?.textContent).toContain("No matches");
    await surface.close();

    const empty = await usageScreen(() => json({ month: "2026-11", workspaces: [] }));
    expect(empty.container.querySelector('[data-slot="empty-state"]')?.textContent).toContain("No workspaces");
    await empty.close();
  });
});
