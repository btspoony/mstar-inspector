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
import { SectionCard } from "../../src/spa/components/SectionCard";
import { PageNotice } from "../../src/spa/pages/PageNotice";
import { AppDetailView } from "../../src/spa/pages/AppDetailPage";
import { withLocation } from "./browser-stub";

const spaRoot = join(import.meta.dir, "../../src/spa");
const sectionCard = readFileSync(join(spaRoot, "components/SectionCard.tsx"), "utf8");
const settingsPageOnly = readFileSync(join(spaRoot, "pages/SettingsPage.tsx"), "utf8");
/** The settings tab's source: the page plus the providers modules it composes. */
const settingsTabSource =
  settingsPageOnly +
  readFileSync(join(spaRoot, "pages/settings-providers.tsx"), "utf8") +
  readFileSync(join(spaRoot, "pages/providers-dialogs.tsx"), "utf8");
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
    expect(sectionCard).toMatch(/import \{[^}]*\bCard\b[^}]*\} from "@design-system";/);
    // The tier prop is the closed two-value union — no third tier can creep in.
    expect(sectionCard).toContain('type SectionTier = "primary" | "secondary"');
    // Each tier face names a border colour token (the primitive's bare
    // `border` is width only, and preflight would paint it in currentColor),
    // and neither carries elevation — shadows belong to overlays.
    const faces = [...sectionCard.matchAll(/(primary|secondary):\s*"([^"]*)"/g)];
    expect(faces.map(([, tier]) => tier)).toEqual(["primary", "secondary"]);
    for (const [, tier, face] of faces) {
      expect(face, tier).toMatch(/border-\(--[\w-]+\)/);
      expect(face, tier).not.toMatch(/shadow/);
    }
    // Zero raw hex in the idiom file.
    expect(sectionCard).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  test("tiers render distinct faces through the card primitive (SSR)", () => {
    const html = (tier: "primary" | "secondary") =>
      renderToStaticMarkup(createElement(SectionCard, { tier }, "content"));
    for (const tier of ["primary", "secondary"] as const) {
      const markup = html(tier);
      expect(markup).toContain(`data-tier="${tier}"`);
      expect(markup).toContain('data-slot="card"');
      // r3: an inline card is a hairline plus the surface step, never an
      // elevated plane. Which hairline strength each tier takes is the
      // surface-idioms test's assertion, not a pinned class here.
      expect(markup).not.toMatch(/shadow-/);
    }
  });
});

describe("settings section flow (r3 baseline § 5)", () => {
  const providersSource = readFileSync(join(spaRoot, "pages/settings-providers.tsx"), "utf8");

  test("every settings section composes the exported FlowSection — no per-section card frame", () => {
    // The settings body is ONE content plane divided by hairlines: the plan's
    // sections are the design system's FlowSection, not six framed cards. The
    // section face is the pattern's; the page passes copy and body only.
    const sectionBlock = (start: string, end: string) => {
      const from = settingsTabSource.indexOf(start);
      expect(from, start).toBeGreaterThan(-1);
      const to = settingsTabSource.indexOf(end, from);
      expect(to, `${start} → ${end}`).toBeGreaterThan(from);
      return settingsTabSource.slice(from, to);
    };
    for (const [section, end, titleKey] of [
      ["export function AppInfoSection", "export function InstallationsSection", "settings.appInfo"],
      ["export function InstallationsSection", "export function RuntimeHarnessSection", "settings.installations"],
      ["export function RuntimeHarnessSection", "function RuntimeHarnessEditor", "settings.runtimeHarness"],
      ["function ChainsSection", "function SeatsSection", "settings.modelChains"],
      ["function SeatsSection", "function DraftChainPanel", "settings.seats"],
      ["function OpsSection", "const NAME_MAX_LENGTH", "settings.ops"],
    ] as const) {
      const body = sectionBlock(section, end);
      expect(body, section).toContain("<FlowSection");
      expect(body, section).toContain(titleKey);
      expect(body, section).not.toContain("<SectionCard tier");
    }
    // Providers lives in its own module and follows the same pattern; the
    // grouped provider cards (the v1.4 contract) stay GroupCards inside it.
    expect(providersSource).toContain("<FlowSection");
    expect(providersSource).not.toContain("<SectionCard");
  });

  test("the section order is the plan's: identity, installations, runtime, configuration, seats, ops", () => {
    let cursor = -1;
    for (const marker of [
      "<AppInfoSection",
      "<InstallationsSection",
      "<RuntimeHarnessSection",
      "<ProvidersSection",
      "<ChainsSection",
      "<SeatsSection",
      "<OpsSection",
    ]) {
      const at = settingsTabSource.indexOf(marker, cursor + 1);
      expect(at, marker).toBeGreaterThan(cursor);
      cursor = at;
    }
    // The sections are direct siblings of one flow plane: the manage face
    // opens that plane once and never re-groups it into tiers.
    expect(settingsTabSource).not.toContain("SectionGroup");
    expect(settingsTabSource).toMatch(/gap-\(--spacing-[a-z0-9-]+\)/);
  });

  test("the flow itself is the design system's pattern, not a page-local re-spelling", () => {
    for (const [name, source] of [
      ["SettingsPage", settingsPageOnly],
      ["settings-providers", providersSource],
    ] as const) {
      expect(source, name).toMatch(/import \{[^}]*\bFlowSection\b[^}]*\} from "@design-system"/);
    }
    // A section separator is the pattern's hairline; no page hand-spells a
    // bordered section face or a card tier.
    expect(settingsTabSource).not.toContain("border-b border-(--border-subtle)");
    expect(settingsTabSource).not.toContain("data-tier");
  });
});

describe("settings heading idiom (QC convergence)", () => {
  test("the appId identity header is the rendered heading-24 h1; sections title with h2", () => {
    // SUPERSEDE (App detail IA): the identity header lives on the AppDetailPage
    // shell with the heading-24 face; that face lives in the ONE PageHeader
    // spelling and the shell composes it. Below it the settings body is the
    // section flow, whose titles are the pattern's h2 — never a second page
    // title.
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
    // The identity header is the page's ONLY h1, and it carries the App's
    // display name as its content.
    expect(shell.match(/<h1/g)).toHaveLength(1);
    expect(shell).toContain('<h1 data-slot="page-header-title"');
    expect(shell).toContain(">Demo</h1>");
    // Ownership: the title face is PageHeader's, and the shell composes it
    // rather than re-spelling it.
    expect(pageHeader).toContain('data-slot="page-header-title"');
    expect(detailPage).toContain("<PageHeader");
    expect(detailPage).toContain("title={appDisplayName(payload.app)}");
    expect(detailPage).not.toContain("--typo-heading-24");
    expect(settingsTabSource).not.toContain("--typo-heading-24");
    // Section titles are the flow's h2, one level under the page h1.
    expect(shell).toContain('data-slot="flow-section"');
    expect(shell).toContain('<h2 class=');
    expect(shell.match(/data-slot="page-header-title"/g)).toHaveLength(1);
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

  test("the heading-16 title step stays single-homed (the named-chain panel composes SectionCardTitle)", () => {
    // A tabpanel title inside the chains section is still a card-title face
    // (heading-16), composed rather than re-spelled; the section titles above
    // it are FlowSection's, so the page never spells the token step itself.
    const chainsBody = settingsTabSource.slice(
      settingsTabSource.indexOf("function ChainsSection"),
      settingsTabSource.indexOf("function SeatsSection"),
    );
    expect(chainsBody).toContain("<SectionCardTitle>");
    expect(settingsTabSource).not.toContain("--typo-heading-16");
  });
});

describe("configuration sections (providers / chains / seats)", () => {
  test("the configuration sections keep the v1.4 provider grouping inside the flow", () => {
    // The setup re-face changes the section chrome only: one group card per
    // configured provider id, its key rows, and the three dialogs stay as
    // they were (AC-10/AC-12 — provider configuration lives in this tab).
    expect(settingsTabSource).not.toContain("<Card>");
    for (const [section, next] of [
      ["function ChainsSection", "function SeatsSection"],
      ["function SeatsSection", "function DraftChainPanel"],
    ] as const) {
      const from = settingsTabSource.indexOf(section);
      expect(from, section).toBeGreaterThan(-1);
      const body = settingsTabSource.slice(from, settingsTabSource.indexOf(next, from));
      expect(body, section).toContain("<FlowSection");
      expect(body, section).not.toContain("<SectionCard tier");
    }
  });

  test("form labels stay label-above-control; the mirror rows speak one compact dialect", () => {
    // The shared label-above-field wrapper survives untouched on every
    // ProviderConfigForm / CustomExpand / DraftChainPanel / SeatsSection field
    // (the combobox aria-labelledby picker label rides its own pinned idiom).
    const labelIdiom = 'className="flex flex-col gap-1.5 text-sm font-medium"';
    expect(settingsTabSource.split(labelIdiom).length - 1).toBeGreaterThanOrEqual(8);
    // The configured rows are the shared list-row / group-card composition
    // (the shared components), never a hand-assembled row dialect: identity →
    // status → meta → actions arrives through ListRow props, the pill through
    // StatusBadge, the group chrome through GroupCard.
    // The group card is the providers module's tail (the forms live in the
    // dialog module), so the slice runs to the end of it.
    const groupCard = settingsTabSource.slice(settingsTabSource.indexOf("function ProviderGroupCard"));
    expect(groupCard).toContain("<GroupCard>");
    expect(groupCard).toContain("<GroupCardHeader");
    expect(groupCard).toContain("<GroupCardBody>");
    expect(groupCard).toContain("<ListRowGroup>");
    expect(groupCard).toContain("<ListRow");
    expect(groupCard).toContain("<StatusBadge");
    expect(settingsTabSource).toContain('from "../components/GroupCard"');
    expect(settingsTabSource).toContain('from "../components/ListRow"');
    expect(settingsTabSource).toMatch(/import \{[^}]*\bStatusBadge\b[^}]*\} from "@design-system"/);
  });
});

describe("provider combobox panel face", () => {
  const combobox = readFileSync(join(spaRoot, "components/provider-combobox.tsx"), "utf8");

  test("the open panel is the capped, scrollable overlay; no generic shadow returns", () => {
    // The panel exists only while the picker is open, caps its height and
    // scrolls internally; its surface and elevation are the overlay tokens.
    expect(combobox).toContain("{open ? (");
    expect(combobox).toContain("max-h-72");
    expect(combobox).toContain("overflow-y-auto");
    expect(combobox).not.toContain("shadow-md");
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
    // Token discipline: the notice reads the tone system directly — the
    // --notice-* aliases retired with plan 203 task 7.
    expect(css).toContain("var(--tone-success-border)");
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
      settingsTabSource.indexOf("function ChainsSection"),
      settingsTabSource.indexOf("function SeatsSection"),
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
      settingsTabSource.indexOf("function ChainsSection"),
      settingsTabSource.indexOf("function SeatsSection"),
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
