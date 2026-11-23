import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import type { Env } from "../../src/worker/env";
import { createMigratedTestD1, seedBot, seedTarget, type TestD1 } from "../store/helpers";

const SESSION_SECRET = ["test", "bot", "scope", "route", "secret", "32-bytes!"].join("-");
const OFFICIAL = "default";
const OTHER = "ws-other";
const HOME_BOT = 8101;
const OTHER_BOT = 8102;
const SHAPE_ERROR = 'body must be { scope: "owned" | "shared" }';
const READ_ONLY_KEY = "settings.error.botReadOnly";

let db: TestD1;

function envFor(target: TestD1): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} },
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} },
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "oauth-client-secret",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DEPLOYMENT_MODE: "self-hosted",
    DB: target,
  } as unknown as Env;
}

function insertUser(target: TestD1, login: string): void {
  target.raw
    .prepare("INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES (?, ?, 'member', ?, NULL)")
    .run(crypto.randomUUID(), login, "2026-01-01T00:00:00.000Z");
}

function seedWorkspace(target: TestD1, id: string): void {
  target.raw
    .prepare("INSERT INTO workspaces (id, slug, name, created_by, created_at, deleted_at) VALUES (?, ?, ?, NULL, ?, NULL)")
    .run(id, id, id, "2026-01-01T00:00:00.000Z");
}

function seedMembership(target: TestD1, workspaceId: string, login: string, role: string): void {
  target.raw
    .prepare(
      "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) SELECT ?, id, ?, '2026-01-01T00:00:00.000Z' FROM users WHERE github_login = ?",
    )
    .run(workspaceId, role, login);
}

function seedOfficialWorkspace(target: TestD1, workspaceId: string): void {
  target.raw
    .prepare(
      "INSERT INTO review_runtime_settings (key, value, updated_at, updated_by) VALUES ('platform.official_workspace_id', ?, '2026-01-01T00:00:00.000Z', 'fixture')",
    )
    .run(workspaceId);
}

function seedOwnedBot(target: TestD1, botId: string, githubAppId: number, workspaceId: string): void {
  seedBot(target, botId, githubAppId);
  target.raw.prepare("INSERT INTO bot_workspaces (bot_id, workspace_id) VALUES (?, ?)").run(botId, workspaceId);
}

function setScope(target: TestD1, botId: string, scope: "owned" | "shared"): void {
  target.raw
    .prepare("UPDATE review_bots SET scope = ?, shared_at = ? WHERE id = ?")
    .run(scope, scope === "shared" ? "2026-01-05T00:00:00.000Z" : null, botId);
}

function world(): TestD1 {
  const target = createMigratedTestD1();
  insertUser(target, "dana");
  insertUser(target, "mallory");
  insertUser(target, "erin");
  seedWorkspace(target, OTHER);
  seedMembership(target, OFFICIAL, "dana", "owner");
  seedMembership(target, OFFICIAL, "mallory", "member");
  seedMembership(target, OTHER, "erin", "owner");
  seedOfficialWorkspace(target, OFFICIAL);
  seedOwnedBot(target, "bot-home", HOME_BOT, OFFICIAL);
  seedOwnedBot(target, "bot-other", OTHER_BOT, OTHER);
  seedTarget(target, "bot-home", { workspaceId: OTHER, repoOwner: "acme", repoName: "widgets" });
  return target;
}

async function patch(ref: string, appId: number | string, login: string, body?: string): Promise<Response> {
  const session = await createSessionValue(login, null, SESSION_SECRET);
  return worker.fetch(
    new Request("https://worker.local/dashboard/" + ref + "/api/apps/" + appId + "/bot/scope", {
      method: "PATCH",
      headers: {
        Cookie: SESSION_COOKIE + "=" + session,
        ...(body === undefined ? {} : { "Content-Type": "application/json" }),
      },
      body,
    }),
    envFor(db),
  );
}

function storedScope(botId: string): { scope: string; shared_at: string | null } {
  return db.raw.query("SELECT scope, shared_at FROM review_bots WHERE id = ?").get(botId) as {
    scope: string;
    shared_at: string | null;
  };
}

function audits(): Array<{ actor_login: string; action: string; target_id: string; detail: unknown }> {
  return (
    db.raw
      .prepare("SELECT actor_login, action, target_id, detail_json FROM platform_audit_events ORDER BY rowid")
      .all() as Array<{ actor_login: string; action: string; target_id: string; detail_json: string | null }>
  ).map((row) => ({
    actor_login: row.actor_login,
    action: row.action,
    target_id: row.target_id,
    detail: JSON.parse(row.detail_json ?? "null"),
  }));
}

describe("PATCH /dashboard/<ref>/api/apps/:appId/bot/scope", () => {
  test("the owning workspace shares the bot: one row write and one audit row", async () => {
    db = world();
    const res = await patch(OFFICIAL, HOME_BOT, "dana", JSON.stringify({ scope: "shared" }));

    expect(res.status).toBe(200);
    const body = (await res.json()) as { scope: string; sharedAt: string | null };
    expect(body.scope).toBe("shared");
    expect(typeof body.sharedAt).toBe("string");
    expect(storedScope("bot-home")).toEqual({ scope: "shared", shared_at: body.sharedAt });
    expect(audits()).toEqual([
      {
        actor_login: "dana",
        action: "runtime.bot_scope.set",
        target_id: "bot-home",
        detail: {
          before: { scope: "owned", shared_at: null },
          after: { scope: "shared", shared_at: body.sharedAt },
        },
      },
    ]);
  });

  test("revoking needs confirm: true, and the confirmed revoke is audited", async () => {
    db = world();
    setScope(db, "bot-home", "shared");

    const refused = await patch(OFFICIAL, HOME_BOT, "dana", JSON.stringify({ scope: "owned" }));
    expect(refused.status).toBe(409);
    expect(await refused.json()).toEqual({ error: "confirm required" });
    expect(storedScope("bot-home")).toEqual({ scope: "shared", shared_at: "2026-01-05T00:00:00.000Z" });
    expect(audits()).toEqual([]);

    const accepted = await patch(OFFICIAL, HOME_BOT, "dana", JSON.stringify({ scope: "owned", confirm: true }));
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ scope: "owned", sharedAt: null });
    expect(storedScope("bot-home")).toEqual({ scope: "owned", shared_at: null });
    expect(audits()).toHaveLength(1);
    expect(audits()[0]?.detail).toEqual({
      before: { scope: "shared", shared_at: "2026-01-05T00:00:00.000Z" },
      after: { scope: "owned", shared_at: null },
    });
  });

  test("a same-value transition answers the stored state and appends nothing", async () => {
    db = world();
    setScope(db, "bot-home", "shared");

    const res = await patch(OFFICIAL, HOME_BOT, "dana", JSON.stringify({ scope: "shared" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ scope: "shared", sharedAt: "2026-01-05T00:00:00.000Z" });
    expect(audits()).toEqual([]);
  });

  test("sharing a bot outside the official workspace is the named 409, with zero writes", async () => {
    db = world();
    const res = await patch(OTHER, OTHER_BOT, "erin", JSON.stringify({ scope: "shared" }));

    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "bot is outside the official workspace" });
    expect(storedScope("bot-other")).toEqual({ scope: "owned", shared_at: null });
    expect(audits()).toEqual([]);
  });

  test("revoking is NOT gated on the designation: a stale share stays revocable", async () => {
    db = world();
    setScope(db, "bot-other", "shared");
    const res = await patch(OTHER, OTHER_BOT, "erin", JSON.stringify({ scope: "owned", confirm: true }));

    expect(res.status).toBe(200);
    expect(storedScope("bot-other")).toEqual({ scope: "owned", shared_at: null });
    expect(audits()).toHaveLength(1);
  });

  test("a plain member is 403 and writes nothing", async () => {
    db = world();
    const res = await patch(OFFICIAL, HOME_BOT, "mallory", JSON.stringify({ scope: "shared" }));

    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "forbidden" });
    expect(storedScope("bot-home")).toEqual({ scope: "owned", shared_at: null });
    expect(audits()).toEqual([]);
  });

  test("a target on a shared bot grants no configuration authority", async () => {
    db = world();
    setScope(db, "bot-home", "shared");
    for (const scope of ["owned", "shared"] as const) {
      const res = await patch(OTHER, HOME_BOT, "erin", JSON.stringify({ scope, confirm: true }));
      expect(res.status, scope).toBe(403);
      expect((await res.json()) as { key: unknown }, scope).toMatchObject({ key: READ_ONLY_KEY });
    }
    expect(storedScope("bot-home")).toEqual({ scope: "shared", shared_at: "2026-01-05T00:00:00.000Z" });
    expect(audits()).toEqual([]);
  });

  test("an unknown App is 404 and a malformed body is the 400 shape refusal", async () => {
    db = world();
    const unknown = await patch(OFFICIAL, 9999, "dana", JSON.stringify({ scope: "shared" }));
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "unknown app" });

    for (const body of ["{}", JSON.stringify({ scope: "global" }), '{"scope":1}', "not json"]) {
      const res = await patch(OFFICIAL, HOME_BOT, "dana", body);
      expect(res.status, body).toBe(400);
      expect(await res.json()).toEqual({ error: SHAPE_ERROR });
    }
    expect(storedScope("bot-home")).toEqual({ scope: "owned", shared_at: null });
    expect(audits()).toEqual([]);
  });
});

describe("GET a shared bot's read faces from a workspace that does not own it", () => {
  const ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

  function sharedWorld(): TestD1 {
    const target = world();
    setScope(target, "bot-home", "shared");
    seedTarget(target, "bot-home", { workspaceId: OFFICIAL, repoOwner: "globex", repoName: "secret-repo" });
    target.raw
      .prepare(
        `INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at, removed_at)
         VALUES ('inst-globex', 'bot-home', 4401, 'globex', datetime('now'), NULL)`,
      )
      .run();
    target.raw
      .prepare(
        `INSERT INTO bot_custom_providers (bot_id, provider_id, base_url, api, model_ids, created_at, updated_at)
         VALUES ('bot-home', 'globex-llm', 'https://llm.globex.internal/v1', 'openai-completions', '["m1"]', datetime('now'), datetime('now'))`,
      )
      .run();
    const delivery = target.raw.prepare(
      `INSERT INTO webhook_deliveries (id, bot_id, event_name, outcome, status_code, repository_full_name, reason)
       VALUES (?, 'bot-home', ?, ?, ?, ?, NULL)`,
    );
    delivery.run("d-globex-1", "pull_request", "rejected", 401, "globex/secret-repo");
    delivery.run("d-globex-2", "check_suite", "ok", null, "globex/secret-repo");
    delivery.run("d-install", "installation", "ok", null, null);
    delivery.run("d-acme", "pull_request", "ok", null, "ACME/Widgets");
    return target;
  }

  async function get(ref: string, path: string, login: string): Promise<Response> {
    const session = await createSessionValue(login, null, SESSION_SECRET);
    return worker.fetch(
      new Request("https://worker.local/dashboard/" + ref + "/api/apps/" + HOME_BOT + path, {
        headers: { Cookie: SESSION_COOKIE + "=" + session },
      }),
      { ...envFor(db), DASHBOARD_ENCRYPTION_KEY: ENCRYPTION_KEY } as Env,
    );
  }

  type BotBody = {
    can_manage: boolean;
    installations: unknown[];
    keys: unknown[];
    model_chain: unknown;
    model_roles: Record<string, unknown>;
    model_chains: unknown[];
    custom_providers: unknown[];
    configured_providers: unknown[];
    delivery_summary: { latest: { event_name: string | null } | null; rejected24h: number };
  };
  type DeliveriesBody = {
    deliveries: Array<{ repository_full_name: string | null; event_name: string | null }>;
    total: number;
    repos: string[];
    types: string[];
  };

  test("workspace B sees none of workspace A's installations, providers or repositories", async () => {
    db = sharedWorld();

    const bot = await get(OTHER, "/bot", "erin");
    expect(bot.status).toBe(200);
    const botBody = (await bot.json()) as BotBody;
    expect(botBody.can_manage).toBe(false);
    expect(botBody.installations).toEqual([]);
    expect(botBody.keys).toEqual([]);
    expect(botBody.model_chain).toBeNull();
    expect(botBody.model_roles).toEqual({});
    expect(botBody.model_chains).toEqual([]);
    expect(botBody.custom_providers).toEqual([]);
    expect(botBody.configured_providers).toEqual([]);
    expect(botBody.delivery_summary).toEqual({
      latest: expect.objectContaining({ event_name: "pull_request", outcome: "ok" }),
      rejected24h: 0,
    });
    const botText = JSON.stringify(botBody);
    expect(botText).not.toContain("globex");

    const deliveries = await get(OTHER, "/deliveries", "erin");
    expect(deliveries.status).toBe(200);
    const deliveriesBody = (await deliveries.json()) as DeliveriesBody;
    expect(deliveriesBody.total).toBe(1);
    expect(deliveriesBody.deliveries.map((row) => row.repository_full_name)).toEqual(["ACME/Widgets"]);
    expect(deliveriesBody.repos).toEqual(["ACME/Widgets"]);
    expect(deliveriesBody.types).toEqual(["pull_request"]);
    expect(JSON.stringify(deliveriesBody)).not.toContain("globex");

    const probe = await get(OTHER, "/deliveries?repo=globex/secret-repo", "erin");
    expect(probe.status).toBe(200);
    expect((await probe.json()) as DeliveriesBody).toMatchObject({ deliveries: [], total: 0 });
  });

  test("a workspace with no target on the shared bot reads no deliveries at all", async () => {
    db = sharedWorld();
    insertUser(db, "frank");
    seedWorkspace(db, "ws-third");
    seedMembership(db, "ws-third", "frank", "owner");

    const deliveries = await get("ws-third", "/deliveries", "frank");
    expect(deliveries.status).toBe(200);
    expect((await deliveries.json()) as DeliveriesBody).toEqual({ deliveries: [], total: 0, repos: [], types: [] });
    const bot = await get("ws-third", "/bot", "frank");
    expect(bot.status).toBe(200);
    const botBody = (await bot.json()) as BotBody;
    expect(botBody.installations).toEqual([]);
    expect(botBody.delivery_summary).toEqual({ latest: null, rejected24h: 0 });
  });

  test("the Apps list health column reads only the caller's repositories on a shared bot", async () => {
    db = sharedWorld();
    async function listHealth(ref: string, login: string, botId: string) {
      const session = await createSessionValue(login, null, SESSION_SECRET);
      const res = await worker.fetch(
        new Request("https://worker.local/dashboard/" + ref + "/api/apps", {
          headers: { Cookie: SESSION_COOKIE + "=" + session },
        }),
        { ...envFor(db), DASHBOARD_ENCRYPTION_KEY: ENCRYPTION_KEY } as Env,
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        apps: Array<{ bot_id: string; health: { latest: { event_name: string | null } | null; rejected24h: number } }>;
      };
      return body.apps.find((row) => row.bot_id === botId)!.health;
    }

    seedOwnedBot(db, "bot-third", 8199, OFFICIAL);
    setScope(db, "bot-third", "shared");
    seedTarget(db, "bot-third", { workspaceId: OTHER, repoOwner: "acme", repoName: "gadgets" });
    const delivery = db.raw.prepare(
      `INSERT INTO webhook_deliveries (id, bot_id, event_name, outcome, status_code, repository_full_name, reason)
       VALUES (?, 'bot-third', ?, ?, ?, ?, NULL)`,
    );
    delivery.run("d-third-gadgets", "check_run", "rejected", 401, "acme/gadgets");
    delivery.run("d-third-globex", "pull_request", "ok", null, "globex/secret-repo");

    const consumer = await listHealth(OTHER, "erin", "bot-home");
    expect(consumer.rejected24h).toBe(0);
    expect(consumer.latest).toEqual(expect.objectContaining({ event_name: "pull_request", outcome: "ok" }));
    const consumerThird = await listHealth(OTHER, "erin", "bot-third");
    expect(consumerThird.rejected24h).toBe(1);
    expect(consumerThird.latest).toEqual(expect.objectContaining({ event_name: "check_run", outcome: "rejected" }));

    const owner = await listHealth(OFFICIAL, "dana", "bot-home");
    expect(owner.rejected24h).toBe(1);
    const ownerThird = await listHealth(OFFICIAL, "dana", "bot-third");
    expect(ownerThird.latest).toEqual(expect.objectContaining({ event_name: "pull_request", outcome: "ok" }));
  });

  test("the owning workspace still reads the whole App", async () => {
    db = sharedWorld();

    const bot = await get(OFFICIAL, "/bot", "dana");
    expect(bot.status).toBe(200);
    const botBody = (await bot.json()) as Omit<BotBody, "installations"> & {
      installations: Array<{ account_login: string }>;
    };
    expect(botBody.installations.map((row) => row.account_login)).toEqual(["globex"]);
    expect(botBody.custom_providers).toHaveLength(1);
    expect(botBody.delivery_summary.rejected24h).toBe(1);

    const deliveries = await get(OFFICIAL, "/deliveries", "dana");
    const deliveriesBody = (await deliveries.json()) as DeliveriesBody;
    expect(deliveriesBody.total).toBe(4);
    expect(deliveriesBody.repos).toEqual(["ACME/Widgets", "globex/secret-repo"]);
  });
});

describe("GET a shared bot's settings face from a workspace that does not own it", () => {
  test("the settings payload leaves the App-wide sections empty and the delivery summary scoped", async () => {
    db = world();
    setScope(db, "bot-home", "shared");
    seedTarget(db, "bot-home", { workspaceId: OFFICIAL, repoOwner: "globex", repoName: "secret-repo" });
    db.raw
      .prepare(
        `INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at, removed_at)
         VALUES ('inst-globex', 'bot-home', 4401, 'globex', datetime('now'), NULL)`,
      )
      .run();
    db.raw
      .prepare(
        `INSERT INTO webhook_deliveries (id, bot_id, event_name, outcome, status_code, repository_full_name, reason)
         VALUES ('d-globex', 'bot-home', 'pull_request', 'rejected', 401, 'globex/secret-repo', NULL)`,
      )
      .run();
    db.raw
      .prepare(
        `INSERT INTO webhook_deliveries (id, bot_id, event_name, outcome, status_code, repository_full_name, reason)
         VALUES ('d-acme', 'bot-home', 'pull_request', 'ok', 202, 'ACME/Widgets', NULL)`,
      )
      .run();
    const session = await createSessionValue("erin", null, SESSION_SECRET);
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/" + OTHER + "/api/apps/" + HOME_BOT + "/settings", {
        headers: { Cookie: SESSION_COOKIE + "=" + session },
      }),
      { ...envFor(db), DASHBOARD_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64") } as Env,
    );
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      can_configure_bot: boolean;
      installations: unknown[];
      keys: unknown[];
      custom_providers: unknown[];
      delivery_summary: { latest: { outcome: string; status_code: number | null } | null; rejected24h: number };
    };
    expect(body.can_configure_bot).toBe(false);
    expect(body.installations).toEqual([]);
    expect(body.keys).toEqual([]);
    expect(body.custom_providers).toEqual([]);
    expect(body.delivery_summary).toEqual({
      latest: expect.objectContaining({ outcome: "ok", status_code: 202 }),
      rejected24h: 0,
    });
  });
});
