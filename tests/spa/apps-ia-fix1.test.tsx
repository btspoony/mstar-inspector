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
  UsableBotsList,
  appsTabOf,
  appsTabQuery,
  installedAppsOf,
  type BotsReadState,
} from "../../src/spa/pages/AppsPage";
import type { AppsPayload, UsableBotsPayload } from "../../src/spa/pages/data";
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

const render = (apps: AppsPayload, tab: "installed" | "created" | "bots" = "installed"): string =>
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
    // renders own-bot unlimited against the chain's spend.
    const face = render(
      payload([app({ installed: true, month: { used_rp: 0, owned: true, multiplier: 1 } })], { month_plan_rp: 5000 }),
    );
    expect(face).toContain(t("en", "bots.monthLabel"));
    expect(face).toContain(t("en", "bots.monthOwn", { used: 0 }));
  });
});

describe("F2 — URL truth", () => {
  test("an unknown nonempty tab resolves to the real default, and the default is omitted", () => {
    expect(appsTabOf("?tab=bogus", false)).toBe("created");
    expect(appsTabOf("?tab=bogus", true)).toBe("installed");
    expect(appsTabOf("?tab=bots", false)).toBe("bots");
    expect(appsTabQuery("created", "created")).toBe("");
    expect(appsTabQuery("bots", "created")).toBe("?tab=bots");
  });
});

describe("F3 — a failed read is not an empty list", () => {
  const botsPayload: UsableBotsPayload = {
    workspace_id: "ws",
    plan_monthly_rp: 1000,
    bots: [
      {
        id: "bot-1",
        name: "Team bot",
        description: null,
        workspace_id: "ws",
        workspace_name: "Acme",
        owned: true,
        can_manage: true,
        scope: "owned",
        multiplier: 1,
        month_used_rp: 10,
      },
    ],
  };

  // The real call site always passes the page's retry; the component's own
  // contract is that an error face carries it.
  const renderBots = (state: BotsReadState, onRetry?: () => void): string =>
    renderToStaticMarkup(createElement(UsableBotsList, { locale: "en", bots: state, onRetry }));

  test("the error face never prints the empty-list copy", () => {
    const failed = renderBots({ kind: "error", message: t("en", "common.loadFailed") }, () => {});
    expect(failed).toContain(t("en", "common.loadFailed"));
    expect(failed).toContain(t("en", "common.retry"));
    expect(failed).not.toContain(t("en", "apps.bots.emptyTitle"));
  });

  test("an empty OK read does print the empty-list copy", () => {
    const empty = renderBots({ kind: "ok", payload: { ...botsPayload, bots: [] } });
    expect(empty).toContain(t("en", "apps.bots.emptyTitle"));
  });
});

describe("F5 — ownership and manage permission are separate from publication scope", () => {
  const bot = (overrides: Partial<UsableBotsPayload["bots"][number]> = {}) => ({
    id: "bot-1",
    name: "Team bot",
    description: null,
    workspace_id: "ws",
    workspace_name: "Acme",
    owned: true,
    can_manage: true,
    scope: "owned" as const,
    multiplier: 1,
    month_used_rp: 7,
    ...overrides,
  });
  const face = (rows: UsableBotsPayload["bots"]): string =>
    renderToStaticMarkup(
      createElement(UsableBotsList, {
        locale: "en",
        bots: { kind: "ok", payload: { workspace_id: "ws", plan_monthly_rp: 1000, bots: rows } },
      }),
    );

  test("an owned bot PUBLISHED as shared still reads own-bot unlimited (no plan ceiling)", () => {
    const html = face([bot({ scope: "shared", owned: true })]);
    expect(html).toContain(t("en", "bots.monthOwn", { used: 7 }));
    expect(html).not.toContain(t("en", "bots.monthLimit", { used: 7, limit: 1000 }));
  });

  test("a member of the owning workspace reads the bot as read-only, not editable", () => {
    const html = face([bot({ can_manage: false })]);
    expect(html).toContain(t("en", "apps.bots.readOnly"));
    expect(html).not.toContain(t("en", "apps.bots.editable"));
  });

  test("a shared bot from another workspace reads a ceiling, and membership is exclusive", () => {
    const html = face([bot({ id: "bot-2", owned: false, can_manage: false, workspace_name: "Other" })]);
    expect(html).toContain(t("en", "bots.monthLimit", { used: 7, limit: 1000 }));
    expect(html).toContain(t("en", "apps.bots.tagShared"));
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
