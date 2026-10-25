/**
 * The console's user list (spec operator-admin-surface §3.3).
 *
 * Pinned at the product seams: two users — one on the operator allowlist, one
 * holding a live support grant — with all five fields asserted, and the counts
 * proving they are resolved in SQL rather than per row (two live memberships,
 * a soft-deleted workspace that must not count, an expired grant that must not
 * count). One refusal case holds the read-only surface boundary.
 */
import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";

const SESSION_SECRET = ["test", "user", "list", "secret", "32-bytes"].join("-");
const OPERATOR = "Support-Bot";
const GRANT_HOLDER = "Regular-Member";
const STAMP = "2026-10-01T00:00:00.000Z";
const DAY_MS = 86_400_000;

// --- fixtures (raw writes; the route reads real SQL) ------------------------

function insertUser(db: TestD1, login: string): string {
  const id = crypto.randomUUID();
  db.raw
    .prepare(
      "INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES (?, ?, 'member', ?, NULL)",
    )
    .run(id, login, STAMP);
  return id;
}

function insertWorkspace(db: TestD1, id: string, deletedAt: string | null): void {
  db.raw
    .prepare(
      `INSERT INTO workspaces (id, slug, name, created_by, created_at, deleted_at)
       VALUES (?, ?, ?, NULL, ?, ?)`,
    )
    .run(id, id, id, STAMP, deletedAt);
}

function insertMember(db: TestD1, workspaceId: string, userId: string): void {
  db.raw
    .prepare(
      "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'member', ?)",
    )
    .run(workspaceId, userId, STAMP);
}

/** The grant's login is lowercased on purpose: the column is NOCASE. */
function insertGrant(
  db: TestD1,
  workspaceId: string,
  operatorLogin: string,
  expiresAt: string,
): void {
  db.raw
    .prepare(
      `INSERT INTO support_grants
         (id, workspace_id, operator_login, reason, granted_by, created_at, expires_at)
       VALUES (?, ?, ?, 'investigate', ?, ?, ?)`,
    )
    .run(crypto.randomUUID(), workspaceId, operatorLogin.toLowerCase(), OPERATOR, STAMP, expiresAt);
}

function at(offsetMs: number): string {
  return new Date(Date.now() + offsetMs).toISOString();
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

async function api(db: TestD1, login: string | null): Promise<Response> {
  const headers: Record<string, string> = {};
  if (login !== null) {
    headers.Cookie = `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}`;
  }
  return worker.fetch(
    new Request("https://worker.local/_internal_admin/api/users", { headers }),
    envFor(db, { DEPLOYMENT_MODE: "saas" }),
  );
}

type UserRow = {
  login: string;
  createdAt: string;
  workspaceCount: number;
  isOperator: boolean;
  activeGrantCount: number;
};

async function usersByLogin(db: TestD1): Promise<Map<string, UserRow>> {
  const res = await api(db, OPERATOR);
  expect(res.status).toBe(200);
  const body = (await res.json()) as { users: UserRow[] };
  return new Map(body.users.map((row) => [row.login, row]));
}

// --- the list --------------------------------------------------------------

describe("GET /_internal_admin/api/users", () => {
  test("lists both users with the SQL-side counts and the env allowlist flag", async () => {
    const db = createMigratedTestD1();
    insertUser(db, OPERATOR);
    const holderId = insertUser(db, GRANT_HOLDER);

    // Two live memberships, one in a soft-deleted workspace that must not count.
    insertWorkspace(db, "ws-live-1", null);
    insertWorkspace(db, "ws-live-2", null);
    insertWorkspace(db, "ws-deleted", STAMP);
    insertMember(db, "ws-live-1", holderId);
    insertMember(db, "ws-live-2", holderId);
    insertMember(db, "ws-deleted", holderId);

    // One live grant and one lapsed grant on another workspace: only the live
    // window counts.
    insertGrant(db, "ws-live-1", GRANT_HOLDER, at(DAY_MS));
    insertGrant(db, "ws-live-2", GRANT_HOLDER, at(-DAY_MS));

    const users = await usersByLogin(db);

    expect(users.get(OPERATOR)).toEqual({
      login: OPERATOR,
      createdAt: STAMP,
      workspaceCount: 0,
      isOperator: true,
      activeGrantCount: 0,
    });
    expect(users.get(GRANT_HOLDER)).toEqual({
      login: GRANT_HOLDER,
      createdAt: STAMP,
      workspaceCount: 2,
      isOperator: false,
      activeGrantCount: 1,
    });
  });

  test("counts a duplicated (workspace, operator) pair once", async () => {
    // Both appends are live; the pair's window is its newest row, so the user
    // holds one grant, not two.
    const db = createMigratedTestD1();
    insertUser(db, OPERATOR);
    insertUser(db, GRANT_HOLDER);
    insertWorkspace(db, "ws-live-1", null);
    insertGrant(db, "ws-live-1", GRANT_HOLDER, at(DAY_MS));
    insertGrant(db, "ws-live-1", GRANT_HOLDER, at(2 * DAY_MS));

    const users = await usersByLogin(db);

    expect(users.get(GRANT_HOLDER)?.activeGrantCount).toBe(1);
  });

  test("does not count an older live append that a newer expired row superseded", async () => {
    const db = createMigratedTestD1();
    insertUser(db, OPERATOR);
    insertUser(db, GRANT_HOLDER);
    insertWorkspace(db, "ws-live-1", null);
    insertGrant(db, "ws-live-1", GRANT_HOLDER, at(DAY_MS));
    insertGrant(db, "ws-live-1", GRANT_HOLDER, at(-DAY_MS));

    const users = await usersByLogin(db);

    expect(users.get(GRANT_HOLDER)?.activeGrantCount).toBe(0);
  });

  test("answers a non-operator with 404", async () => {
    const db = createMigratedTestD1();
    insertUser(db, OPERATOR);

    expect((await api(db, GRANT_HOLDER)).status).toBe(404);
    expect((await api(db, null)).status).toBe(404);
  });
});
