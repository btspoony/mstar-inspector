/**
 * Fix-round-F3 pins for consolidated QC items 9, 12 and 13.
 *
 * 9.  ONE bot directory: the Apps page renders two tabs and no bot surface;
 *     the legacy `?tab=bots` spelling redirects to `/bots`.
 * 12. Identity is stated once on the creator face, and no surface renders a
 *     24h rejection figure.
 * 13. One Credits/ceiling presentation and effective multiplier semantics:
 *     the limit rides every month cell; an unshared bot is ×1 everywhere it is
 *     effective; a shared bot's stored multiplier shows through.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../../src/i18n";
import { AppsView } from "../../src/spa/pages/AppsPage";
import { DeliveryStatusView } from "../../src/spa/pages/AppDeliveryTab";
import { BotsView, type BotsReadState } from "../../src/spa/pages/BotsPage";
import { usageCeilingCell } from "../../src/spa/pages/credits";
import type { AppsPayload, UsableBotsPayload } from "../../src/spa/pages/data";
import { AppDetailView } from "../../src/spa/pages/AppDetailPage";
import type { SettingsPayload } from "../../src/spa/pages/data";
import { legacyBotsTabRedirect } from "../../src/spa/routes";
import { withLocation } from "./browser-stub";

// --------------------------------------------------------------------- item 9

const app = (overrides: Partial<AppsPayload["apps"][number]> = {}): AppsPayload["apps"][number] => ({
  github_app_id: 101,
  owned: true,
  installed: false,
  month: null,
  github_slug: "demo",
  github_name: null,
  github_avatar_url: null,
  status: "active",
  review_enabled: 1,
  created_by: "mallory",
  health: { latest: null, rejected24h: 0 },
  ...overrides,
});

describe("item 9 — one bot directory", () => {
  test("the Apps page renders exactly two tabs and no bot surface", () => {
    const html = withLocation("/dashboard/acme/apps", () =>
      renderToStaticMarkup(
        createElement(AppsView, {
          locale: "en",
          state: "ok",
          payload: {
            viewer: { login: "mallory", role: "admin" },
            apps: [app({ installed: true })],
            shared_bots: [],
          },
          canCreate: true,
          unavailableReason: "",
          tab: "installed",
          onRetry: () => {},
        }),
      ),
    );
    expect(html).toContain(t("en", "apps.tabInstalled"));
    expect(html).toContain(t("en", "apps.tabCreated"));
    // Two tabs exactly, and no bot surface — the retired tab key is deleted,
    // so assert the rendered tab count instead of the copy.
    expect((html.match(/role="tab"/g) ?? []).length).toBe(2);
    expect(html).not.toContain('data-slot="bots-filter"');
  });

  test("the legacy ?tab=bots spelling redirects to the same workspace's /bots", () => {
    expect(legacyBotsTabRedirect("/dashboard/acme/apps", "?tab=bots")).toBe("/dashboard/acme/bots");
    expect(legacyBotsTabRedirect("/dashboard/acme/apps", "?tab=bots&other=1")).toBe("/dashboard/acme/bots");
    expect(legacyBotsTabRedirect("/dashboard/acme/apps", "")).toBeNull();
    expect(legacyBotsTabRedirect("/dashboard/acme/apps", "?tab=installed")).toBeNull();
    expect(legacyBotsTabRedirect("/dashboard/acme/apps/1", "?tab=bots")).toBeNull();
    expect(legacyBotsTabRedirect("/dashboard/acme/bots", "?tab=bots")).toBeNull();
  });
});

// -------------------------------------------------------------------- item 12

describe("item 12 — the synced identity is stated once on the creator face", () => {
  const managePayload = {
    can_manage: true,
    viewer_relation: "created" as const,
    official_workspace: true,
    can_configure_bot: true,
    installation: null,
    pending_installations: [],
    blocked: false,
    blocked_reason: null,
    workspace_id: "ws-acme",
    app: {
      github_slug: "demo",
      id: "app-demo",
      github_app_id: 1,
      status: "active",
      review_enabled: true,
      created_by: "mallory",
      github_name: "Demo Inspector",
      github_description: null,
      github_html_url: "https://github.com/apps/demo",
      github_avatar_url: null,
      github_metadata_synced_at: null,
      last_webhook_at: null,
      scope: "owned" as const,
      sandbox_image_id: "omp",
      review_trigger_mode: "every_push" as const,
      review_level: null,
      default_review_level: "default",
      github_visibility: "unknown" as const,
    },
    check_gate: { min_score: 80, pass_verdicts: ["ship it"] },
    keys: [],
    model_chain: null,
    model_roles: {},
    model_chains: [],
    custom_providers: [],
    configured_providers: [],
    provider_catalog_version: "f3",
    provider_eligibility: {},
    model_role_ids: [],
    custom_provider_api_ids: [],
    sandbox_images: [{ id: "omp", enabled: true }],
    installations: [],
    chain: [],
    targets_many: false,
  };

  test("the name renders once — the page header — and the GitHub entry is an action link", () => {
    const html = withLocation("/dashboard/acme/apps/1?tab=settings", () =>
      renderToStaticMarkup(
        createElement(AppDetailView, {
          locale: "en",
          appId: "1",
          payload: managePayload as unknown as SettingsPayload,
          groups: [],
          notice: null,
          search: { tab: "settings" as const, window: "30" as const, repo: "", pr: "" },
          onReload: async () => true,
          onSearch: () => {},
        }),
      ),
    );
    const occurrences = html.split(">Demo Inspector<").length - 1;
    expect(occurrences).toBe(1);
    // The GitHub entry is labelled by its ACTION, not the App's name.
    expect(html).toContain("Manage on GitHub");
    expect(html).toContain('href="https://github.com/settings/apps/demo"');
  });
});

describe("item 12 — no 24h figure anywhere on the delivery panel", () => {
  const deliveryPage = {
    rows: [
      {
        event_name: "pull_request",
        outcome: "rejected" as const,
        status_code: 401,
        repository_full_name: "acme/web",
        reason: "signature verification failed",
        created_at: "2026-01-01 00:00:00",
      },
    ],
    total: 7,
    repos: ["acme/web"],
    types: ["pull_request"],
  };

  test("a nonzero rejection history still renders no 24h figure — the log stays", () => {
    const markup = renderToStaticMarkup(
      createElement(DeliveryStatusView, {
        locale: "en",
        summary: { last_webhook_at: null },
        page: deliveryPage,
        filters: { repo: "", since: "", type: "" },
        offset: 0,
        loading: false,
        onFilter: () => {},
        onPage: () => {},
        onReload: () => {},
      }),
    );
    expect(markup).not.toContain("24h");
    expect(markup).not.toContain("24 小时");
    // The delivery log itself is untouched.
    expect(markup).toContain("signature verification failed");
    expect(markup).toContain("acme/web");
  });
});

// -------------------------------------------------------------------- item 13

const bot = (overrides: Partial<UsableBotsPayload["bots"][number]> = {}): UsableBotsPayload["bots"][number] => ({
  id: "bot-1",
  name: "Team bot",
  description: null,
  workspace_id: "ws",
  workspace_name: "Acme",
  owned: true,
  can_manage: true,
  scope: "owned",
  multiplier: 3,
  month_used_rp: 9000,
  archived: false,
  ...overrides,
});

const renderBots = (bots: UsableBotsPayload["bots"], plan: number | null): string =>
  withLocation("/dashboard/acme/bots", () =>
    renderToStaticMarkup(
      createElement(BotsView, {
        locale: "en",
        base: "/dashboard/acme",
        state: {
          kind: "ok",
          payload: { workspace_id: "ws", plan_monthly_rp: plan, rp_per_credit: 1000, bots },
        } as BotsReadState,
        canCreate: false,
        onCreated: () => {},
      }),
    ),
  );

describe("item 13 — one ceiling presentation on /bots", () => {
  test("a ceiling states `已用 / 上限`; unlimited states it; own states unlimited (own bot)", () => {
    const shared = bot({ id: "bot-shared", owned: false, scope: "shared", month_used_rp: 90 });
    const withCeiling = renderBots([bot(), shared], 100000);
    expect(withCeiling).toContain("0.09 Credits / 100.00 Credits");
    const unlimited = renderBots([bot(), shared], null);
    expect(unlimited).toContain(t("en", "credits.noCeiling", { used: "0.09" }));
    expect(unlimited).toContain(t("en", "credits.unlimitedOwn", { used: "9.00" }));
  });

  test("an unshared bot reports ×1 in the list; a shared one shows its stored multiplier", () => {
    const html = renderBots(
      [
        bot({ id: "bot-own", name: "Own bot", owned: true, scope: "owned", multiplier: 3 }),
        bot({ id: "bot-pub", name: "Published", owned: false, scope: "shared", multiplier: 4 }),
      ],
      null,
    );
    const ownRow = html.split("<tr ").find((part) => part.includes("Own bot")) ?? "";
    const pubRow = html.split("<tr ").find((part) => part.includes("Published")) ?? "";
    expect(ownRow).toContain("×1");
    expect(ownRow).not.toContain("×3");
    expect(pubRow).toContain("×4");
  });
});

describe("item 13 — the shared cell helper", () => {
  test("states the ceiling, the unlimited spellings and the unknown marker", () => {
    expect(
      usageCeilingCell("en", { used_rp: 2000 }, { owned: false, quotaError: false, ceilingRp: 5000, rpPerCredit: 1000 }),
    ).toBe("2.00 Credits / 5.00 Credits");
    expect(
      usageCeilingCell("en", { used_rp: 2000 }, { owned: false, quotaError: false, ceilingRp: null }),
    ).toBe(t("en", "credits.noCeiling", { used: "2.00" }));
    expect(
      usageCeilingCell("en", { used_rp: 2000 }, { owned: true, quotaError: false, ceilingRp: 5000 }),
    ).toBe(t("en", "credits.unlimitedOwn", { used: "2.00" }));
    expect(
      usageCeilingCell("en", { used_rp: 2000 }, { owned: false, quotaError: true, ceilingRp: null }),
    ).toBe(t("en", "bots.monthUnknown"));
    expect(
      usageCeilingCell("en", null, { owned: false, quotaError: false, ceilingRp: 5000 }),
    ).toBe(t("en", "bots.monthNone"));
  });
});
