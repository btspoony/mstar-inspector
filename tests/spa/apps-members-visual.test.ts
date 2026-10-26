/**
 * Apps + Members visual-discipline pins (A4/A5, AD-581
 * table-reinforced form). Rendered contract — the page faces are asserted on
 * the markup the components emit, never on their source text.
 *
 * 1. AD-581: the Apps list stays a semantic table — the identity cell is
 *    the brand surface (slug primary line + AppID meta line; the list
 *    payload carries no GitHub profile fields, so there is no avatar),
 *    the whole-row click and the visible settings anchor keep their
 *    channels, and StatusBadge rides the v0.3 pill component tokens
 *    (--badge-*) with the semantic tones preserved.
 * 2. v0.3 face: page titles on the heading-24 token step, the DESIGN.md
 *    Table header (background-200 band + label-12 headers), zero raw hex.
 * 3. A6: the new empty-state guidance keys exist atomically in both
 *    locales.
 *
 * Everything here is observed on rendered markup; the suites that own a
 * primitive's own face (PageHeader / DataTable / StatusBadge) pin it there.
 */
import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { isDictionaryKey, t } from "../../src/i18n";
import { AppsList, AppsPage, AppsView } from "../../src/spa/pages/AppsPage";
import { MembersPage, MembersTable } from "../../src/spa/pages/MembersPage";
import type { AppsPayload } from "../../src/spa/pages/data";
import { matchSpaRoute } from "../../src/spa/routes";
import { withLocation } from "./browser-stub";
import { installDom } from "./dom";

const appRow = (overrides: Partial<AppsPayload["apps"][number]> = {}): AppsPayload["apps"][number] => ({
  slug: "demo",
  github_app_id: 1,
  status: "active",
  review_enabled: 1,
  created_by: "mallory",
  health: { latest: null, rejected24h: 0 },
  ...overrides,
});

/** Markup with HTML entities decoded, so class-attribute text is searchable. */
const decoded = (html: string): string => html.replaceAll("&amp;", "&").replaceAll("&quot;", '"');

/** The Apps list table rendered from the real row component, under its own base. */
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

/** The Members table with the page's own loaded state supplied. */
const renderMembers = (): string =>
  decoded(
    withLocation("/dashboard/acme", () =>
      renderToStaticMarkup(
        createElement(MembersTable, {
          locale: "en",
          members: [
            { id: "m1", github_login: "mallory", role: "owner", created_at: "2026-01-01T00:00:00Z" },
          ],
          viewerLogin: "mallory",
          memberRole: "owner",
          canInvite: true,
          onAction: () => {},
        }),
      ),
    ),
  );

/** Class lists of every `th` / `td` the markup emits. */
const classAttrs = (html: string, tag: "th" | "td"): string[] =>
  [...html.matchAll(new RegExp(`<${tag} [^>]*class="([^"]*)"`, "g"))].map((match) => match[1] ?? "");

describe("AppsPage table reinforcement (AD-581)", () => {
  test("identity cell is the brand surface: slug primary line + AppID meta line", () => {
    // The identity cell is the row's brand surface: a slug primary line and
    // the AppID meta line under it — read off the emitted cell, not the page.
    const cells = [...renderList([appRow()]).matchAll(/<td [^>]*>([\s\S]*?)<\/td>/g)];
    const identity = cells[0]?.[1] ?? "";
    expect(identity).toContain(
      '<a class="text-sm font-semibold text-foreground no-underline hover:underline" href="/dashboard/apps/demo"',
    );
    expect(identity).toContain(">demo</a>");
    expect(identity).toContain('<span class="text-xs text-muted-foreground tabular-nums">');
    expect(identity).toContain(t("en", "apps.appId", { id: 1 }));
    // No avatar channel exists: the payload carries no GitHub profile field,
    // so the row's only image slot would have to come from somewhere else.
    expect(identity).not.toContain("<img");
  });

  test("whole-row click and the visible detail anchor keep their channels", () => {
    // Rendered from the real row component under the two ACTUAL pathnames: the
    // emitted links are the page's own base, so a wrong base, a legacy target
    // under a workspace page, or a /settings deep link fails here.
    const hrefs = (pathname: string) =>
      [...renderList([appRow()], pathname).matchAll(/href="([^"]+)"/g)].map((match) => match[1]);
    // Legacy Apps page: the historical detail path, identity link + anchor.
    expect(hrefs("/dashboard/apps")).toEqual(["/dashboard/apps/demo", "/dashboard/apps/demo"]);
    // Workspace Apps page: the workspace copy of the same route — the legacy
    // App family answers 404 under strict.
    expect(hrefs("/dashboard/acme/apps")).toEqual([
      "/dashboard/acme/apps/demo",
      "/dashboard/acme/apps/demo",
    ]);
    const scoped = renderList([appRow()], "/dashboard/acme/apps");
    expect(scoped).toContain('<a class="text-primary underline-offset-4 hover:underline"');
    expect(scoped).not.toContain("/settings");
    // Row action copy is detail semantics in both locales.
    expect(scoped).toContain(">Detail<");
    expect(t("en", "apps.detail")).toBe("Detail");
    expect(t("zh_CN", "apps.detail")).toBe("详情");
  });

  test("the status pill rides the v0.3 pill component tokens with semantic tones", () => {
    // Every pill the list emits, located by its rendered label.
    const pillClass = (overrides: Partial<AppsPayload["apps"][number]>, label: string) =>
      renderList([appRow(overrides)]).match(
        new RegExp(`<span class="([^"]*)">${label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}</span>`),
      )?.[1] ?? "";
    for (const [overrides, label, tone] of [
      [{ status: "active", review_enabled: 1 }, t("en", "apps.status.active"), "success"],
      [{ status: "active", review_enabled: 0 }, t("en", "apps.status.paused"), "warn"],
    ] as const) {
      const classes = pillClass(overrides, label);
      // Shape comes from the --badge-* component tokens (AD-574 pill exception).
      expect(classes, label).toContain("h-(--badge-height)");
      expect(classes, label).toContain("rounded-(--badge-radius)");
      // Tones stay on the semantic badge vars (constraint #5).
      expect(classes, label).toContain(`bg-(--badge-${tone}-bg)`);
      expect(classes, label).toContain(`text-(--badge-${tone}-fg)`);
    }
    // The emitted pill is the only geometry source: no hard-coded pill
    // survives anywhere in the row markup.
    const emitted = [...renderList([appRow()]).matchAll(/class="([^"]*)"/g)]
      .map((match) => match[1] ?? "")
      .join(" ");
    expect(emitted).not.toContain("rounded-full");
    expect(emitted).not.toMatch(/\bh-5\b/);
  });

  test("row hover is the restyled primitive's tinted surface; header row opts out", () => {
    // ui/table.tsx carries hover:bg-muted on data rows. The page adds only its
    // own clickable face through DataTable's rowProps; the header row opts out
    // of the tint (its own band is the surface).
    const html = renderList([appRow()]);
    const [headerRow = "", dataRow = ""] = [
      ...html.matchAll(/<tr [^>]*class="([^"]*)"[^>]*>/g),
    ].map((match) => match[1] ?? "");
    expect(dataRow).toContain("hover:bg-muted");
    expect(headerRow).toContain("hover:bg-inherit");
    expect(dataRow).toContain("cursor-pointer");
  });

  test("the health cell keeps the shared outcome map and gains tabular figures", () => {
    // A landed delivery: the localized outcome label and the 24h rejection
    // count ride the same muted, tabular cell.
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
    expect(withDelivery).toContain(t("en", "apps.health.rejected24h", { count: 2 }));
    expect(withDelivery).toContain('<span class="text-muted-foreground tabular-nums">');
    // No delivery: the never-delivered copy, still through the one map.
    expect(renderList([appRow()])).toContain(t("en", "apps.health.deliveryNever"));
  });
});

describe("v0.3 page face (A4/A5)", () => {
  test("each page title is ONE heading-24 h1 — the PageHeader face, never re-spelled", () => {
    // ONE spelling of the page-title face: exactly one element in the page
    // markup carries the heading-24 trio, and it is the h1. A page that
    // re-spelled the face lower down, or grew a second heading, fails here.
    const apps = decoded(
      renderToStaticMarkup(
        createElement(AppsView, {
          locale: "en",
          state: "ok",
          payload: { viewer: { login: "mallory", role: "member" }, apps: [appRow()] },
          canCreate: true,
          unavailableReason: "",
          onRetry: () => {},
        }),
      ),
    );
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
      expect(html.match(/--typo-heading-24-size/g), name).toHaveLength(1);
      expect(html.match(/<h1/g), name).toHaveLength(1);
      expect(html, name).toContain(
        `<h1 class="font-semibold text-(length:--typo-heading-24-size) leading-(--typo-heading-24-line) tracking-(--typo-heading-24-tracking)">${heading}</h1>`,
      );
    }
  });

  test("table header face: background-200 band + label-12 headers (DESIGN.md Table)", () => {
    // The shell + header face is DataTable's; each page composes it and keeps
    // no second header band of its own — one band, every header on label-12.
    for (const [name, html] of [
      ["AppsPage", renderList([appRow()])],
      ["MembersPage", renderMembers()],
    ] as const) {
      expect(html.match(/<thead[^>]*class="([^"]*)"/)?.[1], name).toContain("bg-(--background-200)");
      expect(html.match(/--background-200/g), name).toHaveLength(1);
      const headers = classAttrs(html, "th");
      expect(headers.length, name).toBeGreaterThan(0);
      for (const header of headers) {
        expect(header, name).toContain("text-xs tracking-(--typo-label-12-tracking)");
      }
    }
  });

  test("the rendered pages emit no raw color literal", () => {
    for (const [name, html] of [
      ["AppsPage", renderList([appRow()])],
      ["MembersPage", renderMembers()],
    ] as const) {
      expect(html, name).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
      expect(html, name).not.toContain("rgb(");
    }
  });
});

describe("table horizontal padding (D5/A3)", () => {
  test("head and cell ride the spacing-3 horizontal step (12px); vertical untouched", () => {
    // D5: one component-level raise benefits both Apps and Members tables —
    // asserted on the emitted th/td class lists of either table.
    for (const [name, html] of [
      ["AppsPage", renderList([appRow()])],
      ["MembersPage", renderMembers()],
    ] as const) {
      const heads = classAttrs(html, "th");
      const cells = classAttrs(html, "td");
      expect(heads.length, name).toBeGreaterThan(0);
      expect(cells.length, name).toBeGreaterThan(0);
      for (const head of heads) expect(head.split(/\s+/), name).toContain("h-10");
      for (const cell of cells) {
        expect(cell.split(/\s+/), name).toContain("px-3");
        expect(cell.split(/\s+/), name).toContain("py-2");
      }
      for (const head of heads) expect(head.split(/\s+/), name).toContain("px-3");
    }
  });

  test("the 8px horizontal step is retired from every emitted head/cell class", () => {
    // Token-exact check: a regen reverting the primitives to upstream
    // px-2/p-2 fails, while token variants (px-2.5, sm:px-2) are not the
    // retired step.
    for (const html of [renderList([appRow()]), renderMembers()]) {
      for (const attr of [...classAttrs(html, "th"), ...classAttrs(html, "td")]) {
        const tokens = attr.split(/\s+/);
        expect(tokens).not.toContain("px-2");
        expect(tokens).not.toContain("p-2");
      }
    }
  });

  test("checkbox flush-right exception survives the padding raise", () => {
    // The pr-0 escape hatch exists on both head and cell (shadcn convention),
    // which the emitted markup shows on either table.
    for (const html of [renderList([appRow()]), renderMembers()]) {
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
    // `t()` fails visible — it returns the key — so a page still asking for a
    // retired key would print it. Neither empty face may carry one.
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
    expect(apps).toContain(t("en", "apps.emptyTitle"));
    expect(apps).not.toMatch(/apps\.empty\b/);
    // The dictionary really dropped them.
    expect(isDictionaryKey("apps.empty")).toBe(false);
    expect(isDictionaryKey("members.empty")).toBe(false);
  });

  test("the empty member list renders the guidance, never the retired key", async () => {
    // Mounted because the page's own state machine owns the empty branch: the
    // loaded-ok face with zero members is what a real first paint shows.
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
      // The empty face offers no action slot: the invite form above is the path.
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
      slug: "demo",
      github_app_id: 1,
      status: "active" as const,
      review_enabled: 1,
      created_by: "mallory",
      health: { latest: null, rejected24h: 0 },
    },
  ];

  /** The loaded Apps face, rendered from the real component. */
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

  test("a manager sees the Create form in the header and, when empty, in the guidance", () => {
    // Header slot (a non-empty list) and the empty-state action are ONE form
    // component — never both at once.
    expect(renderFace(true, 1)).toContain('action="/dashboard/manifest/start"');
    const empty = renderFace(true, 0);
    expect(empty).toContain('action="/dashboard/manifest/start"');
    expect(empty.match(/action="\/dashboard\/manifest\/start"/g)?.length).toBe(1);
  });

  test("a caller who cannot create sees the control DISABLED with the reason, never a silent gap", () => {
    for (const apps of [0, 1]) {
      const html = renderFace(false, apps, t("en", "apps.createUnavailable.role"));
      expect(html, `apps=${apps}`).toContain(t("en", "apps.create"));
      expect(html, `apps=${apps}`).toMatch(/<button[^>]*disabled/);
      // The reason rides beside the control, so the page explains itself.
      expect(html, `apps=${apps}`).toContain(t("en", "apps.createUnavailable.role"));
      expect(html, `apps=${apps}`).toContain(t("en", "apps.heading"));
    }
    // The empty face still explains the state without offering a dead end.
    expect(renderFace(false, 0)).toContain(t("en", "apps.emptyTitle"));
  });
});

describe("Apps list → App detail wayfinding (rendered)", () => {
  const ROW = {
    slug: "demo",
    github_app_id: 1,
    status: "active" as const,
    review_enabled: 1,
    created_by: "mallory",
    health: { latest: null, rejected24h: 0 },
  };
  const PAYLOAD = { viewer: { login: "mallory", role: "admin" as const }, apps: [ROW] };

  /** The real row component under the page's actual pathname. */
  function renderList(pathname: string): string {
    return withLocation(pathname, () =>
      renderToStaticMarkup(createElement(AppsList, { locale: "en", payload: PAYLOAD })),
    );
  }

  /** Every href the list emits, with the route it resolves to. */
  function destinations(pathname: string): Array<[string, string | undefined]> {
    return [...renderList(pathname).matchAll(/href="([^"]+)"/g)].map(([, href]) => {
      const route = matchSpaRoute(href ?? "");
      return [href ?? "", route?.page];
    });
  }

  test("each row links to the App detail route the matcher owns, under the page's own base", () => {
    // What the link emits must resolve as an app-detail route, not a 404 stub.
    // The legacy mount keeps the historical path; the workspace page rides its
    // workspace prefix.
    expect(destinations("/dashboard/apps")).toEqual([
      ["/dashboard/apps/demo", "app-detail"],
      ["/dashboard/apps/demo", "app-detail"],
    ]);
    expect(destinations("/dashboard/acme/apps")).toEqual([
      ["/dashboard/acme/apps/demo", "app-detail"],
      ["/dashboard/acme/apps/demo", "app-detail"],
    ]);
  });

  test("the row anchor names its destination for assistive tech and says Detail, never Settings", () => {
    const html = renderList("/dashboard/acme/apps");
    expect(html).toContain(`aria-label="${t("en", "apps.openAria", { slug: "demo" })}"`);
    expect(t("en", "apps.openAria", { slug: "demo" })).toBe("Open demo detail");
    expect(t("zh_CN", "apps.openAria", { slug: "demo" })).toBe("打开 demo 详情");
    expect(html).toContain(`>${t("en", "apps.detail")}<`);
    expect(t("zh_CN", "apps.detail")).toBe("详情");
  });

  test("the empty Apps face keeps one Create form — creation is the only path", () => {
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
      expect(html.match(/<form/g)?.length, `apps=${apps}`).toBe(1);
      expect(html, `apps=${apps}`).toContain("manifest/start");
    }
    expect(renderFace(0)).toContain(t("en", "apps.emptyTitle"));
    // The guidance sentence rides the rendered face, not just the dictionary:
    // a create-capable viewer is told what the first App unlocks.
    expect(renderFace(0)).toContain(t("en", "apps.emptyDescription"));
  });

  test("the Apps list loading face is the shared table skeleton", () => {
    // The page's own first face: `state` starts at "loading" and the effect
    // never runs under SSR, so this renders exactly the gate a real first
    // paint shows. The table idiom (not cards/forms) is the page's shape.
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
    // The retry control is present; AppsPage binds it to its own reload
    // (`onRetry={() => void load()}`), which this SSR face cannot click.
    expect(html).toContain(t("en", "common.retry"));
  });
});
