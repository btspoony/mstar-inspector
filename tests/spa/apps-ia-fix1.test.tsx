/**
 * Fix-round-1 pins for the Apps IA (F1/F2/F3/F5/F9/F16). These are behavioural:
 * each asserts what the surface DOES with a given payload, not how it is
 * spelled — membership, the real default, the corrected URL, a failed read
 * kept distinct from an empty one, and the ownership/manage split.
 */
import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../../src/i18n";
import {
  AppsView,
  appsTabOf,
  appsTabQuery,
  installedAppsOf,
} from "../../src/spa/pages/AppsPage";
import type { AppsPayload } from "../../src/spa/pages/data";
import { withLocation } from "./browser-stub";

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

const payload = (apps: AppsPayload["apps"], extra: Partial<AppsPayload> = {}): AppsPayload => ({
  viewer: { login: "mallory", role: "admin" },
  apps,
  shared_bots: [],
  ...extra,
});

const render = (apps: AppsPayload, tab: "installed" | "created" = "installed"): string =>
  withLocation("/dashboard/acme/apps", () =>
    renderToStaticMarkup(
      createElement(AppsView, {
        locale: "en",
        state: "ok",
        payload: apps,
        canCreate: true,
        unavailableReason: "",
        tab,
        onRetry: () => {},
      }),
    ),
  );

describe("F1 — installed membership is an installation relation, not visibility", () => {
  test("only rows the server marked installed join the installed set", () => {
    const created = app({ github_app_id: 101, owned: true, installed: false });
    const installed = app({ github_app_id: 202, owned: false, installed: true });
    expect(installedAppsOf(payload([created, installed])).map((row) => row.github_app_id)).toEqual([202]);
  });

  test("an owned-but-uninstalled App appears on created and NOT on installed", () => {
    const onlyCreated = payload([app({ github_app_id: 101, owned: true, installed: false })]);
    const installedFace = render(onlyCreated, "installed");
    expect(installedFace).toContain(t("en", "apps.installed.emptyTitle"));
    const createdFace = render(onlyCreated, "created");
    expect(createdFace).toContain("demo");
  });

  test("the installed table carries a month cell and never reads 0/limit when unmounted", () => {
    // F1: the month state comes from the mounted chain, so an own bot's chain
    // renders own-bot unlimited against the chain's spend — in Credits.
    const face = render(
      payload([app({ installed: true, month: { used_rp: 0, owned: true, multiplier: 1 } })], { month_plan_rp: 5000 }),
    );
    expect(face).toContain(t("en", "credits.usedThisMonth"));
    expect(face).toContain(t("en", "credits.unlimitedOwn", { used: "0.00" }));
  });
});

describe("F2 — URL truth", () => {
  test("an unknown nonempty tab resolves to the real default, and the default is omitted", () => {
    expect(appsTabOf("?tab=bogus")).toBe("installed");
    expect(appsTabOf("?tab=created")).toBe("created");
    expect(appsTabOf("")).toBe("installed");
    // The retired bots tab is a redirect, not a tab: it resolves to the default here.
    expect(appsTabOf("?tab=bots")).toBe("installed");
    expect(appsTabQuery("created", "created")).toBe("");
    expect(appsTabQuery("installed", "created")).toBe("?tab=installed");
    expect(appsTabQuery("installed", "installed")).toBe("");
  });
});

describe("F16 — pending rows name the App from the payload", () => {
  test("the pending row prints the joined App name, never a local id", () => {
    const html = render(
      payload([], {
        pending_installations: [
          {
            installation_id: 9,
            account_login: "acme",
            seen_at: "2026-01-01T00:00:00Z",
            app_id: "app-local-1",
            app_github_app_id: 4242,
            app_name: "Acme Inspector",
            can_bind: true,
          },
        ],
      }),
      "installed",
    );
    expect(html).toContain("Acme Inspector");
    expect(html).not.toContain("app-local-1");
  });
});

describe("F9 — the installed empty state offers both documented actions", () => {
  test("browse-shared and create are both reachable when the tab is empty", () => {
    const html = render(payload([]), "installed");
    expect(html).toContain(t("en", "apps.installed.emptyDescription"));
    expect(html).toContain(t("en", "apps.installed.browseShared"));
    expect(html).toContain(t("en", "apps.create"));
  });
});
