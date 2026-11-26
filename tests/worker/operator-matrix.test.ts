import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import type { Env } from "../../src/worker/env";
import { createMigratedTestD1, syncSplitPair, type TestD1 } from "../store/helpers";
import { insertSupportGrant } from "../../src/dashboard/operator-store";

const SESSION_SECRET = ["test", "operator", "matrix", "secret", "32-bytes!"].join("-");
const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

const OPERATOR = "Support-Bot";
const OPERATOR_KEY = OPERATOR.toLowerCase();
const DAY = 24 * 60 * 60 * 1000;
const WORKSPACE = "ws-acme";
const REF = "acme";
const APP_ID = 7001;
// The seeded App's ROW id — bot-config surfaces bind this.
const BOT_ID = "app-acme";

function envFor(db: TestD1): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} },
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} },
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "oauth-client-secret",
    DEPLOYMENT_MODE: "self-hosted",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DASHBOARD_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    DB: db,
    PLATFORM_OPERATORS: OPERATOR_KEY,
  } as unknown as Env;
}

async function authedRequest(
  path: string,
  login: string,
  init: { method?: string; body?: string } = {},
): Promise<Request> {
  const session = await createSessionValue(login, null, SESSION_SECRET);
  const headers: Record<string, string> = { Cookie: `${SESSION_COOKIE}=${session}` };
  if (init.body !== undefined) headers["Content-Type"] = "application/x-www-form-urlencoded";
  return new Request(`https://worker.local${path}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body === undefined ? {} : { body: init.body }),
  });
}

const seed = (db: TestD1, sql: string, ...params: Array<string | number | null>): void => {
  db.raw.prepare(sql).run(...params);
};

function seedUser(db: TestD1, login: string): string {
  const id = crypto.randomUUID();
  seed(
    db,
    "INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES (?, ?, 'member', ?, NULL)",
    id,
    login,
    new Date().toISOString(),
  );
  return id;
}

function seedWorkspace(db: TestD1, id: string, slug: string): void {
  seed(
    db,
    "INSERT INTO workspaces (id, slug, name, created_by, created_at, deleted_at) VALUES (?, ?, ?, NULL, ?, NULL)",
    id,
    slug,
    slug,
    new Date().toISOString(),
  );
}

function seedMembership(db: TestD1, workspaceId: string, userId: string, role: string): void {
  seed(
    db,
    "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
    workspaceId,
    userId,
    role,
    new Date().toISOString(),
  );
}

function seedApp(db: TestD1, id: string, slug: string, workspaceId: string): void {
  const now = new Date().toISOString();
  seed(
    db,
    `INSERT INTO github_apps
       (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
        created_by, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'v1.primary.aXZpdi.cHJldGV4dA==', 'v1.primary.aXZpdi.cHJldGV4dA==',
             'dana', 'active', ?, ?)`,
    id,
    slug,
    7001,
    slug,
    now,
    now,
  );
  seed(db, "INSERT OR REPLACE INTO app_workspaces (app_id, workspace_id) VALUES (?, ?)", id, workspaceId);
  syncSplitPair(db);
  seed(
    db,
    `INSERT INTO review_targets
       (id, workspace_id, app_id, name, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'dana', ?, ?)`,
    `target-${id}`,
    workspaceId,
    id,
    slug,
    now,
    now,
  );
}

function grant(db: TestD1, operatorLogin = OPERATOR_KEY): Promise<unknown> {
  const now = Date.now();
  return insertSupportGrant(db, {
    workspaceId: WORKSPACE,
    operatorLogin,
    reason: "tenant-reported incident",
    grantedBy: "deployer",
    now: new Date(now).toISOString(),
    expiresAt: new Date(now + DAY).toISOString(),
  });
}

function fixture() {
  const db = createMigratedTestD1();
  seedUser(db, OPERATOR);
  seedUser(db, "stranger");
  const owner = seedUser(db, "dana");
  const member = seedUser(db, "mallory");
  seedWorkspace(db, WORKSPACE, REF);
  seedWorkspace(db, "ws-other", "other");
  seedMembership(db, WORKSPACE, owner, "owner");
  seedMembership(db, WORKSPACE, member, "member");
  seedMembership(db, "ws-other", owner, "owner");
  seedApp(db, "app-acme", "acme-app", WORKSPACE);
  return { db, memberId: member };
}

const auditCount = (db: TestD1): number =>
  (db.raw.query("SELECT COUNT(*) AS n FROM audit_events").get() as { n: number }).n;

const auditActions = (db: TestD1): string[] =>
  (db.raw.query("SELECT action FROM audit_events ORDER BY created_at ASC, rowid ASC").all() as Array<{
    action: string;
  }>).map((row) => row.action);

type Actor = "member" | "granted" | "denied" | "outsider";
const ACTORS: readonly Actor[] = ["member", "granted", "denied", "outsider"];

type Surface = {
  name: string;
  method?: "GET" | "POST";
  path: string;
  body?: (memberId: string) => string;
  status: Record<Actor, number>;
  action: Partial<Record<Actor, string>>;
};

const SURFACES: readonly Surface[] = [
  {
    name: "metadata",
    path: `/dashboard/${REF}/api/support/workspace`,
    status: { member: 403, granted: 200, denied: 404, outsider: 404 },
    action: { granted: "support.read", denied: "support.denied" },
  },
  {
    name: "members",
    path: `/dashboard/${REF}/api/members`,
    status: { member: 200, granted: 200, denied: 404, outsider: 404 },
    action: { granted: "support.read", denied: "support.denied" },
  },
  {
    name: "app list",
    path: `/dashboard/${REF}/api/apps`,
    status: { member: 200, granted: 403, denied: 404, outsider: 404 },
    action: { granted: "support.forbidden", denied: "support.denied" },
  },
  {
    name: "credentials",
    method: "POST",
    path: `/dashboard/${REF}/api/review-bots/${BOT_ID}/keys/verify`,
    body: () => "provider=anthropic&key=sk-not-a-real-key",
    status: { member: 403, granted: 403, denied: 404, outsider: 404 },
    action: { granted: "support.forbidden", denied: "support.denied" },
  },
  {
    name: "settings read",
    path: `/dashboard/${REF}/api/review-bots/${BOT_ID}/settings`,
    status: { member: 200, granted: 403, denied: 404, outsider: 404 },
    action: { granted: "support.forbidden", denied: "support.denied" },
  },
  {
    name: "model chains",
    path: `/dashboard/${REF}/api/review-bots/${BOT_ID}/models`,
    status: { member: 403, granted: 403, denied: 404, outsider: 404 },
    action: { granted: "support.forbidden", denied: "support.denied" },
  },
  {
    name: "settings write",
    method: "POST",
    path: `/dashboard/${REF}/review-bots/${BOT_ID}/settings`,
    body: () => "op=save-chain&model_chain=",
    status: { member: 403, granted: 403, denied: 404, outsider: 404 },
    action: { granted: "support.forbidden", denied: "support.denied" },
  },
  {
    name: "role change",
    method: "POST",
    path: `/dashboard/${REF}/members/role`,
    body: (memberId) => `userId=${memberId}&role=admin`,
    status: { member: 403, granted: 403, denied: 404, outsider: 404 },
    action: { granted: "support.forbidden", denied: "support.denied" },
  },
  {
    name: "audit list",
    path: `/dashboard/${REF}/api/audit`,
    status: { member: 403, granted: 403, denied: 404, outsider: 404 },
    action: { granted: "support.forbidden", denied: "support.denied" },
  },
];

describe("operator matrix (actor × surface)", () => {
  for (const actor of ACTORS) {
    test(`${actor} × every workspace surface`, async () => {
      const { db, memberId } = fixture();
      if (actor === "granted") await grant(db);
      const env = envFor(db);
      const login = actor === "member" ? "mallory" : actor === "outsider" ? "stranger" : OPERATOR;

      for (const surface of SURFACES) {
        const before = auditCount(db);
        const res = await worker.fetch(
          await authedRequest(surface.path, login, {
            method: surface.method,
            body: surface.body?.(memberId),
          }),
          env,
        );
        expect(res.status, `${actor} × ${surface.name}`).toBe(surface.status[actor]);
        const expected = surface.action[actor];
        expect(auditCount(db) - before, `${actor} × ${surface.name} audit rows`).toBe(
          expected === undefined ? 0 : 1,
        );
        expect(auditActions(db).slice(before), `${actor} × ${surface.name} audit action`).toEqual(
          expected === undefined ? [] : [expected],
        );
      }
    });
  }

  test("an EXPIRED grant is the denied row of the matrix, cell for cell", async () => {
    const { db, memberId } = fixture();
    const now = Date.now();
    await insertSupportGrant(db, {
      workspaceId: WORKSPACE,
      operatorLogin: OPERATOR,
      reason: "tenant-reported incident",
      grantedBy: "deployer",
      now: new Date(now - 2 * DAY).toISOString(),
      expiresAt: new Date(now - DAY).toISOString(),
    });
    const env = envFor(db);
    for (const surface of SURFACES) {
      const before = auditCount(db);
      const res = await worker.fetch(
        await authedRequest(surface.path, OPERATOR, {
          method: surface.method,
          body: surface.body?.(memberId),
        }),
        env,
      );
      expect(res.status, surface.name).toBe(404);
      expect(auditActions(db).slice(before), surface.name).toEqual(["support.denied"]);
    }
  });
});
