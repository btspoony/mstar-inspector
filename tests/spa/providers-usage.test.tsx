/**
 * The per-key usage action and dialog:
 *
 * - a key row whose catalog entry lacks `usage_probe` renders no usage
 *   control (DoD 1);
 * - opening the dialog posts `provider` + `keyId` to `/keys/usage`, passes
 *   through `loading`, and renders the snapshot face;
 * - Refresh re-posts the same body and replaces the rendered snapshot
 *   (two fetch calls, DoD 3);
 * - the `unauthorized` and `absent` faces render their own copy and no bar;
 * - a `window` limit renders the remaining share and the future reset time,
 *   a `balance` limit the remaining amount with its unit.
 *
 * Mounted, because the dialog lives in a Radix portal and probes on open.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { t, type DictionaryKey } from "../../src/i18n";
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

  const dialog = (): HTMLElement | null =>
    win.document.querySelector('[role="dialog"]') as unknown as HTMLElement | null;
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

  return {
    win,
    dialog,
    click,
    flush,
    usageButton,
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

  test("a probed provider renders the outline usage control before Remove", async () => {
    const view = await mount(probedPayload());
    try {
      const button = view.usageButton();
      expect(button).not.toBeNull();
      expect(button?.getAttribute("aria-haspopup")).toBe("dialog");
      const row = button?.closest('[data-slot="list-row"]') as HTMLElement | null;
      const rowButtons = [...(row?.querySelectorAll("button") ?? [])] as HTMLButtonElement[];
      expect(rowButtons.map((b) => b.textContent)).toEqual([
        t(locale, "settings.providers.usage.action"),
        t(locale, "settings.remove"),
      ]);
    } finally {
      await view.cleanup();
    }
  });
});

describe("UsageDialog — probe on open and refresh", () => {
  test("opening posts provider + keyId and passes loading to the snapshot face", async () => {
    // The first answer is hand-settled so the loading face is observable
    // before the snapshot replaces it.
    const gate = Promise.withResolvers<Response>();
    queue.push(() => gate.promise);
    const view = await mount(probedPayload());
    try {
      await view.click(view.usageButton());
      // The dialog names the provider label and the masked tail, then loads.
      expect(view.dialog()?.textContent).toContain(t(locale, "settings.providers.usage.title", { label: "Command Code" }));
      expect(view.dialog()?.textContent).toContain(t(locale, "settings.keyEnding", { last4: "9f2c" }));
      expect(view.dialog()?.textContent).toContain(t(locale, "common.loading"));

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
      const text = view.dialog()?.textContent ?? "";
      expect(text).toContain(t(locale, "settings.providers.usage.windowRemaining", { percent: 70 }));
      expect(text).toContain("resets in 3 hours");
      const bar = view.dialog()?.querySelector('[data-slot="usage-bar"]') as HTMLElement | null;
      expect(bar).not.toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  test("refresh re-posts the same body and replaces the snapshot", async () => {
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
      expect(view.dialog()?.textContent).toContain(
        t(locale, "settings.providers.usage.windowRemaining", { percent: 70 }),
      );

      const refresh = [...(view.dialog()?.querySelectorAll("button") ?? [])].find(
        (button) => button.textContent === t(locale, "settings.providers.usage.refresh"),
      ) as HTMLButtonElement | undefined;
      expect(refresh).toBeDefined();
      await view.click(refresh ?? null);
      await view.flush();

      expect(view.calls).toHaveLength(2);
      expect(view.calls[1]!.body).toBe(view.calls[0]!.body);
      const text = view.dialog()?.textContent ?? "";
      expect(text).toContain(t(locale, "settings.providers.usage.windowRemaining", { percent: 30 }));
      expect(text).not.toContain(
        t(locale, "settings.providers.usage.windowRemaining", { percent: 70 }),
      );
    } finally {
      await view.cleanup();
    }
  });

  test("a balance limit renders the remaining amount with its unit and the account-wide label", async () => {
    queue.push(() => new Response(snapshotBody({
      limits: [{ id: "hyper:credits", kind: "balance", remaining: 12.5, unit: "credits", shared: true }],
    })));
    const view = await mount(probedPayload());
    try {
      await view.click(view.usageButton());
      await view.flush();
      const text = view.dialog()?.textContent ?? "";
      expect(text).toContain("12.5 credits remaining");
      expect(text).toContain(t(locale, "settings.providers.usage.shared"));
      expect(view.dialog()?.querySelector('[data-slot="usage-bar"]')).toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  test("a balance limit without a remaining amount renders no fabricated zero", async () => {
    queue.push(() => new Response(snapshotBody({
      limits: [{ id: "hyper:credits", kind: "balance", unit: "credits" }],
    })));
    const view = await mount(probedPayload());
    try {
      await view.click(view.usageButton());
      await view.flush();
      const text = view.dialog()?.textContent ?? "";
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
      expect(view.dialog()?.textContent).toContain(t(locale, "settings.providers.usage.unauthorized"));
      expect(view.dialog()?.querySelector('[data-slot="usage-bar"]')).toBeNull();
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
      expect(view.dialog()?.textContent).toContain(t(locale, "settings.providers.usage.absentNothing"));
      expect(view.dialog()?.querySelector('[data-slot="usage-bar"]')).toBeNull();
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
      const text = view.dialog()?.textContent ?? "";
      expect(text).toContain(t(locale, "settings.providers.usage.error"));
      expect(text).not.toContain("upstream exploded");
    } finally {
      await view.cleanup();
    }
  });

  test("Escape dismisses the dialog", async () => {
    queue.push(() => new Response(snapshotBody({ limits: [] })));
    const view = await mount(probedPayload());
    try {
      await view.click(view.usageButton());
      await view.flush();
      expect(view.dialog()).not.toBeNull();
      await act(async () => {
        view.win.document.dispatchEvent(new view.win.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      });
      expect(view.dialog()).toBeNull();
    } finally {
      await view.cleanup();
    }
  });

  test("each limit row carries a distinguishable semantic label from its id segment", async () => {
    queue.push(() => new Response(snapshotBody({
      limits: [
        { id: "cline-pass:session", kind: "window", usedFraction: 0.12, unit: "percent" },
        { id: "cline-pass:week", kind: "window", usedFraction: 0.45, unit: "percent" },
        { id: "cline-pass:month", kind: "window", usedFraction: 0.6, unit: "percent" },
        { id: "umans:concurrency", kind: "window", usedFraction: 0.5, unit: "percent" },
        { id: "hyper:balance", kind: "balance", remaining: 95, unit: "credits" },
        // An unknown segment falls back to the raw id text, never vendor payload.
        { id: "vendor:rolling", kind: "window", usedFraction: 0.2, unit: "percent" },
      ],
    })));
    const view = await mount(probedPayload());
    try {
      await view.click(view.usageButton());
      await view.flush();
      const rows = [...(view.dialog()?.querySelectorAll("li") ?? [])] as HTMLElement[];
      const labels = rows.map((row) => (row.querySelector("p") as HTMLElement | null)?.textContent ?? "");
      // Distinguishable: every row's label is unique and the known segments
      // map through the dictionary.
      expect(new Set(labels).size).toBe(labels.length);
      const segments = ["session", "week", "month", "concurrency", "balance"] as const;
      for (const segment of segments) {
        const key = `settings.providers.usage.window.${segment}` as DictionaryKey;
        expect(labels).toContain(t(locale, key));
      }
      expect(labels).toContain("rolling");
    } finally {
      await view.cleanup();
    }
  });

  test("a probe that resolves after close or under another key is discarded", async () => {
    const gateA = Promise.withResolvers<Response>();
    const gateB = Promise.withResolvers<Response>();
    queue.push(() => gateA.promise);
    queue.push(() => gateB.promise);
    const keys = [
      keyRow(probedProvider),
      keyRow(probedProvider, { keyId: "bbbb9999dddd8888", last4: "1234" }),
    ];
    const view = await mount(probedPayload({}, keys));
    /** The usage button of the key row whose identity names `last4`. */
    const rowUsageButton = (last4: string): HTMLButtonElement | null => {
      const row = [...(view.win.document.querySelectorAll('[data-slot="list-row"]') as unknown as HTMLElement[])].find(
        (candidate) => candidate.textContent?.includes(last4),
      );
      return (row?.querySelector("button") as HTMLButtonElement | null) ?? null;
    };
    try {
      // Key A opens; its probe stays in flight.
      await view.click(rowUsageButton("9f2c"));
      expect(view.dialog()?.textContent).toContain(t(locale, "common.loading"));
      const cancel = [...(view.dialog()?.querySelectorAll("button") ?? [])].find(
        (button) => button.textContent === t(locale, "common.cancel"),
      ) as HTMLButtonElement | undefined;
      await view.click(cancel ?? null);
      expect(view.dialog()).toBeNull();

      // Key B opens; its probe also stays in flight.
      await view.click(rowUsageButton("1234"));
      expect(view.dialog()?.textContent).toContain(t(locale, "common.loading"));

      // B answers first under its own key: 30% remaining sticks.
      await act(async () => {
        gateB.resolve(new Response(snapshotBody({
          limits: [{ id: "commandcode:session", kind: "window", usedFraction: 0.7, unit: "percent" }],
        })));
      });
      await view.flush();
      expect(view.dialog()?.textContent).toContain(
        t(locale, "settings.providers.usage.windowRemaining", { percent: 30 }),
      );

      // A's late answer must not replace B's snapshot (no 70% from key A).
      await act(async () => {
        gateA.resolve(new Response(snapshotBody({
          limits: [{ id: "commandcode:session", kind: "window", usedFraction: 0.3, unit: "percent" }],
        })));
      });
      await view.flush();
      const text = view.dialog()?.textContent ?? "";
      expect(text).toContain(t(locale, "settings.providers.usage.windowRemaining", { percent: 30 }));
      expect(text).not.toContain(t(locale, "settings.providers.usage.windowRemaining", { percent: 70 }));
      expect(view.calls).toHaveLength(2);
    } finally {
      await view.cleanup();
    }
  });
});
