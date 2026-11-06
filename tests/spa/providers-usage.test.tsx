/**
 * The per-key usage action and its inline panel:
 *
 * - a key row whose catalog entry lacks `usage_probe` renders no usage
 *   control (DoD 1);
 * - no probe leaves the client before the row's usage action is clicked —
 *   mounting the settings page issues no provider quota request;
 * - the first click posts `provider` + `keyId` to `/keys/usage` once and
 *   renders the panel under that key's row; a second click re-posts the
 *   same body and replaces the rendered snapshot (the re-click IS the
 *   refresh — there is deliberately no cache);
 * - a snapshot reporting session + week + month windows renders three
 *   cells in that order, each with its own bar and remaining share;
 * - a snapshot whose windows are only unknown dimensions falls back to one
 *   line per window — no information is dropped, no vendor id text renders;
 * - a reported balance renders as the muted bottom line; a snapshot with
 *   no balance renders no such line;
 * - `unauthorized` / `absent` / `error` render a danger or muted line and
 *   never a fabricated bar;
 * - no dialog role exists anywhere in the tree — the numbers live under
 *   the row, not over the page.
 *
 * Mounted, because the panel probes on open and the probe/late-response
 * guard is lifecycle behavior.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { t } from "../../src/i18n";
import type { SpaBoot } from "../../src/spa/boot";
import {
  parseUsageSnapshot,
  type CatalogProvider,
  type ProviderKeyRow,
  type SettingsManagePayload,
} from "../../src/spa/pages/data";
import { ProvidersSection } from "../../src/spa/pages/settings-providers";
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

function managePayload(overrides: Partial<SettingsManagePayload> = {}): SettingsManagePayload {
  return {
    can_manage: true,
    workspace_id: "ws_test",
    app: {
      github_app_id: 42,
      status: "active",
      review_enabled: true,
      created_by: "mallory",
      last_webhook_at: null,
      id: "app-test",
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
    allowlist: { enabled: false, owners: [] },
    keys: [],
    model_chain: null,
    model_roles: {},
    model_chains: [],
    custom_providers: [],
    configured_providers: [],
    provider_catalog: [],
    model_role_ids: [],
    custom_provider_api_ids: [],
    sandbox_images: [{ id: "omp", enabled: true }],
    installations: [],
    deliveries: [],
    ...overrides,
  };
}

/** A snapshot body the usage route would answer. */
function snapshotBody(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({ ok: true, status: "ok", fetchedAt: 1_700_000_000_000, limits: [], ...overrides });
}

type FetchCall = { url: string; body: string };

const realFetch = globalThis.fetch;
let calls: FetchCall[] = [];
/** Responses returned in call order; a factory so each call gets a fresh Response (a promise arms the loading gate). */
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

async function mount(payload: SettingsManagePayload) {
  const { win, cleanup: cleanupDom } = installDom("http://localhost/dashboard/acme/apps");
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  const element: ReactElement = createElement(ProvidersSection, {
    locale,
    payload,
    onVerify: async (): Promise<OpNotice> => ({ kind: "success", message: "added" }),
    onSettings: async (): Promise<OpNotice> => ({ kind: "success", message: "added" }),
    onPending: () => {},
    notice: null,
    removeOutcome: null,
    onOutcome: () => {},
  });
  await act(async () => root.render(element));
  await act(async () => {});

  const panel = (): HTMLElement | null =>
    win.document.querySelector('[data-slot="usage-panel"]') as unknown as HTMLElement | null;
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
      (button) => button.textContent === t(locale, "settings.providers.usage.action"),
    ) ?? null;
  /** The usage button of the key row whose identity names `last4`. */
  const rowUsageButton = (last4: string): HTMLButtonElement | null => {
    const row = [...(win.document.querySelectorAll('[data-slot="list-row"]') as unknown as HTMLElement[])].find(
      (candidate) => candidate.textContent?.includes(last4),
    );
    return (row?.querySelector("button") as HTMLButtonElement | null) ?? null;
  };

  return {
    win,
    panel,
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

/** Payload with one probed key row and its catalog entry. */
function probedPayload(
  catalogOverrides: Partial<CatalogProvider> = {},
  keys: ProviderKeyRow[] = [keyRow(probedProvider)],
): SettingsManagePayload {
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
      // A disclosure, not a dialog trigger: it names its expanded state.
      expect(button?.getAttribute("aria-haspopup")).toBeNull();
      expect(button?.getAttribute("aria-expanded")).toBe("false");
      const row = button?.closest('[data-slot="list-row"]') as HTMLElement | null;
      const rowButtons = [...(row?.querySelectorAll("button") ?? [])] as HTMLButtonElement[];
      expect(rowButtons.map((b) => b.textContent)).toEqual([
        t(locale, "settings.providers.usage.action"),
        t(locale, "settings.remove"),
      ]);
      // Opening the settings page issues no provider quota request — the
      // row's action is the only trigger.
      expect(view.calls).toHaveLength(0);
      expect(view.panel()).toBeNull();
    } finally {
      await view.cleanup();
    }
  });
});

describe("UsagePanel — inline probe under the owning row", () => {
  test("clicking posts once and renders the panel under that row, passing loading first", async () => {
    // The first answer is hand-settled so the loading face is observable
    // before the snapshot replaces it.
    const gate = Promise.withResolvers<Response>();
    queue.push(() => gate.promise);
    const view = await mount(probedPayload());
    try {
      await view.click(view.usageButton());
      // The panel renders under the owning row and starts on the loading face.
      const loadingPanel = view.panel();
      expect(loadingPanel).not.toBeNull();
      expect(loadingPanel?.textContent).toContain(t(locale, "common.loading"));
      const row = view.usageButton()?.closest('[data-slot="list-row"]') as HTMLElement | null;
      // The panel renders inside the same wrapper as its row, directly under it.
      expect(loadingPanel?.parentElement?.previousElementSibling).toBe(row);
      // No dialog overlays the page.
      expect(view.win.document.querySelector('[role="dialog"]')).toBeNull();

      await act(async () => {
        gate.resolve(
          new Response(snapshotBody({
            limits: [
              // A minute of margin so a slow flush can't floor the bucket
              // below the asserted "3 hours".
              { id: "commandcode:session", kind: "window", usedFraction: 0.3, unit: "percent", resetsAt: Date.now() + 3 * 3_600_000 + 60_000 },
            ],
          })),
        );
      });
      await view.flush();
      expect(view.calls).toHaveLength(1);
      expect(view.calls[0]!.url).toBe("/dashboard/acme/api/apps/42/keys/usage");
      const body = new URLSearchParams(view.calls[0]!.body);
      expect(body.get("provider")).toBe(probedProvider);
      expect(body.get("keyId")).toBe("deadbeefcafe1234");

      // The window face: remaining share, hairline bar, future reset time.
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

      // The re-click IS the refresh: it re-probes, never a cached bar.
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
      // The wire order is month/session/week; the cells render in the fixed
      // session → week → month order with each window's own remaining share.
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
      // One distinguishable line per window: numbered generic labels, each
      // with its own remaining share; the vendor id text never renders.
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
      // A balance is a line, never a bar.
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
      // Key A's probe stays in flight; opening key B closes A's panel.
      await view.click(view.rowUsageButton("9f2c"));
      expect(view.panel()?.textContent).toContain(t(locale, "common.loading"));
      await view.click(view.rowUsageButton("1234"));
      expect(view.panel()?.textContent).toContain(t(locale, "common.loading"));

      // B answers first under its own key: 30% remaining sticks.
      await act(async () => {
        gateB.resolve(new Response(snapshotBody({
          limits: [{ id: "commandcode:session", kind: "window", usedFraction: 0.7, unit: "percent" }],
        })));
      });
      await view.flush();
      expect(view.panel()?.textContent).toContain(remainingOf(30));

      // A's late answer must not replace B's snapshot (no 70% from key A).
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
