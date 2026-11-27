import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { t } from "../../src/i18n";
import type { SpaBoot } from "../../src/spa/boot";
import {
  parseUsageSnapshot,
  type CatalogProvider,
  type ProviderKeyRow,
  type SettingsManagePayload, type ProviderManagementPayload,
} from "../../src/spa/pages/data";
import { LoadedProvidersSection as ProvidersSection } from "../../src/spa/pages/settings-providers";
import { UsagePanel } from "../../src/spa/pages/usage-panel";
import type { OpNotice } from "../../src/spa/pages/PageNotice";
import { installDom } from "./dom";

const locale: SpaBoot["locale"] = "en";

const catalogEntry = (id: string, overrides: Partial<CatalogProvider> = {}): CatalogProvider => ({
  id,
  label: `${id} label`,
  tier: "template",
  base_url: null,
  api: null,
  models: [],
  verifiable: true,
  usage_probe: false,
  eligibility: "template",
  display_group: "catalog",
  ...overrides,
});

const keyRow = (provider: string, overrides: Partial<ProviderKeyRow> = {}): ProviderKeyRow => ({
  provider,
  keyId: "deadbeefcafe1234",
  last4: "9f2c",
  updatedAt: null,
  verifiedAt: null,
  verifiedStatus: "ok",
  ...overrides,
});

function managePayload(overrides: Partial<SettingsManagePayload & ProviderManagementPayload> = {}): SettingsManagePayload & ProviderManagementPayload {
  return {
    can_manage: true,
    viewer_relation: "created",
    installation: null,
    pending_installations: [],
    workspace_id: "ws_test",
    target_id: "rt-501",
    blocked: false as const,
    blocked_reason: null,
    app: {
      github_app_id: 42,
      status: "active",
      review_enabled: true,
      created_by: "mallory",
      last_webhook_at: null,
      scope: "owned" as const,
      id: "bot-42",
      sandbox_image_id: "omp",
      review_trigger_mode: "every_push",
      review_level: null,
      default_review_level: "default",
      github_name: null,
      github_slug: null,
      github_description: null,
      github_html_url: null,
      github_avatar_url: null,
      github_metadata_synced_at: null,
      github_visibility: "unknown",
    },
    check_gate: { min_score: 80, pass_verdicts: ["ship it"] },
    keys: [],
    model_chain: null,
    model_limits_snapshot: "2026-01-01",
    model_roles: {},
    model_chains: [],
    custom_providers: [],
    configured_providers: [],
    provider_catalog: [],
    provider_catalog_version: "fixture-catalog",
    provider_eligibility: {},
    model_role_ids: [],
    custom_provider_api_ids: [],
    sandbox_images: [{ id: "omp", enabled: true }],
    installations: [],
    ...overrides,
  };
}

function snapshotBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ok: true, status: "ok", fetchedAt: 1_700_000_000_000, limits: [], ...overrides });
}

type FetchCall = { url: string; body: string };

const realFetch = globalThis.fetch;
let calls: FetchCall[] = [];
let queue: Array<() => Response | Promise<Response>> = [];

beforeEach(() => {
  calls = [];
  queue = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    calls.push({ url: String(input), body: String(init?.body ?? "") });
    const next = queue.shift();
    if (next === undefined) throw new Error("no stubbed fetch response left");
    return next();
  }) as typeof fetch;
});

afterEach(() => {
  globalThis.fetch = realFetch;
});

async function mount(payload: SettingsManagePayload & ProviderManagementPayload, loc: SpaBoot["locale"] = locale) {
  const { win, cleanup: cleanupDom } = installDom("http://localhost/dashboard/acme/apps");
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  const element: ReactElement = createElement(ProvidersSection, {
    locale: loc,
    payload,
    onVerify: async (): Promise<OpNotice> => ({ kind: "success", message: "added" }),
    onSettings: async (): Promise<OpNotice> => ({ kind: "success", message: "added" }),
    onPending: () => {},
    notice: null,
    removeOutcome: null,
    onOutcome: () => {},
    onReload: async () => {},
  });
  await act(async () => root.render(element));
  await act(async () => {});

  const panel = (): HTMLElement | null =>
    win.document.querySelector('[data-slot="usage-panel"]') as unknown as HTMLElement | null;
  const pressEscape = async () => {
    await act(async () => {
      (win.document as unknown as Document).dispatchEvent(
        new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event,
      );
    });
  };
  const click = async (target: Element | null) => {
    await act(async () => {
      target?.dispatchEvent(
        new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }) as unknown as Event,
      );
    });
  };
  const flush = async () => {
    await act(async () => {});
    await act(async () => {});
  };
  const usageButton = (): HTMLButtonElement | null =>
    [...(win.document.querySelectorAll("button") as unknown as HTMLButtonElement[])].find(
      (button) => button.textContent === t(loc, "settings.providers.usage.action"),
    ) ?? null;
  const rowUsageButton = (last4: string): HTMLButtonElement | null => {
    const row = [...(win.document.querySelectorAll('[data-slot="list-row"]') as unknown as HTMLElement[])].find(
      (candidate) => candidate.textContent?.includes(last4),
    );
    return (row?.querySelector("button") as HTMLButtonElement | null) ?? null;
  };

  return {
    win,
    panel,
    pressEscape,
    click,
    flush,
    usageButton,
    rowUsageButton,
    calls,
    cleanup: async () => {
      await act(async () => root.unmount());
      cleanupDom();
    },
  };
}

const probedProvider = "commandcode";

function probedPayload(
  catalogOverrides: Partial<CatalogProvider> = {},
  keys: ProviderKeyRow[] = [keyRow(probedProvider)],
): SettingsManagePayload & ProviderManagementPayload {
  return managePayload({
    keys,
    provider_catalog: [
      catalogEntry(probedProvider, { label: "Command Code", usage_probe: true, ...catalogOverrides }),
    ],
  });
}

describe("parseUsageSnapshot — field-by-field validation", () => {
  test("unknown shapes, off-vocabulary fields and bad limit rows return null", () => {
    expect(parseUsageSnapshot(null)).toBeNull();
    expect(parseUsageSnapshot("ok")).toBeNull();
    expect(parseUsageSnapshot({ status: "weird", fetchedAt: 1, limits: [] })).toBeNull();
    expect(parseUsageSnapshot({ status: "ok", fetchedAt: "1", limits: [] })).toBeNull();
    expect(parseUsageSnapshot({ status: "ok", fetchedAt: 1, limits: "none" })).toBeNull();
    expect(
      parseUsageSnapshot({ status: "ok", fetchedAt: 1, limits: [{ id: "x", kind: "window", unit: "fortnights" }] }),
    ).toBeNull();
    expect(
      parseUsageSnapshot({ status: "ok", fetchedAt: 1, limits: [{ id: "x", kind: "window", unit: "percent", shared: "yes" }] }),
    ).toBeNull();
    expect(parseUsageSnapshot({ status: "ok", fetchedAt: 1, limits: [], absentCause: "ghost" })).toBeNull();
  });

  test("non-finite numbers (NaN / Infinity) fail the parse instead of rendering NaN%", () => {
    const limit = { id: "x", kind: "window", unit: "percent" };
    for (const bad of [NaN, Infinity, -Infinity]) {
      expect(parseUsageSnapshot({ status: "ok", fetchedAt: 1, limits: [{ ...limit, usedFraction: bad }] })).toBeNull();
      expect(
        parseUsageSnapshot({ status: "ok", fetchedAt: 1, limits: [{ id: "x", kind: "balance", unit: "credits", remaining: bad }] }),
      ).toBeNull();
      expect(parseUsageSnapshot({ status: "ok", fetchedAt: 1, limits: [{ ...limit, resetsAt: bad }] })).toBeNull();
    }
  });

  test("a valid snapshot parses with its limits and optional fields", () => {
    const parsed = parseUsageSnapshot({
      status: "ok",
      fetchedAt: 1_700_000_000_000,
      limits: [
        { id: "commandcode:session", kind: "window", usedFraction: 0.3, unit: "percent", resetsAt: 1_700_000_100_000 },
        { id: "hyper:credits", kind: "balance", remaining: 12.5, unit: "credits", shared: true },
      ],
      reason: "diagnostic only",
    });
    expect(parsed?.status).toBe("ok");
    expect(parsed?.limits).toHaveLength(2);
    expect(parsed?.limits[0]!.resetsAt).toBe(1_700_000_100_000);
    expect(parsed?.limits[1]!.shared).toBe(true);
  });
});

describe("the key-row usage action", () => {
  test("a provider without a probe renders no usage control", async () => {
    const view = await mount(probedPayload({ usage_probe: false }));
    try {
      expect(view.usageButton()).toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  test("a probed provider renders the usage disclosure before Remove, and mounting issues no probe", async () => {
    const view = await mount(probedPayload());
    try {
      const button = view.usageButton();
      expect(button).not.toBeNull();
      expect(button?.getAttribute("aria-haspopup")).toBeNull();
      expect(button?.getAttribute("aria-expanded")).toBe("false");
      const row = button?.closest('[data-slot="list-row"]') as HTMLElement | null;
      const rowButtons = [...(row?.querySelectorAll("button") ?? [])] as HTMLButtonElement[];
      expect(rowButtons.map((b) => b.textContent)).toEqual([
        t(locale, "settings.providers.usage.action"),
        t(locale, "settings.remove"),
      ]);
      expect(view.calls).toHaveLength(0);
      expect(view.panel()).toBeNull();
    } finally {
      await view.cleanup();
    }
  });
});

describe("UsagePanel — inline probe under the owning row", () => {
  test("clicking posts once and renders the panel under that row, passing loading first", async () => {
    const gate = Promise.withResolvers<Response>();
    queue.push(() => gate.promise);
    const view = await mount(probedPayload());
    try {
      await view.click(view.usageButton());
      const loadingPanel = view.panel();
      expect(loadingPanel).not.toBeNull();
      expect(loadingPanel?.textContent).toContain(t(locale, "common.loading"));
      const row = view.usageButton()?.closest('[data-slot="list-row"]') as HTMLElement | null;
      expect(loadingPanel?.parentElement?.previousElementSibling).toBe(row);
      expect(view.win.document.querySelector('[role="dialog"]')).toBeNull();

      await act(async () => {
        gate.resolve(
          new Response(snapshotBody({
            limits: [
              { id: "commandcode:session", kind: "window", usedFraction: 0.3, unit: "percent", resetsAt: Date.now() + 3 * 3_600_000 + 60_000 },
            ],
          })),
        );
      });
      await view.flush();
      expect(view.calls).toHaveLength(1);
      expect(view.calls[0]!.url).toBe("/dashboard/acme/api/review-bots/bot-42/keys/usage");
      const body = new URLSearchParams(view.calls[0]!.body);
      expect(body.get("provider")).toBe(probedProvider);
      expect(body.get("keyId")).toBe("deadbeefcafe1234");

      const text = view.panel()?.textContent ?? "";
      expect(text).toContain(t(locale, "settings.providers.usage.windowRemaining", { percent: 70 }));
      expect(text).toContain("resets in 3 hours");
      const bar = view.panel()?.querySelector('[data-slot="usage-bar"]') as HTMLElement | null;
      expect(bar).not.toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  test("clicking again re-posts the same body and replaces the snapshot", async () => {
    queue.push(() => new Response(snapshotBody({
      limits: [{ id: "commandcode:session", kind: "window", usedFraction: 0.3, unit: "percent" }],
    })));
    queue.push(() => new Response(snapshotBody({
      limits: [{ id: "commandcode:session", kind: "window", usedFraction: 0.7, unit: "percent" }],
    })));
    const view = await mount(probedPayload());
    try {
      await view.click(view.usageButton());
      await view.flush();
      expect(view.panel()?.textContent).toContain(
        t(locale, "settings.providers.usage.windowRemaining", { percent: 70 }),
      );

      await view.click(view.usageButton());
      await view.flush();

      expect(view.calls).toHaveLength(2);
      expect(view.calls[1]!.body).toBe(view.calls[0]!.body);
      const text = view.panel()?.textContent ?? "";
      expect(text).toContain(t(locale, "settings.providers.usage.windowRemaining", { percent: 30 }));
      expect(text).not.toContain(
        t(locale, "settings.providers.usage.windowRemaining", { percent: 70 }),
      );
    } finally {
      await view.cleanup();
    }
  });

  test("session + week + month windows render three cells in that order, each with its own bar", async () => {
    queue.push(() => new Response(snapshotBody({
      limits: [
        { id: "commandcode:month", kind: "window", usedFraction: 0.6, unit: "percent" },
        { id: "commandcode:session", kind: "window", usedFraction: 0.3, unit: "percent" },
        { id: "commandcode:week", kind: "window", usedFraction: 0.45, unit: "percent" },
      ],
    })));
    const view = await mount(probedPayload());
    try {
      await view.click(view.usageButton());
      await view.flush();
      const cells = [...(view.panel()?.querySelectorAll('[data-slot="usage-cell"]') ?? [])] as HTMLElement[];
      expect(cells).toHaveLength(3);
      const labels = cells.map((cell) => (cell.querySelector("p") as HTMLElement | null)?.textContent ?? "");
      expect(labels).toEqual([
        t(locale, "settings.providers.usage.window.session"),
        t(locale, "settings.providers.usage.window.week"),
        t(locale, "settings.providers.usage.window.month"),
      ]);
      const shares = cells.map((cell) => cell.textContent ?? "");
      expect(shares[0]).toContain(t(locale, "settings.providers.usage.windowRemaining", { percent: 70 }));
      expect(shares[1]).toContain(t(locale, "settings.providers.usage.windowRemaining", { percent: 55 }));
      expect(shares[2]).toContain(t(locale, "settings.providers.usage.windowRemaining", { percent: 40 }));
      const bars = view.panel()?.querySelectorAll('[data-slot="usage-bar"]');
      expect(bars?.length).toBe(3);
    } finally {
      await view.cleanup();
    }
  });

  test("an amount-only monthly pool claims the third cell with no fabricated bar", async () => {
    queue.push(() => new Response(snapshotBody({
      limits: [
        { id: "commandcode:session", kind: "window", usedFraction: 0.3, unit: "percent" },
        { id: "commandcode:week", kind: "window", usedFraction: 0.45, unit: "percent" },
        { id: "commandcode:month", kind: "balance", remaining: 15.09, extraRemaining: 25, unit: "credits", shared: true },
      ],
    })));
    const view = await mount(probedPayload());
    try {
      await view.click(view.usageButton());
      await view.flush();
      const cells = [...(view.panel()?.querySelectorAll('[data-slot="usage-cell"]') ?? [])] as HTMLElement[];
      expect(cells).toHaveLength(3);
      const month = cells[2]!;
      expect((month.querySelector("p") as HTMLElement | null)?.textContent).toBe(
        t(locale, "settings.providers.usage.window.month"),
      );
      expect(month.textContent).toContain(
        t(locale, "settings.providers.usage.balanceRemaining", {
          amount: 15.09,
          unit: t(locale, "settings.providers.usage.unit.credits"),
        }),
      );
      expect(month.textContent).toContain(
        t(locale, "settings.providers.usage.extraRemaining", {
          amount: 25,
          unit: t(locale, "settings.providers.usage.unit.credits"),
        }),
      );
      expect(month.querySelector('[data-slot="usage-bar"]')).toBeNull();
      expect(view.panel()?.querySelectorAll('[data-slot="usage-bar"]')).toHaveLength(2);
      expect((cells[0]?.parentElement as HTMLElement | null)?.style.gridTemplateColumns).toBe(
        "repeat(3, minmax(0, 1fr))",
      );
      expect(view.panel()?.querySelectorAll("li")).toHaveLength(3);
      expect((view.panel()?.textContent?.match(/15\.09/g) ?? [])).toHaveLength(1);
      expect((view.panel()?.textContent?.match(/25/g) ?? [])).toHaveLength(1);
    } finally {
      await view.cleanup();
    }
  });

  test("windows of only unknown dimensions fall back to one line per window, no bars", async () => {
    queue.push(() => new Response(snapshotBody({
      limits: [
        { id: "cursor:planUsage", kind: "window", usedFraction: 0.4, unit: "percent" },
        { id: "vendor:rolling", kind: "window", usedFraction: 0.2, unit: "percent" },
      ],
    })));
    const view = await mount(probedPayload());
    try {
      await view.click(view.usageButton());
      await view.flush();
      const panel = view.panel();
      expect(panel?.querySelector('[data-slot="usage-bar"]')).toBeNull();
      const text = panel?.textContent ?? "";
      expect(text).toContain(t(locale, "settings.providers.usage.limit.generic", { index: 1 }));
      expect(text).toContain(t(locale, "settings.providers.usage.limit.generic", { index: 2 }));
      expect(text).toContain(t(locale, "settings.providers.usage.windowRemaining", { percent: 60 }));
      expect(text).toContain(t(locale, "settings.providers.usage.windowRemaining", { percent: 80 }));
      expect(text).not.toContain("planUsage");
      expect(text).not.toContain("rolling");
    } finally {
      await view.cleanup();
    }
  });

  test("a reported balance renders as the muted bottom line; no balance renders none", async () => {
    queue.push(() => new Response(snapshotBody({
      limits: [
        { id: "commandcode:session", kind: "window", usedFraction: 0.3, unit: "percent" },
        { id: "hyper:credits", kind: "balance", remaining: 12.5, unit: "credits", shared: true },
      ],
    })));
    const view = await mount(probedPayload());
    try {
      await view.click(view.usageButton());
      await view.flush();
      const text = view.panel()?.textContent ?? "";
      expect(text).toContain("12.5 credits remaining");
      expect(text).toContain(t(locale, "settings.providers.usage.shared"));
      expect(view.panel()?.querySelectorAll('[data-slot="usage-bar"]')).toHaveLength(1);
    } finally {
      await view.cleanup();
    }

    queue.push(() => new Response(snapshotBody({
      limits: [{ id: "commandcode:session", kind: "window", usedFraction: 0.3, unit: "percent" }],
    })));
    const second = await mount(probedPayload());
    try {
      await second.click(second.usageButton());
      await second.flush();
      const text = second.panel()?.textContent ?? "";
      expect(text).not.toContain("credits remaining");
    } finally {
      await second.cleanup();
    }
  });

  test("a balance without a remaining amount renders no fabricated zero", async () => {
    queue.push(() => new Response(snapshotBody({
      limits: [{ id: "hyper:credits", kind: "balance", unit: "credits" }],
    })));
    const view = await mount(probedPayload());
    try {
      await view.click(view.usageButton());
      await view.flush();
      const text = view.panel()?.textContent ?? "";
      expect(text).not.toContain("0 credits remaining");
      expect(text).toContain(t(locale, "settings.providers.usage.absentNothing"));
    } finally {
      await view.cleanup();
    }
  });

  test("the unauthorized face renders its danger copy and no bar", async () => {
    queue.push(() => new Response(snapshotBody({ status: "unauthorized", limits: [] })));
    const view = await mount(probedPayload());
    try {
      await view.click(view.usageButton());
      await view.flush();
      expect(view.panel()?.textContent).toContain(t(locale, "settings.providers.usage.unauthorized"));
      expect(view.panel()?.querySelector('[data-slot="usage-bar"]')).toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  test("the absent face renders its muted copy and no bar", async () => {
    queue.push(() => new Response(snapshotBody({ status: "absent", absentCause: "reported-nothing", limits: [] })));
    const view = await mount(probedPayload());
    try {
      await view.click(view.usageButton());
      await view.flush();
      expect(view.panel()?.textContent).toContain(t(locale, "settings.providers.usage.absentNothing"));
      expect(view.panel()?.querySelector('[data-slot="usage-bar"]')).toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  test("a non-200 answer renders the error face without verbatim vendor text", async () => {
    queue.push(() => new Response("upstream exploded", { status: 502 }));
    const view = await mount(probedPayload());
    try {
      await view.click(view.usageButton());
      await view.flush();
      const text = view.panel()?.textContent ?? "";
      expect(text).toContain(t(locale, "settings.providers.usage.error"));
      expect(text).not.toContain("upstream exploded");
      expect(view.panel()?.querySelector('[data-slot="usage-bar"]')).toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  test("a keyed 400 renders its refusal naming the provider and host", async () => {
    const params = { provider: probedProvider, host: "proxy.example" };
    queue.push(() => new Response(JSON.stringify({
      ok: false,
      reason: "unsupported_provider",
      key: "settings.error.usageProbeOffVendorHost",
      message: t("en", "settings.error.usageProbeOffVendorHost", params),
      params,
    }), { status: 400 }));
    const view = await mount(probedPayload());
    try {
      await view.click(view.usageButton());
      await view.flush();
      const text = view.panel()?.textContent ?? "";
      expect(text).toBe(t("en", "settings.error.usageProbeOffVendorHost", params));
      expect(text).toContain("proxy.example");
      expect(text).toContain(probedProvider);
      expect(view.panel()?.querySelector('[data-slot="usage-bar"]')).toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  test("the keyed refusal resolves in the operator's locale, not the server's English face", async () => {
    const params = { provider: probedProvider, host: "proxy.example" };
    queue.push(() => new Response(JSON.stringify({
      ok: false,
      reason: "unsupported_provider",
      key: "settings.error.usageProbeOffVendorHost",
      message: t("en", "settings.error.usageProbeOffVendorHost", params),
      params,
    }), { status: 400 }));
    const view = await mount(probedPayload(), "zh_CN");
    try {
      await view.click(view.usageButton());
      await view.flush();
      const text = view.panel()?.textContent ?? "";
      expect(text).toBe(t("zh_CN", "settings.error.usageProbeOffVendorHost", params));
      expect(text).toContain("proxy.example");
      expect(text).not.toContain("vendor's own quota host");
    } finally {
      await view.cleanup();
    }
  });

  test("a keyed 400 with malformed params falls back to the generic error face", async () => {
    queue.push(() => new Response(JSON.stringify({
      ok: false,
      reason: "unsupported_provider",
      key: "settings.error.usageProbeOffVendorHost",
      message: "server face is never rendered",
      params: { provider: { name: "nested" }, host: "proxy.example" },
    }), { status: 400 }));
    const view = await mount(probedPayload());
    try {
      await view.click(view.usageButton());
      await view.flush();
      const text = view.panel()?.textContent ?? "";
      expect(text).toBe(t(locale, "settings.providers.usage.error"));
      expect(text).not.toContain("[object Object]");
      expect(text).not.toContain("{provider}");
    } finally {
      await view.cleanup();
    }
  });

  test("a snapshot reporting only session fills the row instead of a third of it", async () => {
    queue.push(() => new Response(snapshotBody({
      limits: [{ id: "commandcode:session", kind: "window", usedFraction: 0.3, unit: "percent" }],
    })));
    const view = await mount(probedPayload());
    try {
      await view.click(view.usageButton());
      await view.flush();
      const cells = [...(view.panel()?.querySelectorAll('[data-slot="usage-cell"]') ?? [])];
      expect(cells).toHaveLength(1);
      expect((cells[0]?.parentElement as HTMLElement | null)?.style.gridTemplateColumns).toBe(
        "repeat(1, minmax(0, 1fr))",
      );
    } finally {
      await view.cleanup();
    }

    queue.push(() => new Response(snapshotBody({
      limits: [
        { id: "commandcode:session", kind: "window", usedFraction: 0.3, unit: "percent" },
        { id: "commandcode:month", kind: "window", usedFraction: 0.6, unit: "percent" },
      ],
    })));
    const pair = await mount(probedPayload());
    try {
      await pair.click(pair.usageButton());
      await pair.flush();
      const cells = [...(pair.panel()?.querySelectorAll('[data-slot="usage-cell"]') ?? [])];
      expect(cells).toHaveLength(2);
      expect((cells[0]?.parentElement as HTMLElement | null)?.style.gridTemplateColumns).toBe(
        "repeat(2, minmax(0, 1fr))",
      );
    } finally {
      await pair.cleanup();
    }
  });

  test("one Escape dismisses only the panel opened last", async () => {
    const other = "othercode";
    queue.push(() => new Response(snapshotBody({
      limits: [{ id: "commandcode:session", kind: "window", usedFraction: 0.3, unit: "percent" }],
    })));
    queue.push(() => new Response(snapshotBody({
      limits: [{ id: "othercode:session", kind: "window", usedFraction: 0.5, unit: "percent" }],
    })));
    const view = await mount(managePayload({
      keys: [keyRow(probedProvider), keyRow(other, { keyId: "bbbb9999dddd8888", last4: "1234" })],
      provider_catalog: [
        catalogEntry(probedProvider, { usage_probe: true }),
        catalogEntry(other, { label: "Other Code", usage_probe: true }),
      ],
    }));
    try {
      await view.click(view.rowUsageButton("9f2c"));
      await view.flush();
      await view.click(view.rowUsageButton("1234"));
      await view.flush();
      const open = () => [...(view.win.document.querySelectorAll('[data-slot="usage-panel"]') as unknown as HTMLElement[])];
      expect(open()).toHaveLength(2);

      await view.pressEscape();
      expect(open()).toHaveLength(1);
      expect(open()[0]?.textContent).toContain(
        t(locale, "settings.providers.usage.windowRemaining", { percent: 70 }),
      );

      await view.pressEscape();
      expect(open()).toHaveLength(0);
    } finally {
      await view.cleanup();
    }
  });

  test("Escape with a model dialog open leaves the panel up", async () => {
    queue.push(() => new Response(snapshotBody({
      limits: [{ id: "commandcode:session", kind: "window", usedFraction: 0.3, unit: "percent" }],
    })));
    const view = await mount(managePayload({
      keys: [keyRow(probedProvider)],
      custom_providers: [
        { provider_id: probedProvider, base_url: "https://api.test/v1", api: "openai-completions", model_ids: ["m-1"] },
      ],
      provider_catalog: [catalogEntry(probedProvider, { usage_probe: true, models: ["m-1", "m-2"] })],
    }));
    try {
      await view.click(view.usageButton());
      await view.flush();
      expect(view.panel()).not.toBeNull();

      const buttons = () => [...(view.win.document.querySelectorAll("button") as unknown as HTMLButtonElement[])];
      await view.click(
        buttons().find((button) => button.textContent === t(locale, "settings.providers.models.trigger")) ?? null,
      );
      expect(view.win.document.querySelector('[role="dialog"]')).not.toBeNull();

      await view.pressEscape();
      expect(view.panel()).not.toBeNull();

      await view.click(buttons().find((button) => button.textContent === t(locale, "common.cancel")) ?? null);
      expect(view.win.document.querySelector('[role="dialog"]')).toBeNull();
      await view.pressEscape();
      expect(view.panel()).toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  test("a re-render handing the panel a new onClose leaves Escape with the panel opened last", async () => {
    const { win, cleanup: cleanupDom } = installDom("http://localhost/dashboard/acme/apps");
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const closed: string[] = [];
    const openSnapshot = (percent: number) =>
      snapshotBody({ limits: [{ id: "commandcode:session", kind: "window", usedFraction: percent / 100, unit: "percent" }] });
    queue.push(() => new Response(openSnapshot(30)));
    queue.push(() => new Response(openSnapshot(50)));
    const firstV2 = () => {
      closed.push("first:v2");
    };
    const secondV1 = () => {
      closed.push("second:v1");
    };
    const secondV2 = () => {
      closed.push("second:v2");
    };
    const tree = (first: () => void, second: () => void) =>
      createElement(
        "div",
        null,
        createElement(UsagePanel, {
          key: "first",
          locale,
          botId: "bot-42",
          provider: probedProvider,
          keyId: "aaaa1111bbbb2222",
          open: true,
          onClose: first,
        }),
        createElement(UsagePanel, {
          key: "second",
          locale,
          botId: "bot-42",
          provider: probedProvider,
          keyId: "cccc3333dddd4444",
          open: true,
          onClose: second,
        }),
      );
    const pressEscape = async () => {
      await act(async () => {
        (win.document as unknown as Document).dispatchEvent(
          new win.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }) as unknown as Event,
        );
      });
    };
    try {
      await act(async () => root.render(tree(() => closed.push("first:v1"), secondV1)));
      await act(async () => {});
      await act(async () => root.render(tree(firstV2, secondV1)));
      await act(async () => {});
      await pressEscape();
      expect(closed).toEqual(["second:v1"]);

      await act(async () => root.render(tree(firstV2, secondV2)));
      await act(async () => {});
      await pressEscape();
      expect(closed).toEqual(["second:v1", "second:v2"]);
    } finally {
      await act(async () => root.unmount());
      cleanupDom();
    }
  });

  test("a probe that resolves after the panel moved to another key is discarded", async () => {
    const gateA = Promise.withResolvers<Response>();
    const gateB = Promise.withResolvers<Response>();
    queue.push(() => gateA.promise);
    queue.push(() => gateB.promise);
    const keys = [
      keyRow(probedProvider),
      keyRow(probedProvider, { keyId: "bbbb9999dddd8888", last4: "1234" }),
    ];
    const view = await mount(probedPayload({}, keys));
    const remainingOf = (percent: number) => t(locale, "settings.providers.usage.windowRemaining", { percent });
    try {
      await view.click(view.rowUsageButton("9f2c"));
      expect(view.panel()?.textContent).toContain(t(locale, "common.loading"));
      await view.click(view.rowUsageButton("1234"));
      expect(view.panel()?.textContent).toContain(t(locale, "common.loading"));

      await act(async () => {
        gateB.resolve(new Response(snapshotBody({
          limits: [{ id: "commandcode:session", kind: "window", usedFraction: 0.7, unit: "percent" }],
        })));
      });
      await view.flush();
      expect(view.panel()?.textContent).toContain(remainingOf(30));

      await act(async () => {
        gateA.resolve(new Response(snapshotBody({
          limits: [{ id: "commandcode:session", kind: "window", usedFraction: 0.3, unit: "percent" }],
        })));
      });
      await view.flush();
      const text = view.panel()?.textContent ?? "";
      expect(text).toContain(remainingOf(30));
      expect(text).not.toContain(remainingOf(70));
      expect(view.calls).toHaveLength(2);
    } finally {
      await view.cleanup();
    }
  });
});
