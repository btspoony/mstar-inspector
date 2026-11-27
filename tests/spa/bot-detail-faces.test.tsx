/**
 * Task 8: ONE bot route, two faces. These pins mount `BotDetailPage` against a
 * stubbed network and assert the face contract end to end:
 *
 *   owner    — 概览/配置 tabs, the full config machinery, pricing and archive;
 *   consumer — no tab bar, a read-only notice, and NONE of the owner's
 *              provider/seat/chain/pricing machinery (absence, not disabled);
 *   unshared — the multiplier is ×1, disabled, with the shared-only note;
 *   archived — the banner to both faces, restore for the owner, a locked
 *              config face, and nothing at all for the consumer.
 */
import { describe, expect, test } from "bun:test";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { t } from "../../src/i18n";
import type { SpaBoot } from "../../src/spa/boot";
import { BotDetailPage } from "../../src/spa/pages/BotDetailPage";
import { installDom } from "./dom";

const BOOT: SpaBoot = { locale: "en", login: "mallory", name: "Mallory" };

function botPayload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    can_manage: true,
    owned: true,
    archived: false,
    official_workspace: true,
    app: {
      github_app_id: null,
      id: "bot-1",
      name: "Team bot",
      description: "The team's review bot.",
      status: null,
      scope: "owned",
      sandbox_image_id: "omp",
      multiplier: 1,
      monthly_rp: null,
      last_webhook_at: null,
      github_name: null,
      github_slug: null,
      github_description: null,
      github_html_url: null,
      github_avatar_url: null,
      github_metadata_synced_at: null,
    },
    installations: [],
    keys: [],
    model_chain: "anthropic/claude",
    model_roles: {},
    model_chains: [],
    custom_providers: [],
    configured_providers: [],
    provider_catalog_version: "fixture-catalog",
    provider_eligibility: {},
    model_role_ids: [],
    custom_provider_api_ids: [],
    sandbox_images: [{ id: "omp", enabled: true }],
    overview: {
      provider_workspace: "Acme",
      month_used_rp: 1240,
      plan_monthly_rp: null,
      effective_ceiling: null,
      default_chain: "anthropic/claude",
      mounted_apps: [{ id: "app-1", github_app_id: 4803300, name: "Wood's Inspector" }],
    },
    ...overrides,
  };
}

const CONSUMER = botPayload({
  can_manage: false,
  owned: false,
  official_workspace: undefined,
  app: { ...(botPayload().app as Record<string, unknown>), scope: "shared", multiplier: 4 },
  overview: {
    provider_workspace: "platform",
    month_used_rp: 90,
    plan_monthly_rp: 5000,
    // The bot's own ceiling binds this workspace: it wins over the plan.
    effective_ceiling: 3000,
    default_chain: "anthropic/claude",
    mounted_apps: [{ id: "app-1", github_app_id: 4803300, name: "Wood's Inspector" }],
  },
});

async function mountBot(payload: Record<string, unknown>) {
  const { win, cleanup } = installDom("https://worker.local/dashboard/acme/bots/bot-1");
  const realFetch = globalThis.fetch;
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    if (url.includes("/api/review-bots/bot-1/bot")) return Response.json(payload);
    if (url.endsWith("/api/models")) return Response.json({ groups: [] });
    if (url.includes("/api/provider-catalog")) {
      return Response.json({ provider_catalog: [], model_limits_snapshot: "fixture-snapshot" });
    }
    return new Response("not found", { status: 404 });
  }) as unknown as typeof fetch;

  const container = win.document.createElement("div");
  win.document.body.appendChild(container);
  const root = createRoot(container as unknown as Element);
  try {
    await act(async () => root.render(createElement(BotDetailPage, { boot: BOOT, botId: "bot-1" })));
    for (let flush = 0; flush < 4; flush += 1) await act(async () => {});
  } catch (err) {
    globalThis.fetch = realFetch;
    throw err;
  }
  return {
    container,
    text: () => container.textContent ?? "",
    async close() {
      await act(async () => root.unmount());
      globalThis.fetch = realFetch;
      cleanup();
    },
  };
}

const NO_RP = /\bRP\b/;

describe("the owner face", () => {
  test("renders 概览/配置 tabs with both faces' sections, Credits at two decimals", async () => {
    const face = await mountBot(botPayload());
    try {
      const tabs = [...(face.container.querySelector('[role="tablist"]')?.querySelectorAll('[role="tab"]') ?? [])].map(
        (tab) => tab.textContent,
      );
      expect(tabs).toEqual([t("en", "botDetail.tab.overview"), t("en", "botDetail.tab.config")]);

      const text = face.text();
      // 概览: usage, capability, mounts, share state.
      expect(text).toContain(t("en", "botDetail.usage.title"));
      expect(text).toContain(t("en", "bots.fieldCapability"));
      expect(text).toContain(t("en", "bots.fieldMounted"));
      expect(text).toContain(t("en", "bots.fieldSharing"));
      // 配置: identity, pricing, providers, chains, seats, runtime, danger zone.
      expect(text).toContain(t("en", "botDetail.identity.title"));
      expect(text).toContain(t("en", "botDetail.share.title"));
      expect(text).toContain(t("en", "botDetail.overrides.title"));
      expect(text).toContain(t("en", "settings.providers.title"));
      expect(text).toContain(t("en", "settings.modelChains"));
      expect(text).toContain(t("en", "settings.seats"));
      expect(text).toContain(t("en", "settings.runtimeHarness"));
      expect(text).toContain(t("en", "botDetail.archive.dangerTitle"));
      // The metric band and the usage rows speak Credits at two decimals.
      expect(text).toContain("1.24 Credits");
      expect(text).toContain(t("en", "credits.usedThisMonth"));
      // No RP unit anywhere on the rendered page.
      expect(text).not.toMatch(NO_RP);
    } finally {
      await face.close();
    }
  });

  test("an unshared owner sees the multiplier ×1 disabled with the shared-only note", async () => {
    const face = await mountBot(botPayload());
    try {
      const input = face.container.querySelector(
        `input[aria-label="${t("en", "botDetail.share.multiplier")}"]`,
      ) as HTMLInputElement | null;
      expect(input).not.toBeNull();
      expect(input?.disabled).toBe(true);
      expect(input?.value).toBe("1");
      expect(face.text()).toContain(t("en", "botDetail.share.inactiveHint"));
    } finally {
      await face.close();
    }
  });

  test("an unshared bot with a stored multiplier is effectively ×1 everywhere it is presented", async () => {
    // The stored 3 stays in the owner's pricing input; the metric band and the
    // capability line — effective presentations — read ×1.
    const priced = botPayload({
      app: { ...(botPayload().app as Record<string, unknown>), scope: "owned", multiplier: 3 },
    });
    const face = await mountBot(priced);
    try {
      const text = face.text();
      const capability = text.split(t("en", "bots.fieldMultiplier"));
      // Header metric + capability line both read ×1, never ×3.
      expect(text).not.toContain("×3");
      expect(text).toContain("×1");
      expect(capability.length).toBeGreaterThan(1);
      const input = face.container.querySelector(
        `input[aria-label="${t("en", "botDetail.share.multiplier")}"]`,
      ) as HTMLInputElement | null;
      expect(input?.value).toBe("3");
    } finally {
      await face.close();
    }
  });

  test("a shared owner keeps the multiplier editable", async () => {
    const shared = botPayload({
      app: { ...(botPayload().app as Record<string, unknown>), scope: "shared", multiplier: 2 },
    });
    const face = await mountBot(shared);
    try {
      const input = face.container.querySelector(
        `input[aria-label="${t("en", "botDetail.share.multiplier")}"]`,
      ) as HTMLInputElement | null;
      expect(input?.disabled).toBe(false);
      expect(input?.value).toBe("2");
      expect(face.text()).not.toContain(t("en", "botDetail.share.inactiveHint"));
    } finally {
      await face.close();
    }
  });
});

describe("the consumer face", () => {
  test("a member of the owning workspace gets the same read-only face, no machinery", async () => {
    // The route's member answer: owned but not manageable, and no
    // `official_workspace` fact (the switch is a manager surface).
    const face = await mountBot({
      ...botPayload({ can_manage: false, model_chains: [] }),
      official_workspace: undefined,
    });
    try {
      expect(face.container.querySelector('[role="tablist"]')).toBeNull();
      expect(face.container.querySelector(`input[aria-label="${t("en", "botDetail.share.multiplier")}"]`)).toBeNull();
      expect(face.text()).not.toContain(t("en", "botDetail.share.switch"));
      expect(face.text()).toContain(t("en", "botDetail.consumer.readOnlyNotice"));
    } finally {
      await face.close();
    }
  });

  test("has no tab bar and none of the owner's machinery — absence, not disabled", async () => {
    const face = await mountBot(CONSUMER);
    try {
      expect(face.container.querySelector('[role="tablist"]')).toBeNull();
      const text = face.text();
      expect(text).toContain(t("en", "botDetail.consumer.readOnlyNotice"));
      // The read-only sections stay.
      expect(text).toContain(t("en", "botDetail.usage.title"));
      expect(text).toContain(t("en", "bots.fieldCapability"));
      expect(text).toContain(t("en", "bots.fieldMounted"));
      // Absent by absence: no providers, seats, chains, pricing, identity,
      // archive or tab labels anywhere in the markup.
      for (const absent of [
        t("en", "settings.providers.title"),
        t("en", "settings.seats"),
        t("en", "settings.modelChains"),
        t("en", "botDetail.share.title"),
        t("en", "botDetail.overrides.title"),
        t("en", "botDetail.identity.title"),
        t("en", "botDetail.archive.open"),
        t("en", "botDetail.archive.dangerTitle"),
        t("en", "botDetail.tab.overview"),
        t("en", "botDetail.tab.config"),
      ]) {
        expect(text.includes(absent), absent).toBe(false);
      }
      // No control carries the owner's write affordances either.
      expect(face.container.querySelector(`input[aria-label="${t("en", "botDetail.share.multiplier")}"]`)).toBeNull();
      expect(face.container.querySelector(`input[aria-label="${t("en", "botDetail.identity.name")}"]`)).toBeNull();
      expect(face.text()).not.toMatch(NO_RP);
    } finally {
      await face.close();
    }
  });

  test("spend reads against the enforced ceiling and the multiplier is visible", async () => {
    const face = await mountBot(CONSUMER);
    try {
      const text = face.text();
      // 90 RP at the 1,000 fallback rate, and the BOT's 3,000 RP ceiling — not
      // the 5,000 RP plan allowance, which is a separate limit.
      expect(text).toContain("0.09 Credits");
      expect(text).toContain("3.00 Credits");
      expect(text).toContain("2.91 Credits");
      expect(text).not.toContain("5.00 Credits");
      // Item 13: the metric states the limit as `已用 / 上限`, and a shared
      // bot's stored multiplier shows through.
      expect(text).toContain("0.09 Credits / 3.00 Credits");
      expect(text).toContain("×4");
      // The billing source names the providing workspace.
      expect(text).toContain(t("en", "botDetail.usage.source"));
      expect(text).toContain("platform");
    } finally {
      await face.close();
    }
  });

  test("the served credit rate converts the consumer's spend and ceiling", async () => {
    const face = await mountBot({ ...CONSUMER, rp_per_credit: 500 });
    try {
      const text = face.text();
      expect(text).toContain("0.18 Credits");
      expect(text).toContain("6.00 Credits");
    } finally {
      await face.close();
    }
  });
});

describe("the archived faces", () => {
  test("the owner sees the banner, the restore action, and a locked config face", async () => {
    const face = await mountBot(botPayload({ archived: true }));
    try {
      const text = face.text();
      expect(text).toContain(t("en", "botDetail.archive.ownerBanner"));
      expect(text).toContain(t("en", "botDetail.archive.lockedNotice"));
      const restore = [...(face.container.querySelectorAll("button") as unknown as HTMLButtonElement[])].find(
        (button) => button.textContent === t("en", "botDetail.archive.restore"),
      );
      expect(restore).toBeDefined();
      // The config face is a read-only fieldset: sections visible, controls locked.
      const fieldset = face.container.querySelector("fieldset[disabled]");
      expect(fieldset).not.toBeNull();
      expect(fieldset?.querySelector(`input[aria-label="${t("en", "botDetail.identity.name")}"]`)).not.toBeNull();
      // 概览 stays readable.
      expect(text).toContain(t("en", "botDetail.usage.title"));
      expect(text).toContain("1.24 Credits");
      // The archive action itself is gone once archived — restore is the write.
      expect(text).not.toContain(t("en", "botDetail.archive.open"));
    } finally {
      await face.close();
    }
  });

  test("the consumer sees the banner and no config at all", async () => {
    const face = await mountBot(botPayload({ ...CONSUMER, archived: true }));
    try {
      const text = face.text();
      expect(text).toContain(t("en", "botDetail.archive.consumerBanner"));
      expect(text).not.toContain(t("en", "botDetail.archive.ownerBanner"));
      expect(face.container.querySelector('[role="tablist"]')).toBeNull();
      expect(face.container.querySelector("fieldset")).toBeNull();
      expect(text).not.toContain(t("en", "botDetail.identity.title"));
      expect(text).not.toContain(t("en", "botDetail.archive.open"));
    } finally {
      await face.close();
    }
  });
});

describe("a confirmed archive whose re-read fails", () => {
  test("the confirmation names the selection consequence in both locales", () => {
    for (const locale of ["en", "zh_CN"] as const) {
      const hint = t(locale, "botDetail.archive.dangerHint");
      expect(hint).toMatch(locale === "en" ? /selected/i : /选中/);
      // The confirmation must also name what archiving costs other workspaces:
      // the bot becomes unselectable for new chains.
      expect(hint).toMatch(locale === "en" ? /can no longer add it to a bot chain/i : /无法再把它加入机器人链/);
      // The other consequences stay named: the archived badge and restore.
      expect(hint).toMatch(locale === "en" ? /archived/i : /已归档/);
      expect(hint).toMatch(locale === "en" ? /restore/i : /恢复/);
    }
  });

  test("both save buttons render the generic save label", async () => {
    const face = await mountBot(
      botPayload({ app: { ...(botPayload().app as Record<string, unknown>), scope: "shared", multiplier: 2 } }),
    );
    try {
      const labels = [...face.container.querySelectorAll("button")].map((button) => button.textContent);
      // 基本信息 and 共享与定价 each carry their own save, spelled by the
      // generic key in both dictionaries.
      expect(labels.filter((label) => label === t("en", "common.save"))).toHaveLength(2);
      expect(t("zh_CN", "common.save").length).toBeGreaterThan(0);
    } finally {
      await face.close();
    }
  });
  test("locks the face to the archived state instead of leaving the old config editable", async () => {
    const { win, cleanup } = installDom("https://worker.local/dashboard/acme/bots/bot-1");
    const realFetch = globalThis.fetch;
    let archivedWritten = false;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.includes("/api/review-bots/bot-1/bot")) {
        // The archive landed; the follow-up read of it does not.
        return archivedWritten
          ? new Response("unavailable", { status: 503 })
          : Response.json(botPayload());
      }
      if (url.endsWith("/api/review-bots/bot-1/archive") && init?.method === "PATCH") {
        archivedWritten = true;
        return Response.json({ ok: true });
      }
      if (url.endsWith("/api/models")) return Response.json({ groups: [] });
      if (url.includes("/api/provider-catalog")) {
        return Response.json({ provider_catalog: [], model_limits_snapshot: "fixture-snapshot" });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const click = async (node: Element | null | undefined) => {
      await act(async () => {
        node?.dispatchEvent(
          new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }) as unknown as Event,
        );
      });
      await act(async () => {});
    };
    const buttonWith = (label: string, scope: ParentNode) =>
      [...scope.querySelectorAll("button")].find((button) => button.textContent === label);
    try {
      await act(async () => root.render(createElement(BotDetailPage, { boot: BOOT, botId: "bot-1" })));
      for (let flush = 0; flush < 4; flush += 1) await act(async () => {});

      await click(buttonWith(t("en", "botDetail.archive.open"), container as unknown as ParentNode));
      await click(buttonWith(t("en", "botDetail.archive.confirm"), win.document.body as unknown as ParentNode));

      // The confirmed state wins over the payload the page could not re-read:
      // the config is locked, the archive action is gone, and the failure is
      // stated with a reload path.
      expect(archivedWritten).toBe(true);
      const fieldset = container.querySelector("fieldset[disabled]");
      expect(fieldset).not.toBeNull();
      expect(fieldset?.querySelector(`input[aria-label="${t("en", "botDetail.identity.name")}"]`)).not.toBeNull();
      expect(container.textContent).not.toContain(t("en", "botDetail.archive.open"));
      expect(container.textContent).toContain(t("en", "botDetail.archive.staleAfterArchive"));
    } finally {
      await act(async () => root.unmount());
      globalThis.fetch = realFetch;
      cleanup();
    }
  });
});

describe("a confirmed restore whose re-read fails", () => {
  test("keeps the face locked until a later re-read succeeds", async () => {
    const { win, cleanup } = installDom("https://worker.local/dashboard/acme/bots/bot-1");
    const realFetch = globalThis.fetch;
    // The stub tracks the last confirmed write: reads serve the state that
    // write established, except the restore re-read the test fails on purpose.
    let lastArchived: boolean | null = null;
    let readFails = true;
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/api/review-bots/bot-1/archive") && init?.method === "PATCH") {
        lastArchived = JSON.parse(String(init.body)).archived === true;
        return Response.json({ ok: true });
      }
      if (url.includes("/api/review-bots/bot-1/bot")) {
        // The restore landed; the follow-up read of it does not — until it does.
        if (lastArchived === false && readFails) return new Response("unavailable", { status: 503 });
        return Response.json(botPayload({ archived: lastArchived !== false }));
      }
      if (url.endsWith("/api/models")) return Response.json({ groups: [] });
      if (url.includes("/api/provider-catalog")) {
        return Response.json({ provider_catalog: [], model_limits_snapshot: "fixture-snapshot" });
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const container = win.document.createElement("div");
    win.document.body.appendChild(container);
    const root = createRoot(container as unknown as Element);
    const click = async (node: Element | null | undefined) => {
      await act(async () => {
        node?.dispatchEvent(
          new win.MouseEvent("click", { bubbles: true, cancelable: true, button: 0 }) as unknown as Event,
        );
      });
      await act(async () => {});
    };
    const buttonWith = (label: string, scope: ParentNode) =>
      [...scope.querySelectorAll("button")].find((button) => button.textContent === label);
    try {
      await act(async () => root.render(createElement(BotDetailPage, { boot: BOOT, botId: "bot-1" })));
      for (let flush = 0; flush < 4; flush += 1) await act(async () => {});

      // The restore write succeeds but its re-read fails: the confirmed write
      // wins over the stale payload, so the config stays LOCKED even though the
      // stored bot is no longer archived.
      await click(buttonWith(t("en", "botDetail.archive.restore"), container as unknown as ParentNode));
      await act(async () => {});

      expect(lastArchived === false).toBe(true);
      const fieldset = container.querySelector("fieldset[disabled]");
      expect(fieldset).not.toBeNull();
      expect(fieldset?.querySelector(`input[aria-label="${t("en", "botDetail.identity.name")}"]`)).not.toBeNull();
      expect(container.textContent).toContain(t("en", "botDetail.archive.lockedNotice"));
      // The failure is stated with a refresh path, the same as the archive mirror.
      expect(container.textContent).toContain(t("en", "botDetail.archive.staleAfterArchive"));

      // The only remaining writer on the locked face is the archive section:
      // archiving again re-reads successfully, and its restore completes the
      // round trip. Once a re-read succeeds the lock must clear.
      await click(buttonWith(t("en", "botDetail.archive.open"), container as unknown as ParentNode));
      await click(buttonWith(t("en", "botDetail.archive.confirm"), win.document.body as unknown as ParentNode));
      expect(lastArchived === true).toBe(true);
      readFails = false;
      await click(buttonWith(t("en", "botDetail.archive.restore"), container as unknown as ParentNode));
      await act(async () => {});

      expect(container.querySelector("fieldset[disabled]")).toBeNull();
      expect(container.textContent).not.toContain(t("en", "botDetail.archive.lockedNotice"));
      expect(container.textContent).not.toContain(t("en", "botDetail.archive.staleAfterArchive"));
    } finally {
      await act(async () => root.unmount());
      globalThis.fetch = realFetch;
      cleanup();
    }
  });
});

/**
 * QC F3-2: the ceiling semantics follow OWNERSHIP, not management rights. A
 * plain member of the bot's own workspace still reads own-bot unlimited, even
 * when a stored ceiling exists for that workspace; `can_manage` only decides
 * which controls render.
 */
describe("ceiling semantics follow ownership, not manage permission", () => {
  test("an owning-workspace member reads own-bot unlimited against a stored ceiling", async () => {
    const memberPayload = botPayload({
      can_manage: false,
      owned: true,
      official_workspace: undefined,
      overview: {
        provider_workspace: "Acme",
        month_used_rp: 1240,
        plan_monthly_rp: 100000,
        // A ceiling the relay would enforce on a CONSUMER; the owner is not.
        effective_ceiling: 3000,
        default_chain: "anthropic/claude",
        mounted_apps: [],
      },
    });
    const face = await mountBot(memberPayload);
    try {
      const text = face.text();
      expect(text).toContain(t("en", "credits.unlimitedOwn", { used: "1.24" }));
      // Neither the finite ceiling nor the unknown marker may appear.
      expect(text).not.toContain("3.00 Credits / 3.00 Credits");
      expect(text).not.toContain(t("en", "bots.monthUnknown"));
      // Still the read-only face: the ceiling fact does not hand out controls.
      expect(face.container.querySelector('[role="tablist"]')).toBeNull();
      expect(text).toContain(t("en", "botDetail.consumer.readOnlyNotice"));
    } finally {
      await face.close();
    }
  });

  test("the same stored ceiling reads finite for a real consumer", async () => {
    const face = await mountBot(CONSUMER);
    try {
      expect(face.text()).toContain("0.09 Credits / 3.00 Credits");
    } finally {
      await face.close();
    }
  });
});
