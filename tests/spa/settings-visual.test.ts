/**
 * Plan 59 T1: settings section-rhythm visual-discipline pins (A1/A2,
 * AD-591 two-tier surface + grouped rhythm). Source-scan + static-SSR
 * contract — no DOM runner.
 *
 * 1. AD-591: the tier idiom is defined ONCE in SectionCard.tsx (composing
 *    the copy-in ui/card.tsx); the page picks a tier through the prop and
 *    never hand-assembles tier classNames. Tier 1 = identity/status zone
 *    (slug row + AppInfo + Ops/Health), Tier 2 = configuration zone
 *    (RuntimeImage from T1; Providers/Chains/Seats joined in T2).
 * 2. v0.3 face: page/panel headings ride the heading-24/20 token steps
 *    (plan-58 QC idiom convergence), card titles ride heading-16, group
 *    eyebrows separate the two zones at the spacing-8 rhythm.
 * 3. Group label keys exist atomically in both locales.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../../src/i18n";
import { SectionCard, SectionGroup } from "../../src/spa/components/SectionCard";

const spaRoot = join(import.meta.dir, "../../src/spa");
const sectionCard = readFileSync(join(spaRoot, "components/SectionCard.tsx"), "utf8");
const settingsPage = readFileSync(join(spaRoot, "pages/SettingsPage.tsx"), "utf8");

describe("SectionCard tier idiom (plan 59 T1 / AD-591)", () => {
  test("the idiom is single-point: a hand-written wrapper composing ui/card, not a copy-in edit", () => {
    // AD-591: SectionCard lives in components/ (the extension surface), and
    // composes the copy-in Card primitive rather than forking it.
    expect(sectionCard).toContain('import { Card, CardTitle } from "@/components/ui/card"');
    // The tier prop is the closed two-value union — no third tier can creep in.
    expect(sectionCard).toContain('type SectionTier = "primary" | "secondary"');
    // Tier faces are spelled out exactly once.
    expect(sectionCard.match(/border-\(--gray-alpha-500\)/g)?.length).toBe(1);
    expect(sectionCard.match(/shadow-none/g)?.length).toBe(1);
    // Zero raw hex in the idiom file.
    expect(sectionCard).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  test("tiers render distinct faces through the card primitive (SSR)", () => {
    const html = (tier: "primary" | "secondary") =>
      renderToStaticMarkup(createElement(SectionCard, { tier }, "content"));
    // Primary keeps the primitive's elevation and takes the tinted border.
    const primary = html("primary");
    expect(primary).toContain('data-tier="primary"');
    expect(primary).toContain('data-slot="card"');
    expect(primary).toContain("border-(--gray-alpha-500)");
    expect(primary).not.toContain("shadow-none");
    // Secondary is flat on the primitive's hairline.
    const secondary = html("secondary");
    expect(secondary).toContain('data-tier="secondary"');
    expect(secondary).toContain("shadow-none");
    expect(secondary).not.toContain("border-(--gray-alpha-500)");
  });

  test("SectionGroup renders the eyebrow rhythm label above the card stack (SSR)", () => {
    const out = renderToStaticMarkup(createElement(SectionGroup, { label: "Identity", children: "cards" }));
    expect(out).toContain('data-slot="section-group-eyebrow"');
    expect(out).toContain(">Identity</p>");
    // Eyebrow face: label-12 tracking token + muted tone; never a heading.
    expect(out).toContain("tracking-(--typo-label-12-tracking)");
    expect(out).toContain("text-muted-foreground");
    expect(out).toContain('data-slot="section-group"');
    expect(out).toContain("cards");
  });
});

describe("settings section rhythm (plan 59 T1 / AD-591)", () => {
  test("the page picks tiers through props only — no per-block tier className assembly", () => {
    // The tier vocabulary lives in SectionCard.tsx alone; the page source
    // never spells tier classes or the data-tier attribute by hand.
    expect(settingsPage).not.toContain("data-tier");
    expect(settingsPage).not.toContain("shadow-none");
    expect(settingsPage).not.toContain("gray-alpha-500");
  });

  test("identity/status cards re-parent onto the Tier 1 surface; runtime image onto Tier 2", () => {
    const cardBlock = (start: string, end: string) => {
      const from = settingsPage.indexOf(start);
      expect(from, start).toBeGreaterThan(-1);
      return settingsPage.slice(from, settingsPage.indexOf(end, from));
    };
    expect(cardBlock("export function AppInfoCard", "function HealthBody")).toContain(
      '<SectionCard tier="primary">',
    );
    expect(cardBlock("function HealthCard", "function RuntimeImageCard")).toContain(
      '<SectionCard tier="primary">',
    );
    expect(cardBlock("function RuntimeImageCard", "function RuntimeImageEditor")).toContain(
      '<SectionCard tier="secondary">',
    );
    expect(cardBlock("function OpsCard", "function ProvidersCard")).toContain(
      '<SectionCard tier="primary">',
    );
  });

  test("the two tier groups head the view: identity first, configuration second, spacing-8 apart", () => {
    // Group eyebrows resolve through the dictionary, in AD-591 zone order.
    const identityPos = settingsPage.indexOf('label={t(locale, "settings.group.identity")}');
    const configurationPos = settingsPage.indexOf('label={t(locale, "settings.group.configuration")}');
    expect(identityPos).toBeGreaterThan(-1);
    expect(configurationPos).toBeGreaterThan(identityPos);
    // Group-to-group rhythm rides the spacing token (DESIGN.md: large
    // between sections = spacing-8+).
    expect(settingsPage).toContain('gap-(--spacing-8)');
    // Zone membership: the manage conditional (Ops/Health) stays inside the
    // identity group (before the configuration eyebrow), and the runtime
    // image card moves into the configuration group.
    const managePos = settingsPage.indexOf("{payload.can_manage ? (");
    expect(managePos).toBeGreaterThan(identityPos);
    expect(managePos).toBeLessThan(configurationPos);
    const runtimePos = settingsPage.indexOf("<RuntimeImageCard");
    expect(runtimePos).toBeGreaterThan(configurationPos);
  });
});

describe("settings heading idiom (plan 59 T1, plan-58 QC convergence)", () => {
  test("page title rides heading-24, the app slug rides heading-20 — no raw size utilities", () => {
    expect(settingsPage).toContain("text-(length:--typo-heading-24-size)");
    expect(settingsPage).toContain("leading-(--typo-heading-24-line)");
    expect(settingsPage).toContain("tracking-(--typo-heading-24-tracking)");
    expect(settingsPage).toContain("text-(length:--typo-heading-20-size)");
    expect(settingsPage).toContain("leading-(--typo-heading-20-line)");
    expect(settingsPage).toContain("tracking-(--typo-heading-20-tracking)");
    // No raw Tailwind size utilities remain on the page headings.
    expect(settingsPage).not.toContain("text-2xl");
    expect(settingsPage).not.toContain("text-xl");
    expect(settingsPage).not.toContain("text-lg");
  });

  test("re-parented card titles ride the heading-16 token step via SectionCardTitle", () => {
    expect(sectionCard).toContain("text-(length:--typo-heading-16-size)");
    expect(sectionCard).toContain("leading-(--typo-heading-16-line)");
    expect(sectionCard).toContain("tracking-(--typo-heading-16-tracking)");
    // Each re-parented card consumes the upgraded title (the T1 wave re-parented
    // identity/status + runtime image; T2 added providers/chains/seats — pinned
    // in the T2 describe below).
    for (const card of ["export function AppInfoCard", "function HealthCard", "function RuntimeImageCard", "function OpsCard"]) {
      const from = settingsPage.indexOf(card);
      expect(from, card).toBeGreaterThan(-1);
      const nextCard = settingsPage.slice(from, from + 900);
      expect(nextCard, card).toContain("<SectionCardTitle>");
    }
  });
});

describe("group eyebrow copy (plan 59 T1, A8)", () => {
  test("identity/configuration keys exist atomically in both locales", () => {
    for (const key of ["settings.group.identity", "settings.group.configuration"] as const) {
      const en = t("en", key);
      const zh = t("zh_CN", key);
      expect(en.length, key).toBeGreaterThan(0);
      expect(zh.length, key).toBeGreaterThan(0);
      expect(zh, key).not.toBe(en);
      expect(en, key).not.toContain("{");
      expect(zh, key).not.toContain("{");
    }
    expect(t("en", "settings.group.identity")).toBe("Identity");
    expect(t("zh_CN", "settings.group.identity")).toBe("身份");
    expect(t("en", "settings.group.configuration")).toBe("Configuration");
    expect(t("zh_CN", "settings.group.configuration")).toBe("配置");
  });
});

describe("providers/chains/seats re-parent (plan 59 T2 / AD-591)", () => {
  const cardBlock = (start: string, end: string) => {
    const from = settingsPage.indexOf(start);
    expect(from, start).toBeGreaterThan(-1);
    return settingsPage.slice(from, settingsPage.indexOf(end, from));
  };

  test("the three configuration cards ride the Tier 2 surface through the prop, not hand-assembled faces", () => {
    // The page never spells tier classes (the T1 single-point pin above); the
    // three manage-face configuration cards re-parent exactly like the
    // runtime image card did — one prop, zero per-block className assembly.
    expect(cardBlock("function ProvidersCard", "function ConfiguredKeyRow")).toContain(
      '<SectionCard tier="secondary">',
    );
    expect(cardBlock("function ChainsCard", "function SeatsCard")).toContain(
      '<SectionCard tier="secondary">',
    );
    expect(cardBlock("function SeatsCard", "function DraftChainPanel")).toContain(
      '<SectionCard tier="secondary">',
    );
    // No raw <Card> remains: the whole settings page composes SectionCard.
    expect(settingsPage).not.toContain("<Card>");
  });

  test("each re-parented card titles through SectionCardTitle (the heading-16 step)", () => {
    for (const [card, next] of [
      ["function ProvidersCard", "function ConfiguredKeyRow"],
      ["function ChainsCard", "function SeatsCard"],
      ["function SeatsCard", "function DraftChainPanel"],
    ] as const) {
      expect(cardBlock(card, next), card).toContain("<SectionCardTitle>");
    }
  });

  test("form labels stay label-above-control; the mirror rows speak one compact dialect", () => {
    // The shared label-above-field wrapper survives untouched on every
    // ProviderConfigForm / CustomExpand / DraftChainPanel / SeatsCard field
    // (plan-38/54 aria-labelledby picker label rides its own pinned idiom).
    const labelIdiom = 'className="flex flex-col gap-1.5 text-sm font-medium"';
    expect(settingsPage.split(labelIdiom).length - 1).toBeGreaterThanOrEqual(8);
    // Both configured-row kinds (the mirror rows) title at the label-14 form
    // face and carry their meta at the compact xs muted face — one dialect.
    const keyRow = cardBlock("function ConfiguredKeyRow", "function ConfiguredCustomRow");
    const customRow = cardBlock("function ConfiguredCustomRow", "function AddProviderSection");
    for (const [name, row] of [
      ["key row", keyRow],
      ["custom row", customRow],
    ] as const) {
      expect(row, name).toContain('<div className="text-sm font-medium">{label}</div>');
      expect(row, name).toContain('className="text-xs text-muted-foreground"');
    }
    // Compactness pins stay structural: hairline + container radius + the
    // padded row body (plan-55 mirror-row compactness, faces retuned only).
    for (const row of [keyRow, customRow]) {
      expect(row).toContain("flex flex-wrap items-center justify-between gap-2 rounded-md border p-3");
    }
  });
});

describe("provider combobox panel face (plan 59 T2)", () => {
  const combobox = readFileSync(join(spaRoot, "components/provider-combobox.tsx"), "utf8");

  test("the open panel rides the v0.3 popover elevation; group labels ride the label-12 idiom", () => {
    // DESIGN.md elevation: shadow-pop is the popover/disclosure step (the
    // plan-57 SelectContent face); the generic shadow-md is gone. Container
    // radius tier + popover surface stay, and the height cap / internal
    // scroll (plan-42/54 pins) is untouched.
    expect(combobox).toContain("shadow-(--shadow-pop)");
    expect(combobox).not.toContain("shadow-md");
    expect(combobox).toContain("rounded-md border bg-popover");
    expect(combobox).toContain("max-h-72");
    // T1 review Minor 1 convergence: label faces prefer the typo-label-12
    // tracking idiom (same carrier as the SectionGroup eyebrows).
    expect(combobox).toContain("tracking-(--typo-label-12-tracking)");
    // Zero raw hex in the component (iteration hard constraint #4).
    expect(combobox).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});
