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
