/**
 * The providers group view: grouping, the per-key status
 * label (AC-10) with its separate timestamp slot (AC-11), the tier badge, the
 * empty state of a keyless declaration, and the model-id disclosure's
 * aria-expanded / aria-controls pairing (AC-20 / I-000208).
 *
 * Static render of the exported card: no DOM runner, no live provider.
 */
import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { t, type Locale } from "../../src/i18n";
import { ProvidersCard } from "../../src/spa/pages/settings-providers";
import type {
  CatalogProvider,
  ProviderKeyRow,
  SettingsManagePayload,
} from "../../src/spa/pages/data";
import { installDom } from "./dom";

const catalogEntry = (id: string, tier: "builtin" | "template", extra: Partial<CatalogProvider> = {}): CatalogProvider => ({
  id,
  label: `${id} label`,
  tier,
  base_url: null,
  api: null,
  models: [],
  verifiable: true,
  eligibility: "builtin",
  display_group: "catalog",
  ...extra,
});

const keyRow = (provider: string, keyId: string, overrides: Partial<ProviderKeyRow> = {}): ProviderKeyRow => ({
  provider,
  keyId,
  last4: `tail-${keyId}`,
  updatedAt: null,
  verifiedAt: null,
  verifiedStatus: null,
  ...overrides,
});

function managePayload(overrides: Partial<SettingsManagePayload> = {}): SettingsManagePayload {
  return {
    can_manage: true,
    workspace_id: "ws_test",
    app: {
      github_app_id: 1,
      status: "active",
      review_enabled: true,
      created_by: "mallory",
      last_webhook_at: null,
      id: "app-test",
      sandbox_image_id: "omp",
      review_trigger_mode: "every_push",
      github_name: null,
      github_slug: null,
      github_description: null,
      github_html_url: null,
      github_avatar_url: null,
      github_metadata_synced_at: null,
    },
    keys: [],
    model_chain: null,
    model_roles: {},
    model_chains: [],
    custom_providers: [],
    configured_providers: [],
    provider_catalog: [],
    model_role_ids: [],
    custom_provider_api_ids: ["openai-completions"],
    sandbox_images: [{ id: "omp", enabled: true }],
    installations: [],
    deliveries: [],
    ...overrides,
  };
}

function render(payload: SettingsManagePayload, locale: Locale = "en"): string {
  return renderToStaticMarkup(
    createElement(ProvidersCard, {
      locale,
      payload,
      onVerify: async () => ({ kind: "success" as const, message: "" }),
      onSettings: async () => ({ kind: "success" as const, message: "" }),
      onPending: () => {},
      notice: null,
      removeOutcome: null,
      onOutcome: () => {},
    }),
  );
}

/** Every key row's markup, in render order. */
const rowsOf = (html: string): string[] => html.split('data-slot="list-row"').slice(1);

const rowOf = (html: string, last4: string): string => {
  const row = rowsOf(html).find((candidate) => candidate.includes(last4));
  expect(row, `row for ${last4}`).toBeDefined();
  return row as string;
};

/** The whole group card whose title is `label`. */
const groupOf = (html: string, label: string): string => {
  const at = html.indexOf(`>${label}<`);
  expect(at, `group ${label}`).toBeGreaterThan(-1);
  const start = html.lastIndexOf('data-slot="group-card"', at);
  const next = html.indexOf('data-slot="group-card"', at);
  return html.slice(start, next === -1 ? html.length : next);
};

/** The same group's header band — the title, tier badge and header actions. */
const groupHeaderOf = (html: string, label: string): string => {
  const group = groupOf(html, label);
  const body = group.indexOf('data-slot="card-content"');
  expect(body, `body of ${label}`).toBeGreaterThan(-1);
  return group.slice(0, body);
};

describe("grouping (AC-1)", () => {
  test("three keys of one provider render one group, the title once, three key rows", () => {
    const html = render(
      managePayload({
        provider_catalog: [catalogEntry("commandcode", "builtin")],
        keys: [keyRow("commandcode", "a"), keyRow("commandcode", "b"), keyRow("commandcode", "c")],
      }),
    );
    expect(html.split('data-slot="group-card"').length - 1).toBe(1);
    expect(html.split("commandcode label").length - 1).toBe(1);
    expect(rowsOf(html)).toHaveLength(3);
  });

  test("a catalog entry with neither a key nor a declaration renders no group", () => {
    const html = render(managePayload({ provider_catalog: [catalogEntry("anthropic", "builtin")] }));
    expect(html).not.toContain('data-slot="group-card"');
    expect(html).toContain(t("en", "settings.noConfiguredProviders"));
  });
});

describe("status label and timestamp (AC-10, AC-11)", () => {
  const cases = [
    { status: "ok", verifiedAt: "2026-10-30T09:00:00.000Z", updatedAt: "2026-10-30T09:00:00.000Z" },
    { status: "reachable", verifiedAt: "2026-10-30T09:00:00.000Z", updatedAt: "2026-10-30T09:00:00.000Z" },
    { status: "failed", verifiedAt: null, updatedAt: "2026-10-30T09:00:00.000Z" },
    { status: null, verifiedAt: null, updatedAt: "2026-10-30T09:00:00.000Z" },
  ] as const;

  for (const locale of ["en", "zh_CN"] as const) {
    test(`each row carries exactly one locale status label (${locale})`, () => {
      for (const { status, verifiedAt, updatedAt } of cases) {
        const html = render(
          managePayload({
            keys: [
              keyRow("p", "1", {
                verifiedStatus: status,
                verifiedAt,
                updatedAt,
              }),
            ],
          }),
          locale,
        );
        const row = rowOf(html, "tail-1");
        const label = t(locale, `settings.providers.status.${status ?? "unverified"}`);
        // One status pill per row — the label, nothing else. Asserted through
        // the pill's tone attribute, not its design-token classes: a token
        // rename is not a behaviour change.
        expect(row.split('data-tone="').length - 1).toBe(1);
        expect(row).toContain(`>${label}</span>`);
        for (const other of cases) {
          if ((other.status ?? "unverified") === (status ?? "unverified")) continue;
          expect(row).not.toContain(`>${t(locale, `settings.providers.status.${other.status ?? "unverified"}`)}</span>`);
        }
        // AC-11: the time is the meta slot, its own span after the pill.
        const metaAt = row.indexOf('data-slot="list-row-meta"');
        expect(metaAt).toBeGreaterThan(row.indexOf('data-slot="list-row-status"'));
        expect(row.slice(metaAt)).toContain(
          status === "ok" ? t(locale, "settings.providers.verifiedAt", { time: "" }) : t(locale, "settings.updated", { time: "" }),
        );
      }
    });
  }
});

describe("tier badge", () => {
  test("builtin and custom are neutral, template is the warning surface", () => {
    const html = render(
      managePayload({
        provider_catalog: [catalogEntry("anthropic", "builtin"), catalogEntry("workers-ai", "template")],
        keys: [keyRow("anthropic", "a"), keyRow("workers-ai", "b")],
        custom_providers: [{ provider_id: "my-gateway", base_url: "https://gw.test/v1", api: "openai-completions", model_ids: [] }],
      }),
    );
    // Exactly one warning-toned pill on the page: the template tier.
    expect(html.split('data-tone="warn"').length - 1).toBe(1);
    const badgeIn = (label: string) => groupHeaderOf(html, label).match(/data-tone="([a-z]+)"/g);
    expect(badgeIn("workers-ai label"), "template tier").toEqual(['data-tone="warn"']);
    expect(badgeIn("anthropic label"), "builtin tier").toEqual(['data-tone="neutral"']);
    expect(badgeIn("my-gateway"), "custom tier").toEqual(['data-tone="neutral"']);

    expect(groupOf(html, "workers-ai label")).toContain(t("en", "settings.providers.tier.template"));
    expect(groupOf(html, "anthropic label")).toContain(t("en", "settings.providers.tier.builtin"));
    expect(groupOf(html, "my-gateway")).toContain(t("en", "settings.providers.tier.custom"));
  });
});

describe("declaration group with no key", () => {
  test("renders the empty state instead of an empty row container", () => {
    const html = render(
      managePayload({
        custom_providers: [{ provider_id: "my-gateway", base_url: "https://gw.test/v1", api: "openai-completions", model_ids: [] }],
      }),
    );
    expect(html).toContain(t("en", "settings.providers.empty"));
    expect(html).not.toContain('data-slot="list-row-group"');
    expect(rowsOf(html)).toHaveLength(0);
  });
});

describe("endpoint meta-line disclosure (AC-20 / I-000208)", () => {
  test("template and custom groups state api · base_url · models; builtin groups do not", () => {
    const html = render(
      managePayload({
        provider_catalog: [
          catalogEntry("anthropic", "builtin", { base_url: "https://api.anthropic.com", api: "anthropic" }),
          catalogEntry("workers-ai", "template", { base_url: "https://api.test", api: "openai-completions", models: ["a", "b"] }),
        ],
        keys: [keyRow("anthropic", "a"), keyRow("workers-ai", "b")],
      }),
    );
    expect(groupOf(html, "anthropic label")).not.toContain("settings.providers.expand");
    const templateGroup = groupOf(html, "workers-ai label");
    expect(templateGroup).toContain(">openai-completions</span>");
    expect(templateGroup).toContain(">https://api.test</span>");
    expect(templateGroup).toContain(t("en", "settings.providers.modelCount", { count: 2 }));
  });

  test("a one-key group and a one-model list read singular in en", () => {
    const html = render(
      managePayload({
        provider_catalog: [catalogEntry("workers-ai", "template", { base_url: "https://api.test", api: "openai-completions", models: ["only"] })],
        keys: [keyRow("workers-ai", "solo")],
      }),
    );
    const group = groupOf(html, "workers-ai label");
    expect(group).toContain("1 key ·");
    expect(group).not.toContain("1 keys");
    expect(group).toContain("1 model");
    expect(group).not.toContain("1 models");
  });

  test("the expand control names the model-id region it toggles", () => {
    const html = render(
      managePayload({
        keys: [keyRow("p", "a")],
        custom_providers: [{ provider_id: "my-gateway", base_url: "https://gw.test/v1", api: "openai-completions", model_ids: ["m1", "m2"] }],
      }),
    );
    // Collapsed by default: the control states the state and names no region
    // that does not exist yet.
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("aria-controls");
    expect(html).not.toContain('id="provider-models-my-gateway"');
    expect(html).toContain(`>${t("en", "settings.providers.expand")}</button>`);
  });

  test("expanding states aria-expanded and names the model-id region it mounts", async () => {
    const { win, cleanup } = installDom("http://localhost/dashboard/ws/settings");
    try {
      const container = win.document.createElement("div");
      win.document.body.appendChild(container);
      // happy-dom's element is structurally the DOM Element React DOM accepts.
      const root = createRoot(container as unknown as Element);
      await act(async () => {
        root.render(
          createElement(ProvidersCard, {
            locale: "en" as const,
            payload: managePayload({
              custom_providers: [
                { provider_id: "my-gateway", base_url: "https://gw.test/v1", api: "openai-completions", model_ids: ["m1", "m2"] },
              ],
            }),
            onVerify: async () => ({ kind: "success" as const, message: "" }),
            onSettings: async () => ({ kind: "success" as const, message: "" }),
            onPending: () => {},
            notice: null,
            removeOutcome: null,
            onOutcome: () => {},
          }),
        );
      });

      const toggle = [...container.querySelectorAll("button")].find(
        (button) => button.textContent === t("en", "settings.providers.expand"),
      );
      if (!(toggle instanceof win.HTMLElement)) throw new Error("expand control is missing");
      expect(toggle.getAttribute("aria-expanded")).toBe("false");

      await act(async () => {
        toggle.click();
      });

      const expanded = container.querySelector(`[aria-expanded="true"]`);
      if (!(expanded instanceof win.HTMLElement)) throw new Error("the control did not expand");
      const regionId = expanded.getAttribute("aria-controls");
      expect(regionId).toBe("provider-models-my-gateway");
      const region = regionId === null ? null : container.querySelector(`#${regionId}`);
      if (!(region instanceof win.HTMLElement)) throw new Error("the named region is missing");
      expect(region.textContent).toContain("m1");
      expect(region.textContent).toContain("m2");
      expect(expanded.textContent).toBe(t("en", "settings.providers.collapse"));

      await act(async () => {
        root.unmount();
      });
    } finally {
      cleanup();
    }
  });
});

describe("remove routes stay intact", () => {
  test("a key row keeps its per-key remove control and a declaration keeps its card-level one", () => {
    const html = render(
      managePayload({
        keys: [keyRow("p", "a")],
        custom_providers: [{ provider_id: "p", base_url: "https://gw.test/v1", api: "openai-completions", model_ids: [] }],
      }),
    );
    const row = rowOf(html, "tail-a");
    expect(row).toContain(`>${t("en", "settings.remove")}</button>`);
    // The declaration's remove sits in the group header, outside the rows.
    const header = groupHeaderOf(html, "p");
    expect(header.split(`>${t("en", "settings.remove")}</button>`).length - 1).toBe(1);
  });
});
