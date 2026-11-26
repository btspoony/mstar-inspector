import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import { APP_ROUTES } from "../../src/dashboard/index";
import { ADMIN_ROUTES } from "../../src/admin/index";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import type { Env } from "../../src/worker/env";
import { createMigratedTestD1, seedBot, mapAppToDefaultWorkspace, type TestD1 } from "../store/helpers";
import { withSpaAssets } from "../helpers/spa";

/**
 * Behavioural proof of the post-split route table (task 4, F4): mounted
 * requests, not source-shape assertions. The old `/api/apps/:appId` bot-
 * configuration paths answer 404 (they are deleted, not aliased); the new
 * `/api/review-bots/:botId` paths resolve the bot; a numeric bot id is
 * refused before any query (F1); a bot owned by another workspace is refused
 * (F2 — authorization is the bot's own workspace, never a same-id App).
 * Route-table lookups remain only where they pin REGISTRATION.
 */

const SESSION_SECRET = ["test", "route", "split", "session", "32-bytes!"].join("-");
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

function envFor(db: TestD1): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} },
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} },
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "oauth-client-secret",
    DEPLOYMENT_MODE: "self-hosted",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DASHBOARD_ENCRYPTION_KEY: TEST_KEY,
    DB: db,
  } as unknown as Env;
}

function seedWorkspaceMember(db: TestD1, id: string, login: string): void {
  db.raw
    .prepare(
      "INSERT OR IGNORE INTO workspaces (id, slug, name, created_by, created_at, deleted_at) VALUES (?, ?, ?, NULL, ?, NULL)",
    )
    .run(id, id, id, "2026-10-01T00:00:00.000Z");
  const userId = crypto.randomUUID();
  db.raw
    .prepare("INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES (?, ?, 'member', ?, NULL)")
    .run(userId, login, "2026-10-01T00:00:00.000Z");
  db.raw
    .prepare("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)")
    .run(id, userId, "2026-10-01T00:00:00.000Z");
}

async function req(
  db: TestD1,
  method: string,
  path: string,
  login: string,
  body?: unknown,
): Promise<Response> {
  return worker.fetch(
    new Request(`https://worker.local/dashboard/${path}`, {
      method,
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
        Cookie: `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}`,
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    withSpaAssets(envFor(db)),
  );
}

async function world(): Promise<{ db: TestD1 }> {
  const db = createMigratedTestD1();
  seedWorkspaceMember(db, "default", "dana");
  seedWorkspaceMember(db, "ws-foreign", "frank");
  // The pair whose bot the routes must resolve: uuid-shaped id (never all
  // digits), the App's numeric GitHub id is 9201 — deliberately DIFFERENT
  // from anything the bot id parses as.
  seedBot(db, "bot-own-uuid", 9201);
  await mapAppToDefaultWorkspace(db, "bot-own-uuid");
  // A bot owned by the foreign workspace.
  seedBot(db, "bot-foreign-uuid", 9202, { workspaceId: "ws-foreign" });
  return { db };
}

describe("the deleted bot-configuration paths answer 404 (never aliased)", () => {
  for (const [method, path] of [
    ["GET", "default/api/apps/9201/settings"],
    ["GET", "default/api/apps/9201/bot"],
    ["GET", "default/api/apps/9201/models"],
    ["POST", "default/api/apps/9201/keys/verify"],
    ["PATCH", "default/api/apps/9201/bot/scope"],
    ["POST", "default/apps/9201/settings"],
  ] as const) {
    test(`${method} /${path}`, async () => {
      const { db } = await world();
      const res = await req(db, method, path, "dana", method === "PATCH" ? { scope: "shared" } : undefined);
      expect(res.status).toBe(404);
    });
  }
});

describe("the new bot routes resolve the intended entity", () => {
  test("GET /api/review-bots/:botId/settings resolves the bot", async () => {
    const { db } = await world();
    const res = await req(db, "GET", "default/api/review-bots/bot-own-uuid/settings", "dana");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { app: { id: string } };
    expect(body.app.id).toBe("bot-own-uuid");
  });

  test("GET /api/review-bots/:botId/bot resolves the bot with an empty mount list", async () => {
    const { db } = await world();
    const res = await req(db, "GET", "default/api/review-bots/bot-own-uuid/bot", "dana");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { app: { id: string }; installations: unknown[] };
    expect(body.app.id).toBe("bot-own-uuid");
    // F2: the mount list is empty — no App fields come through a same-id join.
    expect(body.installations).toEqual([]);
  });

  test("GET /api/apps/:appId/deliveries resolves the App by its numeric GitHub id", async () => {
    const { db } = await world();
    const res = await req(db, "GET", "default/api/apps/9201/deliveries", "dana");
    expect(res.status).toBe(200);
  });
});

describe("the id boundary refuses the wrong shape (F1)", () => {
  test("a numeric bot id is refused on the bot route", async () => {
    const { db } = await world();
    // 9201 IS a live numeric GitHub App id in this world — exactly the
    // collision F1 forbids. The bot route must never resolve it.
    const res = await req(db, "GET", "default/api/review-bots/9201/settings", "dana");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("unknown app");
  });

  test("a non-numeric segment is refused on the App route", async () => {
    const { db } = await world();
    const res = await req(db, "GET", "default/api/apps/bot-own-uuid/deliveries", "dana");
    expect(res.status).toBe(404);
  });
});

describe("foreign-workspace authorization (F2)", () => {
  test("a bot owned by another workspace is refused", async () => {
    const { db } = await world();
    const res = await req(db, "GET", "default/api/review-bots/bot-foreign-uuid/settings", "dana");
    expect(res.status).toBe(404);
    expect(await res.text()).toBe("unknown app");
  });
});

describe("route registration pins", () => {
  test("the table registers both share switches and the moved configuration routes", () => {
    const has = (method: string, path: string) =>
      APP_ROUTES.some((row: { method: string; path: string }) => row.method === method && row.path === path);
    expect(has("patch", "/api/apps/:appId/scope")).toBe(true);
    expect(has("patch", "/api/review-bots/:botId/scope")).toBe(true);
    expect(has("get", "/api/review-bots/:botId/settings")).toBe(true);
    expect(has("get", "/api/apps/:appId/deliveries")).toBe(true);
  });

  test("the operator console registers the distinct bot-scope route", () => {
    const botRoute = ADMIN_ROUTES.find(
      (row) => row.method === "patch" && row.path === "/api/review-bots/:botId/scope",
    );
    const appRoute = ADMIN_ROUTES.find(
      (row) => row.method === "patch" && row.path === "/api/bots/:botId/scope",
    );
    expect(botRoute).toBeDefined();
    expect(appRoute).toBeDefined();
    expect(appRoute!.handler).not.toBe(botRoute!.handler);
  });
});
