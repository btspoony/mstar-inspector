/**
 * QC F2-10 (worker half): the list states bindability, and an orphan App is
 * ONE row however many installations it has.
 *
 * The rows are the SERVER's facts: which installations are pending at all (a
 * shared App, unbound), and whether THIS caller may bind them (the manager gate
 * the bind route checks first). The surface renders exactly that — it never
 * infers a permission from its own viewer role.
 */
import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import { createReviewBotsStore } from "../../src/dashboard/apps-store";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createUser } from "../../src/dashboard/users";
import { parseApps, type AppsPayload, type PendingBindRow } from "../../src/spa/pages/data";
import { createMigratedTestD1, seedDefaultMemberships, seedTarget, type TestD1 } from "../store/helpers";
import { OAUTH_CLIENT_SECRET } from "../helpers/fake-secrets";
import type { Env } from "../../src/worker/env";

const SESSION_SECRET = ["test", "f2", "pending", "session", "secret", "3"].join("-");
const TEST_KEY = Buffer.alloc(32, 13).toString("base64");
const CALLER_WS = "default";
const OWNER_WS = "ws-provider";
const SHARED_APP = "app-pending-shared";
const OWNED_APP = "app-pending-owned";

function makeEnv(db: TestD1): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} } as unknown as Env["REVIEW_QUEUE"],
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} } as unknown as Env["IDEMPOTENCY_KV"],
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: OAUTH_CLIENT_SECRET,
    DEPLOYMENT_MODE: "self-hosted",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DASHBOARD_ENCRYPTION_KEY: TEST_KEY,
    DB: db,
  } as unknown as Env;
}

async function get(db: TestD1, login: string): Promise<Response> {
  const cookie = await createSessionValue(login, null, SESSION_SECRET);
  return await worker.fetch(
    new Request(`https://worker.local/dashboard/${CALLER_WS}/api/apps`, {
      headers: { Cookie: `${SESSION_COOKIE}=${cookie}`, Accept: "application/json" },
    }),
    makeEnv(db),
  );
}

/**
 * The caller's workspace: a manager (`alice`), a plain member (`mallory`), one
 * SHARED App of a provider workspace installed twice and never bound, and one
 * OWNED App with an unbound installation the bind route refuses outright.
 */
async function world(): Promise<TestD1> {
  const db = createMigratedTestD1();
  await createUser(db, { login: "alice", role: "member" });
  await createUser(db, { login: "mallory", role: "member" });
  seedDefaultMemberships(db, { alice: "owner", mallory: "member" });
  db.raw
    .prepare("INSERT INTO workspaces (id, slug, name, created_by, created_at) VALUES (?, ?, ?, 'x', datetime('now'))")
    .run(OWNER_WS, OWNER_WS, OWNER_WS);

  const apps = createReviewBotsStore(db);
  for (const [id, workspaceId] of [
    [SHARED_APP, OWNER_WS],
    [OWNED_APP, CALLER_WS],
  ] as const) {
    db.raw
      .prepare(
        `INSERT INTO github_apps
           (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
            created_by, status, scope, shared_at, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'enc', 'enc', 'x', 'active', ?, ?, datetime('now'), datetime('now'))`,
      )
      .run(
        id,
        id,
        id === SHARED_APP ? 7601 : 7602,
        id,
        id === SHARED_APP ? "shared" : "owned",
        id === SHARED_APP ? "2026-01-01 00:00:00" : null,
      );
    db.raw.prepare("INSERT INTO app_workspaces (app_id, workspace_id) VALUES (?, ?)").run(id, workspaceId);
    db.raw
      .prepare(
        `INSERT INTO review_bots (id, workspace_id, name, scope, shared_at, multiplier, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, 1, datetime('now'), datetime('now'))`,
      )
      .run(id, workspaceId, id, id === SHARED_APP ? "shared" : "owned", id === SHARED_APP ? "2026-01-01 00:00:00" : null);
  }

  // TWO installations of the ONE orphan shared App, and one of the owned App.
  for (const [appId, installationId, account] of [
    [SHARED_APP, 8801, "acme-org"],
    [SHARED_APP, 8802, "acme-labs"],
    [OWNED_APP, 8803, "acme-owned"],
  ] as const) {
    await apps.upsertInstallation({ appId, installationId, accountLogin: account, authoritative: true });
  }
  // The caller holds a target on the owned App only — so the shared App has no
  // install-state row and no target here: the orphan case.
  seedTarget(db, OWNED_APP, { workspaceId: CALLER_WS, repoOwner: "acme", repoName: "owned" });
  return db;
}

const pendingOf = async (db: TestD1, login: string): Promise<PendingBindRow[]> => {
  const res = await get(db, login);
  expect(res.status).toBe(200);
  const parsed = parseApps(await res.json());
  expect(parsed).not.toBeNull();
  return (parsed as AppsPayload).pending_installations ?? [];
};

describe("F2-10 — a manager reads both orphan installations, both bindable", () => {
  test("one shared App contributes two pending rows, each can_bind: true", async () => {
    const rows = await pendingOf(await world(), "alice");
    expect(rows.map((row) => row.installation_id).sort()).toEqual([8801, 8802]);
    expect(rows.every((row) => row.app_github_app_id === 7601)).toBe(true);
    expect(rows.every((row) => row.app_name === SHARED_APP)).toBe(true);
    expect(rows.every((row) => row.can_bind)).toBe(true);
  });

  test("a member reads the same rows with can_bind: false", async () => {
    const rows = await pendingOf(await world(), "mallory");
    expect(rows.map((row) => row.installation_id).sort()).toEqual([8801, 8802]);
    expect(rows.every((row) => row.can_bind)).toBe(false);
  });

  test("an owned-unshared App is never a pending row — its bind would 404", async () => {
    const db = await world();
    // The owned App's unbound installation exists on GitHub, and this workspace
    // even holds a target on it: the bind route still answers "bot is not
    // shared", so the list must not offer it.
    expect(
      db.raw
        .query("SELECT COUNT(*) AS n FROM github_app_installations WHERE app_id = ? AND removed_at IS NULL")
        .get(OWNED_APP),
    ).toEqual({ n: 1 });
    const rows = await pendingOf(db, "alice");
    expect(rows.some((row) => row.app_github_app_id === 7602)).toBe(false);
  });
});
