import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarProvider } from "@design-system";
import { App as AdminApp } from "../../src/spa/admin/main";
import { DataUpgradePage as AdminDataUpgradePage } from "../../src/spa/admin/DataUpgradePage";
import { FlagsPage as AdminFlagsPage } from "../../src/spa/admin/FlagsPage";
import { RuntimePage as AdminRuntimePage } from "../../src/spa/admin/RuntimePage";
import { SupportGrantsPage as AdminSupportGrantsPage } from "../../src/spa/admin/SupportGrantsPage";
import { UsersPage as AdminUsersPage } from "../../src/spa/admin/UsersPage";
import { WorkspacesPage as AdminWorkspacesPage } from "../../src/spa/admin/WorkspacesPage";
import type { SpaBoot } from "../../src/spa/boot";
import { AppSidebar } from "../../src/spa/components/AppSidebar";
import type { ThemeName } from "../../src/design-system/tokens";
import { resolveTheme, tokenNames } from "../../src/design-system/tokens";
import { t } from "../../src/i18n";
import { InsightsRecordsView } from "../../src/spa/pages/AppInsightsTab";
import { PullRequestsListView } from "../../src/spa/pages/AppPullRequestsTab";
import type { AppsPayload, InsightsSummary, SettingsManagePayload } from "../../src/spa/pages/data";
import { AppsView } from "../../src/spa/pages/AppsPage";
import { LoginPage } from "../../src/spa/pages/LoginPage";
import { MembersList, WorkspacePanel } from "../../src/spa/pages/MembersPage";
import { PullRequestDetailView } from "../../src/spa/pages/PullRequestDetail";
import { SettingsView } from "../../src/spa/pages/SettingsPage";
import { SupportPage } from "../../src/spa/pages/SupportPage";
import { WorkspaceSettingsPage } from "../../src/spa/pages/WorkspaceSettingsPage";
import { WorkspaceSetupPage } from "../../src/spa/pages/WorkspaceSetupPage";
import { withLocation } from "./browser-stub";
import { installDom } from "./dom";
import { DETAIL, ROW_OPEN, recordsOf } from "./pull-request-fixtures";
import { PALETTE_UTILITY_SOURCE } from "../helpers/tailwind-palette";

const NAMES = tokenNames();
const SEMANTIC = new Set(NAMES.semantic);
const COMPONENT = new Set(NAMES.component);

const allLayers = (theme: ThemeName): Record<string, string> => {
  const layers = resolveTheme(theme);
  return { ...layers.primitive, ...layers.semantic, ...layers.component };
};
const DARK = allLayers("dark");
const LIGHT = allLayers("light");

const BRIDGE: Readonly<Record<string, string>> = (() => {
  const css = readFileSync(new URL("../../src/spa/styles/shadcn-theme.css", import.meta.url), "utf8");
  const declared: Record<string, string> = {};
  for (const match of css.matchAll(/--([a-z0-9-]+):\s*(var\(--[a-z0-9-]+\));/g)) {
    declared[match[1] as string] = match[2] as string;
  }
  return declared;
})();

const bridgeTarget = (name: string): string | null => {
  const declared = BRIDGE[name];
  return declared === undefined ? null : (/^var\(--([a-z0-9-]+)\)$/.exec(declared)?.[1] ?? null);
};

const tokenValue = (theme: ThemeName, name: string): string | undefined => {
  const layer = theme === "dark" ? DARK : LIGHT;
  const target = bridgeTarget(name);
  return layer[name] ?? (target === null ? undefined : layer[target]);
};

const THEME_FIXED: Readonly<Record<string, true>> = {
  "chart-2": true,
  "chart-3": true,
  "chart-4": true,
  "chart-6": true,
};

const TOKEN_REF = /--([a-z][a-z0-9-]*)\)/g;
const INLINE_DECL = /--([a-z][a-z0-9-]*):/g;

const RAW_HEX = /#[0-9a-f]{3,8}\b/gi;
const PALETTE_UTILITY = new RegExp(PALETTE_UTILITY_SOURCE, "g");
const RENDERED_ATTRIBUTE = /\b(?:class|style)="([^"]*)"/g;

const isColour = (value: string | undefined): boolean => value !== undefined && /^#[0-9a-f]{3,8}$/i.test(value);

const measured: Record<string, number> = {};

const renderLight = (element: Parameters<typeof renderToStaticMarkup>[0]): string =>
  `<div data-theme="light">${renderToStaticMarkup(element)}</div>`;

async function mountLight(
  element: ReactElement,
  path: string,
  { surface, boot }: { surface?: "ops"; boot?: SpaBoot } = {},
): Promise<string> {
  const { win, cleanup } = installDom(`http://localhost${path}`);
  try {
    win.document.documentElement.dataset.theme = "light";
    if (surface !== undefined) win.document.documentElement.dataset.surface = surface;
    if (boot !== undefined) {
      const bootHost = globalThis as { window?: { __BOOT__?: SpaBoot } };
      bootHost.window!.__BOOT__ = boot;
    }
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

function rawColourFindings(surface: string, markup: string): string[] {
  const findings: string[] = [];
  for (const [, value] of markup.matchAll(RENDERED_ATTRIBUTE)) {
    for (const [hit] of (value as string).matchAll(RAW_HEX)) {
      findings.push(`${surface}: ${hit} is a raw colour, not a token`);
    }
    for (const [hit] of (value as string).matchAll(PALETTE_UTILITY)) {
      findings.push(`${surface}: ${hit} is a Tailwind palette utility`);
    }
  }
  return findings;
}

function surfaceFindings(surface: string, markup: string): string[] {
  const findings = rawColourFindings(surface, markup);
  const names = [...new Set([...markup.matchAll(TOKEN_REF)].map((match) => match[1] as string))].sort();
  measured[surface] = names.length;
  if (names.length === 0) {
    findings.push(`${surface}: rendered no token reference`);
    return findings;
  }

  const inline = new Set([...markup.matchAll(INLINE_DECL)].map((match) => match[1] as string));
  for (const name of names) {
    const dark = tokenValue("dark", name);
    const light = tokenValue("light", name);
    if (dark === undefined || light === undefined) {
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
  can_edit_chain: false,
  viewer_relation: "created",
  installation: null,
  pending_installations: [],
  workspace_id: "ws_0123456789abcdefghijkl",
  target_id: "rt-501",
  blocked: false as const,
  blocked_reason: null,
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
    scope: "owned" as const,
    sandbox_image_id: "omp",
    review_trigger_mode: "every_push",
    review_level: null,
    default_review_level: "default",
    github_visibility: "unknown",
  },
  check_gate: { min_score: 80, pass_verdicts: ["ship it"] },
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
  provider_catalog_version: "fixture-catalog",
  provider_eligibility: {},
  model_role_ids: [],
  custom_provider_api_ids: [],
  sandbox_images: [{ id: "omp", enabled: true }],
  installations: [],
};

const INSIGHTS: InsightsSummary = {
  window_days: 7,
  repo: "",
  reviews_total: 3,
  findings_by_severity: [{ severity: "must-fix", count: 2 }],
  verdict_distribution: [{ verdict: "approve", count: 3 }],
  weekly_trend: [{ week_start: "2026-09-07", reviews: 3, findings: 2 }],
  daily_trend: [{ day_start: "2026-09-10", reviews: 3, findings: 2 }],
  findings_distribution: [
    {
      bucket_start: "2026-09-10",
      granularity: "day",
      by_severity: { "must-fix": 2, "should-fix": 0, nit: 0 },
    },
  ],
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

const SUPPORT_VIEW = {
  workspace: { id: "ws_1", name: "Acme", slug: "acme", created_at: "2026-01-01 00:00:00" },
  members: [{ github_login: "octocat", role: "member" }],
  grants: [{ operator_login: "operator", reason: "incident 42", expires_at: "2026-11-01 00:00:00" }],
};

const ADMIN_FLAGS = [
  { key: "review_global", enabled: true },
  { key: "signup_open", enabled: false },
];
const ADMIN_WORKSPACES = [
  {
    id: "ws_0123456789abcdefghijkl",
    name: "Acme",
    slug: "acme",
    ownerLogin: "octocat",
    memberCount: 3,
    pendingInviteCount: 1,
    planId: "pro",
    planName: "Pro",
    includedMembers: 10,
    createdAt: "2026-09-01T00:00:00Z",
  },
];
const ADMIN_USERS = [
  { login: "octocat", createdAt: "2026-08-26T09:41:00Z", workspaceCount: 1, activeGrantCount: 0, isOperator: true },
];
const ADMIN_GRANTS = [
  {
    id: "g1",
    workspace_id: "ws_0123456789abcdefghijkl",
    operator_login: "operator",
    reason: "incident 42",
    granted_by: "operator",
    created_at: "2026-10-01T00:00:00Z",
    expires_at: "2026-11-01T00:00:00Z",
  },
];

const ADMIN_UPGRADES = [
  {
    id: "repo-backfill",
    title: "Repository identity backfill",
    impact: "Splits duplicate targets and repoints their ledger rows. Never deletes reviews, findings or failures.",
    requiresDowntime: true,
    state: {
      status: "running",
      processed: 20,
      startedAt: "2026-11-16T08:00:00.000Z",
      finishedAt: null,
      lastError: null,
    },
    preflight: { unidentified_targets: 4, ledger_pairs: 12 },
  },
  {
    id: "finding-index",
    title: "Finding index rebuild",
    impact: "Rebuilds the finding index. Never rewrites a stored finding.",
    requiresDowntime: false,
    state: {
      status: "failed",
      processed: 7,
      startedAt: "2026-11-15T08:00:00.000Z",
      finishedAt: null,
      lastError: "verify failed: orphan_rows=2",
    },
    preflight: { rows: 0 },
  },
];

const adminApi = (url: string): unknown => {
  if (url.includes("/data-upgrades")) return { upgrades: ADMIN_UPGRADES };
  if (url.includes("/runtime"))
    return {
      concurrency: 24,
      min: 1,
      max: 256,
      degraded: false,
      checkBudgets: {
        terminalizeMs: 10_000,
        updateMs: 5_000,
        terminalizeMin: 1_000,
        terminalizeMax: 30_000,
        updateMin: 500,
        updateMax: 15_000,
        degraded: false,
        derived: false,
      },
      maintenance: { enabled: true, reason: "data upgrade", since: "2026-11-16T07:59:00.000Z" },
    };
  if (url.includes("/workspaces")) return { workspaces: ADMIN_WORKSPACES };
  if (url.includes("/users")) return { users: ADMIN_USERS };
  if (url.includes("/support-grants")) return { grants: ADMIN_GRANTS };
  return { flags: ADMIN_FLAGS };
};

async function mountAdmin(
  element: ReactElement,
  path: string,
  boot?: SpaBoot,
): Promise<string> {
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: RequestInfo | URL) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.pathname : input.url;
    return new Response(JSON.stringify(adminApi(url)), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  }) as unknown as typeof fetch;
  try {
    return await mountLight(element, path, { surface: "ops", boot });
  } finally {
    globalThis.fetch = realFetch;
  }
}

type Surface = {
  readonly name: string;
  readonly marker: string;
  readonly render: () => string | Promise<string>;
};

const LIVE_REVIEWING = {
  state: "live",
  head_sha: "aaa111bbb222",
  acquired_at: "2026-11-01T10:00:00.000Z",
} as const;

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
    name: "App detail — pull requests",
    marker: t("en", "pullRequests.columnPr"),
    render: () =>
      renderLight(
        createElement(PullRequestsListView, {
          locale: "en",
          rows: [
            { ...ROW_OPEN, reviewing: LIVE_REVIEWING },
            { ...ROW_OPEN, number: 7, title: "Unreadable lock", reviewing: { state: "unknown" } },
          ],
          onOpen: () => {},
        }),
      ),
  },
  {
    name: "App detail — pull request",
    marker: t("en", "pullRequests.reviewingHead", { head: LIVE_REVIEWING.head_sha.slice(0, 7) }),
    render: () =>
      renderLight(
        createElement(PullRequestDetailView, {
          locale: "en",
          detail: { ...DETAIL, pull_request: { ...DETAIL.pull_request, reviewing: LIVE_REVIEWING } },
          records: recordsOf(),
          onEnsureSection: () => {},
          onLoadPage: () => {},
        }),
      ),
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
  {
    name: "Console — shell",
    marker: t("en", "admin.flags.effectReviewGlobal"),
    render: () =>
      mountAdmin(createElement(AdminApp), "/_internal_admin/flags", {
        locale: "en",
        login: "operator",
        name: null,
      }),
  },
  {
    name: "Console — flags",
    marker: t("en", "admin.flags.effectReviewGlobal"),
    render: () => mountAdmin(createElement(AdminFlagsPage, { locale: "en" }), "/_internal_admin/flags"),
  },
  {
    name: "Console — runtime",
    marker: t("en", "admin.runtime.concurrencyCurrent", { value: 24 }),
    render: () => mountAdmin(createElement(AdminRuntimePage, { locale: "en" }), "/_internal_admin/runtime"),
  },
  {
    name: "Console — workspaces",
    marker: t("en", "admin.workspaces.seatsColumn"),
    render: () =>
      mountAdmin(createElement(AdminWorkspacesPage, { locale: "en" }), "/_internal_admin/workspaces"),
  },
  {
    name: "Console — users",
    marker: t("en", "admin.users.githubColumn"),
    render: () => mountAdmin(createElement(AdminUsersPage, { locale: "en" }), "/_internal_admin/users"),
  },
  {
    name: "Console — support access",
    marker: t("en", "admin.supportGrants.expiresColumn"),
    render: () =>
      mountAdmin(
        createElement(AdminSupportGrantsPage, { locale: "en" }),
        "/_internal_admin/support-grants",
      ),
  },
  {
    name: "Console — data upgrades",
    marker: t("en", "admin.dataUpgrades.maintenanceTitle"),
    render: () =>
      mountAdmin(
        createElement(AdminDataUpgradePage, { locale: "en" }),
        "/_internal_admin/data-upgrades",
      ),
  },
];

describe("both-theme acceptance pass", () => {
  test("the pass enumerates the ten customer faces and the console's seven", () => {
    expect(SURFACES.map((surface) => surface.name)).toEqual([
      "Apps list",
      "App detail — settings",
      "App detail — insights",
      "App detail — pull requests",
      "App detail — pull request",
      "Members",
      "Workspace settings",
      "Workspace setup",
      "Support",
      "Login",
      "Console — shell",
      "Console — flags",
      "Console — runtime",
      "Console — workspaces",
      "Console — users",
      "Console — support access",
      "Console — data upgrades",
    ]);
  });

  test("under data-theme=light no surface carries a token that only works in dark", async () => {
    const findings: string[] = [];
    for (const surface of SURFACES) {
      const markup = await surface.render();
      expect(markup, surface.name).toContain(surface.marker);
      findings.push(...surfaceFindings(surface.name, markup));
    }
    expect(findings).toEqual([]);
    expect(Object.keys(measured)).toHaveLength(SURFACES.length);
    const consoleSurfaces = Object.entries(measured).filter(([name]) => name.startsWith("Console"));
    expect(consoleSurfaces).toHaveLength(7);
    for (const [name, count] of consoleSurfaces) expect(count, name).toBeGreaterThan(0);
    const total = Object.values(measured).reduce((sum, count) => sum + count, 0);
    expect(total).toBeGreaterThan(150);
  });

  test("the rule has teeth: a palette step in a surface is caught", () => {
    expect(surfaceFindings("probe", '<div class="bg-(--gray-200)">probe</div>')).toEqual([
      "probe: --gray-200 is a primitive palette step",
    ]);
    expect(surfaceFindings("probe", '<div class="bg-(--surface-page)">probe</div>')).toEqual([]);
    const themeFixed = NAMES.semantic.filter((name) => isColour(DARK[name]) && DARK[name] === LIGHT[name]);
    expect(themeFixed.sort()).toEqual(Object.keys(THEME_FIXED).sort());
  });

  test("the colour probe catches what the token probe could not see", () => {
    expect(surfaceFindings("probe", '<div class="text-neutral-400">probe</div>')).toEqual([
      "probe: text-neutral-400 is a Tailwind palette utility",
      "probe: rendered no token reference",
    ]);
    expect(surfaceFindings("probe", '<div class="bg-(--surface-card) bg-black">probe</div>')).toEqual([
      "probe: bg-black is a Tailwind palette utility",
    ]);
    expect(
      surfaceFindings("probe", '<div class="text-(--text-primary)" style="color:#9ca3af">probe</div>'),
    ).toEqual(["probe: #9ca3af is a raw colour, not a token"]);
    expect(surfaceFindings("probe", '<div class="border-(--tone-neutral-border) bg-transparent">probe</div>')).toEqual(
      [],
    );
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
