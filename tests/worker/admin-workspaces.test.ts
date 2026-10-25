/**
 * The console's workspace list (plan 116 Task 3, spec operator-admin-surface
 * §3.3).
 *
 * Pinned at the product seam: the counts, the owner login and the resolved plan
 * all come from the one list statement, so a lapsed invite row still stored as
 * `pending` holds no seat and must not be counted.
 */
import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";

const SESSION_SECRET = ["test", "workspace", "plan", "secret", "32-bytes"].join("-");
const OPERATOR = "Support-Bot";
const STAMP = "2026-10-01T00:00:00.000Z";
const DAY_MS = 86_400_000;

// --- fixtures (raw writes; the routes and stores read real SQL) -------------

function insertUser(db: TestD1, login: string): string {
  const id = crypto.randomUUID();
  db.raw
    .prepare(
      "INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES (?, ?, 'member', ?, NULL)",
    )
    .run(id, login, STAMP);
  return id;
}

function insertWorkspace(
  db: TestD1,
  row: { id: string; name: string; createdAt: string; createdBy?: string | null },
): void {
  db.raw
    .prepare(
      `INSERT INTO workspaces (id, slug, name, created_by, created_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, NULL)`,
    )
    .run(row.id, row.id, row.name, row.createdBy ?? null, row.createdAt);
}

function insertMember(
  db: TestD1,
  workspaceId: string,
  userId: string,
  role: "owner" | "admin" | "member",
): void {
  db.raw
    .prepare(
      "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
    )
    .run(workspaceId, userId, role, STAMP);
}

function insertInvite(
  db: TestD1,
  row: { workspaceId: string; login: string; expiresAt: string },
): void {
  db.raw
    .prepare(
      `INSERT INTO workspace_invites
         (id, workspace_id, github_login, role, status, invited_by, created_at, expires_at, accepted_at)
       VALUES (?, ?, ?, 'member', 'pending', NULL, ?, ?, NULL)`,
    )
    .run(crypto.randomUUID(), row.workspaceId, row.login, STAMP, row.expiresAt);
}

function insertSubscription(db: TestD1, workspaceId: string, planId: string): void {
  db.raw
    .prepare(
      `INSERT INTO workspace_subscriptions (workspace_id, plan_id, status, created_at, updated_at)
       VALUES (?, ?, 'active', ?, ?)`,
    )
    .run(workspaceId, planId, STAMP, STAMP);
}

function liveFromNow(): string {
  return new Date(Date.now() + DAY_MS).toISOString();
}

function lapsedFromNow(): string {
  return new Date(Date.now() - DAY_MS).toISOString();
}

function envFor(db: TestD1, overrides: Partial<Env> = {}): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} } as unknown as Env["REVIEW_QUEUE"],
    IDEMPOTENCY_KV: {
      get: async () => null,
      put: async () => {},
    } as unknown as Env["IDEMPOTENCY_KV"],
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DEPLOYMENT_MODE: "self-hosted",
    PLATFORM_OPERATORS: OPERATOR.toLowerCase(),
    DB: db,
    ...overrides,
  } as unknown as Env;
}

async function api(
  db: TestD1,
  init: {
    method: "GET" | "PATCH";
    path: string;
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
    new Request(`https://worker.local/_internal_admin${init.path}`, {
      method: init.method,
      headers,
      body: init.body,
    }),
    envFor(db, { DEPLOYMENT_MODE: init.mode ?? "saas" }),
  );
}

async function listOf(db: TestD1): Promise<Array<Record<string, unknown>>> {
  const res = await api(db, { method: "GET", path: "/api/workspaces" });
  expect(res.status).toBe(200);
  return ((await res.json()) as { workspaces: Array<Record<string, unknown>> }).workspaces;
}

// --- the list ---------------------------------------------------------------

describe("GET /_internal_admin/api/workspaces", () => {
  test("returns owner, live counts, resolved plan and creation stamp", async () => {
    const db = createMigratedTestD1();
    insertUser(db, OPERATOR);
    const aliceId = insertUser(db, "alice");
    const bobId = insertUser(db, "bob");
    insertUser(db, "carol");
    insertUser(db, "dave");

    insertWorkspace(db, {
      id: "ws-alpha",
      name: "Alpha",
      createdBy: aliceId,
      createdAt: "2026-10-01T00:00:00.000Z",
    });
    insertMember(db, "ws-alpha", aliceId, "owner");
    insertMember(db, "ws-alpha", bobId, "member");
    // One live pending invite and one lapsed row still stored as `pending`:
    // the lapsed one holds no seat and must not be counted.
    insertInvite(db, { workspaceId: "ws-alpha", login: "carol", expiresAt: liveFromNow() });
    insertInvite(db, { workspaceId: "ws-alpha", login: "dave", expiresAt: lapsedFromNow() });
    insertSubscription(db, "ws-alpha", "pro");

    // No subscription and no owner: the row still resolves to the free plan.
    insertWorkspace(db, {
      id: "ws-beta",
      name: "Beta",
      createdAt: "2026-10-02T00:00:00.000Z",
    });

    // `default` is seeded by migration 0026; newest-first puts it first.
    expect(await listOf(db)).toEqual([
      {
        id: "default",
        name: "Default",
        slug: "default",
        ownerLogin: null,
        memberCount: 0,
        pendingInviteCount: 0,
        planId: "free",
        createdAt: "2026-10-21T00:00:00.000Z",
      },
      {
        id: "ws-beta",
        name: "Beta",
        slug: "ws-beta",
        ownerLogin: null,
        memberCount: 0,
        pendingInviteCount: 0,
        planId: "free",
        createdAt: "2026-10-02T00:00:00.000Z",
      },
      {
        id: "ws-alpha",
        name: "Alpha",
        slug: "ws-alpha",
        ownerLogin: "alice",
        memberCount: 2,
        pendingInviteCount: 1,
        planId: "pro",
        createdAt: "2026-10-01T00:00:00.000Z",
      },
    ]);
  });
});
