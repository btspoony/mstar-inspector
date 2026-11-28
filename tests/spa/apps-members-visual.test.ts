import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { appAvatarUrl } from "../../src/contracts/app-avatar";
import { isDictionaryKey, t } from "../../src/i18n";
import { MetricBand } from "../../src/spa/components/MetricBand";
import { AppsList, AppsPage, AppsView } from "../../src/spa/pages/AppsPage";
import { MembersPage } from "../../src/spa/pages/MembersPage";
import { reviewEnabled, type AppsPayload } from "../../src/spa/pages/data";
import { matchSpaRoute } from "../../src/spa/routes";
import { slotTags } from "../helpers/token-colour";
import { withLocation } from "./browser-stub";
import { installDom } from "./dom";

const appRow = (overrides: Partial<AppsPayload["apps"][number]> = {}): AppsPayload["apps"][number] => ({
  github_slug: "demo",
  github_name: null,
  github_avatar_url: null,
  github_app_id: 1,
  status: "active",
  review_enabled: 1,
  created_by: "mallory",
  health: { latest: null, rejected24h: 0 },
  ...overrides,
});

const spaRoot = join(import.meta.dir, "../../src/spa");

const PAGE_FACE_SOURCES = {
  AppsPage: readFileSync(join(spaRoot, "pages/AppsPage.tsx"), "utf8"),
  MembersPage: readFileSync(join(spaRoot, "pages/MembersPage.tsx"), "utf8"),
};

const decoded = (html: string): string => html.replaceAll("&amp;", "&").replaceAll("&quot;", '"');

const renderAppsPage = (): string =>
  decoded(
    withLocation("/dashboard/acme/apps", () =>
      renderToStaticMarkup(
        createElement(AppsView, {
          locale: "en",
          state: "ok",
          payload: { viewer: { login: "mallory", role: "admin" }, apps: [appRow({ installed: true })] },
          canCreate: true,
          unavailableReason: "",
          onRetry: () => {},
        }),
      ),
    ),
  );

const renderList = (apps: AppsPayload["apps"], pathname = "/dashboard/apps"): string =>
  decoded(
    withLocation(pathname, () =>
      renderToStaticMarkup(
        createElement(AppsList, {
          locale: "en",
          payload: { viewer: { login: "mallory", role: "admin" }, apps },
        }),
      ),
    ),
  );

let membersPageHtml: Promise<string> | null = null;
const membersPage = (): Promise<string> => (membersPageHtml ??= mountMembersPage());

const classAttrs = (html: string, tag: "th" | "td"): string[] =>
  [...html.matchAll(new RegExp(`<${tag} [^>]*class="([^"]*)"`, "g"))].map((match) => match[1] ?? "");

const MEMBERS_PAGE_PAYLOAD = {
  viewer: { role: "owner" },
  members: [{ id: "m1", github_login: "mallory", role: "owner", created_at: "2026-01-01T00:00:00Z" }],
  invites: [
    {
      id: "i1",
      github_login: "hubot",
      role: "member",
      created_at: "2026-01-01T00:00:00Z",
      expires_at: "2026-01-08T00:00:00Z",
    },
  ],
  workspace: {
    plan: { id: "free", name: "Free" },
    memberLimit: 5,
    reviewAttemptsThisMonth: 2,
    pendingInvites: 1,
  },
};

async function mountMembersPage(
  payload: typeof MEMBERS_PAGE_PAYLOAD = MEMBERS_PAGE_PAYLOAD,
): Promise<string> {
  const { win, cleanup } = installDom("http://localhost/dashboard/acme");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) =>
    new Response(
      JSON.stringify(
        String(input).endsWith("/invites")
          ? { invites: payload.invites }
          : {
              viewer: payload.viewer,
              members: payload.members,
              workspace: payload.workspace,
            },
      ),
      { status: 200, headers: { "Content-Type": "application/json" } },
    )) as unknown as typeof fetch;
  try {
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    await act(async () => {
      root.render(createElement(MembersPage, { boot: { locale: "en", login: "mallory", name: null } }));
    });
    const html = container.innerHTML;
    await act(async () => root.unmount());
    return html;
  } finally {
    globalThis.fetch = realFetch;
    cleanup();
  }
}

function expectFullPageRegions(name: string, html: string): void {
  if (name === "AppsPage") {
    for (const marker of [
      t("en", "apps.heading"),
      t("en", "apps.create"),
      t("en", "apps.tableName"),
    ]) {
      expect(html, `${name} ${marker}`).toContain(marker);
    }
    return;
  }
  for (const marker of [
    t("en", "members.heading"),
    t("en", "members.workspaceHeading"),
    t("en", "members.inviteButton"),
    t("en", "members.tableLogin"),
    t("en", "members.pendingHeading"),
    t("en", "members.deleteWorkspace"),
  ]) {
    expect(html, `${name} ${marker}`).toContain(marker);
  }
}

describe("AppsPage table reinforcement (AD-581)", () => {
  test("identity cell is the brand surface: display-name primary line + AppID meta line", () => {
    const cells = [...renderList([appRow()]).matchAll(/<td [^>]*>([\s\S]*?)<\/td>/g)];
    const identity = cells[0]?.[1] ?? "";
    expect(identity).toContain('href="/dashboard/apps/1"');
    expect(identity).toContain(">demo</a>");
    expect(identity).toContain("tabular-nums");
    expect(identity).toContain(t("en", "apps.appId", { id: 1 }));
    expect(identity).toContain(`<img src="${appAvatarUrl(1)}"`);
  });

  test("identity cell avatar: github_avatar_url renders a rounded img; the name falls back github_name → slug → App id", () => {
    const withAvatar = renderList([
      appRow({ github_avatar_url: appAvatarUrl(1234), github_name: "Demo" }),
    ]);
    expect(withAvatar).toContain(`<img src="${appAvatarUrl(1234)}" alt=""`);
    expect(withAvatar).toMatch(/<img [^>]*class="[^"]*h-9 w-9[^"]*rounded-full[^"]*object-cover[^"]*"/);
    expect(withAvatar).toContain(">Demo</a>");
    expect(withAvatar).toContain('aria-label="Open Demo detail"');
    const bySlug = renderList([appRow({ github_slug: "demo" })]);
    expect(bySlug).toContain(">demo</a>");
    const byId = renderList([appRow({ github_slug: null })]);
    expect(byId).toContain(">1</a>");
  });

  test("the row is the whole destination, and there is no separate detail column", () => {
    const hrefs = (pathname: string) =>
      [...renderList([appRow()], pathname).matchAll(/<a [^>]*href="([^"]+)"/g)].map((match) => match[1]);
    expect(hrefs("/dashboard/apps")).toEqual(["/dashboard/apps/1"]);
    expect(hrefs("/dashboard/acme/apps")).toEqual(["/dashboard/acme/apps/1"]);
    const scoped = renderList([appRow()], "/dashboard/acme/apps");
    expect(scoped).not.toContain("/settings");
    expect(scoped).toContain("cursor-pointer");
    const headers = [...scoped.matchAll(/<th [^>]*>([\s\S]*?)<\/th>/g)].map((cell) =>
      (cell[1] ?? "").trim(),
    );
    expect(headers).toEqual([
      t("en", "apps.tableName"),
      t("en", "apps.tableStatus"),
      t("en", "apps.tableHealth"),
      t("en", "apps.tableCreator"),
    ]);
  });

  test("the status pill carries the semantic tone through its data-tone attribute", () => {
    const pillTone = (overrides: Partial<AppsPayload["apps"][number]>, label: string) =>
      renderList([appRow(overrides)]).match(
        new RegExp(
          `<span [^>]*data-tone="([a-z]+)"[^>]*>${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</span>`,
        ),
      )?.[1] ?? "";
    for (const [overrides, label, tone] of [
      [{ status: "active", review_enabled: 1 }, t("en", "apps.status.active"), "success"],
      [{ status: "active", review_enabled: 0 }, t("en", "apps.status.paused"), "warn"],
      [{ status: "disabled", review_enabled: 1 }, t("en", "apps.status.disabled"), "warn"],
    ] as const) {
      expect(pillTone(overrides, label), label).toBe(tone);
    }
    const emitted = [...renderList([appRow()]).matchAll(/class="([^"]*)"/g)]
      .map((match) => match[1] ?? "")
      .filter((classes) => !classes.includes("object-cover"))
      .join(" ");
    expect(emitted).not.toContain("rounded-full");
    const withAvatar = renderList([appRow({ github_avatar_url: "https://x.test/a.png" })]);
    expect(withAvatar.replace(/<img[^>]*>/g, "")).not.toContain("rounded-full");
    expect(withAvatar).toMatch(/<img [^>]*class="[^"]*rounded-full[^"]*object-cover[^"]*"/);
    expect(emitted).not.toMatch(/\bh-5\b/);
  });

  test("the header row is the band; the data row carries the page's clickable face", () => {
    const html = renderList([appRow()]);
    const [headerRow = "", dataRow = ""] = [
      ...html.matchAll(/<tr [^>]*class="([^"]*)"[^>]*>/g),
    ].map((match) => match[1] ?? "");
    expect(headerRow).toBeDefined();
    expect(dataRow).toContain("cursor-pointer");
    expect(html.indexOf("<thead")).toBeLessThan(html.indexOf("<tbody"));
  });

  test("the health cell keeps the shared outcome map and gains tabular figures", () => {
    const withDelivery = renderList([
      appRow({
        health: {
          latest: {
            event_name: "push",
            outcome: "rejected",
            status_code: 200,
            created_at: "2026-01-01T00:00:00Z",
          },
          rejected24h: 2,
        },
      }),
    ]);
    expect(withDelivery).toContain(t("en", "apps.health.outcome.rejected"));
    // The ADR bans a 24h rejection figure on every list.
    expect(withDelivery).not.toContain("24h");
    expect(withDelivery).toContain("tabular-nums");
    expect(renderList([appRow()])).toContain(t("en", "apps.health.deliveryNever"));
  });
});

describe("v0.3 page face (A4/A5)", () => {
  test("each page title is ONE heading-24 h1 — the PageHeader face, never re-spelled", () => {
    const apps = renderAppsPage();
    const members = decoded(
      withLocation("/dashboard/acme", () =>
        renderToStaticMarkup(
          createElement(MembersPage, { boot: { locale: "en", login: "mallory", name: null } }),
        ),
      ),
    );
    for (const [name, html, heading] of [
      ["AppsPage", apps, t("en", "apps.heading")],
      ["MembersPage", members, t("en", "members.heading")],
    ] as const) {
      expect(html.match(/<h1/g), name).toHaveLength(1);
      expect(html, name).toContain('<h1 data-slot="page-header-title"');
      expect(html, name).toContain(`>${heading}</h1>`);
      expect(PAGE_FACE_SOURCES[name], name).not.toContain("--typo-heading-24");
    }
  });

  test("table header face: a semantic band + label-12 headers (DESIGN.md Table)", async () => {
    for (const [name, html] of [
      ["AppsPage", renderAppsPage()],
      ["MembersPage", decoded(await membersPage())],
    ] as const) {
      const thead = html.match(/<thead[^>]*class="([^"]*)"/)?.[1] ?? "";
      expect(thead, name).not.toMatch(/--(?:background|gray|gray-alpha|brand|blue|red|amber|green|purple)-/);
      expect(html.match(/<thead/g), name).toHaveLength(1);
      const headers = classAttrs(html, "th");
      expect(headers.length, name).toBeGreaterThan(0);
      for (const cell of html.matchAll(/<th[^>]*>([\s\S]*?)<\/th>/g)) {
        expect(cell[1]?.trim(), name).not.toBe("");
      }
      expect(PAGE_FACE_SOURCES[name], name).not.toContain("--surface-raised");
      expect(PAGE_FACE_SOURCES[name], name).not.toContain("--background-200");
      expect(PAGE_FACE_SOURCES[name], name).not.toContain("--typo-label-12-tracking");
    }
  });

  test("the page modules and their rendered full pages emit no raw color literal", async () => {
    for (const [name, source] of Object.entries(PAGE_FACE_SOURCES)) {
      expect(source, name).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
    for (const [name, html] of [
      ["AppsPage", renderAppsPage()],
      ["MembersPage", decoded(await mountMembersPage())],
    ] as const) {
      expectFullPageRegions(name, html);
      expect(html, name).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(html, name).not.toContain("rgb(");
    }
  });
});

describe("table horizontal padding (D5/A3)", () => {
  test("head and cell ride the spacing-3 horizontal step (12px); vertical untouched", async () => {
    for (const [name, html] of [
      ["AppsPage", renderList([appRow()])],
      ["MembersPage", decoded(await membersPage())],
    ] as const) {
      const heads = classAttrs(html, "th");
      const cells = classAttrs(html, "td");
      expect(heads.length, name).toBeGreaterThan(0);
      expect(cells.length, name).toBeGreaterThan(0);
      expect(html.indexOf("<thead"), name).toBeLessThan(html.indexOf("<tbody"));
      for (const head of heads) expect(head.split(/\s+/), name).toContain("h-full");
      for (const cell of cells) {
        expect(cell.split(/\s+/), name).toContain("px-3");
        expect(cell.split(/\s+/), name).toContain("py-2");
      }
      for (const head of heads) expect(head.split(/\s+/), name).toContain("px-3");
    }
  });

  test("the 8px horizontal step is retired from every emitted head/cell class", async () => {
    for (const html of [renderList([appRow()]), decoded(await membersPage())]) {
      for (const attr of [...classAttrs(html, "th"), ...classAttrs(html, "td")]) {
        const tokens = attr.split(/\s+/);
        expect(tokens).not.toContain("px-2");
        expect(tokens).not.toContain("p-2");
      }
    }
  });

  test("checkbox flush-right exception survives the padding raise", async () => {
    for (const html of [renderList([appRow()]), decoded(await membersPage())]) {
      expect(classAttrs(html, "th").every((attr) => attr.includes("[&:has([role=checkbox])]:pr-0"))).toBe(
        true,
      );
      expect(classAttrs(html, "td").every((attr) => attr.includes("[&:has([role=checkbox])]:pr-0"))).toBe(
        true,
      );
    }
  });
});

describe("empty-state copy (A6)", () => {
  test("guidance keys exist atomically in both locales", () => {
    for (const key of [
      "apps.emptyTitle",
      "apps.emptyDescription",
      "members.emptyTitle",
      "members.emptyDescription",
    ] as const) {
      const en = t("en", key);
      const zh = t("zh_CN", key);
      expect(en.length, key).toBeGreaterThan(0);
      expect(zh.length, key).toBeGreaterThan(0);
      expect(zh, key).not.toBe(en);
      expect(en, key).not.toContain("{");
      expect(zh, key).not.toContain("{");
    }
  });

  test("the retired single-line keys are gone from the rendered faces and dictionary", () => {
    const apps = renderToStaticMarkup(
      createElement(AppsView, {
        locale: "en",
        state: "ok",
        payload: { viewer: { login: "mallory", role: "member" }, apps: [] },
        canCreate: true,
        unavailableReason: "",
        onRetry: () => {},
      }),
    );
    expect(apps).toContain(t("en", "apps.installed.emptyTitle"));
    expect(apps).not.toMatch(/apps\.empty\b/);
    expect(isDictionaryKey("apps.empty")).toBe(false);
    expect(isDictionaryKey("members.empty")).toBe(false);
  });

  test("the empty member list renders the guidance, never the retired key", async () => {
    const { win, cleanup } = installDom("http://localhost/dashboard/acme");
    const realFetch = globalThis.fetch;
    globalThis.fetch = (async (input: unknown) =>
      new Response(
        JSON.stringify(
          String(input).endsWith("/invites")
            ? { invites: [] }
            : {
                viewer: { role: "owner" },
                members: [],
                workspace: {
                  plan: { id: "free", name: "Free" },
                  memberLimit: 5,
                  reviewAttemptsThisMonth: 2,
                  pendingInvites: 0,
                },
              },
        ),
        { status: 200, headers: { "Content-Type": "application/json" } },
      )) as unknown as typeof fetch;
    try {
      const container = win.document.createElement("div");
      win.document.body.appendChild(container);
      const root = createRoot(container as unknown as Element);
      await act(async () => {
        root.render(
          createElement(MembersPage, { boot: { locale: "en", login: "mallory", name: null } }),
        );
      });
      const html = container.innerHTML;
      expect(html).toContain(t("en", "members.emptyTitle"));
      expect(html).toContain(t("en", "members.emptyDescription"));
      expect(html.match(/data-slot="empty-state"/g)).toHaveLength(1);
      expect(html).not.toMatch(/members\.empty\b/);
      await act(async () => root.unmount());
    } finally {
      globalThis.fetch = realFetch;
      cleanup();
    }
  });
});

describe("Create action is a boot capability (I-000082)", () => {
  const APPS = [
    {
      github_slug: "demo",
      github_name: null,
      github_avatar_url: null,
      github_app_id: 1,
      status: "active" as const,
      review_enabled: 1,
      created_by: "mallory",
      health: { latest: null, rejected24h: 0 },
    },
  ];

  function renderFace(canCreate: boolean, apps: number, unavailableReason = "role"): string {
    return renderToStaticMarkup(
      createElement(AppsView, {
        locale: "en",
        state: "ok",
        payload: { viewer: { login: "mallory", role: "member" }, apps: APPS.slice(0, apps) },
        canCreate,
        unavailableReason,
        onRetry: () => {},
      }),
    );
  }

  test("a manager sees the Create control in the header and, when empty, in the guidance", () => {
    expect(renderFace(true, 1)).toContain('data-slot="create-app-chooser"');
    const empty = renderFace(true, 0);
    expect(empty).toContain('data-slot="create-app-chooser"');
    expect(empty.match(/data-slot="create-app-chooser"/g)?.length).toBe(1);
  });

  test("a caller who cannot create sees the control DISABLED with the reason, never a silent gap", () => {
    for (const apps of [0, 1]) {
      const html = renderFace(false, apps, t("en", "apps.createUnavailable.role"));
      expect(html, `apps=${apps}`).toContain(t("en", "apps.create"));
      expect(html, `apps=${apps}`).toMatch(/<button[^>]*disabled/);
      expect(html, `apps=${apps}`).toContain(t("en", "apps.createUnavailable.role"));
      expect(html, `apps=${apps}`).toContain(t("en", "apps.heading"));
    }
    expect(renderFace(false, 0)).toContain(t("en", "apps.installed.emptyTitle"));
  });
});

describe("Apps list → App detail wayfinding (rendered)", () => {
  const ROW = {
    github_slug: "demo",
    github_name: null,
    github_avatar_url: null,
    github_app_id: 1,
    status: "active" as const,
    review_enabled: 1,
    created_by: "mallory",
    health: { latest: null, rejected24h: 0 },
  };
  const PAYLOAD = { viewer: { login: "mallory", role: "admin" as const }, apps: [ROW] };

  function renderList(pathname: string): string {
    return withLocation(pathname, () =>
      renderToStaticMarkup(createElement(AppsList, { locale: "en", payload: PAYLOAD })),
    );
  }

  function destinations(pathname: string): Array<[string, string | undefined]> {
    return [...renderList(pathname).matchAll(/<a [^>]*href="([^"]+)"/g)].map(([, href]) => {
      const route = matchSpaRoute(href ?? "");
      return [href ?? "", route?.page];
    });
  }

  test("each row links to the App detail route the matcher owns, under the page's own base", () => {
    expect(destinations("/dashboard/apps")).toEqual([["/dashboard/apps/1", "app-detail"]]);
    expect(destinations("/dashboard/acme/apps")).toEqual([["/dashboard/acme/apps/1", "app-detail"]]);
  });

  test("the row anchor names its destination for assistive tech, never Settings", () => {
    const html = renderList("/dashboard/acme/apps");
    expect(html).toContain(`aria-label="${t("en", "apps.openAria", { name: "demo" })}"`);
    expect(t("en", "apps.openAria", { name: "demo" })).toBe("Open demo detail");
    expect(t("zh_CN", "apps.openAria", { name: "demo" })).toBe("打开 demo 详情");
  });

  test("the empty Apps face keeps one Create control — creation is the only path", () => {
    const renderFace = (apps: number): string =>
      renderToStaticMarkup(
        createElement(AppsView, {
          locale: "en",
          state: "ok",
          payload: { ...PAYLOAD, apps: PAYLOAD.apps.slice(0, apps) },
          canCreate: true,
          unavailableReason: "",
          onRetry: () => {},
        }),
      );
    for (const apps of [0, 1]) {
      const html = renderFace(apps);
      expect(html.match(/data-slot="create-app-chooser"/g)?.length, `apps=${apps}`).toBe(1);
      expect(html, `apps=${apps}`).toContain(t("en", "apps.create"));
    }
    expect(renderFace(0)).toContain(t("en", "apps.installed.emptyTitle"));
    expect(renderFace(0)).toContain(t("en", "apps.installed.emptyDescription"));
  });

  test("the Apps list loading face is the shared table skeleton", () => {
    const html = withLocation("/dashboard/acme/apps", () =>
      renderToStaticMarkup(
        createElement(AppsPage, { boot: { locale: "en", login: "mallory", name: "Mallory" } }),
      ),
    );
    expect(html).toContain('data-slot="skeleton-table"');
    expect(html).not.toContain('data-slot="skeleton-cards"');
    expect(html).not.toContain('data-slot="skeleton-forms"');
  });

  test("load failure renders the composed error with the retry affordance", () => {
    const html = renderToStaticMarkup(
      createElement(AppsView, {
        locale: "en",
        state: "error",
        payload: null,
        canCreate: true,
        unavailableReason: "",
        onRetry: () => {},
      }),
    );
    expect(html).toContain('role="alert"');
    expect(html).toContain(t("en", "common.loadFailed"));
    expect(html).toContain(t("en", "common.retry"));
  });
});

describe("Apps list metric band (payload-proved facts only)", () => {
  const APPS = [
    appRow({
      github_app_id: 1,
      status: "active",
      review_enabled: 1,
      health: { latest: null, rejected24h: 2 },
    }),
    appRow({
      github_app_id: 2,
      status: "active",
      review_enabled: 0,
      health: { latest: null, rejected24h: 0 },
    }),
    appRow({
      github_app_id: 3,
      status: "disabled",
      review_enabled: 0,
      health: { latest: null, rejected24h: 1 },
    }),
  ];

  function renderFace(apps: AppsPayload["apps"], state: "ok" | "error" = "ok"): string {
    return decoded(
      withLocation("/dashboard/acme/apps", () =>
        renderToStaticMarkup(
          createElement(AppsView, {
            locale: "en",
            state,
            payload:
              state === "ok" ? { viewer: { login: "mallory", role: "admin" }, apps } : null,
            canCreate: true,
            unavailableReason: "",
            onRetry: () => {},
          }),
        ),
      ),
    );
  }

  const METRIC_CELL =
    /data-slot="metric-key"[^>]*>([^<]*)<\/span><span data-slot="metric-value"[^>]*>([^<]*)</g;

  test("three metric keys, each an AppsPayload fact — no 24h rejection figure", () => {
    const html = renderFace(APPS);
    const reviewOff = APPS.filter((app) => !reviewEnabled(app)).length;
    expect([...html.matchAll(METRIC_CELL)].map((cell) => [cell[1] ?? "", cell[2] ?? ""])).toEqual([
      [t("en", "apps.metricApps"), "3"],
      [t("en", "apps.metricEnabled"), "2"],
      [t("en", "apps.metricReviewOff"), String(reviewOff)],
    ]);
    expect(html).toContain(`>${t("en", "apps.headingDescription")}</p>`);
  });

  test("the empty list keeps its guidance and reports three honest zeroes", () => {
    const empty = renderFace([]);
    expect(empty).toContain(t("en", "apps.installed.emptyTitle"));
    expect([...empty.matchAll(METRIC_CELL)].map((cell) => [cell[1] ?? "", cell[2] ?? ""])).toEqual([
      [t("en", "apps.metricApps"), "0"],
      [t("en", "apps.metricEnabled"), "0"],
      [t("en", "apps.metricReviewOff"), "0"],
    ]);
  });

  test("the error face has no facts to band and keeps its existing copy", () => {
    const failed = renderFace([], "error");
    expect(failed).not.toContain('data-slot="metric-band"');
    expect(failed).toContain(t("en", "common.loadFailed"));
  });

  test("the row columns stay the five payload-proved facts", () => {
    const headers = [...renderList(APPS).matchAll(/<th [^>]*>([\s\S]*?)<\/th>/g)].map((cell) =>
      (cell[1] ?? "").trim(),
    );
    expect(headers).toEqual([
      t("en", "apps.tableName"),
      t("en", "apps.tableStatus"),
      t("en", "apps.tableHealth"),
      t("en", "apps.tableCreator"),
    ]);
  });

  test("the band renders cell-for-cell the tone-free triple — no metric wears the alert face", () => {
    const control = decoded(
      renderToStaticMarkup(
        createElement(MetricBand, {
          metrics: [
            { key: t("en", "apps.metricApps"), value: APPS.length },
            {
              key: t("en", "apps.metricEnabled"),
              value: APPS.filter((app) => app.status !== "disabled").length,
            },
            { key: t("en", "apps.metricReviewOff"), value: APPS.filter((app) => !reviewEnabled(app)).length },
          ],
        }),
      ),
    );
    expect(slotTags(renderFace(APPS), "metric-value")).toEqual(slotTags(control, "metric-value"));
    expect(slotTags(renderFace(APPS), "metric-key")).toEqual(slotTags(control, "metric-key"));
  });
});
