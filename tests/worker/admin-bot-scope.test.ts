/**
 * The console's bot-scope and official-workspace routes (contract § 8.1–§ 8.3).
 *
 * Pinned here:
 *   - a non-operator sees the framework 404 with an empty body and changes no
 *     row; a self-hosted worker does not register the routes at all;
 *   - `PATCH /api/official-workspace` refuses a malformed body, an unknown id
 *     and answers `200 { workspaceId: null }` for a clear;
 *   - `PATCH /api/bots/:botId/scope` maps the store's three refusals to their
 *     exact status/body pairs, and a refused write appends no audit row;
 *   - every accepted write carries exactly one `platform_audit_events` row
 *     with the before/after pair in the same batch, and a same-value write
 *     appends none;
 *   - `GET /api/bots` lists live rows only, and `GET /api/runtime` states the
 *     official workspace.
 */
import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";

const SESSION_SECRET = ["test", "bot", "scope", "secret", "32-bytes!"].join("-");
const OPERATOR = "Support-Bot";
const OPERATOR_KEY = OPERATOR.toLowerCase();
const MEMBER = "regular-member";
const OFFICIAL_KEY = "platform.official_workspace_id";

function insertUser(db: TestD1, login: string): void {
  db.raw
    .prepare("INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES (?, ?, 'member', ?, NULL)")
    .run(crypto.randomUUID(), login, new Date().toISOString());
}

function envFor(db: TestD1, overrides: Partial<Env> = {}): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} } as unknown as Env["REVIEW_QUEUE"],
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} } as unknown as Env["IDEMPOTENCY_KV"],
    GITHUB_OAUTH_CLIENT_ID: "client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "client-secret",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DEPLOYMENT_MODE: "saas",
    PLATFORM_OPERATORS: OPERATOR_KEY,
    DB: db,
    ...overrides,
  } as unknown as Env;
}

/** A workspace beside the seeded `default`; `deleted` stamps `deleted_at`. */
function seedWorkspace(db: TestD1, id: string, deleted = false): void {
  db.raw
    .prepare(
      `INSERT INTO workspaces (id, slug, name, created_at, deleted_at)
       VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z', ${deleted ? "'2026-01-02T00:00:00.000Z'" : "NULL"})`,
    )
    .run(id, id, id);
}

/** One bot with its `bot_workspaces` mapping; the id doubles as its name. */
function seedBot(
  db: TestD1,
  id: string,
  options: { githubAppId: number; workspaceId?: string; deleted?: boolean },
): void {
  db.raw
    .prepare(
      `INSERT INTO review_bots
         (id, github_app_id, name, private_key_enc, webhook_secret_enc, created_by,
          status, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, 'enc', 'enc', 'acme', 'active',
               ${options.deleted ? "'2026-01-02T00:00:00.000Z'" : "NULL"},
               '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
    .run(id, options.githubAppId, id);
  if (options.workspaceId !== undefined) {
    db.raw.prepare("INSERT INTO bot_workspaces (bot_id, workspace_id) VALUES (?, ?)").run(id, options.workspaceId);
  }
}

function seedOfficialWorkspace(db: TestD1, workspaceId: string): void {
  db.raw
    .prepare(
      `INSERT INTO review_runtime_settings (key, value, updated_at, updated_by)
       VALUES (?, ?, '2026-01-01T00:00:00.000Z', 'fixture')`,
    )
    .run(OFFICIAL_KEY, workspaceId);
}

type Audit = {
  action: string;
  actor_login: string;
  target_type: string;
  target_id: string;
  detail: unknown;
};

function audits(db: TestD1): Audit[] {
  return (
    db.raw
      .prepare(
        `SELECT action, actor_login, target_type, target_id, detail_json
           FROM platform_audit_events ORDER BY rowid`,
      )
      .all() as Array<{
      action: string;
      actor_login: string;
      target_type: string;
      target_id: string;
      detail_json: string | null;
    }>
  ).map((row) => ({
    action: row.action,
    actor_login: row.actor_login,
    target_type: row.target_type,
    target_id: row.target_id,
    detail: JSON.parse(row.detail_json ?? "null"),
  }));
}

function storedScope(db: TestD1, botId: string): { scope: string; shared_at: string | null } {
  return db.raw.query("SELECT scope, shared_at FROM review_bots WHERE id = ?").get(botId) as {
    scope: string;
    shared_at: string | null;
  };
}

function officialRow(db: TestD1): string | null {
  const row = db.raw
    .query("SELECT value FROM review_runtime_settings WHERE key = ?")
    .get(OFFICIAL_KEY) as { value: string } | null;
  return row?.value ?? null;
}

/** One admin request; `body` absent means no request body at all. */
async function adminRequest(
  db: TestD1,
  path: string,
  init: {
    method: "GET" | "PATCH";
    body?: string;
    login?: string | null;
    mode?: "saas" | "self-hosted";
  },
): Promise<Response> {
  const login = init.login === undefined ? OPERATOR : init.login;
  const headers: Record<string, string> = {};
  if (login !== null) {
    headers.Cookie = `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}`;
  }
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  return worker.fetch(
    new Request(`https://worker.local/_internal_admin${path}`, {
      method: init.method,
      headers,
      body: init.body,
    }),
    envFor(db, { DEPLOYMENT_MODE: init.mode ?? "saas" }),
  );
}

/**
 * The framework's unknown-path answer, for the same method and caller. The
 * admin namespace must not distinguish its refusals from a path that does not
 * exist, so each non-operator case is compared against this.
 */
async function unknownPath(db: TestD1, method: "GET" | "PATCH", login: string | null): Promise<Response> {
  return adminRequest(db, "/api/not-a-route", { method, login });
}

/** The exact bodies the contract freezes (§ 8.1–§ 8.2). */
const SHAPE_SCOPE_ERROR = 'body must be { scope: "owned" | "shared" }';
const SHAPE_WORKSPACE_ERROR = "body must be { workspaceId: <id> | null }";

describe("PATCH /_internal_admin/api/bots/:botId/scope", () => {
  test("a non-operator gets the empty 404 and no row changes", async () => {
    const db = createMigratedTestD1();
    insertUser(db, MEMBER);
    seedBot(db, "bot-1", { githubAppId: 7001, workspaceId: "default" });
    seedOfficialWorkspace(db, "default");

    for (const login of [MEMBER, null]) {
      const res = await adminRequest(db, "/api/bots/bot-1/scope", {
        method: "PATCH",
        body: JSON.stringify({ scope: "shared" }),
        login,
      });
      const unknown = await unknownPath(db, "PATCH", login);
      expect(res.status).toBe(404);
      expect(await res.text()).toBe(await unknown.text());
    }
    expect(storedScope(db, "bot-1")).toEqual({ scope: "owned", shared_at: null });
    expect(audits(db)).toEqual([]);
  });

  test("self-hosted registers no admin route", async () => {
    const db = createMigratedTestD1();
    insertUser(db, OPERATOR);
    seedBot(db, "bot-1", { githubAppId: 7002, workspaceId: "default" });

    const res = await adminRequest(db, "/api/bots/bot-1/scope", {
      method: "PATCH",
      body: JSON.stringify({ scope: "shared" }),
      mode: "self-hosted",
    });
    expect(res.status).toBe(404);
    expect(storedScope(db, "bot-1")).toEqual({ scope: "owned", shared_at: null });
  });

  test("a malformed scope body is the 400 shape refusal", async () => {
    const db = createMigratedTestD1();
    insertUser(db, OPERATOR);
    seedBot(db, "bot-1", { githubAppId: 7003, workspaceId: "default" });

    for (const body of ["{}", JSON.stringify({ scope: "global" }), '{"scope":1}', "not json"]) {
      const res = await adminRequest(db, "/api/bots/bot-1/scope", { method: "PATCH", body });
      expect(res.status, body).toBe(400);
      expect(await res.json()).toEqual({ error: SHAPE_SCOPE_ERROR });
    }
    expect(audits(db)).toEqual([]);
  });

  test("an unknown or soft-deleted bot is 404 bot not found", async () => {
    const db = createMigratedTestD1();
    insertUser(db, OPERATOR);
    seedBot(db, "bot-gone", { githubAppId: 7004, workspaceId: "default", deleted: true });

    for (const botId of ["bot-absent", "bot-gone"]) {
      const res = await adminRequest(db, `/api/bots/${botId}/scope`, {
        method: "PATCH",
        body: JSON.stringify({ scope: "shared" }),
      });
      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({ error: "bot not found" });
    }
    expect(audits(db)).toEqual([]);
  });

  test("sharing outside the official workspace is the named 409 and appends nothing", async () => {
    const db = createMigratedTestD1();
    insertUser(db, OPERATOR);
    seedWorkspace(db, "other");
    seedBot(db, "bot-elsewhere", { githubAppId: 7005, workspaceId: "other" });
    seedOfficialWorkspace(db, "default");

    const res = await adminRequest(db, "/api/bots/bot-elsewhere/scope", {
      method: "PATCH",
      body: JSON.stringify({ scope: "shared" }),
    });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "bot is outside the official workspace" });
    expect(storedScope(db, "bot-elsewhere")).toEqual({ scope: "owned", shared_at: null });
    expect(audits(db)).toEqual([]);
  });

  test("sharing inside the official workspace writes the row and one audit row", async () => {
    const db = createMigratedTestD1();
    insertUser(db, OPERATOR);
    seedBot(db, "bot-share", { githubAppId: 7006, workspaceId: "default" });
    seedOfficialWorkspace(db, "default");

    const res = await adminRequest(db, "/api/bots/bot-share/scope", {
      method: "PATCH",
      body: JSON.stringify({ scope: "shared" }),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { botId: string; scope: string; sharedAt: string | null };
    expect(body.botId).toBe("bot-share");
    expect(body.scope).toBe("shared");
    expect(typeof body.sharedAt).toBe("string");

    expect(storedScope(db, "bot-share")).toEqual({ scope: "shared", shared_at: body.sharedAt });
    expect(audits(db)).toEqual([
      {
        action: "runtime.bot_scope.set",
        actor_login: OPERATOR,
        target_type: "bot",
        target_id: "bot-share",
        detail: {
          before: { scope: "owned", shared_at: null },
          after: { scope: "shared", shared_at: body.sharedAt },
        },
      },
    ]);
  });

  test("unsharing needs confirm: true, and the accepted write is audited", async () => {
    const db = createMigratedTestD1();
    insertUser(db, OPERATOR);
    seedBot(db, "bot-unshare", { githubAppId: 7007, workspaceId: "default" });
    seedOfficialWorkspace(db, "default");
    db.raw
      .prepare("UPDATE review_bots SET scope = 'shared', shared_at = '2026-01-05T00:00:00.000Z' WHERE id = ?")
      .run("bot-unshare");

    const refused = await adminRequest(db, "/api/bots/bot-unshare/scope", {
      method: "PATCH",
      body: JSON.stringify({ scope: "owned" }),
    });
    expect(refused.status).toBe(400);
    expect(await refused.json()).toEqual({ error: "unsharing requires confirm: true" });
    expect(storedScope(db, "bot-unshare")).toEqual({ scope: "shared", shared_at: "2026-01-05T00:00:00.000Z" });
    expect(audits(db)).toEqual([]);

    const accepted = await adminRequest(db, "/api/bots/bot-unshare/scope", {
      method: "PATCH",
      body: JSON.stringify({ scope: "owned", confirm: true }),
    });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toEqual({ botId: "bot-unshare", scope: "owned", sharedAt: null });
    expect(storedScope(db, "bot-unshare")).toEqual({ scope: "owned", shared_at: null });
    expect(audits(db)).toEqual([
      {
        action: "runtime.bot_scope.set",
        actor_login: OPERATOR,
        target_type: "bot",
        target_id: "bot-unshare",
        detail: {
          before: { scope: "shared", shared_at: "2026-01-05T00:00:00.000Z" },
          after: { scope: "owned", shared_at: null },
        },
      },
    ]);
  });

  test("a same-value write returns 200 and appends no audit row", async () => {
    const db = createMigratedTestD1();
    insertUser(db, OPERATOR);
    seedBot(db, "bot-owned", { githubAppId: 7008, workspaceId: "default" });

    const res = await adminRequest(db, "/api/bots/bot-owned/scope", {
      method: "PATCH",
      body: JSON.stringify({ scope: "owned" }),
    });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ botId: "bot-owned", scope: "owned", sharedAt: null });
    expect(audits(db)).toEqual([]);
  });
});

describe("PATCH /_internal_admin/api/official-workspace", () => {
  test("a malformed body is the 400 shape refusal", async () => {
    const db = createMigratedTestD1();
    insertUser(db, OPERATOR);

    for (const body of ["{}", '{"workspaceId":""}', '{"workspaceId":1}', '{"workspaceId":{}}', "not json"]) {
      const res = await adminRequest(db, "/api/official-workspace", { method: "PATCH", body });
      expect(res.status, body).toBe(400);
      expect(await res.json()).toEqual({ error: SHAPE_WORKSPACE_ERROR });
    }
    expect(officialRow(db)).toBeNull();
    expect(audits(db)).toEqual([]);
  });

  test("an unknown or retired workspace is 400 workspace not found, writing nothing", async () => {
    const db = createMigratedTestD1();
    insertUser(db, OPERATOR);
    seedWorkspace(db, "retired", true);

    for (const workspaceId of ["nope", "retired"]) {
      const res = await adminRequest(db, "/api/official-workspace", {
        method: "PATCH",
        body: JSON.stringify({ workspaceId }),
      });
      expect(res.status, workspaceId).toBe(400);
      expect(await res.json()).toEqual({ error: "workspace not found" });
    }
    expect(officialRow(db)).toBeNull();
    expect(audits(db)).toEqual([]);
  });

  test("an accepted write stores the id with one audit row; clearing deletes it", async () => {
    const db = createMigratedTestD1();
    insertUser(db, OPERATOR);
    seedWorkspace(db, "acme");

    const set = await adminRequest(db, "/api/official-workspace", {
      method: "PATCH",
      body: JSON.stringify({ workspaceId: "acme" }),
    });
    expect(set.status).toBe(200);
    expect(await set.json()).toEqual({ workspaceId: "acme" });
    expect(officialRow(db)).toBe("acme");

    const clear = await adminRequest(db, "/api/official-workspace", {
      method: "PATCH",
      body: JSON.stringify({ workspaceId: null }),
    });
    expect(clear.status).toBe(200);
    expect(await clear.json()).toEqual({ workspaceId: null });
    expect(officialRow(db)).toBeNull();

    expect(audits(db)).toEqual([
      {
        action: "runtime.official_workspace.set",
        actor_login: OPERATOR,
        target_type: "runtime",
        target_id: OFFICIAL_KEY,
        detail: { before: null, after: "acme" },
      },
      {
        action: "runtime.official_workspace.set",
        actor_login: OPERATOR,
        target_type: "runtime",
        target_id: OFFICIAL_KEY,
        detail: { before: "acme", after: null },
      },
    ]);

    // Clearing again is idempotent and appends nothing.
    const again = await adminRequest(db, "/api/official-workspace", {
      method: "PATCH",
      body: JSON.stringify({ workspaceId: null }),
    });
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ workspaceId: null });
    expect(audits(db)).toHaveLength(2);
  });

  test("a non-operator gets the empty 404 and writes nothing", async () => {
    const db = createMigratedTestD1();
    insertUser(db, MEMBER);
    seedWorkspace(db, "acme");

    const res = await adminRequest(db, "/api/official-workspace", {
      method: "PATCH",
      body: JSON.stringify({ workspaceId: "acme" }),
      login: MEMBER,
    });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(await (await unknownPath(db, "PATCH", MEMBER)).text());
    expect(officialRow(db)).toBeNull();
    expect(audits(db)).toEqual([]);
  });
});

describe("GET /_internal_admin/api/bots", () => {
  test("lists live bots with their scope, ordered by name then id", async () => {
    const db = createMigratedTestD1();
    insertUser(db, OPERATOR);
    seedWorkspace(db, "other");
    seedBot(db, "bot-b", { githubAppId: 7101, workspaceId: "other" });
    seedBot(db, "bot-a", { githubAppId: 7102, workspaceId: "default" });
    seedBot(db, "bot-dead", { githubAppId: 7103, workspaceId: "default", deleted: true });
    db.raw
      .prepare("UPDATE review_bots SET scope = 'shared', shared_at = '2026-01-05T00:00:00.000Z' WHERE id = 'bot-b'")
      .run();

    const res = await adminRequest(db, "/api/bots", { method: "GET" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      bots: [
        {
          botId: "bot-a",
          name: "bot-a",
          githubAppId: 7102,
          workspaceId: "default",
          scope: "owned",
          sharedAt: null,
          deletedAt: null,
        },
        {
          botId: "bot-b",
          name: "bot-b",
          githubAppId: 7101,
          workspaceId: "other",
          scope: "shared",
          sharedAt: "2026-01-05T00:00:00.000Z",
          deletedAt: null,
        },
      ],
    });
    // The console read is unaudited.
    expect(audits(db)).toEqual([]);
  });

  test("a non-operator gets the empty 404", async () => {
    const db = createMigratedTestD1();
    insertUser(db, MEMBER);
    seedBot(db, "bot-a", { githubAppId: 7104, workspaceId: "default" });

    const res = await adminRequest(db, "/api/bots", { method: "GET", login: MEMBER });
    expect(res.status).toBe(404);
    expect(await res.text()).toBe(await (await unknownPath(db, "GET", MEMBER)).text());
  });
});

describe("GET /_internal_admin/api/runtime", () => {
  test("states the official workspace, absent = null", async () => {
    const db = createMigratedTestD1();
    insertUser(db, OPERATOR);

    const absent = await adminRequest(db, "/api/runtime", { method: "GET" });
    expect(absent.status).toBe(200);
    expect((await absent.json()) as { officialWorkspaceId: unknown }).toMatchObject({
      officialWorkspaceId: null,
    });

    seedWorkspace(db, "acme");
    seedOfficialWorkspace(db, "acme");
    const set = await adminRequest(db, "/api/runtime", { method: "GET" });
    expect((await set.json()) as { officialWorkspaceId: unknown }).toMatchObject({
      officialWorkspaceId: "acme",
    });
  });
});
