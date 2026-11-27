import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../../src/i18n";
import { SectionCard } from "../../src/spa/components/SectionCard";
import { PageNotice, type OpNotice } from "../../src/spa/pages/PageNotice";
import { AppDetailView } from "../../src/spa/pages/AppDetailPage";
import type { BotConfigSections, BotSettingsPayload, SettingsManagePayload, ProviderManagementPayload } from "../../src/spa/pages/data";
import { BotSettingsView } from "../../src/spa/pages/BotSettingsPage";
import { DeliveryStatusView } from "../../src/spa/pages/AppDeliveryTab";
import { LoadedProvidersSection as ProvidersSection } from "../../src/spa/pages/settings-providers";
import { alertSegments } from "../helpers/token-colour";
import { withLocation } from "./browser-stub";

const spaRoot = join(import.meta.dir, "../../src/spa");
const sectionCard = readFileSync(join(spaRoot, "components/SectionCard.tsx"), "utf8");
const settingsPageOnly = readFileSync(join(spaRoot, "pages/SettingsPage.tsx"), "utf8");
const botPageOnly = readFileSync(join(spaRoot, "pages/BotSettingsPage.tsx"), "utf8");
const settingsTabSource =
  settingsPageOnly +
  botPageOnly +
  readFileSync(join(spaRoot, "pages/settings-providers.tsx"), "utf8") +
  readFileSync(join(spaRoot, "pages/providers-dialogs.tsx"), "utf8");
const detailPage = readFileSync(join(spaRoot, "pages/AppDetailPage.tsx"), "utf8");
const pageHeader = readFileSync(join(spaRoot, "components/PageHeader.tsx"), "utf8");
const pagesCss = readFileSync(join(spaRoot, "pages.module.css"), "utf8");

const detailPayload = (): SettingsManagePayload => ({
  can_manage: true,
  viewer_relation: "created",
  installation: null,
  pending_installations: [],
  workspace_id: "ws_0123456789abcdefghijkl",
  target_id: "rt-501",
  blocked: false as const,
  blocked_reason: null,
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
    scope: "owned" as const,
    sandbox_image_id: "omp",
    review_trigger_mode: "every_push",
    review_level: null,
    default_review_level: "default",
    github_visibility: "unknown",
  },
  check_gate: { min_score: 80, pass_verdicts: ["ship it"] },
  keys: [],
  model_chain: null,
  model_roles: {},
  model_chains: [],
  custom_providers: [],
  configured_providers: [],
  provider_catalog_version: "fixture-catalog",
  provider_eligibility: {},
  model_role_ids: [],
  custom_provider_api_ids: [],
  sandbox_images: [{ id: "omp", enabled: true }],
  installations: [],
});

const providersPayload = (): SettingsManagePayload & ProviderManagementPayload => ({
  ...detailPayload(),
  model_limits_snapshot: "fixture-snapshot",
  keys: [
    {
      provider: "openai",
      keyId: "0123456789abcdef",
      last4: "abcd",
      updatedAt: null,
      verifiedAt: null,
      verifiedStatus: null,
    },
  ],
  provider_catalog: [
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
});

describe("SectionCard tier idiom (AD-591)", () => {
  test("the idiom is single-point: a hand-written wrapper composing ui/card, not a copy-in edit", () => {
    expect(sectionCard).toMatch(/import \{[^}]*\bCard\b[^}]*\} from "@design-system";/);
    expect(sectionCard).toContain('type SectionTier = "primary" | "secondary"');
    const faces = [...sectionCard.matchAll(/(primary|secondary):\s*"([^"]*)"/g)];
    expect(faces.map(([, tier]) => tier)).toEqual(["primary", "secondary"]);
    for (const [, tier, face] of faces) {
      expect(face, tier).toMatch(/border-\(--[\w-]+\)/);
      expect(face, tier).not.toMatch(/shadow/);
    }
    expect(sectionCard).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });

  test("tiers render distinct faces through the card primitive (SSR)", () => {
    const html = (tier: "primary" | "secondary") =>
      renderToStaticMarkup(createElement(SectionCard, { tier }, "content"));
    for (const tier of ["primary", "secondary"] as const) {
      const markup = html(tier);
      expect(markup).toContain(`data-tier="${tier}"`);
      expect(markup).toContain('data-slot="card"');
      expect(markup).not.toMatch(/shadow-/);
    }
  });
});

describe("settings section flow (r3 baseline § 5)", () => {
  const providersSource = readFileSync(join(spaRoot, "pages/settings-providers.tsx"), "utf8");

  test("every settings section composes the exported FlowSection — no per-section card frame", () => {
    const sectionBlock = (start: string, end: string) => {
      const from = settingsTabSource.indexOf(start);
      expect(from, start).toBeGreaterThan(-1);
      const to = settingsTabSource.indexOf(end, from);
      expect(to, `${start} → ${end}`).toBeGreaterThan(from);
      return settingsTabSource.slice(from, to);
    };
    for (const [section, end, titleKey] of [
      ["export function AppInfoSection", "export function AppInstallSection", "settings.appInfo"],
      ["export function AppInstallSection", "export function AppInstallationsSection", "settings.install"],
      ["export function AppInstallationsSection", "export function RuntimeHarnessEditor", "settings.installations"],
      ["export function ChainsSection", "export function SeatsSection", "settings.modelChains"],
      ["export function SeatsSection", "export function DraftChainPanel", "settings.seats"],
      ["function OpsSection", "export function WorkspaceNameCard", "settings.ops"],
    ] as const) {
      const body = sectionBlock(section, end);
      expect(body, section).toContain("<FlowSection");
      expect(body, section).toContain(titleKey);
      expect(body, section).not.toContain("<SectionCard tier");
    }
    expect(providersSource).toContain("<FlowSection");
    expect(providersSource).not.toContain("<SectionCard");
  });

  test("the App settings body keeps the identity card only; the target policy lives on the repository surface", () => {
    const view = settingsTabSource.slice(
      settingsTabSource.indexOf("export function SettingsView"),
      settingsTabSource.indexOf("export function pendingConfirmCopy"),
    );
    expect(view).toContain("<AppInfoSection");
    expect(settingsTabSource).toContain("export function OpsSection");
    for (const marker of ["<ReviewTriggerSection", "<ReviewDepthSection", "<ReviewGateSection"]) {
      expect(settingsTabSource, marker).not.toContain(`export function ${marker.slice(1)}`);
      expect(view, marker).not.toContain(marker);
    }
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
    expect(settingsTabSource).not.toContain("border-b border-(--border-subtle)");
    expect(settingsTabSource).not.toContain("data-tier");
  });
});

describe("settings heading idiom (QC convergence)", () => {
  test("the appId identity header is the rendered heading-24 h1; sections title with h2", () => {
    const shell = withLocation("/dashboard/apps/1", () =>
      renderToStaticMarkup(
        createElement(AppDetailView, {
          locale: "en",
          appId: "1",
          payload: detailPayload(),
          groups: [],
          notice: null,
          search: { tab: "settings", window: "30", repo: "", pr: "" },
          onReload: async () => true,
          onSearch: () => {},
        }),
      ),
    );
    expect(shell.match(/<h1/g)).toHaveLength(1);
    expect(shell).toContain('<h1 data-slot="page-header-title"');
    expect(shell).toContain(">Demo</h1>");
    expect(pageHeader).toContain('data-slot="page-header-title"');
    expect(detailPage).toContain("<PageHeader");
    expect(detailPage).toContain("title={appDisplayName(payload.app)}");
    expect(detailPage).not.toContain("--typo-heading-24");
    expect(settingsTabSource).not.toContain("--typo-heading-24");
    expect(shell).toContain('data-slot="flow-section"');
    expect(shell).toContain('<h2 class=');
    expect(shell.match(/data-slot="page-header-title"/g)).toHaveLength(1);
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
    const labelIdiom = 'className="flex flex-col gap-1.5 text-sm font-medium"';
    expect(settingsTabSource.split(labelIdiom).length - 1).toBeGreaterThanOrEqual(8);
    const groupCard = settingsTabSource.slice(settingsTabSource.indexOf("function ProviderGroupCard"));
    expect(groupCard).toContain("<GroupCard>");
    expect(groupCard).toContain("<GroupCardHeader");
    expect(groupCard).toContain("<GroupCardBody>");
    expect(groupCard).toContain("<ListRowGroup>");
    expect(groupCard).toContain("<ListRow");
    expect(groupCard).toContain("<StatusBadge");
    expect(settingsTabSource).toContain('from "../components/GroupCard"');
    expect(settingsTabSource).toContain('from "../components/ListRow"');
    expect(
      renderToStaticMarkup(
        createElement(ProvidersSection, {
          locale: "en",
          payload: providersPayload(),
          onVerify: async (): Promise<OpNotice> => ({ kind: "success", message: "" }),
          onSettings: async (): Promise<OpNotice> => ({ kind: "success", message: "" }),
          onPending: () => {},
          notice: null,
          removeOutcome: null,
          onOutcome: () => {},
          onReload: async () => {},
        }),
      ),
    ).toContain(
      `data-slot="status-badge" data-tone="neutral" data-strength="soft">${t("en", "settings.providers.tier.builtin")}</span>`,
    );
  });
});

describe("provider combobox panel face", () => {
  const combobox = readFileSync(join(spaRoot, "components/provider-combobox.tsx"), "utf8");

  test("the open panel is the capped, scrollable overlay; no generic shadow returns", () => {
    expect(combobox).toContain("{open ? (");
    expect(combobox).toContain("max-h-72");
    expect(combobox).toContain("overflow-y-auto");
    expect(combobox).not.toContain("shadow-md");
    expect(combobox).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe("notice face (A5)", () => {
  const pageNotice = readFileSync(join(spaRoot, "pages/PageNotice.tsx"), "utf8");

  test("each kind renders its semantic glyph; the alert/status role contract is untouched", () => {
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
    expect(css).toContain("padding: var(--spacing-4)");
    expect(css).not.toContain("padding: var(--spacing-3)");
    expect(css).toContain("line-height: var(--typo-copy-14-line)");
    expect(css).toContain("font-size: var(--typo-copy-14-size)");
    expect(css).toContain("display: flex");
    expect(css).toContain("gap: var(--spacing-2)");
    expect(css).toContain("var(--tone-success-border)");
    expect(css).not.toMatch(/#[0-9a-fA-F]{3,8}\b/);
  });
});

describe("composed load/error states (A6)", () => {
  test("the foreground load gate rides the forms skeleton; retry wires the shell's load", () => {
    expect(detailPage).toContain('<PageSkeleton locale={locale} kind="forms" />');
    expect(detailPage).toContain('<ErrorState locale={locale} onRetry={() => void load()} />');
    expect(detailPage).not.toContain("LoadingNotice");
    expect(detailPage).not.toContain("LoadFailedNotice");
    expect(detailPage).toContain('{notice ? <PageNotice kind={notice.kind} message={notice.message} /> : null}');
  });
});

describe("chains panel faces (review deferrals)", () => {
  test("the named-chain panel title rides the heading-16 token idiom (SectionCardTitle's face)", () => {
    const chainsBody = settingsTabSource.slice(
      settingsTabSource.indexOf("function ChainsSection"),
      settingsTabSource.indexOf("function SeatsSection"),
    );
    expect(chainsBody).toContain("<SectionCardTitle>{tab.id}</SectionCardTitle>");
    expect(chainsBody).not.toContain("text-(length:--typo-heading-16-size)");
    expect(chainsBody).not.toContain('<span className="font-medium">{tab.id}</span>');
  });

  test("the selector-row remove is a local edit (outline); stored-data removes stay destructive", () => {
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
    expect(panelBody).toContain('className="flex w-fit flex-col gap-1.5 text-sm font-medium"');
    expect(panelBody).toContain('className="w-64"');
    expect(panelBody).toContain("value={name}");
    expect(panelBody).toContain("onNameChange(event.target.value)");
    expect(panelBody.match(/useState\([^)]*\)/g) ?? []).toEqual(["useState(false)"]);
  });
});

describe("section description wording (A8)", () => {
  test("the Default-chain term stays stable across zh faces (wording consistency pass)", () => {
    expect(t("zh_CN", "settings.seatsCopy")).toContain("回退到 Default");
    expect(t("zh_CN", "settings.modelChainsCopy")).toContain("回退到 Default 链");
    expect(t("zh_CN", "settings.confirmRemoveChainBody")).toContain("回退到 Default 链");
    for (const key of ["settings.modelChainsCopy", "settings.confirmRemoveChainBody"] as const) {
      expect(t("zh_CN", key), key).not.toContain("回退到 default");
    }
    expect(t("en", "settings.modelChainsCopy")).toContain("tabs");
    expect(t("en", "settings.modelChainsCopy")).toContain("can't be removed");
    expect(t("zh_CN", "settings.modelChainsCopy")).toContain("标签页");
    expect(t("zh_CN", "settings.modelChainsCopy")).toContain("无法移除");
  });
});

describe("delivery-status summary line (I-000251)", () => {
  const render = (): string =>
    renderToStaticMarkup(
      createElement(DeliveryStatusView, {
        locale: "en",
        summary: { last_webhook_at: null },
        page: null,
        filters: { repo: "", since: "", type: "" },
        offset: 0,
        loading: false,
        onFilter: () => {},
        onPage: () => {},
        onReload: () => {},
      }),
    );

  test("the summary line is the webhook stamp alone — the 24h figure is banned everywhere", () => {
    const lastWebhook = t("en", "settings.lastWebhook", { time: t("en", "common.time.never") });
    expect(render()).toContain(lastWebhook);
    expect(render()).not.toContain("24h");
    expect(alertSegments(render(), "light")).toEqual([]);
  });
});

describe("the bot page carries the moved sections", () => {
  const botPayload = (): BotSettingsPayload => ({
    can_manage: true,
    archived: false,
    app: {
      github_app_id: 1,
      id: "app-demo",
      status: "active",
      scope: "owned",
      sandbox_image_id: "omp",
      last_webhook_at: null,
      github_name: "Demo",
      github_slug: "demo",
      github_description: null,
      github_html_url: null,
      github_avatar_url: null,
      github_metadata_synced_at: null,
    },
    keys: [
      {
        provider: "openai",
        keyId: "0123456789abcdef",
        last4: "wxyz",
        updatedAt: null,
        verifiedAt: null,
        verifiedStatus: null,
      },
    ],
    model_chain: "openai/gpt-5",
    model_roles: { "mstar-review-seat": "fast" },
    model_chains: [
      { name: "fast", chain: "openai/gpt-5-mini", is_default: false, created_at: "2026-01-01", updated_at: "2026-01-01" },
    ],
    custom_providers: [],
    configured_providers: [
      {
        kind: "key",
        provider: "openai",
        key_id: "0123456789abcdef",
        last4: "wxyz",
        updated_at: null,
        verified_at: null,
        verified_status: null,
      },
    ],
    provider_catalog_version: "fixture-catalog",
    provider_eligibility: {},
    model_role_ids: ["mstar-review-seat"],
    custom_provider_api_ids: [],
    sandbox_images: [{ id: "omp", enabled: true }],
    installations: [{ installation_id: 987654, account_login: "acme", seen_at: "2026-01-01 00:00:00" }],
  });

  test("a manager's bot sections render providers, chains, seats and the sandbox image", () => {
    const markup = renderToStaticMarkup(
      createElement(BotSettingsView, {
        locale: "en",
        payload: botPayload(),
        groups: [],
        notice: null,
        onReload: async () => true,
      }),
    );
    expect(markup).toContain(t("en", "settings.providers.title"));
    expect(markup).toContain(t("en", "common.loading"));
    expect(markup).toContain(t("en", "settings.modelChains"));
    expect(markup).toContain("openai/gpt-5");
    expect(markup).toContain("fast");
    expect(markup).toContain(t("en", "settings.seats"));
    expect(markup).toContain("omp");
  });

  // The retired "shared bot's page renders the same sections read-only" case:
  // the consumer FACE (read-only notice and none of the owner's machinery) is
  // proven in bot-detail-faces.test.tsx, and this view's non-manager sandbox
  // branch in runtime-harness-card.test.tsx. BotSettingsView carries no
  // read-only or scope copy of its own, so the case had no observable left.
});
