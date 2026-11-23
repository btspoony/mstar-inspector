import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { insertSupportGrant } from "../../src/dashboard/operator-store";

const SESSION_SECRET = ["test", "support", "grant", "secret", "32-bytes"].join("-");
const OPERATOR = "Support-Bot";
const MEMBER = "regular-member";
const STAMP = "2026-10-01T00:00:00.000Z";
const HOUR_MS = 3_600_000;
const DAY_MS = 24 * HOUR_MS;


function seed(db: TestD1, sql: string, ...params: Array<string | null>): void {
  db.raw.prepare(sql).run(...params);
}

function insertUser(db: TestD1, login: string): string {
  const id = crypto.randomUUID();
  seed(
    db,
    "INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES (?, ?, 'member', ?, NULL)",
    id,
    login,
    STAMP,
  );
  return id;
}

function insertWorkspace(db: TestD1, id: string, slug: string): void {
  seed(
    db,
    `INSERT INTO workspaces (id, slug, name, created_by, created_at, deleted_at)
     VALUES (?, ?, ?, NULL, ?, NULL)`,
    id,
    slug,
    slug,
    STAMP,
  );
}

function insertMember(db: TestD1, workspaceId: string, userId: string): void {
  seed(
    db,
    "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
    workspaceId,
    userId,
    STAMP,
  );
}

function fixture(): TestD1 {
  const db = createMigratedTestD1();
  insertUser(db, OPERATOR);
  const memberId = insertUser(db, MEMBER);
  insertWorkspace(db, "ws-acme", "acme");
  insertWorkspace(db, "ws-other", "other");
  insertMember(db, "ws-acme", memberId);
  return db;
}

function seedGrant(db: TestD1, workspaceId: string, ttlMs: number): Promise<{ id: string }> {
  return insertSupportGrant(db, {
    workspaceId,
    operatorLogin: OPERATOR,
    reason: "tenant-reported incident",
    grantedBy: "deployer",
    now: STAMP,
    expiresAt: new Date(Date.now() + ttlMs).toISOString(),
  });
}

function envFor(db: TestD1): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} },
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} },
    DEPLOYMENT_MODE: "saas",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    PLATFORM_OPERATORS: OPERATOR.toLowerCase(),
    DB: db,
  } as unknown as Env;
}

async function api(
  db: TestD1,
  init: { method: "GET" | "POST" | "DELETE"; path: string; body?: string; login?: string },
): Promise<Response> {
  const headers: Record<string, string> = {
    Cookie: `${SESSION_COOKIE}=${await createSessionValue(init.login ?? OPERATOR, null, SESSION_SECRET)}`,
  };
  if (init.body !== undefined) headers["Content-Type"] = "application/json";
  return worker.fetch(
    new Request(`https://worker.local/_internal_admin${init.path}`, {
      method: init.method,
      headers,
      body: init.body,
    }),
    envFor(db),
  );
}

async function supportView(db: TestD1, login = OPERATOR): Promise<Response> {
  return worker.fetch(
    new Request("https://worker.local/dashboard/acme/api/support/workspace", {
      headers: { Cookie: `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}` },
    }),
    envFor(db),
  );
}

type AuditRow = { action: string; actor_login: string; workspace_id: string };

function auditRows(db: TestD1): AuditRow[] {
  return db.raw
    .prepare("SELECT action, actor_login, workspace_id FROM audit_events ORDER BY rowid")
    .all() as AuditRow[];
}

function grantCount(db: TestD1): number {
  const row = db.raw.prepare("SELECT COUNT(*) AS n FROM support_grants").get() as { n: number };
  return row.n;
}

const CREATE = (body: Record<string, unknown>) =>
  JSON.stringify({
    workspaceId: "ws-acme",
    operatorLogin: OPERATOR,
    reason: "tenant-reported incident",
    ttlHours: 24,
    ...body,
  });


describe("POST /_internal_admin/api/support-grants", () => {
  test("the created grant is honoured by the existing classifier, and the write appends one audit row", async () => {
    const db = fixture();
    const res = await api(db, { method: "POST", path: "/api/support-grants", body: CREATE({}) });
    expect(res.status).toBe(201);
    const { grant } = (await res.json()) as { grant: Record<string, unknown> };
    expect(grant).toMatchObject({
      workspace_id: "ws-acme",
      operator_login: OPERATOR,
      reason: "tenant-reported incident",
      granted_by: OPERATOR,
    });
    expect(Date.parse(String(grant.expires_at)) - Date.parse(String(grant.created_at))).toBe(24 * HOUR_MS);

    expect(auditRows(db)).toEqual([
      { action: "support.grant.create", actor_login: OPERATOR, workspace_id: "ws-acme" },
    ]);

    const view = await supportView(db);
    expect(view.status).toBe(200);
    const body = (await view.json()) as { grants: Array<Record<string, unknown>> };
    expect(body.grants.map((row) => row.operator_login)).toEqual([OPERATOR]);
    expect(auditRows(db).map((row) => row.action)).toEqual(["support.grant.create", "support.read"]);
  });

  test("an unknown workspace, a malformed body or a non-positive ttl writes nothing", async () => {
    const db = fixture();
    for (const body of [
      CREATE({ workspaceId: "ws-missing" }),
      CREATE({ operatorLogin: "" }),
      CREATE({ reason: "  " }),
      CREATE({ ttlHours: 0 }),
      CREATE({ ttlHours: -3 }),
      CREATE({ ttlHours: "24" }),
      "{not json",
    ]) {
      const res = await api(db, { method: "POST", path: "/api/support-grants", body });
      expect(res.status, body).toBe(400);
    }
    expect(grantCount(db)).toBe(0);
    expect(auditRows(db)).toEqual([]);
  });

  test("a JSON null root is a 400, not a throw — and writes nothing", async () => {
    const db = fixture();
    const res = await api(db, { method: "POST", path: "/api/support-grants", body: "null" });
    expect(res.status).toBe(400);
    expect(grantCount(db)).toBe(0);
    expect(auditRows(db)).toEqual([]);
  });

  test("a failed audit append leaves no live grant", async () => {
    const db = fixture();
    db.raw.run(
      `CREATE TRIGGER fail_grant_audit BEFORE INSERT ON audit_events
       BEGIN SELECT RAISE(ABORT, 'audit append refused'); END;`,
    );

    const res = await api(db, { method: "POST", path: "/api/support-grants", body: CREATE({}) });
    expect(res.status).toBe(500);

    expect(grantCount(db)).toBe(0);
    expect(auditRows(db)).toEqual([]);

    db.raw.run("DROP TRIGGER fail_grant_audit");
    expect((await supportView(db)).status).toBe(404);
  });
});


describe("DELETE /_internal_admin/api/support-grants/:id", () => {
  test("the deleted grant stops being usable, and the delete appends one audit row", async () => {
    const db = fixture();
    const grant = await seedGrant(db, "ws-acme", DAY_MS);
    expect((await supportView(db)).status).toBe(200);

    const res = await api(db, { method: "DELETE", path: `/api/support-grants/${grant.id}` });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: grant.id, workspaceId: "ws-acme" });

    expect(auditRows(db).filter((row) => row.action === "support.grant.delete")).toEqual([
      { action: "support.grant.delete", actor_login: OPERATOR, workspace_id: "ws-acme" },
    ]);
    expect(grantCount(db)).toBe(0);

    const after = await supportView(db);
    expect(after.status).toBe(404);
    expect(auditRows(db).map((row) => row.action)).toEqual([
      "support.read",
      "support.grant.delete",
      "support.denied",
    ]);
  });

  test("an unknown grant id is a 404 with no write and no audit row", async () => {
    const db = fixture();
    const res = await api(db, { method: "DELETE", path: "/api/support-grants/no-such-id" });
    expect(res.status).toBe(404);
    expect(auditRows(db)).toEqual([]);
  });

  test("a failed audit append rolls the revocation back — the window stays open", async () => {
    const db = fixture();
    const grant = await seedGrant(db, "ws-acme", DAY_MS);
    db.raw.run(
      `CREATE TRIGGER fail_revoke_audit BEFORE INSERT ON audit_events
       BEGIN SELECT RAISE(ABORT, 'audit append refused'); END;`,
    );

    const res = await api(db, { method: "DELETE", path: `/api/support-grants/${grant.id}` });
    expect(res.status).toBe(500);

    expect(auditRows(db)).toEqual([]);
    expect(grantCount(db)).toBe(1);

    db.raw.run("DROP TRIGGER fail_revoke_audit");
    expect((await supportView(db)).status).toBe(200);
  });

  test("a failed revocation leaves no audit row claiming one", async () => {
    const db = fixture();
    const grant = await seedGrant(db, "ws-acme", DAY_MS);
    db.raw.run(
      `CREATE TRIGGER fail_grant_delete BEFORE DELETE ON support_grants
       BEGIN SELECT RAISE(ABORT, 'grant delete refused'); END;`,
    );

    const res = await api(db, { method: "DELETE", path: `/api/support-grants/${grant.id}` });
    expect(res.status).toBe(500);

    expect(grantCount(db)).toBe(1);
    expect(auditRows(db)).toEqual([]);

    db.raw.run("DROP TRIGGER fail_grant_delete");
    expect((await supportView(db)).status).toBe(200);
  });
});


describe("GET /_internal_admin/api/support-grants", () => {
  test("lists live grants across workspaces and drops expired and superseded rows", async () => {
    const db = fixture();
    const live = await seedGrant(db, "ws-other", DAY_MS);
    const superseded = await seedGrant(db, "ws-acme", 2 * DAY_MS);
    await seedGrant(db, "ws-acme", -DAY_MS);
    expect(superseded.id).not.toBe(live.id);

    const res = await api(db, { method: "GET", path: "/api/support-grants" });
    expect(res.status).toBe(200);
    const { grants } = (await res.json()) as { grants: Array<Record<string, unknown>> };
    expect(grants.map((grant) => grant.workspace_id)).toEqual(["ws-other"]);
    expect(grants[0]?.id).toBe(live.id);
  });
});


describe("the grant routes stay behind the operator gate", () => {
  test("a non-operator gets 404 on every verb and nothing is written", async () => {
    const db = fixture();
    const grant = await seedGrant(db, "ws-acme", DAY_MS);
    for (const request of [
      { method: "GET" as const, path: "/api/support-grants" },
      { method: "POST" as const, path: "/api/support-grants" },
      { method: "DELETE" as const, path: `/api/support-grants/${grant.id}` },
    ]) {
      const res = await api(db, { ...request, login: MEMBER, body: request.method === "POST" ? CREATE({}) : undefined });
      expect(res.status, request.method).toBe(404);
    }
    expect(grantCount(db)).toBe(1);
    expect(auditRows(db)).toEqual([]);
  });
});
