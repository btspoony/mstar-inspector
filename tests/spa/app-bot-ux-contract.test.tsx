/**
 * Task 10: the ADR acceptance criteria that only hold ACROSS surfaces.
 *
 * Each screen already pins its own face (Tasks 5–9). This suite pins the rules
 * that are only true when you read the App faces, the bot faces and the bots
 * list together:
 *
 *   1. relation → face   the same App renders differently for its installer and its creator
 *   2. tab sets          creator exactly three, every other face none
 *   3. absence           the installed and consumer faces carry the owner's machinery nowhere
 *   4. one chain control the installed chain has exactly one move/remove/add surface
 *   5. Credits           every amount is `N.NN Credits`, and no rendered string says RP
 *   6. archived          listed as 已归档, unavailable in an App chain, banner to the consumer
 *   7. bots list         two sections, create in the owned header only for a manager
 *
 * Fixtures are built locally and minimally on purpose: importing another test's
 * fixture would let one file's shape silently redefine this contract.
 */
import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../../src/i18n";
import type {
  AppChainEntry,
  AppDetailFrom,
  BotConfigSections,
  SettingsManagePayload,
  SettingsReadOnlyPayload,
  SettingsUntargetedPayload,
  UsableBotRow,
  UsableBotsPayload,
} from "../../src/spa/pages/data";
import { appDetailFace, formatCredits } from "../../src/spa/pages/data";
import { AppDetailView } from "../../src/spa/pages/AppDetailPage";
import { BotsView } from "../../src/spa/pages/BotsPage";
import { BotDetailPage } from "../../src/spa/pages/BotDetailPage";
import type { SpaBoot } from "../../src/spa/boot";
import { installDom, withMarkup } from "./dom";

const WORKSPACE_ID = "ws_0123456789abcdefghijkl";
const RATE = 500;
const BOOT: SpaBoot = { locale: "en", login: "mallory", name: "Mallory" };
const SEARCH = { tab: "settings" as const, window: "30" as const, repo: "", pr: "" };

/** One chain row carrying every field the faces read; callers override what they test. */
function chainRow(overrides: Partial<AppChainEntry> & { position: number; bot_id: string }): AppChainEntry {
  return {
    name: overrides.bot_id,
    description: null,
    provider_workspace: "Acme",
    owned: true,
    available: true,
    multiplier: 1,
    month_used_rp: 0,
    effective_monthly_rp: null,
    archived: false,
    default_chain: null,
    runtime: "omp",
    ...overrides,
  };
}

/** 620 RP live + 45 RP shared + 5 RP archived = 670 RP → 1.34 Credits at 500 RP/Credit. */
const CHAIN: AppChainEntry[] = [
  chainRow({ position: 1, bot_id: "bot-live", name: "Live Bot", month_used_rp: 620 }),
  chainRow({
    position: 2,
    bot_id: "bot-shared",
    name: "Shared Bot",
    provider_workspace: "platform",
    owned: false,
    month_used_rp: 45,
    effective_monthly_rp: 1000,
  }),
  chainRow({ position: 3, bot_id: "bot-archived", name: "Archived Bot", owned: false, month_used_rp: 5, archived: true }),
];

const INSTALLATIONS = [{ installation_id: 88123456, account_login: "mallory", seen_at: "2026-11-27 08:14" }];

const IDENTITY_APP = {
  github_slug: "acme-app",
  id: "app-acme",
  github_app_id: 4803300,
  status: "active",
  review_enabled: true,
  created_by: "mallory",
  created_at: "2026-01-01 00:00:00",
  github_name: "Acme Inspector",
  github_description: null,
  github_html_url: "https://github.com/apps/acme-app",
  github_avatar_url: null,
  github_metadata_synced_at: "2026-01-01 00:00:00",
};

/** The bot-owned sections the manager/unmanaged creator face carries. */
const CONFIG_SECTIONS: Omit<BotConfigSections, "app"> = {
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
  installations: INSTALLATIONS,
};

/** The manager (creator face) payload: this workspace owns the App and targets it. */
function managerPayload(): SettingsManagePayload {
  return {
    can_manage: true,
    can_edit_chain: false,
    viewer_relation: "created",
    rp_per_credit: RATE,
    official_workspace: true,
    can_configure_bot: true,
    installation: null,
    pending_installations: [],
    blocked: false,
    blocked_reason: null,
    workspace_id: WORKSPACE_ID,
    target_id: "rt-1",
    app: {
      ...IDENTITY_APP,
      last_webhook_at: null,
      scope: "owned",
      sandbox_image_id: "omp",
      review_trigger_mode: "every_push",
      review_level: null,
      default_review_level: "default",
      github_visibility: "unknown",
    },
    check_gate: null,
    chain: CHAIN,
    ...CONFIG_SECTIONS,
  };
}

/** The installed face opened by a member: no writes, the same rows read-only. */
function memberInstalledPayload(): SettingsReadOnlyPayload {
  return {
    can_manage: false,
    can_edit_chain: false,
    viewer_relation: "installed",
    rp_per_credit: RATE,
    workspace_id: WORKSPACE_ID,
    blocked: false,
    blocked_reason: null,
    app: IDENTITY_APP,
    installations: INSTALLATIONS,
    chain: CHAIN,
  };
}

/** A manager of a workspace that did not create the App: the installed face with controls. */
function managerInstalledPayload(): SettingsManagePayload {
  return {
    ...managerPayload(),
    viewer_relation: "installed",
    // The installer fact: the workspace holds the install row AND manages it,
    // so the chain controls are the server's own yes.
    can_edit_chain: true,
    installation: { id: 88123456, account_login: "mallory", removed: false },
  };
}

function renderApp(
  payload: SettingsManagePayload | SettingsReadOnlyPayload | SettingsUntargetedPayload,
  from: AppDetailFrom | null = null,
  locale: SpaBoot["locale"] = "en",
): string {
  return renderToStaticMarkup(
    createElement(AppDetailView, {
      locale,
      appId: "app-acme",
      payload,
      groups: [],
      notice: null,
      search: SEARCH,
      from,
      mountable: [{ id: "bot-mountable", name: "Mountable Bot" }],
      onReload: async () => true,
      onSearch: () => {},
    }),
  );
}

const tabLabels = (container: HTMLElement): string[] =>
  [...(container.querySelector('[role="tablist"]')?.querySelectorAll('[role="tab"]') ?? [])].map(
    (tab) => tab.textContent ?? "",
  );

/* ------------------------------------------------------------------ *
 * Bot-side fixtures
 * ------------------------------------------------------------------ */

function botPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    can_manage: true,
    owned: true,
    archived: false,
    official_workspace: true,
    app: {
      github_app_id: null,
      id: "bot-1",
      name: "Team Bot",
      description: "The team's review bot.",
      status: null,
      scope: "owned",
      sandbox_image_id: "omp",
      multiplier: 1,
      last_webhook_at: null,
      github_name: null,
      github_slug: null,
      github_description: null,
      github_html_url: null,
      github_avatar_url: null,
      github_metadata_synced_at: null,
    },
    ...CONFIG_SECTIONS,
    overview: {
      provider_workspace: "Acme",
      month_used_rp: 1240,
      plan_monthly_rp: null,
      effective_ceiling: null,
      default_chain: "anthropic/claude",
      mounted_apps: [{ id: "app-acme", github_app_id: 4803300, name: "Acme Inspector" }],
    },
    ...overrides,
  };
}

/**
 * The owner's live configuration, spelled so a leak is unmistakable. Every one
 * of these is narrowed to empty/null by `botScopedSections` for a non-manager;
 * a regressed route serves them, and this is what such a payload looks like.
 */
const LEAKED = {
  keyTail: "9f3c",
  keyId: "key_live_9f3c",
  providerId: "acme-gateway",
  baseUrl: "https://gateway.acme.internal/v1",
  seatChain: "seat-nightly",
  chainName: "nightly-fallback",
  ownerChain: "acme-gateway/secret-model-v9",
};

/** The consumer read: not the owner, not manageable, and no official-workspace fact. */
function consumerPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    ...botPayload(),
    can_manage: false,
    owned: false,
    official_workspace: undefined,
    app: { ...(botPayload().app as Record<string, unknown>), scope: "shared" },
    keys: [
      {
        provider: "deepseek",
        keyId: LEAKED.keyId,
        last4: LEAKED.keyTail,
        updatedAt: null,
        verifiedAt: null,
        verifiedStatus: "ok",
      },
    ],
    model_chain: LEAKED.ownerChain,
    model_roles: { review: LEAKED.seatChain },
    model_chains: [
      {
        name: LEAKED.chainName,
        chain: LEAKED.ownerChain,
        is_default: false,
        created_at: "2026-01-01 00:00:00",
        updated_at: "2026-01-01 00:00:00",
      },
    ],
    custom_providers: [
      { provider_id: LEAKED.providerId, base_url: LEAKED.baseUrl, api: "openai-chat", model_ids: ["secret-model-v9"] },
    ],
    configured_providers: [
      {
        kind: "key",
        provider: "deepseek",
        key_id: LEAKED.keyId,
        last4: LEAKED.keyTail,
        updated_at: null,
        verified_at: null,
        verified_status: "ok",
      },
      { kind: "custom", provider_id: LEAKED.providerId, base_url: LEAKED.baseUrl, api: "openai-chat", model_ids: ["secret-model-v9"] },
    ],
    model_role_ids: ["review"],
    custom_provider_api_ids: ["openai-chat"],
    ...overrides,
  };
}

/** Mount BotDetailPage against a stubbed network; the only way to read both bot faces. */
async function mountBot(payload: Record<string, unknown>, locale: SpaBoot["locale"] = "en") {
  const { win, cleanup } = installDom("https://worker.local/dashboard/acme/bots/bot-1");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/review-bots/bot-1/bot")) return Response.json(payload);
    if (url.endsWith("/api/review-bots/bot-1/models")) return Response.json({ groups: [] });
    if (url.includes("/api/provider-catalog")) {
      return Response.json({ provider_catalog: [], model_limits_snapshot: "fixture-snapshot" });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(createElement(BotDetailPage, { boot: { ...BOOT, locale }, botId: "bot-1" })));
    for (let flush = 0; flush < 4; flush += 1) await act(async () => {});
  } catch (err) {
    globalThis.fetch = realFetch;
    throw err;
  }
  return {
    // The shared DOM helpers below take the platform `HTMLElement`; happy-dom's
    // own node type satisfies it structurally, only nominally distinct.
    container: container as unknown as HTMLElement,
    text: () => container.textContent ?? "",
    async close() {
      await act(async () => root.unmount());
      globalThis.fetch = realFetch;
      cleanup();
    },
  };
}

/** No word boundary: the retired unit also hides inside `620RP`. */
const NO_RP = /RP/;
/**
 * A number and its Credits unit, the space between them optional. The number
 * may not start mid-figure, or `1.2.34 Credits` matches as `2.34 Credits` and
 * the orphaned `1.` escapes the foreign-unit scan below.
 */
const CREDITS_FIGURE = /(?<![\d.,])(\d+(?:[.,]\d+)?)\s*Credits?/g;
/** Two decimal separators in one figure: a malformed amount no scan may excuse. */
const DOUBLE_SEPARATOR = /\d+[.,]\d+[.,]\d+/;

/**
 * EVERY rendered figure is a two-decimal amount with its unit. A single good
 * figure must not excuse a bad one: the first version only asked that ONE
 * `N.NN Credits` matched somewhere, so "1 Credits" or "1.2 Credits" rode along
 * unseen beside a well-formed figure. The unit scan is anchored on the number,
 * not on the space before `Credits`, so "1.34 Credits 2Credits" cannot slip
 * through, and any OTHER decimal figure is a foreign unit — Credits is the only
 * currency this product states.
 */
function assertCreditsShape(text: string): void {
  expect(text).not.toMatch(DOUBLE_SEPARATOR);
  const amounts = [...text.matchAll(CREDITS_FIGURE)].map((match) => match[1]);
  expect(amounts.length).toBeGreaterThan(0);
  for (const amount of amounts) expect(amount).toMatch(/^\d+\.\d{2}$/);
  expect(text.replace(CREDITS_FIGURE, "")).not.toMatch(/\d+[.,]\d+\s*[A-Za-z]/);
  // Catches a stray amount in a unit label the scans above do not name.
  expect(text).not.toMatch(NO_RP);
}

/** No rendered attribute — the chain row's month tooltip included — says RP. */
function assertNoRpInAttributes(container: HTMLElement): void {
  const offenders = [...container.querySelectorAll("[title], [aria-label], [placeholder]")]
    .flatMap((element) => ["title", "aria-label", "placeholder"].map((name) => element.getAttribute(name)))
    .filter((value): value is string => value !== null && NO_RP.test(value));
  expect(offenders).toEqual([]);
}

/** The metric band as key/value pairs, in render order. */
function metricBand(container: HTMLElement): Array<{ key: string; value: string }> {
  return [...container.querySelectorAll('[data-slot="metric"]')].map((metric) => ({
    key: metric.querySelector('[data-slot="metric-key"]')?.textContent ?? "",
    value: metric.querySelector('[data-slot="metric-value"]')?.textContent ?? "",
  }));
}

/** A table row's whole text, found by one of its cells. */
function rowText(container: HTMLElement, needle: string): string {
  return [...container.querySelectorAll("tbody tr")].find((row) => row.textContent?.includes(needle))?.textContent ?? "";
}

/* ------------------------------------------------------------------ *
 * 1. Relation selects the face
 * ------------------------------------------------------------------ */

describe("1. the relation selects the face", () => {
  test("installed opens the mount, created opens the creator", () => {
    expect(appDetailFace("installed", null)).toBe("installed");
    expect(appDetailFace("created", null)).toBe("creator");
  });

  test("both follows the ?from= param, and defaults to the creator face", () => {
    expect(appDetailFace("both", "installed")).toBe("installed");
    expect(appDetailFace("both", "created")).toBe("creator");
    expect(appDetailFace("both", null)).toBe("creator");
  });

  test("a single relation is never overridden by ?from=", () => {
    expect(appDetailFace("installed", "created")).toBe("installed");
    expect(appDetailFace("created", "installed")).toBe("creator");
  });

  test("the rendered faces follow the same rule, not the payload alone", async () => {
    const installed = renderApp(managerInstalledPayload());
    await withMarkup(installed, (container) => {
      expect(container.querySelector('[data-slot="tabs"]')).toBeNull();
      expect(container.querySelector('[data-slot="installed-chain"]')).not.toBeNull();
    });

    // The SAME payload opened with from=created is the creator face.
    const created = renderApp({ ...managerPayload(), viewer_relation: "both" }, "created");
    await withMarkup(created, (container) => {
      expect(container.querySelector('[data-slot="tabs"]')).not.toBeNull();
      expect(container.querySelector('[data-slot="installed-chain"]')).toBeNull();
    });

    // both + ?from=installed renders the mount even though the workspace created it.
    const bothInstalled = renderApp({ ...managerPayload(), viewer_relation: "both" }, "installed");
    await withMarkup(bothInstalled, (container) => {
      expect(container.querySelector('[data-slot="tabs"]')).toBeNull();
      expect(container.querySelector('[data-slot="installed-chain"]')).not.toBeNull();
    });

    // both without the param is the creator face.
    const bothBare = renderApp({ ...managerPayload(), viewer_relation: "both" });
    await withMarkup(bothBare, (container) => {
      expect(container.querySelector('[data-slot="tabs"]')).not.toBeNull();
    });
  });
});

/* ------------------------------------------------------------------ *
 * 2. Tab sets
 * ------------------------------------------------------------------ */

describe("2. the tab sets", () => {
  test("the creator face has exactly three tabs", async () => {
    const markup = renderApp(managerPayload());
    expect(
      await withMarkup(markup, tabLabels),
    ).toEqual([
      t("en", "appDetail.tabSettings"),
      t("en", "appDetail.tabDelivery"),
      t("en", "appDetail.tabInstallations"),
    ]);
  });

  test("the installed face has no tab bar", async () => {
    const markup = renderApp(managerInstalledPayload());
    await withMarkup(markup, (container) => {
      expect(container.querySelector('[data-slot="tabs"]')).toBeNull();
      expect(container.querySelector('[role="tablist"]')).toBeNull();
    });
  });

  test("the consumer bot face has no tab bar", async () => {
    const face = await mountBot(consumerPayload());
    try {
      expect(face.container.querySelector('[role="tablist"]')).toBeNull();
    } finally {
      await face.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 3. Absence assertions
 * ------------------------------------------------------------------ */

describe("3. absence — the installed face carries none of the creator machinery", () => {
  const markup = renderApp(managerInstalledPayload());

  /**
   * The entrypoints, not their dialog copy. The first version checked the
   * delete CONFIRM title (which never renders with no dialog open) and a
   * credentials heading this face never had — both assertions were true of
   * any page. Delete / enable-disable / metadata refresh / share / the stored
   * credential line are the things a reader could actually press or read.
   */
  test("delete, enable/disable, refresh, share and the credentials line are absent", async () => {
    await withMarkup(markup, (container) => {
      const text = container.textContent ?? "";
      for (const absent of [
        t("en", "apps.actions.delete"),
        t("en", "apps.actions.enable"),
        t("en", "apps.actions.disable"),
        t("en", "settings.appInfoRefresh"),
        t("en", "apps.shareAppSwitch"),
        t("en", "appDetail.credentialsTitle"),
        t("en", "appDetail.credentialsStored"),
        t("en", "settings.ops"),
        t("en", "appDetail.delivery.copy"),
      ]) {
        expect(text.includes(absent), absent).toBe(false);
      }
      // The share block has its own slot; its absence is structural, not copy.
      expect(container.querySelector('[data-slot="app-share"]')).toBeNull();
      expect(text).not.toContain("24h");
    });
  });
});

describe("3. absence — the consumer bot face carries no owner machinery", () => {
  test("a recognisable owner payload renders none of it", async () => {
    const face = await mountBot(consumerPayload());
    try {
      const text = face.text();
      // (a) Positive control: the read-only overview really rendered, so the
      // absences below are about this page and not an error state.
      expect(text).toContain(t("en", "botDetail.consumer.readOnlyNotice"));
      for (const present of [
        "botDetail.usage.title",
        "bots.fieldCapability",
        "bots.fieldMounted",
      ] as const) {
        expect(text, present).toContain(t("en", present));
      }
      expect(face.container.querySelectorAll('[data-slot="flow-section"]').length).toBe(3);
      expect(text).toContain("Acme"); // the served billing source

      // (b) Not one recognisable owner value, anywhere in the DOM — text or
      // attribute. The previous fixture left keys/providers/chains empty, so a
      // leak had nothing to show and the assertion proved nothing.
      for (const secret of [
        LEAKED.chainName,
        LEAKED.keyTail,
        LEAKED.keyId,
        LEAKED.providerId,
        LEAKED.baseUrl,
        LEAKED.seatChain,
        LEAKED.ownerChain,
        "secret-model-v9",
      ]) {
        expect(text.includes(secret), secret).toBe(false);
        expect(face.container.innerHTML.includes(secret), `${secret} (markup)`).toBe(false);
      }

      // ...and none of their controls. A section, a key form, a seat or chain
      // editor would all be an `input`/`select`/`textarea` on this face.
      for (const absent of [
        t("en", "settings.providers.title"),
        t("en", "settings.seats"),
        t("en", "settings.modelChains"),
        t("en", "botDetail.share.title"),
        t("en", "botDetail.overrides.title"),
        t("en", "botDetail.identity.title"),
        t("en", "botDetail.archive.dangerTitle"),
        t("en", "settings.addKey"),
      ]) {
        expect(text.includes(absent), absent).toBe(false);
      }
      expect(face.container.querySelectorAll("input, select, textarea, [role=tablist]").length).toBe(0);
    } finally {
      await face.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 4. One chain control surface
 * ------------------------------------------------------------------ */

describe("4. the installed face has exactly one chain control surface", () => {
  test("one add affordance in the section header, one move/remove set on the rows", async () => {
    const markup = renderApp(managerInstalledPayload());
    await withMarkup(markup, (container) => {
      const sections = container.querySelectorAll('[data-slot="installed-chain"]');
      expect(sections.length).toBe(1);
      const section = sections[0] as HTMLElement;

      // The add affordance lives in the section HEADER, and there is exactly one.
      const header = section.firstElementChild as HTMLElement;
      expect(header.querySelector("summary")?.textContent).toBe(t("en", "appDetail.installed.addBot"));
      expect(container.querySelectorAll('[data-slot="app-chain-add"]').length).toBe(1);

      // One set of controls per row: every move/remove affordance names its bot
      // exactly once, so no competing reorder surface exists beside the table.
      expect(container.querySelectorAll(`[aria-label="${t("en", "apps.chain.moveUp", { bot: "Live Bot" })}"]`).length).toBe(1);
      expect(container.querySelectorAll(`[aria-label="${t("en", "apps.chain.moveDown", { bot: "Live Bot" })}"]`).length).toBe(1);
      expect(container.querySelectorAll(`[aria-label="${t("en", "apps.chain.removeBot", { bot: "Live Bot" })}"]`).length).toBe(1);
    });
  });

  test("a member sees the same rows and no controls at all", async () => {
    const markup = renderApp(memberInstalledPayload());
    await withMarkup(markup, (container) => {
      expect(container.querySelector('[data-slot="installed-chain"]')).not.toBeNull();
      expect(container.querySelector('[data-slot="app-chain-add"]')).toBeNull();
      expect(container.querySelector(`[aria-label="${t("en", "apps.chain.moveUp", { bot: "Live Bot" })}"]`)).toBeNull();
      expect(container.querySelector(`[aria-label="${t("en", "apps.chain.removeBot", { bot: "Live Bot" })}"]`)).toBeNull();
    });
  });
});

/* ------------------------------------------------------------------ *
 * 5. Credits
 * ------------------------------------------------------------------ */

describe("5. Credits everywhere, RP nowhere", () => {
  test("the helper renders the ADR quantum and its documented fallback", () => {
    expect(formatCredits(670, RATE)).toBe("1.34 Credits");
    expect(formatCredits(670)).toBe("0.67 Credits");
    expect(formatCredits(0, RATE)).toBe("0.00 Credits");
  });

  test("the checker rejects a figure that is not `N.NN Credits`", () => {
    // The assertion's own test: a well-formed figure must not excuse a bad one.
    assertCreditsShape("1.34 Credits");
    expect(() => assertCreditsShape("1 Credits")).toThrow();
    expect(() => assertCreditsShape("1.2 Credits")).toThrow();
    expect(() => assertCreditsShape("1.340 Credits")).toThrow();
    expect(() => assertCreditsShape("1.34 Credits 2 Credits")).toThrow();
    // No space before the unit, so the scan must anchor on the number.
    expect(() => assertCreditsShape("1.34 Credits 2Credits")).toThrow();
    expect(() => assertCreditsShape("1.34 Credits 2.1Credits")).toThrow();
    // A well-formed figure beside a decimal in another unit.
    expect(() => assertCreditsShape("1.34 Credits 2.1 tokens")).toThrow();
    // A malformed amount must not be rescued by matching from its tail.
    expect(() => assertCreditsShape("1.2.34 Credits")).toThrow();
    // A stray amount in the retired unit, even beside correct Credits.
    expect(() => assertCreditsShape("1.34 Credits · 620 RP")).toThrow();
    // The unit also hides inside a figure, where `\b` never matched.
    expect(() => assertCreditsShape("1.34 Credits · 620RP")).toThrow();
    expect(() => assertCreditsShape("no figures here")).toThrow();
  });

  test.each(["en", "zh_CN"] as const)(
    "the installed face states every spend and ceiling figure in Credits, never RP (%s)",
    async (locale) => {
      const markup = renderApp(managerInstalledPayload(), null, locale);
      // The band's total, the own row's spend, the shared row's spend AND its
      // ceiling, and the archived row's spend — every one a two-decimal figure.
      for (const figure of ["1.34 Credits", "1.24 Credits", "0.09 Credits", "2.00 Credits", "0.01 Credits"]) {
        expect(markup, figure).toContain(figure);
      }
      await withMarkup(markup, (container) => {
        assertCreditsShape(container.textContent ?? "");
        // Attributes too: the chain row's month tooltip is user-visible on hover.
        assertNoRpInAttributes(container);
      });
    },
  );

  test.each(["en", "zh_CN"] as const)("the installed face reads the 本月 spend label as 本月已用 (%s)", async (locale) => {
    const markup = renderApp(managerInstalledPayload(), null, locale);
    await withMarkup(markup, (container) => {
      const keys = metricBand(container).map((metric) => metric.key);
      expect(keys).toContain(t(locale, "credits.usedThisMonth"));
      // The rendered label, not the dictionary: 本月 is a prefix of 本月已用, so
      // the bare shorthand can only be caught by an exact key comparison.
      expect(keys).not.toContain(t(locale, "bots.monthLabel"));
      // The chain's month column carries the same label.
      expect([...container.querySelectorAll("thead th")].map((th) => th.textContent)).toContain(
        t(locale, "credits.usedThisMonth"),
      );
    });
  });

  test.each(["en", "zh_CN"] as const)("the owner bot face states Credits and never RP (%s)", async (locale) => {
    const face = await mountBot({ ...botPayload(), rp_per_credit: RATE }, locale);
    try {
      const text = face.text();
      assertCreditsShape(text);
      expect(text).toContain("2.48 Credits"); // 1,240 RP at 500 RP/Credit
      assertNoRpInAttributes(face.container);
    } finally {
      await face.close();
    }
  });

  test.each(["en", "zh_CN"] as const)("the owner bot face reads the 本月 spend label as 本月已用 (%s)", async (locale) => {
    const face = await mountBot({ ...botPayload(), rp_per_credit: RATE }, locale);
    try {
      const keys = metricBand(face.container).map((metric) => metric.key);
      expect(keys).toContain(t(locale, "credits.usedThisMonth"));
      expect(keys).not.toContain(t(locale, "bots.monthLabel"));
    } finally {
      await face.close();
    }
  });

  test.each(["en", "zh_CN"] as const)("the consumer bot face states Credits and never RP (%s)", async (locale) => {
    const face = await mountBot({ ...consumerPayload(), rp_per_credit: RATE }, locale);
    try {
      const text = face.text();
      assertCreditsShape(text);
      assertNoRpInAttributes(face.container);
    } finally {
      await face.close();
    }
  });

  test.each(["en", "zh_CN"] as const)("the consumer bot face reads the 本月 spend label as 本月已用 (%s)", async (locale) => {
    const face = await mountBot({ ...consumerPayload(), rp_per_credit: RATE }, locale);
    try {
      const keys = metricBand(face.container).map((metric) => metric.key);
      expect(keys).toContain(t(locale, "credits.usedThisMonth"));
      expect(keys).not.toContain(t(locale, "bots.monthLabel"));
    } finally {
      await face.close();
    }
  });

  test("the 本月 keys themselves carry the ADR's wording in both locales", () => {
    expect(t("zh_CN", "credits.usedThisMonth")).toBe("本月已用");
    expect(t("en", "credits.usedThisMonth")).toBe("Used this month");
    for (const locale of ["en", "zh_CN"] as const) {
      expect(t(locale, "credits.usedThisMonth")).not.toBe(t(locale, "bots.monthLabel"));
    }
  });
});

/* ------------------------------------------------------------------ *
 * 6. Archived
 * ------------------------------------------------------------------ */

describe("6. archived is unavailable everywhere and visible to consumers", () => {
  test("listed in the bots list with 已归档", async () => {
    const markup = renderToStaticMarkup(
      createElement(BotsView, {
        locale: "en",
        base: "/dashboard/acme",
        state: { kind: "ok", payload: botsPayload() },
        canCreate: true,
        onCreated: () => {},
      }),
    );
    const rowText = await withMarkup(markup, (container) => {
      const row = Array.from(container.querySelectorAll("tbody tr")).find((tr) =>
        tr.textContent?.includes("Retired Bot"),
      );
      return row?.textContent ?? null;
    });
    expect(rowText).not.toBeNull();
    expect(rowText).toContain(t("en", "bots.list.archived"));
  });

  test("unavailable in an App chain, and its row says why", async () => {
    const markup = renderApp(managerInstalledPayload());
    expect(markup).toContain(t("en", "appDetail.installed.archivedSkipped"));
    await withMarkup(markup, (container) => {
      const row = Array.from(container.querySelectorAll("tbody tr")).find((tr) =>
        tr.textContent?.includes("Archived Bot"),
      );
      expect(row).toBeDefined();
      expect(row?.textContent).toContain(t("en", "appDetail.installed.archivedSkipped"));
    });
  });

  test("the archived bot still counts its month spend in the band", async () => {
    // Archiving stops selection, not accounting: 620 + 45 + 5 RP → 1.34 Credits.
    expect(renderApp(managerInstalledPayload())).toContain("1.34 Credits");
  });

  test("the consumer bot face shows the banner", async () => {
    const face = await mountBot(consumerPayload({ archived: true }));
    try {
      const text = face.text();
      expect(text).toContain(t("en", "botDetail.archive.consumerBanner"));
      expect(text).not.toContain(t("en", "botDetail.archive.ownerBanner"));
    } finally {
      await face.close();
    }
  });
});

/* ------------------------------------------------------------------ *
 * 7. Bots list
 * ------------------------------------------------------------------ */

function botRow(overrides: Partial<UsableBotRow> & { id: string; name: string; owned: boolean }): UsableBotRow {
  return {
    description: null,
    workspace_id: WORKSPACE_ID,
    workspace_name: "Acme",
    can_manage: overrides.owned,
    scope: overrides.owned ? "owned" : "shared",
    multiplier: 1,
    month_used_rp: 0,
    effective_ceiling: null,
    archived: false,
    ...overrides,
  };
}

function botsPayload(): UsableBotsPayload {
  return {
    workspace_id: WORKSPACE_ID,
    plan_monthly_rp: null,
    rp_per_credit: RATE,
    bots: [
      botRow({ id: "bot-own", name: "My Bot", owned: true, description: "Mine to configure.", month_used_rp: 500 }),
      botRow({ id: "bot-retired", name: "Retired Bot", owned: true, archived: true }),
      // Archived is a state fact in BOTH sections: a shared bot the owning
      // workspace retired stays listed here, so its consumer can see why their
      // chain skipped it. The earlier fixture only had an OWNED archived bot.
      botRow({
        id: "bot-retired-shared",
        name: "Platform Retired Bot",
        owned: false,
        workspace_name: "platform",
        scope: "shared",
        archived: true,
      }),
      botRow({ id: "bot-theirs", name: "Their Bot", owned: false, workspace_name: "platform" }),
    ],
  };
}

describe("7. the bots list", () => {
  test("renders two sections, each naming its bots", async () => {
    const markup = renderToStaticMarkup(
      createElement(BotsView, {
        locale: "en",
        base: "/dashboard/acme",
        state: { kind: "ok", payload: botsPayload() },
        canCreate: true,
        onCreated: () => {},
      }),
    );
    expect(markup).toContain(t("en", "bots.list.ownedSection"));
    expect(markup).toContain(t("en", "bots.list.sharedSection"));
    await withMarkup(markup, (container) => {
      expect(container.querySelectorAll('[data-slot="group-card"]').length).toBe(2);
    });
  });

  test("the create action sits inside the owned section's header", async () => {
    const markup = renderToStaticMarkup(
      createElement(BotsView, {
        locale: "en",
        base: "/dashboard/acme",
        state: { kind: "ok", payload: botsPayload() },
        canCreate: true,
        onCreated: () => {},
      }),
    );
    await withMarkup(markup, (container) => {
      const cards = [...container.querySelectorAll('[data-slot="group-card"]')];
      expect(cards.length).toBe(2);
      const ownedCard = cards[0] as HTMLElement;
      const sharedCard = cards[1] as HTMLElement;
      expect(ownedCard.textContent).toContain(t("en", "bots.list.ownedSection"));
      expect(sharedCard.textContent).toContain(t("en", "bots.list.sharedSection"));

      // The trigger is inside the owned card's HEADER, not merely somewhere on
      // the page: a page-wide text match cannot tell the two headers apart.
      const header = ownedCard.querySelector('[data-slot="card-header"]');
      const action = header?.querySelector('[data-slot="card-action"]');
      expect(action?.textContent).toBe(t("en", "bots.create.open"));
      expect(sharedCard.querySelector('[data-slot="card-action"]')).toBeNull();
      expect(sharedCard.textContent).not.toContain(t("en", "bots.create.open"));
    });
  });

  test("each row lands in the section its ownership implies", async () => {
    const markup = renderToStaticMarkup(
      createElement(BotsView, {
        locale: "en",
        base: "/dashboard/acme",
        state: { kind: "ok", payload: botsPayload() },
        canCreate: true,
        onCreated: () => {},
      }),
    );
    await withMarkup(markup, (container) => {
      const cards = [...container.querySelectorAll('[data-slot="group-card"]')];
      const namesIn = (card: Element): string[] =>
        [...card.querySelectorAll("tbody tr")].map((row) => row.querySelector("a")?.textContent ?? "");
      // Owned rows first, shared rows second — and NOT one flat table.
      expect(namesIn(cards[0] as HTMLElement)).toEqual(["My Bot", "Retired Bot"]);
      expect(namesIn(cards[1] as HTMLElement)).toEqual(["Platform Retired Bot", "Their Bot"]);
      // An archived SHARED bot stays listed with 已归档, not dropped and not
      // mislabelled as a live sharing state.
      const sharedArchived = rowText(cards[1] as HTMLElement, "Platform Retired Bot");
      expect(sharedArchived).toContain(t("en", "bots.list.archived"));
      expect(sharedArchived).not.toContain(t("en", "bots.stateShared"));
      const ownedArchived = rowText(cards[0] as HTMLElement, "Retired Bot");
      expect(ownedArchived).toContain(t("en", "bots.list.archived"));
      // The live rows still state their sharing state.
      expect(rowText(cards[1] as HTMLElement, "Their Bot")).toContain(t("en", "bots.stateShared"));
      expect(container.querySelectorAll("tbody tr").length).toBe(4);
    });
  });

  test("the create action disappears for a member but the sections stay", async () => {
    const member = renderToStaticMarkup(
      createElement(BotsView, {
        locale: "en",
        base: "/dashboard/acme",
        state: { kind: "ok", payload: botsPayload() },
        canCreate: false,
        onCreated: () => {},
      }),
    );
    expect(member).toContain(t("en", "bots.list.ownedSection"));
    expect(member.includes(t("en", "bots.create.open"))).toBe(false);
  });

  test("rows carry the name, the description and the Credits spend", async () => {
    const markup = renderToStaticMarkup(
      createElement(BotsView, {
        locale: "en",
        base: "/dashboard/acme",
        state: { kind: "ok", payload: botsPayload() },
        canCreate: true,
        onCreated: () => {},
      }),
    );
    const rowText = await withMarkup(markup, (container) => {
      const row = Array.from(container.querySelectorAll("tbody tr")).find((tr) =>
        tr.textContent?.includes("My Bot"),
      );
      return row?.textContent ?? null;
    });
    expect(rowText).toContain("Mine to configure.");
    expect(rowText).toContain("1.00 Credits"); // 500 RP at 500 RP/Credit
    expect(markup).not.toMatch(NO_RP);
  });
});
