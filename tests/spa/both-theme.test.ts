/**
 * Both-theme acceptance pass (dashboard surface pass, 2026-11-01; the console
 * joined it the same day).
 *
 * Every customer-facing surface of the compass `## Surface census` — and now
 * the operator console's four screens plus its shell — is rendered under
 * `data-theme="light"` and the token vocabulary its markup carries is checked
 * against the token source. Each finding below is a way a surface ends up
 * working only in dark:
 *
 * 1. A colour the page names instead of the token layer: a **primitive** palette
 *    step (`bg-(--gray-200)`), a raw hex (`#9ca3af`), or a Tailwind palette
 *    utility (`text-neutral-400`, `bg-black`). It paints, but it cannot invert,
 *    and it is not the page's layer to name.
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
 *
 * The colour probe reads rendered `class` and `style` values only. A colour that
 * reaches the paint any other way — a rule in a stylesheet, an SVG presentation
 * attribute, a class name composed at runtime — is invisible to it; the
 * stylesheet forms belong to `tests/design-system/boundary.test.ts`, which names
 * its own limits. Nothing here claims to see them.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { act, createElement, type ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { SidebarProvider } from "@design-system";
import { App as AdminApp } from "../../src/spa/admin/main";
import { FlagsPage as AdminFlagsPage } from "../../src/spa/admin/FlagsPage";
import { SupportGrantsPage as AdminSupportGrantsPage } from "../../src/spa/admin/SupportGrantsPage";
import { UsersPage as AdminUsersPage } from "../../src/spa/admin/UsersPage";
import { WorkspacesPage as AdminWorkspacesPage } from "../../src/spa/admin/WorkspacesPage";
import type { SpaBoot } from "../../src/spa/boot";
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
 * `chart-5` left this set when dark was lifted to clear the 3:1 non-text bar
 * on the dark raised planes (`I-000232`): it is now the one fill that does
 * invert, deliberately.
 */
const THEME_FIXED: Readonly<Record<string, true>> = {
  "chart-2": true,
  "chart-3": true,
  "chart-4": true,
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

/**
 * A colour painted without naming a token, in the two spellings that carry no
 * token reference at all: a hex literal, and a Tailwind palette utility. Both
 * are the dark-only face this pass exists to catch, and neither closes a paren
 * group — which is exactly why the token probe alone passed them. The family
 * list is shared with the StatusBadge face guard (`tests/helpers`), so the two
 * cannot drift into covering different halves of Tailwind's palette.
 */
const RAW_HEX = /#[0-9a-f]{3,8}\b/gi;
const PALETTE_UTILITY = new RegExp(PALETTE_UTILITY_SOURCE, "g");
/** The rendered attribute values a colour can be painted in. */
const RENDERED_ATTRIBUTE = /\b(?:class|style)="([^"]*)"/g;

const isColour = (value: string | undefined): boolean => value !== undefined && /^#[0-9a-f]{3,8}$/i.test(value);

/** Token references measured per surface — the coverage count behind the verdict. */
const measured: Record<string, number> = {};

/**
 * The light root every static surface is rendered inside — the attribute the
 * pre-paint bootstrap writes; the mounted faces set it on the document element.
 */
const renderLight = (element: Parameters<typeof renderToStaticMarkup>[0]): string =>
  `<div data-theme="light">${renderToStaticMarkup(element)}</div>`;

/**
 * Mount a page whose contract lives in its effect, under the light attribute.
 *
 * `surface` is the console document's second root attribute (D15): the admin
 * document carries both, so the pass renders those screens exactly as the
 * server ships them. `boot` is the injected `window.__BOOT__` the console entry
 * reads its locale and login from.
 */
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
      // `readBoot()` reads `window.__BOOT__`; installDom has just made the
      // happy-dom window the global, so this is the Worker's injection channel.
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

/** The colours one surface paints without naming a token — finding 1, raw form. */
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

/** Everything one surface's markup says about the token contract. */
function surfaceFindings(surface: string, markup: string): string[] {
  const findings = rawColourFindings(surface, markup);
  const names = [...new Set([...markup.matchAll(TOKEN_REF)].map((match) => match[1] as string))].sort();
  measured[surface] = names.length;
  // A probe that matched nothing is not a pass: every surface names tokens.
  if (names.length === 0) {
    findings.push(`${surface}: rendered no token reference`);
    return findings;
  }

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

/** The console's four reads, answered from one stub by path. */
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

/** The console's read stub: one payload per endpoint the console calls. */
const adminApi = (url: string): unknown => {
  if (url.includes("/workspaces")) return { workspaces: ADMIN_WORKSPACES };
  if (url.includes("/users")) return { users: ADMIN_USERS };
  if (url.includes("/support-grants")) return { grants: ADMIN_GRANTS };
  return { flags: ADMIN_FLAGS };
};

/**
 * Mount one console screen exactly as the server ships it: the stored-light
 * root plus D15's `data-surface="ops"`, with the console's reads answered from
 * `adminApi`. The ops attribute is part of the measurement, not a convenience —
 * the console's real document carries it, and a token that only works because
 * the variant is absent would not be caught here.
 */
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
  // The 2026-11-01 census: the console's four screens plus the shell they mount in.
  // Each marker is a loaded-face string, so a screen that fell back to its
  // skeleton or error branch cannot pass the marker assertion.
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
];

describe("both-theme acceptance pass", () => {
  test("the pass enumerates the eight customer faces and the console's five", () => {
    expect(SURFACES.map((surface) => surface.name)).toEqual([
      "Apps list",
      "App detail — settings",
      "App detail — insights",
      "Members",
      "Workspace settings",
      "Workspace setup",
      "Support",
      "Login",
      "Console — shell",
      "Console — flags",
      "Console — workspaces",
      "Console — users",
      "Console — support access",
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
    // The verdict names what it compared: 13 surfaces, this many references.
    expect(Object.keys(measured)).toHaveLength(SURFACES.length);
    // The console's five are part of the verdict, not appended to it: each one
    // rendered a token vocabulary of its own.
    const consoleSurfaces = Object.entries(measured).filter(([name]) => name.startsWith("Console"));
    expect(consoleSurfaces).toHaveLength(5);
    for (const [name, count] of consoleSurfaces) expect(count, name).toBeGreaterThan(0);
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

  test("the colour probe catches what the token probe could not see", () => {
    // Each seeded surface below named no token at all, so it produced an empty
    // finding list: that is the hole this probe closes. A palette utility and a
    // hex literal are the two spellings a dark-only face actually takes.
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
    // The token spellings stay legal: a token reference is not a palette
    // utility, even where the two names collide (`neutral` is a tone family).
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
