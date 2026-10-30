/**
 * settings section-rhythm visual-discipline pins (A1/A2,
 * AD-591 two-tier surface + grouped rhythm). Source-scan + static-SSR
 * contract — no DOM runner.
 *
 * 1. AD-591: the tier idiom is defined ONCE in SectionCard.tsx (composing
 *    the copy-in ui/card.tsx); the page picks a tier through the prop and
 *    never hand-assembles tier classNames. Tier 1 = identity/status zone
 *    (identity header + AppInfo + Ops/Health), Tier 2 = configuration zone
 *    (RuntimeHarness from T1; Providers/Chains/Seats joined in T2).
 * 2. v0.3 face: page/panel headings ride the heading-24/20 token steps
 * (QC idiom convergence), card titles ride heading-16, group
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
import { PageNotice } from "../../src/spa/pages/PageNotice";
import { AppDetailView } from "../../src/spa/pages/AppDetailPage";
import { withLocation } from "./browser-stub";

const spaRoot = join(import.meta.dir, "../../src/spa");
const sectionCard = readFileSync(join(spaRoot, "components/SectionCard.tsx"), "utf8");
const settingsPageOnly = readFileSync(join(spaRoot, "pages/SettingsPage.tsx"), "utf8");
/** The settings tab's source: the page plus the providers module it composes. */
const settingsTabSource =
  settingsPageOnly + readFileSync(join(spaRoot, "pages/settings-providers.tsx"), "utf8");
const detailPage = readFileSync(join(spaRoot, "pages/AppDetailPage.tsx"), "utf8");
const pageHeader = readFileSync(join(spaRoot, "components/PageHeader.tsx"), "utf8");
const pagesCss = readFileSync(join(spaRoot, "pages.module.css"), "utf8");

/** A manage-face settings payload, so the detail shell renders its real body. */
const detailPayload = (): Parameters<typeof AppDetailView>[0]["payload"] => ({
  can_manage: true,
  workspace_id: "ws_0123456789abcdefghijkl",
  app: {
    github_slug: "demo",
    id: "app-demo",
    github_app_id: 1,
    status: "active",
    review_enabled: true,
    created_by: "mallory",
    github_name: "Demo",
    github_description: null,
    github_html_url: "https://github.com/apps/demo",
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
  configured_providers: [],
  provider_catalog: [],
  model_role_ids: [],
  custom_provider_api_ids: [],
  sandbox_images: [{ id: "omp", enabled: true }],
  installations: [],
  deliveries: [],
});

describe("SectionCard tier idiom (AD-591)", () => {
  test("the idiom is single-point: a hand-written wrapper composing ui/card, not a copy-in edit", () => {
    // AD-591: SectionCard lives in components/ (the extension surface), and
    // composes the copy-in Card primitive rather than forking it.
    expect(sectionCard).toContain('import { Card, CardTitle } from "@/components/ui/card"');
    // The tier prop is the closed two-value union — no third tier can creep in.
    expect(sectionCard).toContain('type SectionTier = "primary" | "secondary"');
    // Tier faces are spelled out exactly once.
    expect(sectionCard.match(/border-\(--gray-alpha-500\)/g)?.length).toBe(1);
    expect(sectionCard.match(/shadow-none/g)?.length).toBe(1);
    // Tier 2's hairline color is explicit (qc2 F-001): the primitive's bare
    // `border` carries width only — preflight leaves border-color at
    // currentColor — so the secondary face must carry `border-border`.
    expect(sectionCard).toContain('secondary: "shadow-none border-border"');
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
    // Secondary is flat on the token hairline (border-border → gray-alpha-400).
    const secondary = html("secondary");
    expect(secondary).toContain('data-tier="secondary"');
    expect(secondary).toContain("shadow-none");
    expect(secondary).toContain("border-border");
    expect(secondary).not.toContain("border-(--gray-alpha-500)");
  });

  test("SectionGroup renders the eyebrow rhythm label above the card stack (SSR)", () => {
    const out = renderToStaticMarkup(createElement(SectionGroup, { label: "Identity", children: "cards" }));
    expect(out).toContain('data-slot="section-group-eyebrow"');
    expect(out).toContain(">Identity</p>");
    // Eyebrow face: the full label-12 token face (size/line/tracking/weight
    // per tokens.css --typo-label-12-*) + muted tone; never a heading.
    expect(out).toContain("text-(length:--typo-label-12-size)");
    expect(out).toContain("leading-(--typo-label-12-line)");
    expect(out).toContain("tracking-(--typo-label-12-tracking)");
    expect(out).toContain("font-(weight:--typo-label-12-weight)");
    expect(out).toContain("text-muted-foreground");
    expect(out).toContain('data-slot="section-group"');
    expect(out).toContain("cards");
  });
});

describe("settings section rhythm (AD-591)", () => {
  test("the page picks tiers through props only — no per-block tier className assembly", () => {
    // The tier vocabulary lives in SectionCard.tsx alone; the page source
    // never spells tier classes or the data-tier attribute by hand.
    expect(settingsTabSource).not.toContain("data-tier");
    expect(settingsTabSource).not.toContain("shadow-none");
    expect(settingsTabSource).not.toContain("gray-alpha-500");
  });

  test("identity/status cards re-parent onto the Tier 1 surface; runtime harness onto Tier 2", () => {
    const cardBlock = (start: string, end: string) => {
      const from = settingsTabSource.indexOf(start);
      expect(from, start).toBeGreaterThan(-1);
      return settingsTabSource.slice(from, settingsTabSource.indexOf(end, from));
    };
    expect(cardBlock("export function AppInfoCard", "function HealthBody")).toContain(
      '<SectionCard tier="primary">',
    );
    expect(cardBlock("function RuntimeHarnessCard", "function RuntimeHarnessEditor")).toContain(
      '<SectionCard tier="secondary">',
    );
    expect(cardBlock("function OpsCard", "function ProvidersCard")).toContain(
      '<SectionCard tier="primary">',
    );
  });

  test("the two tier groups head the view: appInfo first, configuration second, spacing-8 apart", () => {
    // Group eyebrows resolve through the dictionary, in AD-591 zone order.
    const appInfoPos = settingsTabSource.indexOf('label={t(locale, "settings.group.appInfo")}');
    const configurationPos = settingsTabSource.indexOf('label={t(locale, "settings.group.configuration")}');
    expect(appInfoPos).toBeGreaterThan(-1);
    expect(configurationPos).toBeGreaterThan(appInfoPos);
    // Group-to-group rhythm rides the spacing token (DESIGN.md: large
    // between sections = spacing-8+).
    expect(settingsTabSource).toContain('gap-(--spacing-8)');
    // Zone membership: the manage conditional (Ops/Health) stays inside the
    // identity group (before the configuration eyebrow), and the runtime
    // image card moves into the configuration group.
    const managePos = settingsTabSource.indexOf("{payload.can_manage ? (");
    expect(managePos).toBeGreaterThan(appInfoPos);
    expect(managePos).toBeLessThan(configurationPos);
    const runtimePos = settingsTabSource.indexOf("<RuntimeHarnessCard");
    expect(runtimePos).toBeGreaterThan(configurationPos);
  });
});

describe("settings heading idiom (QC convergence)", () => {
  test("the appId identity header is the rendered heading-24 h1; no raw size utility appears on either face", () => {
    // SUPERSEDE (App detail IA): the identity header moved onto the
    // AppDetailPage shell with the heading-24 face; that face now lives in
    // the ONE PageHeader spelling and the shell composes it. The settings tab
    // keeps the card-title heading-16 step only.
    //
    // Rendering alone cannot express OWNERSHIP: a shell that inlines the same
    // heading-24 triple renders byte-identical markup. The source pins below
    // are what keep the face single-homed — the shell composes <PageHeader>
    // and PageHeader is the only file spelling the triple.
    const shell = withLocation("/dashboard/apps/1", () =>
      renderToStaticMarkup(
        createElement(AppDetailView, {
          locale: "en",
          appId: "1",
          payload: detailPayload(),
          groups: [],
          notice: null,
          search: { tab: "settings", window: "30", repo: "" },
          onReload: async () => true,
          onSearch: () => {},
        }),
      ),
    );
    // The identity header is the page's ONLY heading, and it carries the
    // heading-24 trio with the appId as its content.
    expect(shell.match(/<h1/g)).toHaveLength(1);
    expect(shell.match(/--typo-heading-24-size/g)).toHaveLength(1);
    expect(shell).toContain(
      '<h1 class="font-semibold text-(length:--typo-heading-24-size) leading-(--typo-heading-24-line) tracking-(--typo-heading-24-tracking)\">Demo</h1>',
    );
    // Ownership: the triple is spelled once, in PageHeader, and the shell
    // composes it rather than re-spelling it.
    expect(pageHeader).toContain("text-(length:--typo-heading-24-size)");
    expect(pageHeader).toContain("leading-(--typo-heading-24-line)");
    expect(pageHeader).toContain("tracking-(--typo-heading-24-tracking)");
    expect(detailPage).toContain("<PageHeader");
    expect(detailPage).toContain("title={appDisplayName(payload.app)}");
    expect(detailPage).not.toContain("--typo-heading-24");
    expect(settingsTabSource).not.toContain("--typo-heading-24");
    // Card titles ride the heading-16 step instead — the detail face never
    // re-spells the page title at that size.
    const cardTitles = [...shell.matchAll(/data-slot="card-title" class="([^"]*)"/g)].map(
      (match) => match[1] ?? "",
    );
    expect(cardTitles.length).toBeGreaterThan(0);
    for (const title of cardTitles) {
      expect(title).toContain("text-(length:--typo-heading-16-size)");
      expect(title).not.toContain("--typo-heading-24");
    }
    // No raw Tailwind size utility reaches either rendered face.
    for (const [name, html] of [
      ["AppDetailView", shell],
      ["SettingsPage", settingsTabSource],
    ] as const) {
      for (const utility of ["text-2xl", "text-xl", "text-lg"]) {
        expect(html, `${name} ${utility}`).not.toContain(utility);
      }
    }
  });

  test("re-parented card titles ride the heading-16 token step via SectionCardTitle", () => {
    expect(sectionCard).toContain("text-(length:--typo-heading-16-size)");
    expect(sectionCard).toContain("leading-(--typo-heading-16-line)");
    expect(sectionCard).toContain("tracking-(--typo-heading-16-tracking)");
    // Each re-parented card consumes the upgraded title (the T1 wave re-parented
    // identity/status + runtime harness; T2 added providers/chains/seats — pinned
    // in the T2 describe below). End anchors use the file's cardBlock
    // next-declaration pattern so prose near a signature can't break the pin.
    const cardBlock = (start: string, end: string) => {
      const from = settingsTabSource.indexOf(start);
      expect(from, start).toBeGreaterThan(-1);
      return settingsTabSource.slice(from, settingsTabSource.indexOf(end, from));
    };
    for (const [card, next] of [
      ["export function AppInfoCard", "function HealthBody"],
      ["function RuntimeHarnessCard", "function RuntimeHarnessEditor"],
      ["function OpsCard", "function ChainsCard"],
    ] as const) {
      expect(cardBlock(card, next), card).toContain("<SectionCardTitle>");
    }
  });
});

describe("group eyebrow copy (A8)", () => {
  test("appInfo/configuration keys exist atomically in both locales", () => {
    for (const key of ["settings.group.appInfo", "settings.group.configuration"] as const) {
      const en = t("en", key);
      const zh = t("zh_CN", key);
      expect(en.length, key).toBeGreaterThan(0);
      expect(zh.length, key).toBeGreaterThan(0);
      expect(zh, key).not.toBe(en);
      expect(en, key).not.toContain("{");
      expect(zh, key).not.toContain("{");
    }
    expect(t("en", "settings.group.appInfo")).toBe("App info");
    expect(t("zh_CN", "settings.group.appInfo")).toBe("应用信息");
    expect(t("en", "settings.group.configuration")).toBe("Configuration");
    expect(t("zh_CN", "settings.group.configuration")).toBe("配置");
  });
});

describe("providers/chains/seats re-parent (AD-591)", () => {
  const cardBlock = (start: string, end: string) => {
    const from = settingsTabSource.indexOf(start);
    expect(from, start).toBeGreaterThan(-1);
    return settingsTabSource.slice(from, settingsTabSource.indexOf(end, from));
  };

  test("the three configuration cards ride the Tier 2 surface through the prop, not hand-assembled faces", () => {
    // The page never spells tier classes (the T1 single-point pin above); the
    // three manage-face configuration cards re-parent exactly like the
    // runtime harness card did — one prop, zero per-block className assembly.
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
    expect(settingsTabSource).not.toContain("<Card>");
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
    // (the combobox aria-labelledby picker label rides its own pinned idiom).
    const labelIdiom = 'className="flex flex-col gap-1.5 text-sm font-medium"';
    expect(settingsTabSource.split(labelIdiom).length - 1).toBeGreaterThanOrEqual(8);
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
    // padded row body (mirror-row compactness, faces retuned only).
    for (const row of [keyRow, customRow]) {
      expect(row).toContain("flex flex-wrap items-center justify-between gap-2 rounded-md border p-3");
    }
  });
});

describe("provider combobox panel face", () => {
  const combobox = readFileSync(join(spaRoot, "components/provider-combobox.tsx"), "utf8");

  test("the open panel rides the v0.3 popover elevation; group labels ride the label-12 idiom", () => {
    // DESIGN.md elevation: shadow-pop is the popover/disclosure step (the
    // SelectContent face); the generic shadow-md is gone. Container
    // radius tier + popover surface stay, and the height cap / internal
    // scroll (combobox pins) is untouched.
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

describe("notice face (A5)", () => {
  const pageNotice = readFileSync(join(spaRoot, "pages/PageNotice.tsx"), "utf8");

  test("each kind renders its semantic glyph; the alert/status role contract is untouched", () => {
    // v0.3 dual-state form: success/warn/error get their semantic glyph over
    // the tinted token face. The WCAG 4.1.3 role pin survives
    // verbatim, and the kind two-value + message semantics are unchanged
    // (op-outcome notices keep the PageNotice channel — AD-582 boundary).
    expect(pageNotice).toContain('role={kind === "error" ? "alert" : "status"}');
    const html = (kind: "success" | "warn" | "error") =>
      renderToStaticMarkup(createElement(PageNotice, { kind, message: "msg" }));
    for (const kind of ["success", "warn", "error"] as const) {
      const out = html(kind);
      expect(out, kind).toContain("<svg");
      expect(out, kind).toContain('aria-hidden="true"');
      expect(out, kind).toContain(">msg</span>");
    }
    expect(html("error")).toContain('role="alert"');
    expect(html("success")).toContain('role="status"');
    expect(html("warn")).toContain('role="status"');
    expect(pageNotice).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  test("the notice face rides the DESIGN.md Notice contract (16px padding, copy-14 line)", () => {
    const block = pagesCss.match(/\.notice \{[\s\S]*?\n\}/);
    expect(block).not.toBeNull();
    const css = block![0];
    // 16px padding (spacing-4 — converges with the SSR .banner face) and the
    // copy-14 line step; the flex row carries the glyph at the text's edge.
    expect(css).toContain("padding: var(--spacing-4)");
    expect(css).not.toContain("padding: var(--spacing-3)");
    expect(css).toContain("line-height: var(--typo-copy-14-line)");
    expect(css).toContain("font-size: var(--typo-copy-14-size)");
    expect(css).toContain("display: flex");
    expect(css).toContain("gap: var(--spacing-2)");
    // Token discipline: semantic tones stay on the --notice-* component vars.
    expect(css).toContain("var(--notice-success-border)");
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe("composed load/error states (A6)", () => {
  test("the foreground load gate rides the forms skeleton; retry wires the shell's load", () => {
    // SUPERSEDE (App detail IA): the load machinery lives on the
    // AppDetailPage shell now — the skeleton is the page's full loading face
    // (its heading placeholder stands in for the real h1; the settings kind
    // is "forms", AD-582), and retry binds the foreground load, the only
    // path that flips state back to "loading" (the background-reload
    // contract: op-triggered reloads never flash the skeleton).
    expect(detailPage).toContain('<PageSkeleton locale={locale} kind="forms" />');
    expect(detailPage).toContain('<ErrorState locale={locale} onRetry={() => void load()} />');
    // The old text-notice faces are retired from this page.
    expect(detailPage).not.toContain("LoadingNotice");
    expect(detailPage).not.toContain("LoadFailedNotice");
    // The background-reload failure channel stays the page banner.
    expect(detailPage).toContain('{notice ? <PageNotice kind={notice.kind} message={notice.message} /> : null}');
  });
});

describe("chains panel faces (review deferrals)", () => {
  test("the named-chain panel title rides the heading-16 token idiom (SectionCardTitle's face)", () => {
    const chainsBody = settingsTabSource.slice(
      settingsTabSource.indexOf("function ChainsCard"),
      settingsTabSource.indexOf("function SeatsCard"),
    );
    // The panel title now composes the shared SectionCardTitle
    // instead of re-spelling the heading-16 utility chain at the site.
    expect(chainsBody).toContain("<SectionCardTitle>{tab.id}</SectionCardTitle>");
    expect(chainsBody).not.toContain("text-(length:--typo-heading-16-size)");
    // No bare 16px-inherit title face remains in the panel header.
    expect(chainsBody).not.toContain('<span className="font-medium">{tab.id}</span>');
  });

  test("the selector-row remove is a local edit (outline); stored-data removes stay destructive", () => {
    // The ChainEditor row remove filters the UNSAVED local list — recoverable,
    // no dialog, no server op — so it rides the AD-552 local-edit face. The
    // named-chain header remove opens the confirm dialog (stored chain) and
    // keeps the destructive face.
    const editorBody = settingsPageOnly.slice(settingsPageOnly.indexOf("function ChainEditor"));
    expect(editorBody).toContain('variant="outline"');
    expect(editorBody).toContain('onClick={() => setChain(chain.filter((_, i) => i !== index))}');
    expect(editorBody).not.toContain('variant="destructive"');
    const chainsBody = settingsTabSource.slice(
      settingsTabSource.indexOf("function ChainsCard"),
      settingsTabSource.indexOf("function SeatsCard"),
    );
    expect(chainsBody).toContain('variant="destructive" size="sm" onClick={() => onRemoveChain(tab.id)}');
  });

  test("the draft panel opens with a compact identity-field header; the controlled wiring is intact", () => {
    const panelBody = settingsTabSource.slice(
      settingsTabSource.indexOf("function DraftChainPanel"),
      settingsTabSource.indexOf("function ChainEditor"),
    );
    // The name field is the panel's identity header: compact block (w-fit +
    // w-64, the invite-input idiom), label-above-control idiom preserved.
    expect(panelBody).toContain('className="flex w-fit flex-col gap-1.5 text-sm font-medium"');
    expect(panelBody).toContain('className="w-64"');
    // AD-551 controlled surface + the busy-gate-only state inventory (pinned
    // in settings-layout) are untouched — presence re-checked here.
    expect(panelBody).toContain("value={name}");
    expect(panelBody).toContain("onNameChange(event.target.value)");
    expect(panelBody.match(/useState\([^)]*\)/g) ?? []).toEqual(["useState(false)"]);
  });
});

describe("section description wording (A8)", () => {
  test("the Default-chain term stays stable across zh faces (wording consistency pass)", () => {
    // The stable technical term is the capitalized chain id; the zh faces for
    // the remove-cascade and the chains description used a lowercase drift.
    expect(t("zh_CN", "settings.seatsCopy")).toContain("回退到 Default");
    expect(t("zh_CN", "settings.modelChainsCopy")).toContain("回退到 Default 链");
    expect(t("zh_CN", "settings.confirmRemoveChainBody")).toContain("回退到 Default 链");
    for (const key of ["settings.modelChainsCopy", "settings.confirmRemoveChainBody"] as const) {
      expect(t("zh_CN", key), key).not.toContain("回退到 default");
    }
    // Pinned technical facts of the touched description survive the pass.
    expect(t("en", "settings.modelChainsCopy")).toContain("tabs");
    expect(t("en", "settings.modelChainsCopy")).toContain("can't be removed");
    expect(t("zh_CN", "settings.modelChainsCopy")).toContain("标签页");
    expect(t("zh_CN", "settings.modelChainsCopy")).toContain("无法移除");
  });
});
