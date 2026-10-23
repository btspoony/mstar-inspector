/**
 * Apps + Members visual-discipline pins (A4/A5, AD-581
 * table-reinforced form). Source-scan contract — no DOM runner.
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
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { isDictionaryKey, t } from "../../src/i18n";
import { AppsList, AppsView } from "../../src/spa/pages/AppsPage";
import { matchSpaRoute } from "../../src/spa/routes";
import { withLocation } from "./browser-stub";

const spaRoot = join(import.meta.dir, "../../src/spa");
const appsPage = readFileSync(join(spaRoot, "pages/AppsPage.tsx"), "utf8");
const membersPage = readFileSync(join(spaRoot, "pages/MembersPage.tsx"), "utf8");
const tablePrimitive = readFileSync(join(spaRoot, "components/ui/table.tsx"), "utf8");

describe("AppsPage table reinforcement (AD-581)", () => {
  test("identity cell is the brand surface: slug primary line + AppID meta line", () => {
    expect(appsPage).toContain('className="text-sm font-semibold text-foreground no-underline hover:underline"');
    expect(appsPage).toContain("text-xs text-muted-foreground tabular-nums");
    expect(appsPage).toContain('{t(locale, "apps.appId", { id: app.github_app_id })}');
  });

  test("whole-row click and the visible detail anchor keep their channels", () => {
    // Rendered from the real row component under the two ACTUAL pathnames: the
    // emitted links are the page's own base, so a wrong base, a legacy target
    // under a workspace page, or a /settings deep link fails here.
    const render = (pathname: string): string =>
      withLocation(pathname, () =>
        renderToStaticMarkup(
          createElement(AppsList, {
            locale: "en",
            payload: {
              viewer: { login: "mallory", role: "member" },
              apps: [
                {
                  slug: "demo",
                  github_app_id: 1,
                  status: "active",
                  review_enabled: 1,
                  created_by: "mallory",
                  health: { latest: null, rejected24h: 0 },
                },
              ],
            },
          }),
        ),
      );
    // Legacy Apps page: the historical detail path, identity link + anchor.
    expect(
      [...render("/dashboard/apps").matchAll(/href="([^"]+)"/g)].map((match) => match[1]),
    ).toEqual(["/dashboard/apps/demo", "/dashboard/apps/demo"]);
    // Workspace Apps page: the workspace copy of the same route — the legacy
    // App family answers 404 under strict.
    expect(
      [...render("/dashboard/acme/apps").matchAll(/href="([^"]+)"/g)].map((match) => match[1]),
    ).toEqual(["/dashboard/acme/apps/demo", "/dashboard/acme/apps/demo"]);
    const scoped = render("/dashboard/acme/apps");
    expect(scoped).toContain('class="text-primary underline-offset-4 hover:underline"');
    expect(scoped).not.toContain("/settings");
    // Row action copy is detail semantics in both locales.
    expect(scoped).toContain(">Detail<");
    expect(t("en", "apps.detail")).toBe("Detail");
    expect(t("zh_CN", "apps.detail")).toBe("详情");
  });

  test("StatusBadge rides the v0.3 pill component tokens with semantic tones", () => {
    // Shape comes from the --badge-* component tokens (AD-574 pill exception).
    expect(appsPage).toContain("h-(--badge-height)");
    expect(appsPage).toContain("rounded-(--badge-radius)");
    // Tones stay on the semantic success/warn badge vars (constraint #5).
    expect(appsPage).toContain("bg-(--badge-success-bg)");
    expect(appsPage).toContain("text-(--badge-success-fg)");
    expect(appsPage).toContain("bg-(--badge-warn-bg)");
    expect(appsPage).toContain("text-(--badge-warn-fg)");
    // No hard-coded pill geometry left behind.
    expect(appsPage).not.toContain("rounded-full");
    expect(appsPage).not.toMatch(/\bh-5\b/);
  });

  test("row hover is the restyled primitive's tinted surface; header row opts out", () => {
    // ui/table.tsx carries hover:bg-muted on data rows — the page
    // must not shadow it, and the header band opts out of the row hover.
    expect(appsPage).toContain('className="cursor-pointer"');
    expect(appsPage).toContain('<TableRow className="hover:bg-inherit">');
  });

  test("the health cell keeps the shared outcome map and gains tabular figures", () => {
    expect(appsPage).toContain("deliveryOutcomeLabel(latest.outcome, locale)");
    expect(appsPage).toContain("text-muted-foreground tabular-nums");
  });
});

describe("v0.3 page face (A4/A5)", () => {
  test("page titles ride the heading-24 token step", () => {
    for (const [name, source] of [
      ["AppsPage", appsPage],
      ["MembersPage", membersPage],
    ] as const) {
      expect(source, name).toContain("text-(length:--typo-heading-24-size)");
      expect(source, name).toContain("leading-(--typo-heading-24-line)");
      expect(source, name).toContain("tracking-(--typo-heading-24-tracking)");
    }
  });

  test("table header face: background-200 band + label-12 headers (DESIGN.md Table)", () => {
    for (const [name, source] of [
      ["AppsPage", appsPage],
      ["MembersPage", membersPage],
    ] as const) {
      expect(source, name).toContain('bg-(--background-200)');
      expect(source, name).toContain("text-xs tracking-(--typo-label-12-tracking)");
    }
  });

  test("zero raw hex in both page sources", () => {
    for (const [name, source] of [
      ["AppsPage", appsPage],
      ["MembersPage", membersPage],
    ] as const) {
      expect(source, name).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
    }
  });
});

describe("table horizontal padding (D5/A3)", () => {
  // The exact head/cell class literals (qc round 1, qc1-F-002): the
  // retirement pin scans these strings only — a hypothetical future variant
  // elsewhere in the file (px-2.5, sm:px-2) cannot false-fail it.
  const headClassLiteral = tablePrimitive.match(/"(h-10 px-3[^"]*)"/)?.[1];
  const cellClassLiteral = tablePrimitive.match(/"(px-3 py-2[^"]*)"/)?.[1];

  test("head and cell ride the spacing-3 horizontal step (12px); vertical untouched", () => {
    // D5: one component-level raise benefits both Apps and Members tables.
    expect(tablePrimitive).toContain("h-10 px-3");
    expect(tablePrimitive).toContain("px-3 py-2");
  });

  test("head/cell class literals are locatable (pin integrity)", () => {
    expect(headClassLiteral).toBeDefined();
    expect(cellClassLiteral).toBeDefined();
  });

  test("the 8px horizontal step is retired from the head/cell class literals", () => {
    // Standalone-token check inside the literals: a regen reverting the
    // primitives to upstream px-2/p-2 still fails, while token variants
    // (px-2.5, sm:px-2) do not count as the retired step.
    for (const literal of [headClassLiteral, cellClassLiteral]) {
      const tokens = (literal ?? "").split(/\s+/);
      expect(tokens).toContain("px-3");
      expect(tokens).not.toContain("px-2");
      expect(tokens).not.toContain("p-2");
    }
    expect((cellClassLiteral ?? "").split(/\s+/)).toContain("py-2");
  });

  test("checkbox flush-right exception survives the padding raise", () => {
    // The pr-0 escape hatch exists on both head and cell (shadcn convention).
    expect(tablePrimitive.match(/\[&:has\(\[role=checkbox\]\)\]:pr-0/g)?.length).toBe(2);
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

  test("the retired single-line keys are gone from sources and dictionary", () => {
    expect(appsPage).not.toContain('t(locale, "apps.empty")');
    expect(membersPage).not.toContain('t(locale, "members.empty")');
    // t() fails visible (returns the key) — the dictionary really dropped them.
    expect(isDictionaryKey("apps.empty")).toBe(false);
    expect(isDictionaryKey("members.empty")).toBe(false);
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
