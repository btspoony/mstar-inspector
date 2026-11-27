import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { t } from "../../src/i18n";
import type {
  AppChainEntry,
  SettingsBlockedPayload,
  SettingsManagePayload,
  SettingsPayload,
  SettingsReadOnlyPayload,
} from "../../src/spa/pages/data";
import {
  AppDetailView,
  appDetailFace,
  InstalledChainSection,
  parseAppDetailFrom,
} from "../../src/spa/pages/AppDetailPage";
import { installDom, withMarkup } from "./dom";

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
    effective_monthly_rp: null,
    archived: false,
    default_chain: null,
    runtime: "omp",
    ...overrides,
  };
}

/**
 * The prototype's three-row chain at the 500 RP/Credit fixture rate: the band
 * totals ALL THREE rows (620 + 45 + 5 = 670 RP → 1.34 Credits) — an archived
 * row's recorded spend is still spend this month; the first row alone reads
 * 1.24 Credits.
 */
const CHAIN: AppChainEntry[] = [
  chainRow({
    position: 1,
    bot_id: "bot-studio",
    name: "Studio Reviewer",
    description: "Default review bot: DeepSeek first, Flash fallback.",
    month_used_rp: 620,
    default_chain: "deepseek/deepseek-chat, anthropic/claude-sonnet",
    runtime: "omp",
  }),
  chainRow({
    position: 2,
    bot_id: "bot-docs",
    name: "Docs Scanner",
    provider_workspace: "platform",
    owned: false,
    multiplier: 4,
    month_used_rp: 45,
    effective_monthly_rp: 1000,
    default_chain: "openai/gpt-5-mini",
    runtime: "omp-1.4",
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
      { installation_id: 99231774, account_login: null, seen_at: "2026-11-27 09:00", can_bind: true },
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

/** The Blocked manager: the bot this target runs on is no longer shared with this workspace. */
function blockedManagerPayload(): SettingsBlockedPayload {
  return {
    can_manage: true,
    blocked: true,
    blocked_reason: "bot_not_shared",
    viewer_relation: "installed",
    rp_per_credit: 500,
    workspace_id: WORKSPACE_ID,
    target_id: "rt-1",
    installation: null,
    app: {
      ...IDENTITY_APP,
      scope: "owned",
      review_enabled: true,
      review_trigger_mode: "every_push",
      review_level: null,
      default_review_level: "default",
      github_visibility: "unknown",
    },
    check_gate: null,
    installations: INSTALLATIONS,
    chain: CHAIN,
  };
}

/** The Blocked member: same state, no control anywhere. */
function blockedMemberPayload(): SettingsReadOnlyPayload {
  return {
    can_manage: false,
    viewer_relation: "installed",
    rp_per_credit: 500,
    workspace_id: WORKSPACE_ID,
    blocked: true,
    blocked_reason: "bot_not_shared",
    app: { ...IDENTITY_APP, created_at: "2026-01-01 00:00:00" },
    installations: INSTALLATIONS,
    chain: CHAIN,
  };
}

const SEARCH = { tab: "settings" as const, window: "30" as const, repo: "", pr: "" };
const MOUNTABLE = [{ id: "bot-extra", name: "Extra Bot" }];

function renderFace(
  payload: SettingsPayload,
  from: "installed" | "created" | null = null,
  mountable = MOUNTABLE,
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
      mountable,
      onReload: async () => true,
      onSearch: () => {},
    }),
  );
}

describe("face selection — the served relation is the authority", () => {
  test("parseAppDetailFrom accepts only the two valid values", () => {
    expect(parseAppDetailFrom("?from=installed")).toBe("installed");
    expect(parseAppDetailFrom("?from=created")).toBe("created");
    expect(parseAppDetailFrom("?from=bogus")).toBeNull();
    expect(parseAppDetailFrom("")).toBeNull();
  });

  test("from picks a face only when BOTH relations hold", () => {
    expect(appDetailFace("both", null)).toBe("creator");
    expect(appDetailFace("both", "installed")).toBe("installed");
    expect(appDetailFace("both", "created")).toBe("creator");
    expect(appDetailFace("installed", null)).toBe("installed");
    expect(appDetailFace("created", null)).toBe("creator");
  });

  /**
   * The wayfinding param is not an authorization: an admitted installer who
   * opens `?from=created` must NOT receive the creator face (tabs, share,
   * credentials, enable/delete), and an owner who opens `?from=installed` must
   * not be downgraded into the consumer mount.
   */
  test("installed-only + from=created still renders the installed face", async () => {
    const html = renderFace(managerPayload(), "created");
    await withMarkup(html, (container) => {
      expect(container.querySelector('[data-slot="tabs"]')).toBeNull();
      expect(container.querySelector('[data-slot="installed-chain"]')).not.toBeNull();
      // The creator-only controls are absent, not merely disabled.
      expect(container.querySelector('[data-slot="app-share"]')).toBeNull();
    });
    expect(html).not.toContain("Credentials");
    expect(html).not.toContain("Share this app");
    expect(html).not.toContain("Delete");
    expect(html).not.toContain("24h");
  });

  test("created-only + from=installed still renders the creator face", async () => {
    const payload: SettingsManagePayload = {
      ...managerPayload(),
      viewer_relation: "created",
      installation: null,
      pending_installations: [],
    };
    const html = renderFace(payload, "installed");
    await withMarkup(html, (container) => {
      expect(container.querySelector('[data-slot="tabs"]')).not.toBeNull();
      expect(container.querySelector('[data-slot="installed-chain"]')).toBeNull();
    });
    expect(html).toContain("Stored credentials");
    expect(html).toContain("Share this app");
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
    // 620 + 45 + 5 RP at 500 RP/Credit: the archived row's past spend is still
    // this month's spend (archiving stops selection, not accounting).
    expect(markup).toContain("1.34 Credits");
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

  test("a bot already in the chain never reappears among the add actions", async () => {
    // The parent subtracts mounted bots from the mountable list
    // (AppDetailPage.tsx's InstalledAppFace); pass one already-mounted.
    const filtered = renderFace(managerPayload(), null, [
      { id: "bot-studio", name: "Studio Reviewer" },
      ...MOUNTABLE,
    ]);
    await withMarkup(filtered, (container) => {
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

  test("each row states its default model chain and its runtime", async () => {
    expect(markup).toContain("Default chain");
    expect(markup).toContain("Runtime harness");
    expect(markup).toContain("deepseek/deepseek-chat, anthropic/claude-sonnet");
    expect(markup).toContain("openai/gpt-5-mini");
    expect(markup).toContain("omp-1.4");
    // A bot with no default chain configured reads the dash, not a blank cell.
    await withMarkup(markup, (container) => {
      const row = Array.from(container.querySelectorAll("tbody tr")).find((tr) =>
        tr.textContent?.includes("Security Scanner"),
      );
      expect(row?.textContent).toContain("—");
    });
  });

  test("each row's spend states its ceiling: own bot unlimited, capped, no ceiling", () => {
    // Row 1 is this workspace's own bot — no ceiling applies to it.
    expect(markup).toContain("1.24 Credits · unlimited (own bot)");
    // Row 2 is shared with a 1,000 RP cap at 500 RP/Credit: 0.09 / 2.00 Credits.
    expect(markup).toContain("0.09 Credits / 2.00 Credits");
    // Row 3 is shared with no cap of its own.
    expect(markup).toContain("0.01 Credits · no ceiling");
  });

  /**
   * The relay enforces the VIEWER's workspace ceiling: its
   * `bot_quota_overrides` row when one exists, else the bot's default
   * (`readBotCeiling`). The row must state that number, not `monthly_rp`.
   * Fixture rate: 500 RP/Credit.
   */
  const spendCell = (rows: AppChainEntry[]): Promise<string> =>
    withMarkup(
      renderFace({ ...managerPayload(), chain: rows }),
      (container) =>
        Array.from(container.querySelectorAll("tbody tr td"))
          .map((td) => td.textContent ?? "")
          .find((text) => text.includes("Credits")) ?? "",
    );

  test("an override replaces the bot's default in the row", async () => {
    const cell = await spendCell([
      chainRow({
        position: 1,
        bot_id: "bot-overridden",
        name: "Overridden",
        owned: false,
        month_used_rp: 45,
        effective_monthly_rp: 5000,
      }),
    ]);
    // 45 RP used / the 5,000 RP override — never the bot's 1,000 default.
    expect(cell).toBe("0.09 Credits / 10.00 Credits");
  });

  test("an override applies even when the bot itself has no default", async () => {
    const cell = await spendCell([
      chainRow({
        position: 1,
        bot_id: "bot-override-only",
        name: "Override only",
        owned: false,
        month_used_rp: 45,
        effective_monthly_rp: 5000,
      }),
    ]);
    expect(cell).toBe("0.09 Credits / 10.00 Credits");
  });

  test("no override and no default reads as no ceiling", async () => {
    const cell = await spendCell([
      chainRow({
        position: 1,
        bot_id: "bot-uncapped",
        name: "Uncapped",
        owned: false,
        month_used_rp: 45,
        effective_monthly_rp: null,
      }),
    ]);
    expect(cell).toBe("0.09 Credits · no ceiling");
  });

  test("the App name is stated once, and the install entry survives that", async () => {
    await withMarkup(markup, (container) => {
      const header = container.querySelector('[data-slot="page-header"] h1');
      expect(header?.textContent).toBe("Wood's Inspector");
      // The install block keeps its bind state but not a second identity row.
      const section = container.querySelector('[data-slot="flow-section"]')!;
      expect(section.textContent).toContain("Bound installation account: btspoony");
      expect(section.querySelector("p.font-semibold")).toBeNull();
      // The install entry is NOT part of the identity row: an unblocked
      // manager still opens GitHub's install page from this block.
      expect(section.querySelector('a[href*="installations/new"]')).not.toBeNull();
    });
  });

  test("an unblocked manager with nothing bound still has the install entry", async () => {
    const unbound = renderFace({ ...managerPayload(), installation: null });
    await withMarkup(unbound, (container) => {
      const section = container.querySelector('[data-slot="flow-section"]')!;
      expect(section.querySelector('a[href*="installations/new"]')).not.toBeNull();
      expect(section.querySelector("p.font-semibold")).toBeNull();
    });
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

  test("an empty chain with mountable bots available still gives the member no add affordance", async () => {
    const empty = renderFace({ ...memberPayload(), chain: [] });
    await withMarkup(empty, (container) => {
      expect(container.querySelector('[data-slot="app-chain-add"]')).toBeNull();
      expect(container.querySelector('[aria-label="Add Extra Bot"]')).toBeNull();
    });
  });
});

describe("installed face — the from param only chooses between two faces", () => {
  test("a both-relation App opened with from=installed renders the mount (no tab bar)", async () => {
    const markup = renderFace({ ...managerPayload(), viewer_relation: "both" }, "installed");
    await withMarkup(markup, (container) => {
      expect(container.querySelector('[data-slot="tabs-list"]')).toBeNull();
      expect(container.querySelector('[data-slot="installed-chain"]')).not.toBeNull();
    });
  });

  test("a both-relation App opened with from=created renders the creator face (tab bar)", async () => {
    const markup = renderFace({ ...managerPayload(), viewer_relation: "both" }, "created");
    await withMarkup(markup, (container) => {
      expect(container.querySelector('[data-slot="tabs-list"]')).not.toBeNull();
      expect(container.querySelector('[data-slot="installed-chain"]')).toBeNull();
    });
  });
});

describe("installed face — a Blocked App stays a mount, never the creator face", () => {
  test("a blocked manager sees the installed face, the blocked warning and no creator tabs", async () => {
    const markup = renderFace(blockedManagerPayload());
    expect(markup).toContain("no longer shared with this workspace");
    // The read-only identity still names the App once.
    expect(markup).toContain("Wood&#x27;s Inspector");
    expect(markup.match(/GitHub App ID/g)).toHaveLength(1);
    await withMarkup(markup, (container) => {
      expect(container.querySelector('[data-slot="tabs-list"]')).toBeNull();
      expect(container.querySelector('[data-slot="tabs"]')).toBeNull();
      expect(container.querySelector('[data-slot="installed-chain"]')).not.toBeNull();
      // No creator-only surface reaches the page, in any form.
      expect(container.querySelector('[data-slot="app-credentials"]')).toBeNull();
      expect(container.querySelector('[data-slot="app-share"]')).toBeNull();
    });
    expect(markup).not.toContain("Credentials");
    expect(markup).not.toContain("Share this app");
  });

  test("a blocked member gets the same face with every chain control absent", async () => {
    const markup = renderFace(blockedMemberPayload());
    expect(markup).toContain("no longer shared with this workspace");
    await withMarkup(markup, (container) => {
      expect(container.querySelector('[data-slot="tabs-list"]')).toBeNull();
      expect(container.querySelector('[data-slot="installed-chain"]')).not.toBeNull();
      expect(container.querySelector('[aria-label^="Move "]')).toBeNull();
      expect(container.querySelector('[aria-label^="Remove "]')).toBeNull();
      expect(container.querySelector('[data-slot="app-chain-add"]')).toBeNull();
    });
  });

  test("a blocked manager is never offered a bind action", () => {
    const markup = renderFace(blockedManagerPayload());
    expect(markup).not.toContain("Bind to this target");
  });
});

/**
 * The chain write path, ported from the retired app-chain-editor suite: the
 * editor's behaviour (whole-order PATCH, re-read, add/remove, refusal) now
 * lives only in the installed face's {@link InstalledChainSection}.
 */
describe("the chain rows' effective multiplier (item 13)", () => {
  test("own and unshared bots read ×1; a shared consumer row shows its stored multiplier", () => {
    const html = renderToStaticMarkup(
      createElement(InstalledChainSection, {
        locale: "en" as const,
        appId: "app-1",
        chain: [
          // Own bot with a stored price: the owner never pays it.
          chainRow({ position: 1, bot_id: "bot-own", name: "Own", owned: true, multiplier: 3 }),
          // A shared bot consumed here: the stored multiplier is effective.
          chainRow({ position: 2, bot_id: "bot-shared", name: "Shared", owned: false, multiplier: 4 }),
          // An unshared foreign remnant: mounted but skipped — never a price.
          chainRow({ position: 3, bot_id: "bot-gone", name: "Gone", owned: false, available: false, multiplier: 9 }),
        ],
        canManage: false,
        mountableBots: [],
        onReordered: async () => {},
      }),
    );
    const rows = html.split("<tr").filter((part) => part.includes("×"));
    const ownRow = html.split("<tr").find((part) => part.includes("Own")) ?? "";
    const sharedRow = html.split("<tr").find((part) => part.includes(">Shared<")) ?? "";
    const goneRow = html.split("<tr").find((part) => part.includes("Gone")) ?? "";
    expect(rows.length).toBeGreaterThan(0);
    expect(ownRow).toContain("×1");
    expect(ownRow).not.toContain("×3");
    expect(sharedRow).toContain("×4");
    expect(goneRow).toContain("×1");
    expect(goneRow).not.toContain("×9");
  });
});

describe("the installed chain's write path", () => {
  const realFetch = globalThis.fetch;
  const EDITOR_CHAIN: AppChainEntry[] = [
    chainRow({ position: 1, bot_id: "bot-a", name: "Alpha", owned: false, multiplier: 1.5 }),
    chainRow({ position: 2, bot_id: "bot-b", name: "Beta" }),
  ];

  type Sent = { url: string; method: string; body: unknown };

  async function mountEditor(input: {
    canManage: boolean;
    chain?: AppChainEntry[];
    mountableBots?: Array<{ id: string; name: string }>;
  }) {
    const { win, cleanup } = installDom("http://localhost/dashboard/ws/apps/app-1");
    const sent: Sent[] = [];
    globalThis.fetch = (async (target: RequestInfo | URL, init?: RequestInit) => {
      sent.push({
        url: String(target),
        method: init?.method ?? "GET",
        body: typeof init?.body === "string" ? JSON.parse(init.body) : undefined,
      });
      return new Response(JSON.stringify({ chain: [] }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      });
    }) as typeof fetch;

    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    let reloads = 0;
    await act(async () => {
      root.render(
        createElement(InstalledChainSection, {
          locale: "en" as const,
          appId: "app-1",
          chain: input.chain ?? EDITOR_CHAIN,
          canManage: input.canManage,
          // The parent subtracts the mounted bots before they reach this section.
          mountableBots: input.mountableBots ?? [],
          onReordered: async () => {
            reloads += 1;
          },
        }),
      );
    });
    await act(async () => {});

    const buttons = () => [...(container.querySelectorAll("button") as unknown as HTMLButtonElement[])];
    const labelled = (label: string) => buttons().filter((button) => button.getAttribute("aria-label") === label);
    const click = async (button: { click: () => void }) => {
      await act(async () => {
        button.click();
      });
      await act(async () => {});
    };

    return {
      sent,
      labelled,
      click,
      reloads: () => reloads,
      text: () => container.textContent ?? "",
      async close() {
        await act(async () => root.unmount());
        globalThis.fetch = realFetch;
        cleanup();
      },
    };
  }

  test("moving a bot down PATCHes the WHOLE order and re-reads the chain", async () => {
    const surface = await mountEditor({ canManage: true });
    await surface.click(surface.labelled(t("en", "apps.chain.moveDown", { bot: "Alpha" }))[0]!);

    const patch = surface.sent.find((request) => request.method === "PATCH");
    expect(patch?.url).toContain("/api/apps/app-1/chain");
    // The whole order, not a single position: the store rewrites every position.
    expect(patch?.body).toEqual({ botIds: ["bot-b", "bot-a"] });
    // Re-read the chain, not the page.
    expect(surface.reloads()).toBe(1);
    await surface.close();
  });

  test("the first row cannot move up and the last cannot move down; a single row disables both", async () => {
    const surface = await mountEditor({ canManage: true });
    expect(surface.labelled(t("en", "apps.chain.moveUp", { bot: "Alpha" }))[0]!.hasAttribute("disabled")).toBe(true);
    expect(surface.labelled(t("en", "apps.chain.moveDown", { bot: "Beta" }))[0]!.hasAttribute("disabled")).toBe(true);
    await surface.close();

    const single = await mountEditor({ canManage: true, chain: [EDITOR_CHAIN[0]!] });
    expect(single.labelled(t("en", "apps.chain.moveUp", { bot: "Alpha" }))[0]!.hasAttribute("disabled")).toBe(true);
    expect(single.labelled(t("en", "apps.chain.moveDown", { bot: "Alpha" }))[0]!.hasAttribute("disabled")).toBe(true);
    await single.close();
  });

  test("adding a bot appends it to the full order and re-reads the chain", async () => {
    const surface = await mountEditor({ canManage: true, mountableBots: [{ id: "bot-c", name: "Gamma" }] });
    await surface.click(surface.labelled(t("en", "apps.chain.addNamed", { bot: "Gamma" }))[0]!);
    const patch = surface.sent.find((request) => request.method === "PATCH");
    expect(patch?.body).toEqual({ botIds: ["bot-a", "bot-b", "bot-c"] });
    expect(surface.reloads()).toBe(1);
    await surface.close();
  });

  test("removing a bot rewrites the order without it; the LAST row cannot be removed", async () => {
    const surface = await mountEditor({ canManage: true });
    await surface.click(surface.labelled(t("en", "apps.chain.removeBot", { bot: "Alpha" }))[0]!);
    const patch = surface.sent.find((request) => request.method === "PATCH");
    expect(patch?.body).toEqual({ botIds: ["bot-b"] });
    await surface.close();

    // D27: one row left — its remove control is present but disabled.
    const single = await mountEditor({ canManage: true, chain: [EDITOR_CHAIN[0]!] });
    const remove = single.labelled(t("en", "apps.chain.removeBot", { bot: "Alpha" }))[0]!;
    expect(remove.hasAttribute("disabled")).toBe(true);
    await single.close();
  });

  test("an EMPTY chain still offers the add affordance to a manager", async () => {
    const surface = await mountEditor({ canManage: true, chain: [], mountableBots: [{ id: "bot-c", name: "Gamma" }] });
    expect(surface.text()).toContain(t("en", "apps.chain.empty"));
    await surface.click(surface.labelled(t("en", "apps.chain.addNamed", { bot: "Gamma" }))[0]!);
    const patch = surface.sent.find((request) => request.method === "PATCH");
    // The FIRST bot: an empty list becomes one id.
    expect(patch?.body).toEqual({ botIds: ["bot-c"] });
    await surface.close();
  });

  test("a refused reorder says so and re-reads nothing", async () => {
    const { win, cleanup } = installDom("http://localhost/dashboard/ws/apps/app-1");
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ error: "unknown app" }), {
        status: 404,
        headers: { "Content-Type": "application/json" },
      })) as unknown as typeof fetch;
    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    let reloads = 0;
    await act(async () => {
      root.render(
        createElement(InstalledChainSection, {
          locale: "en" as const,
          appId: "app-1",
          chain: EDITOR_CHAIN,
          canManage: true,
          mountableBots: [],
          onReordered: async () => {
            reloads += 1;
          },
        }),
      );
    });
    await act(async () => {});
    const button = [...(container.querySelectorAll("button") as unknown as HTMLButtonElement[])].find(
      (candidate) => candidate.getAttribute("aria-label") === t("en", "apps.chain.moveDown", { bot: "Alpha" }),
    );
    await act(async () => button?.click());
    await act(async () => {});

    expect(container.textContent).toContain(t("en", "apps.chain.reorderFailed"));
    expect(reloads).toBe(0);
    await act(async () => root.unmount());
    globalThis.fetch = realFetch;
    cleanup();
  });
});
