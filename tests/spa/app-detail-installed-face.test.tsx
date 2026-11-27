import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type {
  AppChainEntry,
  SettingsManagePayload,
  SettingsReadOnlyPayload,
} from "../../src/spa/pages/data";
import {
  AppDetailView,
  appDetailFace,
  parseAppDetailFrom,
} from "../../src/spa/pages/AppDetailPage";
import { withMarkup } from "./dom";

const WORKSPACE_ID = "ws_0123456789abcdefghijkl";

const IDENTITY_APP = {
  github_slug: "woods-inspector",
  id: "app-demo",
  github_app_id: 4803300,
  status: "active",
  review_enabled: true,
  created_by: "btspoony",
  created_at: "2026-01-01 00:00:00",
  github_name: "Wood's Inspector",
  github_description: null,
  github_html_url: "https://github.com/apps/woods-inspector",
  github_avatar_url: null,
  github_metadata_synced_at: "2026-01-01 00:00:00",
};

/** One chain row with the fields the installed face renders; callers override the ones under test. */
function chainRow(overrides: Partial<AppChainEntry> & { position: number; bot_id: string }): AppChainEntry {
  return {
    name: overrides.bot_id,
    description: null,
    provider_workspace: "Wood",
    owned: true,
    available: true,
    multiplier: 1,
    month_used_rp: 0,
    monthly_rp: null,
    archived: false,
    ...overrides,
  };
}

/**
 * The prototype's three-row chain at the 500 RP/Credit fixture rate: the band
 * totals the two live rows (620 + 45 = 665 RP → 1.33 Credits) and skips the
 * archived row's 5 RP; the first row alone reads 1.24 Credits.
 */
const CHAIN: AppChainEntry[] = [
  chainRow({
    position: 1,
    bot_id: "bot-studio",
    name: "Studio Reviewer",
    description: "Default review bot: DeepSeek first, Flash fallback.",
    month_used_rp: 620,
  }),
  chainRow({
    position: 2,
    bot_id: "bot-docs",
    name: "Docs Scanner",
    provider_workspace: "platform",
    owned: false,
    multiplier: 4,
    month_used_rp: 45,
    monthly_rp: 1000,
  }),
  chainRow({
    position: 3,
    bot_id: "bot-sec",
    name: "Security Scanner",
    provider_workspace: "platform",
    owned: false,
    multiplier: 2,
    month_used_rp: 5,
    archived: true,
  }),
];

const INSTALLATIONS = [
  { installation_id: 88123456, account_login: "btspoony", seen_at: "2026-11-27 08:14" },
];

/** The manager installed face: this workspace administers the mount it did not create. */
function managerPayload(): SettingsManagePayload {
  return {
    can_manage: true,
    viewer_relation: "installed",
    rp_per_credit: 500,
    official_workspace: true,
    can_configure_bot: true,
    installation: { id: 88123456, account_login: "btspoony", removed: false },
    pending_installations: [
      { installation_id: 99231774, account_login: null, seen_at: "2026-11-27 09:00" },
    ],
    blocked: false,
    blocked_reason: null,
    workspace_id: WORKSPACE_ID,
    target_id: "rt-1",
    app: {
      ...IDENTITY_APP,
      last_webhook_at: null,
      scope: "shared",
      sandbox_image_id: "omp",
      review_trigger_mode: "every_push",
      review_level: null,
      default_review_level: "default",
      github_visibility: "unknown",
    },
    check_gate: null,
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
    chain: CHAIN,
  };
}

/** The member installed face: the read-only payload serves the chain and the roster, nothing else. */
function memberPayload(): SettingsReadOnlyPayload {
  return {
    can_manage: false,
    viewer_relation: "installed",
    rp_per_credit: 500,
    workspace_id: WORKSPACE_ID,
    blocked: false,
    blocked_reason: null,
    app: IDENTITY_APP,
    installations: INSTALLATIONS,
    chain: CHAIN,
  };
}

const SEARCH = { tab: "settings" as const, window: "30" as const, repo: "", pr: "" };
const MOUNTABLE = [{ id: "bot-extra", name: "Extra Bot" }];

function renderFace(
  payload: SettingsManagePayload | SettingsReadOnlyPayload,
  from: "installed" | "created" | null = null,
): string {
  return renderToStaticMarkup(
    createElement(AppDetailView, {
      locale: "en",
      appId: "app-demo",
      payload,
      groups: [],
      notice: null,
      search: SEARCH,
      from,
      mountable: MOUNTABLE,
      onReload: async () => true,
      onSearch: () => {},
    }),
  );
}

describe("face selection — from wins, the relation is the default", () => {
  test("parseAppDetailFrom accepts only the two valid values", () => {
    expect(parseAppDetailFrom("?from=installed")).toBe("installed");
    expect(parseAppDetailFrom("?from=created")).toBe("created");
    expect(parseAppDetailFrom("?from=bogus")).toBeNull();
    expect(parseAppDetailFrom("")).toBeNull();
  });

  test("a valid from wins; otherwise installed opens the mount and created/both open the creation", () => {
    expect(appDetailFace("installed", null)).toBe("installed");
    expect(appDetailFace("created", null)).toBe("creator");
    expect(appDetailFace("both", null)).toBe("creator");
    expect(appDetailFace("both", "installed")).toBe("installed");
    expect(appDetailFace("installed", "created")).toBe("creator");
  });
});

describe("installed face — manager", () => {
  const markup = renderFace(managerPayload());

  test("no tab bar, no credentials, no share, no delete, no 24h refusal metric", async () => {
    expect(markup).not.toContain("Credentials");
    expect(markup).not.toContain("Share this app");
    expect(markup).not.toContain("Delete");
    expect(markup).not.toContain("24h");
    await withMarkup(markup, (container) => {
      expect(container.querySelector('[data-slot="tabs"]')).toBeNull();
      expect(container.querySelector('[data-slot="tabs-list"]')).toBeNull();
    });
  });

  test("the read-only identity header names the App, its creator and its GitHub App ID once", () => {
    expect(markup).toContain("Wood&#x27;s Inspector");
    expect(markup).toContain("by btspoony");
    expect(markup.match(/GitHub App ID/g)).toHaveLength(1);
    expect(markup).toContain("4803300");
  });

  test("the metric band is 挂载的机器人 / 安装 / 本月已用 with the payload's credit rate", () => {
    expect(markup).toContain("Mounted bots");
    expect(markup).toContain("Installations");
    expect(markup).toContain("Used this month");
    // 620 + 45 RP at 500 RP/Credit; the archived row's 5 RP stays off the band.
    expect(markup).toContain("1.33 Credits");
  });

  test("the install/bind block shows the bound account with its state", () => {
    expect(markup).toContain("Bound installation account: btspoony");
  });

  test("with nothing bound yet, the pending installation carries its bind action", () => {
    // The reused AppInstallSection offers the bind list only while the App is
    // unbound; once bound, the bound row is the state.
    const unbound = renderFace({ ...managerPayload(), installation: null });
    expect(unbound).toContain("Installation 99231774 (account not reported yet)");
    expect(unbound).toContain("Bind to this target");
  });

  test("the chain has ONE control surface: 添加机器人 in the section header, ↑↓✕ on the rows", async () => {
    await withMarkup(markup, (container) => {
      const section = container.querySelector('[data-slot="installed-chain"]');
      expect(section).not.toBeNull();
      // The add affordance lives in the section header, not in a chip row below.
      const header = section!.firstElementChild!;
      expect(header.querySelector("summary")?.textContent).toBe("Add bot");
      expect(section!.querySelector('[data-slot="app-chain-reorder"]')).toBeNull();
      expect(container.querySelector('[aria-label="Move Studio Reviewer earlier"]')).not.toBeNull();
      expect(container.querySelector('[aria-label="Move Docs Scanner later"]')).not.toBeNull();
      expect(container.querySelector('[aria-label="Remove Security Scanner from the chain"]')).not.toBeNull();
      // The add list offers only the unmounted bot.
      expect(container.querySelector('[aria-label="Add Extra Bot"]')).not.toBeNull();
      expect(container.querySelector('[aria-label="Add Studio Reviewer"]')).toBeNull();
    });
  });

  test("each row links the bot, states its Credits through the payload rate, and marks the archived row", async () => {
    await withMarkup(markup, (container) => {
      const link = container.querySelector('a[href$="/bots/bot-studio"]');
      expect(link?.textContent).toBe("Studio Reviewer");
    });
    expect(markup).toContain("1.24 Credits");
    expect(markup).toContain("Archived — skipped");
  });
});

describe("installed face — member", () => {
  const markup = renderFace(memberPayload());

  test("same rows, no controls present (absent, not disabled), no tab bar", async () => {
    expect(markup).toContain("Studio Reviewer");
    expect(markup).toContain("Security Scanner");
    expect(markup).toContain("Archived — skipped");
    expect(markup).toContain("1.24 Credits");
    await withMarkup(markup, (container) => {
      expect(container.querySelector('[data-slot="tabs-list"]')).toBeNull();
      expect(container.querySelector('[aria-label^="Move "]')).toBeNull();
      expect(container.querySelector('[aria-label^="Remove "]')).toBeNull();
      expect(container.querySelector('[data-slot="app-chain-add"]')).toBeNull();
    });
  });

  test("the member still reads the bound installation roster", () => {
    expect(markup).toContain("btspoony");
  });
});

describe("installed face — the from param decides the face", () => {
  test("a both-relation App opened with from=installed renders the mount (no tab bar)", async () => {
    const markup = renderFace({ ...managerPayload(), viewer_relation: "both" }, "installed");
    await withMarkup(markup, (container) => {
      expect(container.querySelector('[data-slot="tabs-list"]')).toBeNull();
      expect(container.querySelector('[data-slot="installed-chain"]')).not.toBeNull();
    });
  });

  test("an installed-relation App opened with from=created renders the creator face (tab bar)", async () => {
    const markup = renderFace(managerPayload(), "created");
    await withMarkup(markup, (container) => {
      expect(container.querySelector('[data-slot="tabs-list"]')).not.toBeNull();
      expect(container.querySelector('[data-slot="installed-chain"]')).toBeNull();
    });
  });
});
