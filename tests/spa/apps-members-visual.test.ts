/**
 * Plan 58 T3: Apps + Members visual-discipline pins (A4/A5, AD-581
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
import { isDictionaryKey, t } from "../../src/i18n";

const spaRoot = join(import.meta.dir, "../../src/spa");
const appsPage = readFileSync(join(spaRoot, "pages/AppsPage.tsx"), "utf8");
const membersPage = readFileSync(join(spaRoot, "pages/MembersPage.tsx"), "utf8");
const tablePrimitive = readFileSync(join(spaRoot, "components/ui/table.tsx"), "utf8");

describe("AppsPage table reinforcement (plan 58 T3 / AD-581)", () => {
  test("identity cell is the brand surface: slug primary line + AppID meta line", () => {
    expect(appsPage).toContain('className="text-sm font-semibold text-foreground no-underline hover:underline"');
    expect(appsPage).toContain("text-xs text-muted-foreground tabular-nums");
    expect(appsPage).toContain('{t(locale, "apps.appId", { id: app.github_app_id })}');
  });

  test("whole-row click and the visible settings anchor keep their channels", () => {
    // Row-level and identity-link spaClick handlers (plan 40 behavior).
    expect(appsPage.split("onClick={(event) => spaClick(href, event)}").length - 1).toBe(3);
    expect(appsPage).toContain('className="text-primary underline-offset-4 hover:underline"');
    expect(appsPage).toContain('{t(locale, "apps.settings")}');
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
    // ui/table.tsx (plan 57) carries hover:bg-muted on data rows — the page
    // must not shadow it, and the header band opts out of the row hover.
    expect(appsPage).toContain('className="cursor-pointer"');
    expect(appsPage).toContain('<TableRow className="hover:bg-inherit">');
  });

  test("the health cell keeps the shared outcome map and gains tabular figures", () => {
    expect(appsPage).toContain("deliveryOutcomeLabel(latest.outcome, locale)");
    expect(appsPage).toContain("text-muted-foreground tabular-nums");
  });
});

describe("v0.3 page face (plan 58 T3, A4/A5)", () => {
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

describe("table horizontal padding (plan 62 T2, D5/A3)", () => {
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

describe("empty-state copy (plan 58 T3, A6)", () => {
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
