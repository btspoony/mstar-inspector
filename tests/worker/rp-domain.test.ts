/**
 * QC F2-7: ONE RP domain for writers and readers.
 *
 * A ceiling the writer accepts but a parser refuses turns a whole mounted App
 * read into a load error; a multiplier with no accounting bound prices a review
 * into a number no stored ceiling can be compared against. Both bounds live in
 * `contracts/rp-limits`, and these cases pin each surface to it: the write, the
 * parse, the price and the SPA guard.
 */
import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import { updateBotPricing } from "../../src/dashboard/apps-store";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import {
  BOT_MULTIPLIER_MAX,
  CHAIN_MULTIPLIER_MAX,
  RP_CEILING_MAX,
  isBotMultiplier,
  isChainMultiplier,
  isRpCeiling,
} from "../../src/contracts/rp-limits";
import { rpFor, type QuotaProfile } from "../../src/store/quota-store";
import { parseApps, type AppsPayload } from "../../src/spa/pages/data";
import { createMigratedTestD1, seedBot, type TestD1 } from "../store/helpers";
import { OAUTH_CLIENT_SECRET } from "../helpers/fake-secrets";
import type { Env } from "../../src/worker/env";

const SESSION_SECRET = ["test", "rp", "domain", "session", "secret", "32b"].join("-");
const TEST_KEY = Buffer.alloc(32, 3).toString("base64");
const OFFICIAL = "default";
const OTHER = "ws-consumer";
const BOT_ROW = "bot-priced";
const GITHUB_APP_ID = 8401;
const NOW = "2026-11-01T00:00:00.000Z";

let db: TestD1;

function envFor(): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} },
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} },
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: OAUTH_CLIENT_SECRET,
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DASHBOARD_ENCRYPTION_KEY: TEST_KEY,
    DEPLOYMENT_MODE: "self-hosted",
    DB: db,
  } as unknown as Env;
}

function world(): void {
  db = createMigratedTestD1();
  db.raw.prepare("INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES (?, ?, 'member', ?, NULL)").run(
    crypto.randomUUID(),
    "dana",
    NOW,
  );
  db.raw
    .prepare(
      "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) SELECT ?, id, 'owner', ? FROM users WHERE github_login = 'dana'",
    )
    .run(OFFICIAL, NOW);
  db.raw.prepare("INSERT INTO workspaces (id, slug, name, created_by, created_at) VALUES (?, ?, ?, NULL, ?)").run(
    OTHER,
    OTHER,
    OTHER,
    NOW,
  );
  seedBot(db, BOT_ROW, GITHUB_APP_ID, { workspaceId: OFFICIAL });
  db.raw.prepare("UPDATE review_bots SET scope = 'shared', shared_at = ? WHERE id = ?").run(NOW, BOT_ROW);
}

async function patchPricing(body: unknown): Promise<Response> {
  const session = await createSessionValue("dana", null, SESSION_SECRET);
  return worker.fetch(
    new Request(`https://worker.local/dashboard/${OFFICIAL}/api/review-bots/${BOT_ROW}/pricing`, {
      method: "PATCH",
      headers: { Cookie: `${SESSION_COOKIE}=${session}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    envFor(),
  );
}

const storedPricing = (): { multiplier: number; monthly_rp: number | null } =>
  db.raw
    .query("SELECT multiplier, monthly_rp FROM review_bots WHERE id = ?")
    .get(BOT_ROW) as { multiplier: number; monthly_rp: number | null };

describe("the shared RP domain", () => {
  test("the ceiling must be a positive safe integer inside the domain", () => {
    expect(isRpCeiling(1)).toBe(true);
    expect(isRpCeiling(RP_CEILING_MAX)).toBe(true);
    expect(isRpCeiling(RP_CEILING_MAX + 1)).toBe(false);
    // Past 2^53 the value is no longer the number it printed as, so it can
    // neither be compared against nor rendered faithfully.
    expect(isRpCeiling(Number.MAX_SAFE_INTEGER + 2)).toBe(false);
    expect(isRpCeiling(0)).toBe(false);
    expect(isRpCeiling(1.5)).toBe(false);
  });

  test("the multiplier is finite, positive and bounded so its price stays representable", () => {
    expect(isBotMultiplier(0.001)).toBe(true);
    expect(isBotMultiplier(BOT_MULTIPLIER_MAX)).toBe(true);
    expect(isBotMultiplier(BOT_MULTIPLIER_MAX + 1)).toBe(false);
    expect(isBotMultiplier(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isBotMultiplier(0)).toBe(false);
    expect(isBotMultiplier(-1)).toBe(false);
  });

  // The Apps list serves `month.multiplier` as the PRODUCT of the mounted
  // chain, so the single-bot bound is the wrong guard for it: two max-valid
  // bots multiply past it and the whole list would fail to parse.
  test("a chain's product is bounded by its price, not by the single-bot bound", () => {
    expect(isBotMultiplier(BOT_MULTIPLIER_MAX)).toBe(true);
    expect(isChainMultiplier(BOT_MULTIPLIER_MAX)).toBe(true);
    expect(isChainMultiplier(BOT_MULTIPLIER_MAX * BOT_MULTIPLIER_MAX)).toBe(true);
    expect(isChainMultiplier(CHAIN_MULTIPLIER_MAX)).toBe(true);
    expect(isChainMultiplier(CHAIN_MULTIPLIER_MAX + 1)).toBe(false);
    expect(isChainMultiplier(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isChainMultiplier(0)).toBe(false);
    // The bound is exactly "no storable ceiling could cover one review".
    expect(isRpCeiling(CHAIN_MULTIPLIER_MAX * 300)).toBe(true);
    expect(CHAIN_MULTIPLIER_MAX * 300 <= RP_CEILING_MAX).toBe(true);
  });
});

describe("the pricing writer refuses what the reader cannot parse", () => {
  const authority = { workspaceId: OFFICIAL, role: "owner" as const };

  test("an unsafe ceiling integer is refused at the write and persists nothing", async () => {
    world();
    db.raw.prepare("UPDATE review_bots SET monthly_rp = 1000 WHERE id = ?").run(BOT_ROW);
    const unsafe = Number.MAX_SAFE_INTEGER + 2;
    expect(await updateBotPricing(db, { botId: BOT_ROW, monthlyRp: unsafe, authority, now: NOW })).toBe("invalid");
    expect(storedPricing().monthly_rp).toBe(1000);
  });

  test("a ceiling past the domain's ceiling is refused at the write", async () => {
    world();
    db.raw.prepare("UPDATE review_bots SET monthly_rp = 1000 WHERE id = ?").run(BOT_ROW);
    expect(
      await updateBotPricing(db, { botId: BOT_ROW, monthlyRp: RP_CEILING_MAX + 1, authority, now: NOW }),
    ).toBe("invalid");
    expect(storedPricing().monthly_rp).toBe(1000);
  });

  test("a multiplier above the bound is refused at the write", async () => {
    world();
    db.raw.prepare("UPDATE review_bots SET multiplier = 1 WHERE id = ?").run(BOT_ROW);
    expect(
      await updateBotPricing(db, { botId: BOT_ROW, multiplier: BOT_MULTIPLIER_MAX + 1, authority, now: NOW }),
    ).toBe("invalid");
    expect(storedPricing().multiplier).toBe(1);
  });

  test("the route answers 400 for both, so the SPA sees the same refusal", async () => {
    world();
    const unsafe = await patchPricing({ monthly_rp: Number.MAX_SAFE_INTEGER + 2 });
    expect(unsafe.status).toBe(400);
    const multiplier = await patchPricing({ multiplier: BOT_MULTIPLIER_MAX + 1 });
    expect(multiplier.status).toBe(400);
    const maxValid = await patchPricing({ monthly_rp: RP_CEILING_MAX, multiplier: BOT_MULTIPLIER_MAX });
    expect(maxValid.status).toBe(200);
    expect(storedPricing()).toEqual({ multiplier: BOT_MULTIPLIER_MAX, monthly_rp: RP_CEILING_MAX });
  });
});

describe("the price calculation fails closed", () => {
  const profile: QuotaProfile = {
    id: "quota-v2-large-base",
    version: 2,
    effectiveFrom: NOW,
    base: { quick: 50, default: 100, deep: 300 },
    rpPerCredit: 1000,
  };

  test("a max-valid multiplier prices representably", () => {
    const rp = rpFor("deep", BOT_MULTIPLIER_MAX, profile);
    expect(rp).toBe(300 * BOT_MULTIPLIER_MAX);
    expect(isRpCeiling(rp!)).toBe(true);
  });

  test("an unrepresentable product answers null instead of a number no ceiling can bound", () => {
    expect(rpFor("deep", Number.POSITIVE_INFINITY, profile)).toBeNull();
    expect(rpFor("deep", RP_CEILING_MAX, profile)).toBeNull();
  });
});

describe("the SPA parser applies the same domain", () => {
  const chainRow = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    position: 1,
    bot_id: "bot-1",
    name: "Priced",
    description: null,
    provider_workspace: "Default",
    owned: false,
    available: true,
    multiplier: 1,
    month_used_rp: 0,
    effective_monthly_rp: 1000,
    archived: false,
    default_chain: "anthropic/claude",
    runtime: "omp",
    ...overrides,
  });

  const appsPayload = (row: Record<string, unknown>): Record<string, unknown> => ({
    viewer: { login: "dana", role: "admin" },
    apps: [
      {
        github_app_id: 1,
        owned: true,
        installed: true,
        month: null,
        github_slug: "demo",
        github_name: "Demo",
        github_avatar_url: null,
        status: "active",
        review_enabled: 1,
        created_by: "dana",
        health: { latest: null, rejected24h: 0 },
        chain: [row],
      },
    ],
    shared_bots: [],
    pending_installations: [],
  });

  test("an unsafe ceiling row makes the parse fail, which is why the writer refuses it", () => {
    const parsed = parseApps(appsPayload(chainRow()));
    expect(parsed).not.toBeNull();
    expect((parsed as AppsPayload).apps[0]?.chain?.[0]?.effective_monthly_rp).toBe(1000);

    expect(parseApps(appsPayload(chainRow({ effective_monthly_rp: Number.MAX_SAFE_INTEGER + 2 })))).toBeNull();
    expect(parseApps(appsPayload(chainRow({ effective_monthly_rp: RP_CEILING_MAX + 1 })))).toBeNull();
  });

  test("a chain row's multiplier above the single-bot bound makes the parse fail", () => {
    expect(parseApps(appsPayload(chainRow()))).not.toBeNull();
    expect(parseApps(appsPayload(chainRow({ multiplier: BOT_MULTIPLIER_MAX + 1 })))).toBeNull();
  });

  // The wire fact: `month.multiplier` is the chain's PRODUCT. Two 100× bots —
  // each a legal stored value — make 10,000, which the single-bot bound refuses.
  // End to end on the real list route: the payload the server actually serves
  // for two mounted 100× bots must parse. This is the regression the guard
  // exists for — the aggregate is a product, and the single-bot bound refused it.
  test("a two-bot 100× chain serves month.multiplier 10,000 and parses", async () => {
    world();
    const partner = "bot-partner";
    db.raw
      .prepare(
        `INSERT INTO review_bots (id, workspace_id, name, multiplier, scope, created_at, updated_at)
         VALUES (?, ?, ?, 100, 'shared', ?, ?)`,
      )
      .run(partner, OFFICIAL, partner, NOW, NOW);
    db.raw.prepare("UPDATE review_bots SET multiplier = 100 WHERE id = ?").run(BOT_ROW);
    db.raw
      .prepare("INSERT INTO app_installations (github_app_id, workspace_id, created_at) VALUES (?, ?, ?)")
      .run(BOT_ROW, OFFICIAL, NOW);
    db.raw
      .prepare(
        `INSERT INTO app_install_bots (github_app_id, workspace_id, position, bot_id)
         VALUES (?, ?, 1, ?), (?, ?, 2, ?)`,
      )
      .run(BOT_ROW, OFFICIAL, BOT_ROW, BOT_ROW, OFFICIAL, partner);

    const session = await createSessionValue("dana", null, SESSION_SECRET);
    const res = await worker.fetch(
      new Request(`https://worker.local/dashboard/${OFFICIAL}/api/apps`, {
        headers: { Cookie: `${SESSION_COOKIE}=${session}` },
      }),
      envFor(),
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      apps: Array<{ github_app_id: number; month: { multiplier: number } | null }>;
    };
    const row = body.apps.find((app) => app.github_app_id === GITHUB_APP_ID)!;
    expect(row.month?.multiplier).toBe(100 * 100);
    // And the guard the SPA applies accepts the payload the server sends.
    expect(parseApps(body)).not.toBeNull();
  });

  test("a list row's chain-product multiplier parses past the single-bot bound", () => {
    const withMonth = (month: Record<string, unknown>) => {
      const base = appsPayload(chainRow());
      const rows = base.apps as Array<Record<string, unknown>>;
      const [only] = rows;
      return { ...base, apps: [{ ...only, month }] };
    };
    expect(parseApps(withMonth({ used_rp: 0, owned: false, multiplier: 100 * 100 }))).not.toBeNull();
    expect(parseApps(withMonth({ used_rp: 0, owned: false, multiplier: CHAIN_MULTIPLIER_MAX }))).not.toBeNull();
    // Past the price domain no stored ceiling could cover the chain's review.
    expect(parseApps(withMonth({ used_rp: 0, owned: false, multiplier: CHAIN_MULTIPLIER_MAX + 1 }))).toBeNull();
    expect(parseApps(withMonth({ used_rp: 0, owned: false, multiplier: Number.POSITIVE_INFINITY }))).toBeNull();
  });
});
