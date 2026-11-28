import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import type { Env } from "../../src/worker/env";
import { createMigratedTestD1, seedBot, seedTarget, type TestD1 } from "../store/helpers";
import { createAppConfigStore } from "../../src/dashboard/app-config-store";
import { setBotArchived, updateBotPricing, updateBotProfile } from "../../src/dashboard/apps-store";

const SESSION_SECRET = ["test", "bot", "face", "writes", "secret", "32-bytes!"].join("-");
const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
const OFFICIAL = "default";
const OTHER = "ws-other";
const HOME_BOT = 8301;
const OTHER_BOT = 8302;
const HOME_BOT_ROW = "bot-home";
const OTHER_BOT_ROW = "bot-other";

let db: TestD1;

function envFor(): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} },
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} },
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "oauth-client-secret",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DASHBOARD_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    DEPLOYMENT_MODE: "self-hosted",
    DB: db,
  } as unknown as Env;
}

function insertUser(login: string): void {
  db.raw
    .prepare("INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES (?, ?, 'member', ?, NULL)")
    .run(crypto.randomUUID(), login, "2026-01-01T00:00:00.000Z");
}

function seedWorkspace(id: string): void {
  db.raw
    .prepare("INSERT INTO workspaces (id, slug, name, created_by, created_at, deleted_at) VALUES (?, ?, ?, NULL, ?, NULL)")
    .run(id, id, id, "2026-01-01T00:00:00.000Z");
}

function seedMembership(workspaceId: string, login: string, role: string): void {
  db.raw
    .prepare(
      "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) SELECT ?, id, ?, '2026-01-01T00:00:00.000Z' FROM users WHERE github_login = ?",
    )
    .run(workspaceId, role, login);
}

function seedOwnedBot(botId: string, githubAppId: number, workspaceId: string): void {
  seedBot(db, botId, githubAppId);
  db.raw.prepare("INSERT OR REPLACE INTO app_workspaces (app_id, workspace_id) VALUES (?, ?)").run(botId, workspaceId);
  // The scoped read keys on review_bots.workspace_id, not the App mapping.
  db.raw.prepare("UPDATE review_bots SET workspace_id = ? WHERE id = ?").run(workspaceId, botId);
}

function world(): void {
  db = createMigratedTestD1();
  insertUser("dana");
  insertUser("mallory");
  insertUser("erin");
  seedWorkspace(OTHER);
  seedMembership(OFFICIAL, "dana", "owner");
  seedMembership(OFFICIAL, "mallory", "member");
  seedMembership(OTHER, "erin", "owner");
  db.raw
    .prepare(
      "INSERT INTO review_runtime_settings (key, value, updated_at, updated_by) VALUES ('platform.official_workspace_id', ?, '2026-01-01T00:00:00.000Z', 'fixture')",
    )
    .run(OFFICIAL);
  seedOwnedBot(HOME_BOT_ROW, HOME_BOT, OFFICIAL);
  seedOwnedBot(OTHER_BOT_ROW, OTHER_BOT, OTHER);
  // A consumer of the home bot: a target alone, plus the shared scope the
  // consumer's chain resolution needs.
  db.raw.prepare("UPDATE review_bots SET scope = 'shared', shared_at = '2026-01-05T00:00:00.000Z' WHERE id = ?").run(
    HOME_BOT_ROW,
  );
  seedTarget(db, HOME_BOT_ROW, { workspaceId: OTHER, repoOwner: "acme", repoName: "widgets" });
}

/**
 * A DB whose first `UPDATE review_bots` statement competes with it: a second
 * manager writes `column` between this request's read and its write. That is
 * the interleaving an omitted field must not undo.
 */
function racingDb(column: string, value: unknown): TestD1 {
  let fired = false;
  return {
    prepare(query: string) {
      if (!fired && query.includes("UPDATE review_bots SET")) {
        fired = true;
        db.raw.prepare(`UPDATE review_bots SET ${column} = ? WHERE id = ?`).run(value as never, HOME_BOT_ROW);
      }
      return db.prepare(query);
    },
    batch: (statements: Parameters<TestD1["batch"]>[0]) => db.batch(statements),
  } as unknown as TestD1;
}

async function patch(
  ref: string,
  botId: string,
  face: string,
  login: string,
  body?: unknown,
  racing?: TestD1,
): Promise<Response> {
  const session = await createSessionValue(login, null, SESSION_SECRET);
  return worker.fetch(
    new Request("https://worker.local/dashboard/" + ref + "/api/review-bots/" + botId + "/" + face, {
      method: "PATCH",
      headers: {
        Cookie: SESSION_COOKIE + "=" + session,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body: body === undefined ? undefined : typeof body === "string" ? body : JSON.stringify(body),
    }),
    racing === undefined ? envFor() : ({ ...envFor(), DB: racing } as unknown as Env),
  );
}

async function getBot(ref: string, botId: string, login: string): Promise<Response> {
  const session = await createSessionValue(login, null, SESSION_SECRET);
  return worker.fetch(
    new Request("https://worker.local/dashboard/" + ref + "/api/review-bots/" + botId + "/bot", {
      headers: { Cookie: SESSION_COOKIE + "=" + session },
    }),
    envFor(),
  );
}

function stored(botId: string): {
  name: string;
  description: string | null;
  multiplier: number;
  monthly_rp: number | null;
  archived_at: string | null;
  updated_at: string;
} {
  return db.raw
    .prepare("SELECT name, description, multiplier, monthly_rp, archived_at, updated_at FROM review_bots WHERE id = ?")
    .get(botId) as {
    name: string;
    description: string | null;
    multiplier: number;
    monthly_rp: number | null;
    archived_at: string | null;
    updated_at: string;
  };
}

function setUpdatedAt(botId: string, value: string): void {
  db.raw.prepare("UPDATE review_bots SET updated_at = ? WHERE id = ?").run(value, botId);
}

describe("PATCH /api/review-bots/:botId/profile", () => {
  test("the owner writes name and description, trimming the name and bumping updated_at", async () => {
    world();
    setUpdatedAt(HOME_BOT_ROW, "2026-01-01T00:00:00.000Z");

    const res = await patch(OFFICIAL, HOME_BOT_ROW, "profile", "dana", {
      name: "  Release bot ",
      description: "reviews the release repos",
    });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const row = stored(HOME_BOT_ROW);
    expect(row.name).toBe("Release bot");
    expect(row.description).toBe("reviews the release repos");
    expect(row.updated_at).not.toBe("2026-01-01T00:00:00.000Z");
  });

  test("an omitted description keeps the stored one; null clears it", async () => {
    world();
    db.raw.prepare("UPDATE review_bots SET description = 'kept' WHERE id = ?").run(HOME_BOT_ROW);

    expect((await patch(OFFICIAL, HOME_BOT_ROW, "profile", "dana", { name: "Renamed" })).status).toBe(200);
    expect(stored(HOME_BOT_ROW).description).toBe("kept");

    expect((await patch(OFFICIAL, HOME_BOT_ROW, "profile", "dana", { name: "Renamed", description: null })).status).toBe(
      200,
    );
    expect(stored(HOME_BOT_ROW).description).toBeNull();
    expect(stored(HOME_BOT_ROW).name).toBe("Renamed");
  });

  test("a blank name and a non-string description are 400 with zero writes", async () => {
    world();
    db.raw.prepare("UPDATE review_bots SET name = 'original', description = NULL WHERE id = ?").run(HOME_BOT_ROW);

    for (const body of [{ name: "   " }, { name: "" }, { name: 7 }, { name: "ok", description: 3 }, "not json", "[]"]) {
      const res = await patch(OFFICIAL, HOME_BOT_ROW, "profile", "dana", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(stored(HOME_BOT_ROW).name).toBe("original");
  });

  test("a plain member is 403 and another workspace's owner is 403, both writing nothing", async () => {
    world();
    db.raw.prepare("UPDATE review_bots SET name = 'original' WHERE id = ?").run(HOME_BOT_ROW);

    const member = await patch(OFFICIAL, HOME_BOT_ROW, "profile", "mallory", { name: "hijacked" });
    expect(member.status).toBe(403);
    expect(await member.json()).toEqual({ error: "forbidden" });

    const stranger = await patch(OFFICIAL, OTHER_BOT_ROW, "profile", "dana", { name: "hijacked" });
    expect(stranger.status).toBe(404);
    expect(stored(OTHER_BOT_ROW).name).toBe("bot-other");

    const consumer = await patch(OTHER, HOME_BOT_ROW, "profile", "erin", { name: "hijacked" });
    expect(consumer.status).toBe(403);

    expect(stored(HOME_BOT_ROW).name).toBe("original");
  });

  test("a name-only write keeps a description another manager set while it was in flight", async () => {
    world();
    db.raw.prepare("UPDATE review_bots SET name = 'original', description = 'kept' WHERE id = ?").run(HOME_BOT_ROW);

    const res = await patch(
      OFFICIAL,
      HOME_BOT_ROW,
      "profile",
      "dana",
      { name: "Renamed" },
      racingDb("description", "set while renaming"),
    );

    expect(res.status).toBe(200);
    const row = stored(HOME_BOT_ROW);
    expect(row.name).toBe("Renamed");
    expect(row.description).toBe("set while renaming");
  });

  test("an unknown bot is 404", async () => {
    world();
    const res = await patch(OFFICIAL, "no-such-bot", "profile", "dana", { name: "x" });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown bot" });
  });
});

describe("PATCH /api/review-bots/:botId/pricing", () => {
  test("the owner sets the multiplier and the monthly ceiling", async () => {
    world();
    const res = await patch(OFFICIAL, HOME_BOT_ROW, "pricing", "dana", { multiplier: 2.5, monthly_rp: 500000 });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(stored(HOME_BOT_ROW).multiplier).toBe(2.5);
    expect(stored(HOME_BOT_ROW).monthly_rp).toBe(500000);
  });

  test("monthly_rp null means no bot-level ceiling", async () => {
    world();
    db.raw.prepare("UPDATE review_bots SET monthly_rp = 1000 WHERE id = ?").run(HOME_BOT_ROW);

    const res = await patch(OFFICIAL, HOME_BOT_ROW, "pricing", "dana", { multiplier: 1, monthly_rp: null });
    expect(res.status).toBe(200);
    expect(stored(HOME_BOT_ROW).monthly_rp).toBeNull();
    expect(stored(HOME_BOT_ROW).multiplier).toBe(1);
  });

  test("a multiplier of 0, negative or non-numeric is 400, and so is an empty body", async () => {
    world();
    db.raw.prepare("UPDATE review_bots SET multiplier = 1, monthly_rp = NULL WHERE id = ?").run(HOME_BOT_ROW);

    for (const body of [{ multiplier: 0 }, { multiplier: -1 }, { multiplier: "2" }, {}, "not json"]) {
      const res = await patch(OFFICIAL, HOME_BOT_ROW, "pricing", "dana", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(stored(HOME_BOT_ROW).multiplier).toBe(1);
  });

  test("a ceiling-only save omits the multiplier, which stays untouched", async () => {
    world();
    // The page omits `multiplier` while unshared; the ceiling must still save.
    db.raw.prepare("UPDATE review_bots SET multiplier = 3.5, monthly_rp = NULL WHERE id = ?").run(HOME_BOT_ROW);

    const res = await patch(OFFICIAL, HOME_BOT_ROW, "pricing", "dana", { monthly_rp: 250000 });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    const row = stored(HOME_BOT_ROW);
    expect(row.multiplier).toBe(3.5);
    expect(row.monthly_rp).toBe(250000);
  });

  test("a zero, negative or fractional monthly_rp is 400 with zero writes", async () => {
    world();
    for (const monthly_rp of [0, -5, 1.5, "10"]) {
      const res = await patch(OFFICIAL, HOME_BOT_ROW, "pricing", "dana", { multiplier: 2, monthly_rp });
      expect(res.status, String(monthly_rp)).toBe(400);
    }
    expect(stored(HOME_BOT_ROW).multiplier).toBe(1);
    expect(stored(HOME_BOT_ROW).monthly_rp).toBeNull();
  });

  test("a multiplier-only write keeps a ceiling another manager set while it was in flight", async () => {
    world();
    db.raw.prepare("UPDATE review_bots SET multiplier = 1, monthly_rp = NULL WHERE id = ?").run(HOME_BOT_ROW);

    const res = await patch(
      OFFICIAL,
      HOME_BOT_ROW,
      "pricing",
      "dana",
      { multiplier: 2 },
      racingDb("monthly_rp", 500000),
    );

    expect(res.status).toBe(200);
    const row = stored(HOME_BOT_ROW);
    expect(row.multiplier).toBe(2);
    expect(row.monthly_rp).toBe(500000);
  });

  test("a plain member is 403 and writes nothing", async () => {
    world();
    const res = await patch(OFFICIAL, HOME_BOT_ROW, "pricing", "mallory", { multiplier: 3 });
    expect(res.status).toBe(403);
    expect(stored(HOME_BOT_ROW).multiplier).toBe(1);
  });

  test("a consumer of a shared bot is 403 and writes nothing", async () => {
    world();
    db.raw.prepare("UPDATE review_bots SET monthly_rp = 1000 WHERE id = ?").run(HOME_BOT_ROW);
    const res = await patch(OTHER, HOME_BOT_ROW, "pricing", "erin", { multiplier: 3 });
    expect(res.status).toBe(403);
    const row = stored(HOME_BOT_ROW);
    expect(row.multiplier).toBe(1);
    expect(row.monthly_rp).toBe(1000);
  });
});

describe("PATCH /api/review-bots/:botId/archive", () => {
  test("archiving stamps archived_at; restoring clears it", async () => {
    world();
    const archived = await patch(OFFICIAL, HOME_BOT_ROW, "archive", "dana", { archived: true });
    expect(archived.status).toBe(200);
    expect(await archived.json()).toEqual({ ok: true });
    const stamp = stored(HOME_BOT_ROW).archived_at;
    expect(typeof stamp).toBe("string");

    const restored = await patch(OFFICIAL, HOME_BOT_ROW, "archive", "dana", { archived: false });
    expect(restored.status).toBe(200);
    expect(stored(HOME_BOT_ROW).archived_at).toBeNull();
  });

  test("a non-boolean archived is 400 and writes nothing", async () => {
    world();
    for (const body of [{ archived: "true" }, { archived: 1 }, {}, "not json"]) {
      const res = await patch(OFFICIAL, HOME_BOT_ROW, "archive", "dana", body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
    expect(stored(HOME_BOT_ROW).archived_at).toBeNull();
  });

  test("a plain member is 403 and an unknown bot is 404", async () => {
    world();
    expect((await patch(OFFICIAL, HOME_BOT_ROW, "archive", "mallory", { archived: true })).status).toBe(403);
    expect(stored(HOME_BOT_ROW).archived_at).toBeNull();
    expect((await patch(OFFICIAL, "no-such-bot", "archive", "dana", { archived: true })).status).toBe(404);
  });

  test("a consumer of a shared bot is 403 and cannot archive it", async () => {
    world();
    const res = await patch(OTHER, HOME_BOT_ROW, "archive", "erin", { archived: true });
    expect(res.status).toBe(403);
    expect(stored(HOME_BOT_ROW).archived_at).toBeNull();
  });

  test("GET /bot reports archived: true once the bot is archived", async () => {
    world();
    const before = (await (await getBot(OFFICIAL, HOME_BOT_ROW, "dana")).json()) as { archived: boolean };
    expect(before.archived).toBe(false);

    expect((await patch(OFFICIAL, HOME_BOT_ROW, "archive", "dana", { archived: true })).status).toBe(200);

    const after = (await (await getBot(OFFICIAL, HOME_BOT_ROW, "dana")).json()) as { archived: boolean };
    expect(after.archived).toBe(true);
  });

  test("GET /bot reports archived: true to a consumer of the shared bot", async () => {
    world();
    expect((await patch(OFFICIAL, HOME_BOT_ROW, "archive", "dana", { archived: true })).status).toBe(200);

    const seen = (await (await getBot(OTHER, HOME_BOT_ROW, "erin")).json()) as { archived: boolean; can_manage: boolean };
    expect(seen.archived).toBe(true);
    expect(seen.can_manage).toBe(false);
  });
});

/**
 * The owner machinery is manager-only. A plain member of the OWNNING workspace
 * reads the consumer face, so their payload must not carry the owner's keys,
 * seats, named chains, custom providers or ceiling exceptions — and the share
 * switch's official-workspace fact exists only for a manager.
 */
describe("GET /bot narrows the owner machinery to managers", () => {
  async function seedOwnerMachinery(): Promise<void> {
    const store = createAppConfigStore(db, TEST_ENCRYPTION_KEY);
    const authority = { botId: HOME_BOT_ROW, workspaceId: OFFICIAL, role: "owner" as const };
    await store.addProviderKey(authority, HOME_BOT_ROW, "anthropic", "sk-ant-fixture-key");
    await store.upsertModelChain(authority, HOME_BOT_ROW, "named", "anthropic/claude");
    await store.setModelChainSeat(authority, HOME_BOT_ROW, "code-reviewer", "named");
    await store.upsertCustomProvider(
      authority,
      HOME_BOT_ROW,
      {
        provider_id: "acme-llm",
        base_url: "https://llm.example.com/v1",
        api: "openai-completions",
        model_ids: ["acme-7b"],
      },
      "sk-custom-fixture-key",
    );
    db.raw
      .prepare(
        `INSERT INTO bot_quota_overrides (bot_id, workspace_id, monthly_rp, updated_at)
         VALUES (?, ?, 1200, '2026-01-06T00:00:00.000Z')`,
      )
      .run(HOME_BOT_ROW, OTHER);
  }

  type BotFace = {
    can_manage: boolean;
    official_workspace?: boolean;
    rp_per_credit?: number;
    quota_overrides?: Array<{ workspaceId: string }>;
    keys: unknown[];
    model_roles: Record<string, string>;
    model_chains: Array<{ name: string }>;
    custom_providers: unknown[];
    configured_providers: unknown[];
    overview: { effective_ceiling: number | null; plan_monthly_rp: number | null };
  };

  test("a plain member of the owning workspace receives no owner machinery", async () => {
    world();
    await seedOwnerMachinery();

    const member = (await (await getBot(OFFICIAL, HOME_BOT_ROW, "mallory")).json()) as BotFace;
    expect(member.can_manage).toBe(false);
    expect(member.keys).toEqual([]);
    expect(member.model_roles).toEqual({});
    expect(member.model_chains).toEqual([]);
    expect(member.custom_providers).toEqual([]);
    expect(member.configured_providers).toEqual([]);
    // The switch's fact and the exception list are manager answers only.
    expect("official_workspace" in member).toBe(false);
    expect("quota_overrides" in member).toBe(false);
  });

  test("the manager of the owning workspace still reads all of it", async () => {
    world();
    await seedOwnerMachinery();

    const owner = (await (await getBot(OFFICIAL, HOME_BOT_ROW, "dana")).json()) as BotFace;
    expect(owner.can_manage).toBe(true);
    expect(owner.official_workspace).toBe(true);
    expect(owner.keys).toHaveLength(2); // the provider key plus the custom-provider key
    expect(owner.model_roles).toEqual({ "code-reviewer": "named" });
    expect(owner.model_chains.map((row) => row.name)).toContain("named");
    expect(owner.custom_providers).toHaveLength(1);
    expect(owner.quota_overrides?.map((row) => row.workspaceId)).toEqual([OTHER]);
  });

  test("the served rate and the enforced ceiling reach owner and consumer alike", async () => {
    world();
    await seedOwnerMachinery();
    db.raw.prepare("UPDATE review_bots SET monthly_rp = 3000 WHERE id = ?").run(HOME_BOT_ROW);

    const owner = (await (await getBot(OFFICIAL, HOME_BOT_ROW, "dana")).json()) as BotFace;
    expect(typeof owner.rp_per_credit).toBe("number");
    // The owner's own workspace has no override: the bot default applies.
    expect(owner.overview.effective_ceiling).toBe(3000);

    const consumer = (await (await getBot(OTHER, HOME_BOT_ROW, "erin")).json()) as BotFace;
    expect(typeof consumer.rp_per_credit).toBe("number");
    // The consumer's negotiated 1,200 RP override wins over the 3,000 default,
    // and no plan ceiling is confused with it.
    expect(consumer.overview.effective_ceiling).toBe(1200);
    expect("quota_overrides" in consumer).toBe(false);
    // A consumer has no share switch to reach, so the fact is not served.
    expect("official_workspace" in consumer).toBe(false);

    // The switch itself still answers for an owner outside the official
    // workspace: the fact is served, and it is false.
    const otherOwner = (await (await getBot(OTHER, OTHER_BOT_ROW, "erin")).json()) as BotFace;
    expect(otherOwner.can_manage).toBe(true);
    expect(otherOwner.official_workspace).toBe(false);
  });

  test("an empty quota_profiles table omits the rate instead of failing the read", async () => {
    world();
    db.raw.run(
      `DELETE FROM workspace_quota_binding;
       DELETE FROM quota_profile_plans;
       DELETE FROM quota_profiles;`,
    );

    const res = await getBot(OFFICIAL, HOME_BOT_ROW, "dana");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect("rp_per_credit" in body).toBe(false);
  });
});

/**
 * The store's own re-check, called with no route in front of it. The route
 * gates first, so only these direct calls prove the store refuses on its own.
 */
describe("bot writers refuse in the store itself", () => {
  const NOW = "2026-02-01T00:00:00.000Z";

  for (const [label, authority] of [
    ["a plain member of the owning workspace", { workspaceId: OFFICIAL, role: "member" as const }],
    ["an owner of a different workspace", { workspaceId: OTHER, role: "owner" as const }],
  ] as const) {
    test(updateBotProfile.name + " refuses " + label + " and writes nothing", async () => {
      world();
      db.raw.prepare("UPDATE review_bots SET name = 'original', description = 'kept' WHERE id = ?").run(HOME_BOT_ROW);

      const outcome = await updateBotProfile(db, {
        botId: HOME_BOT_ROW,
        name: "hijacked",
        description: null,
        authority,
        now: NOW,
      });

      expect(outcome).toBe("forbidden");
      const row = stored(HOME_BOT_ROW);
      expect(row.name).toBe("original");
      expect(row.description).toBe("kept");
    });

    test(updateBotPricing.name + " refuses " + label + " and writes nothing", async () => {
      world();
      db.raw.prepare("UPDATE review_bots SET multiplier = 1, monthly_rp = 1000 WHERE id = ?").run(HOME_BOT_ROW);

      const outcome = await updateBotPricing(db, {
        botId: HOME_BOT_ROW,
        multiplier: 9,
        monthlyRp: null,
        authority,
        now: NOW,
      });

      expect(outcome).toBe("forbidden");
      const row = stored(HOME_BOT_ROW);
      expect(row.multiplier).toBe(1);
      expect(row.monthly_rp).toBe(1000);
    });

    test(setBotArchived.name + " refuses " + label + " and writes nothing", async () => {
      world();

      const outcome = await setBotArchived(db, {
        botId: HOME_BOT_ROW,
        archived: true,
        authority,
        now: NOW,
      });

      expect(outcome).toBe("forbidden");
      expect(stored(HOME_BOT_ROW).archived_at).toBeNull();
    });
  }
});

/**
 * Item F1-5: archive is a LOCK, not a deletion. Every configuration write —
 * profile, pricing, overrides, share, the legacy settings ops and the key
 * routes — refuses until the bot is restored, and restore is the transition
 * that reopens them.
 */
describe("an archived bot refuses every configuration write until it is restored", () => {
  async function archive(): Promise<void> {
    const res = await patch(OFFICIAL, HOME_BOT_ROW, "archive", "dana", { archived: true });
    expect(res.status).toBe(200);
  }

  async function restore(): Promise<void> {
    const res = await patch(OFFICIAL, HOME_BOT_ROW, "archive", "dana", { archived: false });
    expect(res.status).toBe(200);
  }

  function setArchivedAt(value: string | null): void {
    db.raw.prepare("UPDATE review_bots SET archived_at = ? WHERE id = ?").run(value, HOME_BOT_ROW);
  }

  function overrides(): Array<{ workspace_id: string }> {
    return db.raw
      .query("SELECT workspace_id FROM bot_quota_overrides WHERE bot_id = ?")
      .all(HOME_BOT_ROW) as Array<{ workspace_id: string }>;
  }

  test("profile and pricing are 409 while archived, and both accept after restore", async () => {
    world();
    await archive();

    const profile = await patch(OFFICIAL, HOME_BOT_ROW, "profile", "dana", { name: "renamed" });
    expect(profile.status).toBe(409);
    expect(await profile.json()).toMatchObject({ key: "settings.error.botArchived" });
    expect(stored(HOME_BOT_ROW).name).toBe("bot-home");

    const pricing = await patch(OFFICIAL, HOME_BOT_ROW, "pricing", "dana", { multiplier: 3 });
    expect(pricing.status).toBe(409);
    expect(stored(HOME_BOT_ROW).multiplier).toBe(1);

    await restore();
    expect((await patch(OFFICIAL, HOME_BOT_ROW, "profile", "dana", { name: "renamed" })).status).toBe(200);
    expect(stored(HOME_BOT_ROW).name).toBe("renamed");
    expect((await patch(OFFICIAL, HOME_BOT_ROW, "pricing", "dana", { multiplier: 3 })).status).toBe(200);
    expect(stored(HOME_BOT_ROW).multiplier).toBe(3);
  });

  test("the per-workspace override write is 409 while archived and accepts after restore", async () => {
    world();
    const write = async (monthlyRp: number) =>
      worker.fetch(
        new Request(`https://worker.local/dashboard/${OFFICIAL}/api/review-bots/${HOME_BOT_ROW}/quota-overrides`, {
          method: "PATCH",
          headers: {
            Cookie: `${SESSION_COOKIE}=${await createSessionValue("dana", null, SESSION_SECRET)}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ workspaceId: OTHER, monthlyRp }),
        }),
        envFor(),
      );

    await archive();
    const refused = await write(900);
    expect(refused.status).toBe(409);
    expect(overrides()).toEqual([]);

    await restore();
    expect((await write(900)).status).toBe(200);
    expect(overrides()).toEqual([{ workspace_id: OTHER }]);
  });

  test("the bot share switch is 409 while archived and accepts after restore", async () => {
    world();
    setArchivedAt("2026-02-01T00:00:00.000Z");
    const share = async () =>
      worker.fetch(
        new Request(`https://worker.local/dashboard/${OFFICIAL}/api/review-bots/${HOME_BOT_ROW}/scope`, {
          method: "PATCH",
          headers: {
            Cookie: `${SESSION_COOKIE}=${await createSessionValue("dana", null, SESSION_SECRET)}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({ scope: "owned", confirm: true }),
        }),
        envFor(),
      );
    const before = stored(HOME_BOT_ROW);

    expect((await share()).status).toBe(409);
    expect(stored(HOME_BOT_ROW).name).toBe(before.name);

    setArchivedAt(null);
    expect((await share()).status).toBe(200);
  });

  test("the legacy settings op and the key routes are 409 while archived", async () => {
    world();
    setArchivedAt("2026-02-01T00:00:00.000Z");
    for (const [path, form] of [
      [
        `/dashboard/${OFFICIAL}/review-bots/${HOME_BOT_ROW}/settings`,
        { op: "save-sandbox-image", sandbox_image_id: "omp" },
      ],
      [`/dashboard/${OFFICIAL}/api/review-bots/${HOME_BOT_ROW}/keys/verify`, { provider: "", key: "" }],
      [`/dashboard/${OFFICIAL}/review-bots/${HOME_BOT_ROW}/settings/key/delete`, { provider: "zai", key_id: "nope" }],
    ] as const) {
      const res = await worker.fetch(
        new Request(`https://worker.local${path}`, {
          method: "POST",
          headers: { Cookie: `${SESSION_COOKIE}=${await createSessionValue("dana", null, SESSION_SECRET)}` },
          body: new URLSearchParams(form),
        }),
        envFor(),
      );
      expect(res.status, path).toBe(409);
    }
    // Nothing was written: the bot and its configuration tables are untouched.
    expect(stored(HOME_BOT_ROW).archived_at).not.toBeNull();
  });

  test("the store itself refuses each write for an archived bot, without a route in front of it", async () => {
    world();
    setArchivedAt("2026-02-01T00:00:00.000Z");
    const authority = { workspaceId: OFFICIAL, role: "owner" as const };
    const now = "2026-02-02T00:00:00.000Z";

    expect(await updateBotProfile(db, { botId: HOME_BOT_ROW, name: "x", authority, now })).toBe("archived");
    expect(await updateBotPricing(db, { botId: HOME_BOT_ROW, multiplier: 2, authority, now })).toBe("archived");
    // Restore stays possible: it is the one transition an archived bot takes.
    expect(await setBotArchived(db, { botId: HOME_BOT_ROW, archived: false, authority, now })).toBe("ok");
    expect(stored(HOME_BOT_ROW).archived_at).toBeNull();
  });
});
