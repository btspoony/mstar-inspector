/**
 * Workspace deletion — `POST /dashboard/<ref>/api/workspace/delete`, owner only.
 *
 * Deletion is a SOFT retire: the `workspaces` row is never hard-deleted, only
 * `deleted_at` is stamped; every membership is dropped and every pending invite
 * is revoked, all in ONE batch so a half-retired tenant is never observable.
 * The tenant then stops resolving, which is what makes every workspace path —
 * this route included — answer 404 afterwards, and what frees the owner's free
 * slot for a new creation.
 *
 * The fixture runs the full migration set, so `default` (0026's seed) is a real
 * workspace; roles are seeded explicitly to keep the 403 boundary readable.
 */
import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { deleteWorkspace } from "../../src/dashboard/workspace-store";
import type { Env } from "../../src/worker/env";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";

const SESSION_SECRET = ["test", "dashboard", "session", "secret", "32-bytes!"].join("-");
/** base64 of exactly 32 bytes — the secretbox master-key requirement. */
const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");
const OWNER_REFUSAL = "Only the workspace owner can delete it.";

function envFor(db: TestD1): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} },
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} },
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "oauth-client-secret",
    // `saas`: the free slot this file's creation cases assert binds that mode
    // only (self-hosted resolves every workspace to `unlimited`).
    DEPLOYMENT_MODE: "saas",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DASHBOARD_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    DB: db,
  } as unknown as Env;
}

/** A signed-in login sending a request through the real worker mount. */
async function request(
  db: TestD1,
  path: string,
  login: string,
  init: { method?: string; body?: Record<string, string> } = {},
): Promise<Response> {
  const session = await createSessionValue(login, null, SESSION_SECRET);
  const headers: Record<string, string> = { Cookie: `${SESSION_COOKIE}=${session}` };
  if (init.body !== undefined) headers["Content-Type"] = "application/x-www-form-urlencoded";
  return worker.fetch(
    new Request(`https://worker.local${path}`, {
      method: init.method ?? "GET",
      headers,
      ...(init.body === undefined ? {} : { body: new URLSearchParams(init.body) }),
    }),
    envFor(db),
  );
}

function seed(db: TestD1, sql: string, ...params: Array<string | number | null>): void {
  db.raw.prepare(sql).run(...params);
}

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

function seedMembership(
  db: TestD1,
  workspaceId: string,
  userId: string,
  role: "owner" | "admin" | "member",
): void {
  seed(
    db,
    "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
    workspaceId,
    userId,
    role,
    new Date().toISOString(),
  );
}

function seedPendingInvite(db: TestD1, workspaceId: string, login: string): void {
  const now = Date.now();
  seed(
    db,
    `INSERT INTO workspace_invites (id, workspace_id, github_login, role, status, invited_by, created_at, expires_at)
     VALUES (?, ?, ?, 'member', 'pending', NULL, ?, ?)`,
    crypto.randomUUID(),
    workspaceId,
    login,
    new Date(now).toISOString(),
    new Date(now + 7 * 24 * 60 * 60 * 1000).toISOString(),
  );
}

/** One live App in the workspace, so the settings face has something to serve. */
function seedApp(db: TestD1, workspaceId: string): void {
  const now = new Date().toISOString();
  seed(
    db,
    `INSERT INTO github_apps
       (id, webhook_path, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
        created_by, status, created_at, updated_at)
     VALUES ('app-acme', 'acme-app', 'acme-app', 4711, 'acme-app', 'v1.primary.aXZpdi5wcmV0ZXh0',
             'v1.primary.aXZpdi5wcmV0ZXh0', 'dana', 'active', ?, ?)`,
    now,
    now,
  );
  seed(db, "INSERT INTO app_workspaces (app_id, workspace_id) VALUES ('app-acme', ?)", workspaceId);
}

/** The live workspace 0026 seeds (`default`) plus the role matrix. */
function deletionFixture() {
  const db = createMigratedTestD1();
  const owner = seedUser(db, "dana");
  const admin = seedUser(db, "carol");
  const member = seedUser(db, "mallory");
  seedMembership(db, "default", owner, "owner");
  seedMembership(db, "default", admin, "admin");
  seedMembership(db, "default", member, "member");
  seedPendingInvite(db, "default", "newbie");
  seedApp(db, "default");
  return { db };
}

const DELETE_PATH = "/dashboard/default/api/workspace/delete";

function count(db: TestD1, sql: string, ...params: Array<string | number>): number {
  // bun:sqlite returns `unknown`; the COUNT projection is this query's shape.
  const row = db.raw.prepare(sql).get(...params) as { n: number } | null;
  return row?.n ?? 0;
}

function deletedAtOf(db: TestD1): string | null {
  const row = db.raw.prepare("SELECT deleted_at FROM workspaces WHERE id = 'default'").get() as
    | { deleted_at: string | null }
    | null;
  return row?.deleted_at ?? null;
}

function inviteStatuses(db: TestD1): Array<{ status: string }> {
  return db.raw
    .prepare("SELECT status FROM workspace_invites WHERE workspace_id = 'default'")
    .all() as Array<{ status: string }>;
}

function subscriptionStatuses(db: TestD1): Array<{ status: string }> {
  return db.raw
    .prepare("SELECT status FROM workspace_subscriptions WHERE workspace_id = 'default'")
    .all() as Array<{ status: string }>;
}

describe("POST /dashboard/<ref>/api/workspace/delete", () => {
  test("the owner retires the workspace, its memberships, its pending invites and its subscription", async () => {
    const { db } = deletionFixture();
    const now = new Date().toISOString();
    db.raw
      .prepare(
        `INSERT INTO workspace_subscriptions (workspace_id, plan_id, status, created_at, updated_at)
         VALUES ('default', 'free', 'active', ?, ?)`,
      )
      .run(now, now);

    const res = await request(db, DELETE_PATH, "dana", { method: "POST" });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ deleted: true, next: "/dashboard" });
    // Soft delete: the row survives, only its `deleted_at` stamp is new.
    expect(count(db, "SELECT COUNT(*) AS n FROM workspaces WHERE id = 'default'")).toBe(1);
    expect(deletedAtOf(db)).not.toBeNull();
    expect(
      count(db, "SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = 'default'"),
    ).toBe(0);
    expect(inviteStatuses(db)).toEqual([{ status: "revoked" }]);
    // A retired tenant must not leave an `active` plan row behind.
    expect(subscriptionStatuses(db)).toEqual([{ status: "canceled" }]);
  });

  test("every workspace path answers 404 afterwards — this one included", async () => {
    const { db } = deletionFixture();
    const paths = [
      "/dashboard/default/api/apps",
      "/dashboard/default/api/members",
      "/dashboard/default/api/apps/4711/settings",
    ];
    // Live tenant: the same paths answer (they do not 404 on their own).
    for (const path of paths) {
      expect((await request(db, path, "dana")).status, `before ${path}`).not.toBe(404);
    }

    expect((await request(db, DELETE_PATH, "dana", { method: "POST" })).status).toBe(200);

    for (const path of paths) {
      const res = await request(db, path, "dana");
      expect(res.status, path).toBe(404);
    }
    // The owner keeps a session but loses the tenant: the delete face is gone
    // with it, so a replayed request can never resolve the workspace again.
    const replay = await request(db, DELETE_PATH, "dana", { method: "POST" });
    expect(replay.status).toBe(404);
  });

  test("the owner's free slot is free again, so a new workspace can be created", async () => {
    const { db } = deletionFixture();
    // The slot is spent while the workspace is live; the delete is what frees it.
    const before = await request(db, "/dashboard/api/workspaces", "dana", {
      method: "POST",
      body: { name: "Before" },
    });
    expect(before.status).toBe(409);

    expect((await request(db, DELETE_PATH, "dana", { method: "POST" })).status).toBe(200);

    const created = await request(db, "/dashboard/api/workspaces", "dana", {
      method: "POST",
      body: { name: "Second" },
    });

    expect(created.status).toBe(201);
    const body = (await created.json()) as { id: string };
    expect(body.id).not.toBe("default");
    expect(count(db, "SELECT COUNT(*) AS n FROM workspaces WHERE id = ?", body.id)).toBe(1);
  });

  test("a non-owner is refused and nothing changes", async () => {
    const { db } = deletionFixture();

    // An admin passes `requireAdmin` and hits the owner-only boundary.
    const asAdmin = await request(db, DELETE_PATH, "carol", { method: "POST" });
    expect(asAdmin.status).toBe(403);
    expect(await asAdmin.text()).toBe(OWNER_REFUSAL);

    // A plain member is refused by the members-family gate before it.
    expect((await request(db, DELETE_PATH, "mallory", { method: "POST" })).status).toBe(403);

    expect(deletedAtOf(db)).toBeNull();
    expect(
      count(db, "SELECT COUNT(*) AS n FROM workspace_members WHERE workspace_id = 'default'"),
    ).toBe(3);
    expect(inviteStatuses(db)).toEqual([{ status: "pending" }]);
  });

  test("a store-level replay is a no-op that reports it changed nothing", async () => {
    const { db } = deletionFixture();
    expect((await request(db, DELETE_PATH, "dana", { method: "POST" })).status).toBe(200);
    const stampedAt = deletedAtOf(db);

    // A second delete carries a LATER stamp: were the batch not guarded, the
    // row would be re-stamped.
    const replayed = await deleteWorkspace(db, "default", new Date(Date.now() + 60_000).toISOString());

    expect(replayed).toBe(false);
    expect(deletedAtOf(db)).toBe(stampedAt);
    expect(count(db, "SELECT COUNT(*) AS n FROM workspace_members")).toBe(0);
    expect(inviteStatuses(db)).toEqual([{ status: "revoked" }]);
  });
});
