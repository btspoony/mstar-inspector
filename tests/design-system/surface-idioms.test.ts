/**
 * Surface idioms (r3 shell rebuild, 2026-10-31).
 *
 * The r3 rule these assert is a property, not a class name: a card is defined
 * by a hairline plus a surface step, and its edge colour must be a declared
 * token. Tailwind's preflight leaves `border-color` at `currentColor`, so a
 * card that sets only a border width paints its hairline in the text colour —
 * and a `var(--missing)` reference resolves to currentColor too, silently.
 * Asserting "the class is named `border-(--x)`" would only re-pin the oracle
 * this migration removes; resolving the declared colour through `tokens.css`
 * is what the component actually guarantees.
 *
 * The second half of the rule is that content on the page never lifts off it:
 * elevation belongs to overlays (dialogs, popovers), so no card declares a
 * box-shadow.
 *
 * The flow-section idiom is the third: one plane divided by hairlines, so a
 * detail page composes sections without a card per section.
 *
 * The fourth is what the table, list-row and group-card comments hand off to
 * this file: the named row heights. A row face names exactly one height, it is
 * a declared `--row-h-*` step, and that step resolves to a length — a literal
 * or an undeclared token fails here instead of only in a comment.
 *
 * The fifth is the same hairline rule applied where the card layer does not
 * reach (I-000235): the loading skeleton, the provider picker's popover edge
 * and the two App avatars. Seven class sites across four files that named a
 * width and left the colour to preflight — each is read off its rendered face
 * and resolved through the same oracle, so "it looked fine" cannot pass.
 */
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

/** The generated stylesheet is the declared-token oracle: every `--name` a
 *  component may reference has to appear here, in both themes. */
const DECLARED = new Map<string, string>();
const TOKENS_CSS = readFileSync(new URL("../../src/spa/styles/tokens.css", import.meta.url), "utf8");
for (const match of TOKENS_CSS.matchAll(/(--[\w-]+)\s*:\s*([^;]+);/g)) {
  const [, name, value] = match;
  if (name && value) DECLARED.set(name, value.trim());
}

const VAR_VALUE = /^var\((--[\w-]+)\)$/;

/** Follows `var(--a)` → `var(--b)` → a literal; "" when a hop is undeclared
 *  (the browser would then fall back to currentColor, which is the trap). */
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

/** Border utilities that carry geometry or style, never a colour. */
const NOT_A_COLOUR =
  /^border-(?:\d+|\[[^\]]*\]|[trblesxy](?:-\d+)?|solid|dashed|dotted|double|hidden|none|collapse|separate)$/;

function classesOf(markup: string): string[] {
  const attribute = /class="([^"]*)"/.exec(markup)?.[1] ?? "";
  return attribute.split(/\s+/).filter(Boolean);
}

/** The colour-bearing border utilities in one class list. */
function borderColours(classes: string[]): string[] {
  return classes.filter((name) => name.startsWith("border-") && !NOT_A_COLOUR.test(name));
}

/** The card's hairline: one colour-bearing border utility, backed by a token.
 *  `width: false` for a face whose width utility is spelled `border-b` (or
 *  under an arbitrary variant) rather than the bare `border`. */
function expectTokenHairline(markup: string, options: { width?: boolean } = {}): void {
  const classes = classesOf(markup);
  if (options.width !== false) expect(classes).toContain("border");
  const colours = borderColours(classes);
  expect(colours, `a card names ${colours.length || "no"} border colour: ${colours.join(" ")}`)
    .toHaveLength(1);
  const colour = colours[0] ?? "";
  const match = ARBITRARY_VAR.exec(colour) ?? BRACKET_VAR.exec(colour);
  // `border-current`, a palette step or a raw literal would satisfy the
  // browser and tell us nothing about the token layer.
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

/** The tags in a markup that paint `slot`, so a row can be located by the
 *  identity it declares rather than by its position in the string. */
function tagsOfSlot(markup: string, slot: string): string[] {
  return [...markup.matchAll(new RegExp(`<[^>]*data-slot="${slot}"[^>]*>`, "g"))].map(
    (match) => match[0],
  );
}

/** A height utility that carries its height as a token: `h-(--x)` / `min-h-(--x)`. */
const ROW_HEIGHT = /^(?:min-)?h-\((--[\w-]+)\)$/;

/** A row face names exactly one height utility, it is the declared `--row-h-*`
 *  step, and that step resolves to a length in `tokens.css`. A raw `h-10`, a
 *  missing height or an undeclared token all fail here; returns the utility so
 *  the caller can assert the min/grow form. */
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

/** Every card that sits on the page, rendered at its rest face. */
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
  // The three surfaces that sit on the named row steps. The classes are read
  // off the rendered faces so a regression is caught where the page would
  // wear it, and every height resolves through the declared token — the same
  // oracle the hairlines use.
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
    // A bare `h-` would pin the row and clip its content; the list row is a
    // fixed face, so it names the height outright.
    expect(utility).not.toMatch(/^min-h-/);
  });

  test("the GroupCard header band is at least one comfort row", () => {
    const utility = expectRowHeight(groupHeader, "--row-h-comfort", "GroupCardHeader");
    // `min-h-` is the documented growth contract: a header with a summary
    // line grows past the comfort row.
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
    // The divider is the subtle hairline, declared as a token — and it is a
    // divider only: no fill, no elevation, no framed box.
    const colours = borderColours(classes);
    expect(colours, colours.join(" ")).toHaveLength(1);
    expect(resolveToken(ARBITRARY_VAR.exec(colours[0] ?? "")?.[1] ?? "")).not.toBe("");
    expect(classes.some((name) => name.startsWith("bg-"))).toBe(false);
    expectNoElevation(markup);
    // The flow trims its own first and last edges so it meets the page's
    // padding without a doubled gap or a trailing divider.
    expect(classes).toContain("last:border-b-0");
  });

  test("the section title is a real heading set on the type-token scale", () => {
    // The title must be a heading element, and its size must resolve to a
    // declared typography token — a raw px value would bypass the fixed scale.
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

/**
 * The provider picker opened on a live DOM: the popover edge only exists while
 * the list is open, and focus is what opens it.
 */
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
    // The listbox's own parent is the popover surface the edge belongs to.
    const popover = container.querySelector('[role="listbox"]')?.parentElement ?? null;
    expect(popover, "the picker did not open — nothing to read").not.toBeNull();
    return popover?.outerHTML ?? "";
  } finally {
    await act(async () => root.unmount());
    cleanup();
  }
}

/** The two dashboard faces that carry an App avatar (both inline, not in AppAvatar). */
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
    // Every row, not the first: the row face carries its colour under an
    // arbitrary variant, which is the spelling a spot check would miss.
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
    // One per face: the assertion is about the faces that ship them, not a
    // count in the abstract.
    expect(avatars).toHaveLength(2);
    for (const avatar of avatars) expectTokenHairline(avatar);
  });
});
