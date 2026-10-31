/**
 * Both-theme acceptance pass (plan 203, task 6).
 *
 * Every customer-facing surface of the compass `## Surface census` is rendered
 * under `data-theme="light"` and the token vocabulary its markup carries is
 * checked against the token source. Each finding below is a way a surface ends
 * up working only in dark:
 *
 * 1. A colour named from the **primitive** layer — a palette step in a page.
 *    It paints, but it is not the page's layer to name.
 * 2. A name declared nowhere (or not in both themes). It renders as
 *    `currentColor`, which looks correct exactly where another theme's value
 *    happened to be inherited.
 * 3. A colour token whose resolved value is the SAME in both themes — a surface
 *    face that cannot invert. That is a **token** defect, not a page defect:
 *    it returns to plans 201/202 instead of being patched locally. The D14
 *    carve-out (`chart-2`…`chart-6`, one approved literal per theme) is the
 *    only documented exemption.
 *
 * Two vocabularies are legitimate besides the semantic/component layers: the
 * shadcn bridge keys (`--card`, `--border`, …) declared in
 * `src/spa/styles/shadcn-theme.css`, which resolve onto a semantic; and a
 * component-local geometry variable (`--gap`, `--sidebar-width`) that the very
 * markup declares inline. The pass follows the first to its semantic target and
 * skips the second, because neither carries a colour of its own.
 *
 * happy-dom resolves no `var()` chain, so a rendered DOM cannot be asked for
 * computed colours. The observable is the token vocabulary the render carries —
 * which is exactly what a page owns.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarProvider } from "@design-system";
import { AppSidebar } from "../../src/spa/components/AppSidebar";
import type { ThemeName } from "../../src/design-system/tokens";
import { resolveTheme, tokenNames } from "../../src/design-system/tokens";
import { t } from "../../src/i18n";
import { InsightsRecordsView } from "../../src/spa/pages/AppInsightsTab";
import type { AppsPayload, InsightsSummary, SettingsManagePayload } from "../../src/spa/pages/data";
import { AppsView } from "../../src/spa/pages/AppsPage";
import { LoginPage } from "../../src/spa/pages/LoginPage";
import { MembersList, WorkspacePanel } from "../../src/spa/pages/MembersPage";
import { SettingsView } from "../../src/spa/pages/SettingsPage";
import { SupportPage } from "../../src/spa/pages/SupportPage";
import { WorkspaceSettingsPage } from "../../src/spa/pages/WorkspaceSettingsPage";
import { WorkspaceSetupPage } from "../../src/spa/pages/WorkspaceSetupPage";
import { withLocation } from "./browser-stub";
import { installDom } from "./dom";

const NAMES = tokenNames();
const SEMANTIC = new Set(NAMES.semantic);
const COMPONENT = new Set(NAMES.component);

const allLayers = (theme: ThemeName): Record<string, string> => {
  const layers = resolveTheme(theme);
  return { ...layers.primitive, ...layers.semantic, ...layers.component };
};
const DARK = allLayers("dark");
const LIGHT = allLayers("light");

/** The shadcn bridge: `@theme inline` keys → the semantic token each one names. */
const BRIDGE: Readonly<Record<string, string>> = (() => {
  const css = readFileSync(new URL("../../src/spa/styles/shadcn-theme.css", import.meta.url), "utf8");
  const declared: Record<string, string> = {};
  for (const match of css.matchAll(/--([a-z0-9-]+):\s*(var\(--[a-z0-9-]+\));/g)) {
    declared[match[1] as string] = match[2] as string;
  }
  return declared;
})();

/** The semantic token a bridge key resolves to, or null when `name` is no bridge key. */
const bridgeTarget = (name: string): string | null => {
  const declared = BRIDGE[name];
  return declared === undefined ? null : (/^var\(--([a-z0-9-]+)\)$/.exec(declared)?.[1] ?? null);
};

/** A token's value in one theme, following one bridge hop when it is a bridge key. */
const tokenValue = (theme: ThemeName, name: string): string | undefined => {
  const layer = theme === "dark" ? DARK : LIGHT;
  const target = bridgeTarget(name);
  return layer[name] ?? (target === null ? undefined : layer[target]);
};

/**
 * D14 carve-out: the quiet 600-step chart fills are one approved literal for
 * both themes on purpose (semantic.ts carries the reasoning). A chart is not a
 * surface, so it is the single exemption from "a colour must invert".
 */
const THEME_FIXED: Readonly<Record<string, true>> = {
  "chart-2": true,
  "chart-3": true,
  "chart-4": true,
  "chart-5": true,
  "chart-6": true,
};

/**
 * A token REFERENCE: a name that closes a paren group — `bg-(--x)`,
 * `text-(length:--x)`, `var(--x)`. A custom property the markup DECLARES
 * (`style="--sidebar-width: 16rem"`) is not a reference and is not counted.
 */
const TOKEN_REF = /--([a-z][a-z0-9-]*)\)/g;
/** A custom property declared inline by the markup that then consumes it. */
const INLINE_DECL = /--([a-z][a-z0-9-]*):/g;

const isColour = (value: string | undefined): boolean => value !== undefined && /^#[0-9a-f]{3,8}$/i.test(value);

/** Token references measured per surface — the coverage count behind the verdict. */
const measured: Record<string, number> = {};

/**
 * The light root every static surface is rendered inside — the attribute the
 * pre-paint bootstrap writes; the mounted faces set it on the document element.
 */
const renderLight = (element: Parameters<typeof renderToStaticMarkup>[0]): string =>
  `<div data-theme="light">${renderToStaticMarkup(element)}</div>`;

/** Mount a page whose contract lives in its effect, under the light attribute. */
async function mountLight(element: ReactElement, path: string): Promise<string> {
  const { win, cleanup } = installDom(`http://localhost${path}`);
  try {
    win.document.documentElement.dataset.theme = "light";
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    await act(async () => {
      root.render(element);
    });
    const html = container.innerHTML;
    await act(async () => root.unmount());
    return html;
  } finally {
    cleanup();
  }
}

/** Everything one surface's markup says about the token contract. */
function surfaceFindings(surface: string, markup: string): string[] {
  const names = [...new Set([...markup.matchAll(TOKEN_REF)].map((match) => match[1] as string))].sort();
  measured[surface] = names.length;
  // A probe that matched nothing is not a pass: every surface names tokens.
  if (names.length === 0) return [`${surface}: rendered no token reference`];

  const findings: string[] = [];
  const inline = new Set([...markup.matchAll(INLINE_DECL)].map((match) => match[1] as string));
  for (const name of names) {
    const dark = tokenValue("dark", name);
    const light = tokenValue("light", name);
    if (dark === undefined || light === undefined) {
      // A geometry variable its own primitive emits inline carries no theme.
      if (!inline.has(name)) findings.push(`${surface}: --${name} is declared nowhere`);
      continue;
    }
    const target = SEMANTIC.has(name) || COMPONENT.has(name) ? name : bridgeTarget(name);
    if (target === null) {
      if (isColour(dark)) findings.push(`${surface}: --${name} is a primitive palette step`);
      continue;
    }
    if (isColour(dark) && dark === light && THEME_FIXED[target] !== true) {
      findings.push(`${surface}: --${target} resolves to ${dark} in both themes`);
    }
  }
  return findings;
}

const APPS_PAYLOAD: AppsPayload = {
  viewer: { login: "mallory", role: "admin" },
  apps: [
    {
      github_app_id: 42,
      github_name: "acme",
      github_slug: "acme",
      github_avatar_url: null,
      status: "active",
      review_enabled: 1,
      created_by: "mallory",
      health: {
        latest: {
          event_name: "pull_request",
          outcome: "ok",
          status_code: 200,
          created_at: "2026-10-01T00:00:00Z",
        },
        rejected24h: 0,
      },
    },
  ],
};

const SETTINGS_PAYLOAD: SettingsManagePayload = {
  can_manage: true,
  workspace_id: "ws_0123456789abcdefghijkl",
  app: {
    github_slug: "acme-app",
    id: "app-acme",
    github_app_id: 42,
    status: "active",
    review_enabled: true,
    created_by: "octocat",
    github_name: "Acme",
    github_description: null,
    github_html_url: "https://github.com/apps/acme",
    github_avatar_url: null,
    github_metadata_synced_at: null,
    last_webhook_at: null,
    sandbox_image_id: "omp",
    review_trigger_mode: "every_push",
  },
  keys: [],
  model_chain: null,
  model_roles: {},
  model_chains: [],
  custom_providers: [],
  configured_providers: [
    {
      kind: "key",
      provider: "openai",
      key_id: "0123456789abcdef",
      last4: "abcd",
      updated_at: "2026-10-01T00:00:00Z",
      verified_at: "2026-10-01T00:00:00Z",
      verified_status: "ok",
    },
  ],
  provider_catalog: [],
  model_role_ids: [],
  custom_provider_api_ids: [],
  sandbox_images: [{ id: "omp", enabled: true }],
  installations: [],
  deliveries: [],
};

const INSIGHTS: InsightsSummary = {
  window_days: 7,
  repo: "",
  reviews_total: 3,
  findings_by_severity: [{ severity: "must-fix", count: 2 }],
  findings_by_category: [{ category: "DEBT", count: 2 }],
  verdict_distribution: [{ verdict: "approve", count: 3 }],
  weekly_trend: [{ week_start: "2026-09-07", reviews: 3, findings: 2 }],
  daily_trend: [{ day_start: "2026-09-10", reviews: 3, findings: 2 }],
  findings_distribution: [
    {
      bucket_start: "2026-09-10",
      granularity: "day",
      by_severity: { "must-fix": 2, "should-fix": 0, nit: 0 },
      by_category: { DEBT: 2, uncategorized: 0 },
    },
  ],
  recurring_top: [{ fingerprint: "fp1", title_sample: "Off-by-one", count: 2, repos: ["acme/web"] }],
  repos: ["acme/web"],
};

const MEMBER = {
  id: "u1",
  github_login: "octocat",
  role: "member" as const,
  created_at: "2026-01-02T03:04:05.678Z",
};

const WORKSPACE = {
  plan: { id: "free", name: "Free" },
  memberLimit: 5,
  reviewAttemptsThisMonth: 12,
  pendingInvites: 0,
};

/** The support read the mounted face performs. */
const SUPPORT_VIEW = {
  workspace: { id: "ws_1", name: "Acme", slug: "acme", created_at: "2026-01-01 00:00:00" },
  members: [{ github_login: "octocat", role: "member" }],
  grants: [{ operator_login: "operator", reason: "incident 42", expires_at: "2026-11-01 00:00:00" }],
};

type Surface = {
  readonly name: string;
  /** Copy the render must carry — proves the pass measured a real face. */
  readonly marker: string;
  readonly render: () => string | Promise<string>;
};

/**
 * The census, in the plan's order. Each surface renders the loaded face a user
 * actually meets (state supplied), never the loading skeleton.
 */
const SURFACES: readonly Surface[] = [
  {
    name: "Apps list",
    marker: t("en", "apps.heading"),
    render: () =>
      renderLight(
        createElement(AppsView, {
          locale: "en",
          state: "ok",
          payload: APPS_PAYLOAD,
          canCreate: true,
          unavailableReason: "",
          onRetry: () => {},
        }),
      ),
  },
  {
    name: "App detail — settings",
    marker: t("en", "settings.appInfo"),
    render: () =>
      withLocation("/dashboard/acme/apps/42", () =>
        renderLight(
          createElement(SettingsView, {
            locale: "en",
            payload: SETTINGS_PAYLOAD,
            groups: [],
            onReload: () => Promise.resolve(true),
          }),
        ),
      ),
  },
  {
    name: "App detail — insights",
    marker: t("en", "insights.heading"),
    render: () => renderLight(createElement(InsightsRecordsView, { locale: "en", data: INSIGHTS })),
  },
  {
    name: "Members",
    marker: t("en", "members.workspaceHeading"),
    render: () =>
      renderLight(
        createElement(
          "div",
          null,
          createElement(WorkspacePanel, {
            locale: "en",
            workspace: WORKSPACE,
            memberCount: 1,
            deploymentMode: "self-hosted",
          }),
          createElement(MembersList, {
            locale: "en",
            members: [MEMBER],
            viewerLogin: "mallory",
            memberRole: "owner",
            canInvite: true,
            onAction: () => {},
          }),
        ),
      ),
  },
  {
    name: "Workspace settings",
    marker: t("en", "workspace.nameHeading"),
    render: () =>
      withLocation("/dashboard/ws_acme/settings", () =>
        renderLight(
          createElement(WorkspaceSettingsPage, {
            boot: {
              locale: "en",
              login: "dana",
              name: "Dana",
              workspaceRef: "ws_acme",
              memberships: [{ id: "ws_acme", slug: "acme", name: "Acme", role: "owner", plan: "Free" }],
            },
          }),
        ),
      ),
  },
  {
    name: "Workspace setup",
    marker: t("en", "workspace.invitesHeading"),
    render: () =>
      renderLight(
        createElement(WorkspaceSetupPage, {
          boot: {
            locale: "en",
            login: "invitee",
            name: null,
            needsWorkspace: true,
            pendingInvites: [
              { workspaceRef: "acme", inviteId: "inv_1", role: "admin", expiresAt: "2099-01-01T00:00:00Z" },
            ],
          },
        }),
      ),
  },
  {
    name: "Support",
    marker: t("en", "support.grantsHeading"),
    render: async () => {
      const realFetch = globalThis.fetch;
      globalThis.fetch = (async () =>
        new Response(JSON.stringify(SUPPORT_VIEW), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        })) as unknown as typeof fetch;
      try {
        return await mountLight(
          createElement(SupportPage, { boot: { locale: "en", login: "operator", name: null } }),
          "/dashboard/acme/support",
        );
      } finally {
        globalThis.fetch = realFetch;
      }
    },
  },
  {
    name: "Login",
    marker: t("en", "login.signIn"),
    render: () => renderLight(createElement(LoginPage, { boot: { locale: "en", login: null, name: null } })),
  },
];

describe("both-theme acceptance pass", () => {
  test("the pass enumerates all eight customer-facing surfaces", () => {
    expect(SURFACES.map((surface) => surface.name)).toEqual([
      "Apps list",
      "App detail — settings",
      "App detail — insights",
      "Members",
      "Workspace settings",
      "Workspace setup",
      "Support",
      "Login",
    ]);
  });

  test("under data-theme=light no surface carries a token that only works in dark", async () => {
    const findings: string[] = [];
    for (const surface of SURFACES) {
      const markup = await surface.render();
      // The loaded face really rendered — the probe measured a surface, not a
      // skeleton or an error branch.
      expect(markup, surface.name).toContain(surface.marker);
      findings.push(...surfaceFindings(surface.name, markup));
    }
    // Empty = no token is returned to plans 201/202.
    expect(findings).toEqual([]);
    // The verdict names what it compared: 8 surfaces, this many references.
    expect(Object.keys(measured)).toHaveLength(SURFACES.length);
    const total = Object.values(measured).reduce((sum, count) => sum + count, 0);
    expect(total).toBeGreaterThan(150);
  });

  test("the rule has teeth: a palette step in a surface is caught", () => {
    // The failure path on a synthetic markup — the real surfaces are clean, and
    // a guard that cannot fail is not a guard.
    expect(surfaceFindings("probe", '<div class="bg-(--gray-200)">probe</div>')).toEqual([
      "probe: --gray-200 is a primitive palette step",
    ]);
    expect(surfaceFindings("probe", '<div class="bg-(--surface-page)">probe</div>')).toEqual([]);
    // Nothing else is exempt from inverting: the semantic colours that keep one
    // value across the themes are exactly the D14 chart fills.
    const themeFixed = NAMES.semantic.filter((name) => isColour(DARK[name]) && DARK[name] === LIGHT[name]);
    expect(themeFixed.sort()).toEqual(Object.keys(THEME_FIXED).sort());
  });

  test("the sidebar chrome the signed-in surfaces sit on is theme-complete too", () => {
    const sidebar = renderLight(
      createElement(
        SidebarProvider,
        null,
        createElement(AppSidebar, {
          model: {
            brand: t("en", "nav.brand"),
            brandHref: "/dashboard",
            navLabel: t("en", "nav.apps"),
            items: [{ href: "/dashboard/apps", label: t("en", "nav.apps"), current: true }],
          },
        }),
      ),
    );
    expect(surfaceFindings("Sidebar", sidebar)).toEqual([]);
    expect(measured["Sidebar"]).toBeGreaterThan(0);
  });
});
