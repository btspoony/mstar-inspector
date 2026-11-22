import { readFileSync } from "node:fs";
import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";

import { FlowSection } from "../../src/design-system/patterns/flow-section";
import { Card } from "../../src/design-system/primitives/card";
import { DataTable } from "../../src/spa/components/DataTable";
import { GroupCard, GroupCardHeader } from "../../src/spa/components/GroupCard";
import { ListRow } from "../../src/spa/components/ListRow";
import { SectionCard } from "../../src/spa/components/SectionCard";
import { EmptyState } from "../../src/spa/components/state/EmptyState";
import { PageSkeleton } from "../../src/spa/components/state/PageSkeleton";
import { ProviderCombobox } from "../../src/spa/components/provider-combobox";
import { AppsList } from "../../src/spa/pages/AppsPage";
import { AppInfoSection } from "../../src/spa/pages/SettingsPage";
import { withLocation } from "../spa/browser-stub";
import { installDom } from "../spa/dom";

const DECLARED = new Map<string, string>();
const TOKENS_CSS = readFileSync(new URL("../../src/spa/styles/tokens.css", import.meta.url), "utf8");
for (const match of TOKENS_CSS.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
  const [, name, value] = match;
  if (name && value) DECLARED.set(name, value.trim());
}

const VAR_VALUE = /^var\((--[\w-]+)\)$/;

function resolveToken(name: string): string {
  let value: string | undefined = DECLARED.get(name);
  for (let hop = 0; value && hop < 8; hop += 1) {
    const next = VAR_VALUE.exec(value)?.[1];
    if (!next) break;
    value = DECLARED.get(next);
  }
  return value ?? "";
}

const ARBITRARY_VAR = /^border-\((--[\w-]+)\)$/;
const BRACKET_VAR = /^border-\[var\((--[\w-]+)\)\]$/;

const NOT_A_COLOUR =
  /^border-(?:\d+|\[[^\]]*\]|[trblesxy](?:-\d+)?|solid|dashed|dotted|double|hidden|none|collapse|separate)$/;

function classesOf(markup: string): string[] {
  const attribute = /class="([^"]*)"/.exec(markup)?.[1] ?? "";
  return attribute.split(/\s+/).filter(Boolean);
}

function borderColours(classes: string[]): string[] {
  return classes.filter((name) => name.startsWith("border-") && !NOT_A_COLOUR.test(name));
}

function expectTokenHairline(markup: string, options: { width?: boolean } = {}): void {
  const classes = classesOf(markup);
  if (options.width !== false) expect(classes).toContain("border");
  const colours = borderColours(classes);
  expect(colours, `a card names ${colours.length || "no"} border colour: ${colours.join(" ")}`)
    .toHaveLength(1);
  const colour = colours[0] ?? "";
  const match = ARBITRARY_VAR.exec(colour) ?? BRACKET_VAR.exec(colour);
  expect(match, `${colour} names no token`).not.toBeNull();
  const token = match?.[1] ?? colour;
  const value = resolveToken(token);
  expect(value, `${token} is not declared in tokens.css`).not.toBe("");
  expect(value, `${token} resolves to currentColor`).not.toMatch(/currentColor|transparent/i);
}

function expectNoElevation(markup: string): void {
  const shadows = classesOf(markup).filter((name) => name.startsWith("shadow"));
  expect(shadows, `inline surface declares ${shadows.join(" ")}`).toEqual([]);
}

function tagsOfSlot(markup: string, slot: string): string[] {
  return [...markup.matchAll(new RegExp(`<[^>]*data-slot="${slot}"[^>]*>`, "g"))].map(
    (match) => match[0],
  );
}

const ROW_HEIGHT = /^(?:min-)?h-\((--[\w-]+)\)$/;

function expectRowHeight(tag: string, token: string, where: string): string {
  const heights = classesOf(tag).filter((name) => /^(?:min-)?h-/.test(name));
  expect(heights, `${where} names ${heights.join(" ") || "no"} height`).toHaveLength(1);
  const utility = heights[0] ?? "";
  const match = ROW_HEIGHT.exec(utility);
  expect(match, `${where} height ${utility} carries no token`).not.toBeNull();
  expect(match?.[1], `${where} sits on ${match?.[1]}, not ${token}`).toBe(token);
  const value = resolveToken(token);
  expect(value, `${token} is not declared in tokens.css`).not.toBe("");
  expect(value, `${token} is not a length`).toMatch(/^\d+(?:\.\d+)?(?:px|rem)$/);
  return utility;
}

const CARD_LAYER: ReadonlyArray<readonly [string, string]> = [
  ["Card", renderToStaticMarkup(createElement(Card, null, "content"))],
  [
    "SectionCard primary",
    renderToStaticMarkup(createElement(SectionCard, { tier: "primary" }, "content")),
  ],
  [
    "SectionCard secondary",
    renderToStaticMarkup(createElement(SectionCard, { tier: "secondary" }, "content")),
  ],
  ["GroupCard", renderToStaticMarkup(createElement(GroupCard, null))],
  ["EmptyState", renderToStaticMarkup(createElement(EmptyState, { title: "Nothing here" }))],
];

describe("card surface rule (r3)", () => {
  for (const [name, markup] of CARD_LAYER) {
    test(`${name} paints its hairline in a token, not currentColor`, () => {
      expectTokenHairline(markup);
    });

    test(`${name} carries no elevation on the inline plane`, () => {
      expectNoElevation(markup);
    });
  }

  test("the two SectionCard tiers stay distinguishable by hairline strength alone", () => {
    const tiers = (["primary", "secondary"] as const).map((tier) =>
      borderColours(classesOf(renderToStaticMarkup(createElement(SectionCard, { tier }, "content")))),
    );
    expect(tiers[0]).toHaveLength(1);
    expect(tiers[0]).not.toEqual(tiers[1]);
  });
});

describe("row heights (DESIGN.md Table, list-row, group-card)", () => {
  const table = renderToStaticMarkup(
    createElement(DataTable<{ slug: string }>, {
      columns: [{ header: "App", cell: (row) => row.slug }],
      rows: [{ slug: "demo" }],
      rowKey: (row) => row.slug,
    }),
  );
  const [headRow = "", bodyRow = ""] = tagsOfSlot(table, "table-row");
  const [listRow = ""] = tagsOfSlot(
    renderToStaticMarkup(createElement(ListRow, { identity: "demo" })),
    "list-row",
  );
  const [groupHeader = ""] = tagsOfSlot(
    renderToStaticMarkup(createElement(GroupCardHeader, { title: "Apps" })),
    "card-header",
  );

  test("the table header band sits on the compact step and its rows on the comfort step", () => {
    expectRowHeight(headRow, "--row-h-compact", "DataTable header row");
    expectRowHeight(bodyRow, "--row-h-comfort", "DataTable body row");
  });

  test("ListRow sits on the compact step", () => {
    const utility = expectRowHeight(listRow, "--row-h-compact", "ListRow");
    expect(utility).not.toMatch(/^min-h-/);
  });

  test("the GroupCard header band is at least one comfort row", () => {
    const utility = expectRowHeight(groupHeader, "--row-h-comfort", "GroupCardHeader");
    expect(utility).toMatch(/^min-h-/);
  });
});

describe("flow-section idiom", () => {
  const markup = renderToStaticMarkup(
    createElement(
      FlowSection,
      { title: "App info", subtitle: "GitHub identity cache" },
      createElement("p", null, "4482910"),
    ),
  );

  test("a section divides the page plane instead of framing its own", () => {
    const classes = classesOf(markup);
    expect(markup).toContain('data-slot="flow-section"');
    const colours = borderColours(classes);
    expect(colours, colours.join(" ")).toHaveLength(1);
    expect(resolveToken(ARBITRARY_VAR.exec(colours[0] ?? "")?.[1] ?? "")).not.toBe("");
    expect(classes.some((name) => name.startsWith("bg-"))).toBe(false);
    expectNoElevation(markup);
    expect(classes).toContain("last:border-b-0");
  });

  test("the section title is a real heading set on the type-token scale", () => {
    const heading = /<h2 class="([^"]*)"[^>]*>App info<\/h2>/.exec(markup);
    expect(heading, "the title is not an h2").not.toBeNull();
    const step = /length:(--[\w-]+)/.exec(heading?.[1] ?? "");
    expect(step, "the title names no type token").not.toBeNull();
    expect(resolveToken(step?.[1] ?? "")).not.toBe("");
  });

  test("renders the subtitle and the section body", () => {
    expect(markup).toContain("GitHub identity cache");
    expect(markup).toContain("4482910");
  });
});

async function openPickerPopover(): Promise<string> {
  const { win, cleanup } = installDom("http://localhost/dashboard/acme/apps/1/settings");
  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  try {
    await act(async () => {
      root.render(
        createElement(ProviderCombobox, {
          locale: "en",
          labelledby: "provider-label",
          providers: [
            {
              id: "openai",
              label: "OpenAI",
              tier: "builtin",
              base_url: null,
              api: null,
              models: [],
              verifiable: true,
              usage_probe: false,
              eligibility: "builtin",
              display_group: "common",
            },
          ],
          value: undefined,
          onValueChange: () => {},
          imageId: "omp",
        }),
      );
    });
    const input = container.querySelector('input[role="combobox"]');
    await act(async () => {
      input?.dispatchEvent(new win.FocusEvent("focusin", { bubbles: true }));
    });
    const popover = container.querySelector('[role="listbox"]')?.parentElement ?? null;
    expect(popover, "the picker did not open — nothing to read").not.toBeNull();
    return popover?.outerHTML ?? "";
  } finally {
    await act(async () => root.unmount());
    cleanup();
  }
}

const APPS_LIST = withLocation("/dashboard/acme/apps", () =>
  renderToStaticMarkup(
    createElement(AppsList, {
      locale: "en",
      payload: {
        viewer: { login: "mallory", role: "admin" },
        apps: [
          {
            github_slug: "demo",
            github_name: "Demo",
            github_avatar_url: "https://avatars.example/demo.png",
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

const APP_INFO = withLocation("/dashboard/acme/apps/1/settings", () =>
  renderToStaticMarkup(
    createElement(AppInfoSection, {
      locale: "en",
      workspaceId: "ws_0123456789abcdefghijkl",
      canManage: false,
      app: {
        github_app_id: 1,
        status: "active",
        review_enabled: true,
        created_by: "mallory",
        created_at: "2026-01-01T00:00:00Z",
        id: "app-demo",
        github_name: "Demo",
        github_slug: "demo",
        github_description: null,
        github_html_url: null,
        github_avatar_url: "https://avatars.example/demo.png",
        github_metadata_synced_at: null,
      },
    }),
  ),
);

describe("hairline sites outside the card layer (I-000235)", () => {
  test("the loading skeleton: table shell, header band, every row and every card", () => {
    const table = renderToStaticMarkup(createElement(PageSkeleton, { locale: "en", kind: "table" }));
    for (const slot of ["skeleton-table", "skeleton-table-header"]) {
      const [tag = ""] = tagsOfSlot(table, slot);
      expect(tag, slot).not.toBe("");
      expectTokenHairline(tag, { width: false });
    }
    const rows = tagsOfSlot(table, "skeleton-table-row");
    expect(rows.length).toBeGreaterThan(1);
    for (const row of rows) expectTokenHairline(row, { width: false });

    const cards = tagsOfSlot(
      renderToStaticMarkup(createElement(PageSkeleton, { locale: "en", kind: "cards" })),
      "skeleton-card",
    );
    expect(cards.length).toBeGreaterThan(0);
    for (const card of cards) expectTokenHairline(card);
  });

  test("the provider picker's open list edge names its colour", async () => {
    expectTokenHairline(await openPickerPopover());
  });

  test("both App avatars name their ring colour", () => {
    const avatarsOf = (markup: string): string[] =>
      [...markup.matchAll(/<img\b[^>]*>/g)]
        .map((match) => match[0])
        .filter((tag) => classesOf(tag).includes("rounded-full"));
    const avatars = [...avatarsOf(APPS_LIST), ...avatarsOf(APP_INFO)];
    expect(avatars).toHaveLength(2);
    for (const avatar of avatars) expectTokenHairline(avatar);
  });
});
