/**
 * The console's workspace list and plan assignment (spec operator-admin-surface
 * §3.2 / §3.3).
 *
 * Pinned at the product seams: the list's SQL-side counts and resolved plan,
 * the resolver answering differently after each assignment, the refusal paths
 * writing nothing, and a downgrade that keeps every member while the existing
 * invite seat guard starts refusing. The audit assertions hold the ledger
 * contract: exactly one `platform_audit_events` row per successful change, none
 * for a refused one.
 */
import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { MemberCapError, resolveWorkspacePlan } from "../../src/dashboard/entitlement";
import { createInvite } from "../../src/dashboard/invite-store";

const SESSION_SECRET = ["test", "workspace", "plan", "secret", "32-bytes"].join("-");
const OPERATOR = "Support-Bot";
const MEMBER = "regular-member";
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

function count(db: TestD1, sql: string): number {
  // The raw test handle returns a plain row object, like the other raw reads.
  const row = db.raw.prepare(sql).get() as { n: number } | null;
  return row?.n ?? 0;
}

function subscriptionOf(
  db: TestD1,
  workspaceId: string,
): { plan_id: string; status: string; updated_at: string } | null {
  return db.raw
    .prepare(
      "SELECT plan_id, status, updated_at FROM workspace_subscriptions WHERE workspace_id = ?",
    )
    .get(workspaceId) as { plan_id: string; status: string; updated_at: string } | null;
}

type AuditRow = {
  action: string;
  actor_login: string;
  target_type: string;
  target_id: string;
  detail_json: string | null;
};

function auditRows(db: TestD1): AuditRow[] {
  return db.raw
    .prepare(
      `SELECT action, actor_login, target_type, target_id, detail_json
         FROM platform_audit_events ORDER BY rowid`,
    )
    .all() as AuditRow[];
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

    // The no-cap tier: its `included_members` is NULL, which must stay NULL.
    insertWorkspace(db, {
      id: "ws-gamma",
      name: "Gamma",
      createdAt: "2026-10-03T00:00:00.000Z",
    });
    insertSubscription(db, "ws-gamma", "unlimited");

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
        planName: "Free",
        includedMembers: 5,
        createdAt: "2026-10-21T00:00:00.000Z",
      },
      {
        id: "ws-gamma",
        name: "Gamma",
        slug: "ws-gamma",
        ownerLogin: null,
        memberCount: 0,
        pendingInviteCount: 0,
        planId: "unlimited",
        planName: "Unlimited",
        includedMembers: null,
        createdAt: "2026-10-03T00:00:00.000Z",
      },
      {
        id: "ws-beta",
        name: "Beta",
        slug: "ws-beta",
        ownerLogin: null,
        memberCount: 0,
        pendingInviteCount: 0,
        planId: "free",
        planName: "Free",
        includedMembers: 5,
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
        planName: "Pro",
        includedMembers: 5,
        createdAt: "2026-10-01T00:00:00.000Z",
      },
    ]);
  });

  test("the seat cap is the catalogue's value, and NULL stays null", async () => {
    const db = createMigratedTestD1();
    insertUser(db, OPERATOR);
    insertWorkspace(db, { id: "ws-alpha", name: "Alpha", createdAt: STAMP });
    insertSubscription(db, "ws-alpha", "pro");
    insertWorkspace(db, { id: "ws-gamma", name: "Gamma", createdAt: STAMP });
    insertSubscription(db, "ws-gamma", "unlimited");

    const rows = await listOf(db);
    const catalogue = db.raw.prepare("SELECT id, included_members FROM plans").all() as Array<{
      id: string;
      included_members: number | null;
    }>;
    const capOf = (id: string) => catalogue.find((plan) => plan.id === id)?.included_members;

    // An unlimited workspace reports no cap — it must never be serialised as 0.
    expect(rows.find((row) => row.id === "ws-gamma")).toMatchObject({
      planId: "unlimited",
      includedMembers: null,
    });
    expect(rows.find((row) => row.id === "ws-alpha")?.includedMembers).toBe(capOf("pro"));
    expect(capOf("unlimited")).toBeNull();
  });
});

// --- the plan assignment ----------------------------------------------------

describe("PATCH /_internal_admin/api/workspaces/:id/plan", () => {
  test("assigning pro then unlimited changes what the workspace resolves to", async () => {
    const db = createMigratedTestD1();
    insertUser(db, OPERATOR);
    insertWorkspace(db, { id: "ws-alpha", name: "Alpha", createdAt: STAMP });
    expect(await resolveWorkspacePlan(db, "ws-alpha", "saas")).toMatchObject({
      id: "free",
      includedMembers: 5,
    });

    const pro = await api(db, {
      method: "PATCH",
      path: "/api/workspaces/ws-alpha/plan",
      body: JSON.stringify({ planId: "pro" }),
    });
    expect(pro.status).toBe(200);
    expect(await pro.json()).toEqual({ workspaceId: "ws-alpha", planId: "pro" });
    expect(await resolveWorkspacePlan(db, "ws-alpha", "saas")).toMatchObject({
      id: "pro",
      includedMembers: 5,
    });

    const unlimited = await api(db, {
      method: "PATCH",
      path: "/api/workspaces/ws-alpha/plan",
      body: JSON.stringify({ planId: "unlimited" }),
    });
    expect(unlimited.status).toBe(200);
    expect(await resolveWorkspacePlan(db, "ws-alpha", "saas")).toMatchObject({
      id: "unlimited",
      includedMembers: null,
    });

    // One audit row per successful change, with the before/after pair.
    expect(auditRows(db)).toEqual([
      {
        action: "workspace.plan.set",
        actor_login: OPERATOR,
        target_type: "workspace",
        target_id: "ws-alpha",
        detail_json: JSON.stringify({ before: "free", after: "pro" }),
      },
      {
        action: "workspace.plan.set",
        actor_login: OPERATOR,
        target_type: "workspace",
        target_id: "ws-alpha",
        detail_json: JSON.stringify({ before: "pro", after: "unlimited" }),
      },
    ]);

    const row = (await listOf(db)).find((workspace) => workspace.id === "ws-alpha");
    expect(row?.planId).toBe("unlimited");
  });

  test("an unknown plan id is 400 and writes nothing", async () => {
    const db = createMigratedTestD1();
    insertUser(db, OPERATOR);
    insertWorkspace(db, { id: "ws-alpha", name: "Alpha", createdAt: STAMP });
    insertSubscription(db, "ws-alpha", "pro");

    const res = await api(db, {
      method: "PATCH",
      path: "/api/workspaces/ws-alpha/plan",
      body: JSON.stringify({ planId: "enterprise" }),
    });
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      error: 'unknown planId "enterprise": the plans catalogue has no such row',
    });
    // Neither the subscription nor the ledger moved.
    expect(subscriptionOf(db, "ws-alpha")).toEqual({
      plan_id: "pro",
      status: "active",
      updated_at: STAMP,
    });
    expect(auditRows(db)).toEqual([]);
  });

  test("a malformed body and an unknown workspace are refusals with no write", async () => {
    const db = createMigratedTestD1();
    insertUser(db, OPERATOR);

    const malformed = await api(db, {
      method: "PATCH",
      path: "/api/workspaces/ws-alpha/plan",
      body: JSON.stringify({ plan: "pro" }),
    });
    expect(malformed.status).toBe(400);

    const unknownWorkspace = await api(db, {
      method: "PATCH",
      path: "/api/workspaces/ws-gone/plan",
      body: JSON.stringify({ planId: "pro" }),
    });
    expect(unknownWorkspace.status).toBe(404);
    expect(await unknownWorkspace.json()).toEqual({ error: "workspace not found" });

    expect(count(db, "SELECT COUNT(*) AS n FROM workspace_subscriptions")).toBe(0);
    expect(auditRows(db)).toEqual([]);
  });

  test("a downgrade below the member count succeeds, keeps members, blocks the next invite", async () => {
    const db = createMigratedTestD1();
    insertUser(db, OPERATOR);
    const ownerId = insertUser(db, "alice");
    insertWorkspace(db, { id: "ws-six", name: "Six", createdBy: ownerId, createdAt: STAMP });
    insertMember(db, "ws-six", ownerId, "owner");
    for (const login of ["m1", "m2", "m3", "m4", "m5"]) {
      insertMember(db, "ws-six", insertUser(db, login), "member");
    }
    insertSubscription(db, "ws-six", "unlimited");

    const res = await api(db, {
      method: "PATCH",
      path: "/api/workspaces/ws-six/plan",
      body: JSON.stringify({ planId: "free" }),
    });
    expect(res.status).toBe(200);
    expect(await resolveWorkspacePlan(db, "ws-six", "saas")).toMatchObject({
      id: "free",
      includedMembers: 5,
    });
    // A downgrade never removes anyone.
    expect(count(db, "SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = 'ws-six'")).toBe(
      6,
    );
    expect(auditRows(db)).toEqual([
      {
        action: "workspace.plan.set",
        actor_login: OPERATOR,
        target_type: "workspace",
        target_id: "ws-six",
        detail_json: JSON.stringify({ before: "unlimited", after: "free" }),
      },
    ]);

    // The existing invite seat guard is what blocks NEW invites.
    const blockedInvite = createInvite(
      db,
      {
        workspaceId: "ws-six",
        login: "newcomer",
        role: "member",
        invitedBy: ownerId,
        now: STAMP,
        expiresAt: liveFromNow(),
      },
      "saas",
    );
    await expect(blockedInvite).rejects.toThrow(MemberCapError);
    expect(count(db, "SELECT COUNT(*) AS n FROM workspace_invites WHERE workspace_id = 'ws-six'")).toBe(
      0,
    );
  });
});

// --- authorization and registration ----------------------------------------

describe("the workspace routes answer only an allowlisted operator on saas", () => {
  test("a member, an unauthenticated caller and the self-hosted mode get 404 with no write", async () => {
    const db = createMigratedTestD1();
    insertUser(db, OPERATOR);
    insertUser(db, MEMBER);
    insertWorkspace(db, { id: "ws-alpha", name: "Alpha", createdAt: STAMP });

    const patch = { method: "PATCH" as const, path: "/api/workspaces/ws-alpha/plan" as const };

    expect((await api(db, { ...patch, login: MEMBER, body: JSON.stringify({ planId: "pro" }) })).status).toBe(404);
    expect((await api(db, { ...patch, login: null, body: JSON.stringify({ planId: "pro" }) })).status).toBe(404);
    expect((await api(db, { ...patch, mode: "self-hosted", body: JSON.stringify({ planId: "pro" }) })).status).toBe(404);

    expect((await api(db, { method: "GET", path: "/api/workspaces", login: MEMBER })).status).toBe(404);
    expect((await api(db, { method: "GET", path: "/api/workspaces", login: null })).status).toBe(404);
    expect((await api(db, { method: "GET", path: "/api/workspaces", mode: "self-hosted" })).status).toBe(404);

    expect(count(db, "SELECT COUNT(*) AS n FROM workspace_subscriptions")).toBe(0);
    expect(auditRows(db)).toEqual([]);
  });
});
