/**
 * QC F2-3 / F2-4: the Apps LIST route binds only the parameters its statement
 * uses, and offers a bind only where the bind route would accept one.
 *
 * F2-3 — the pending-installations statement has no placeholders (it is not
 * parameterised by workspace: a shared App belongs to its owner, not to the
 * reader). A leftover `.bind(workspaceId)` made D1 reject the whole list with
 * "wrong number of parameter bindings", so the Apps page 500ed. The regression
 * case drives the REAL route against a migrated fixture and asserts both the
 * 200 and the bounded parameter count; the test D1 double now enforces the
 * parameter count the way D1 does, so the old shape fails loudly here.
 *
 * F2-4 — `can_bind` is the route's predicate, not a narrower one. The route
 * needs a live SHARED App with at least one live associated workspace; a list
 * row that offered the action for an App whose associations are all deleted
 * sent the user into a 404. Both surfaces now read one predicate
 * (`APP_BINDABLE_SQL`).
 */
import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import { createReviewBotsStore } from "../../src/dashboard/apps-store";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createUser } from "../../src/dashboard/users";
import { parseApps, type AppsPayload } from "../../src/spa/pages/data";
import { createMigratedTestD1, seedDefaultMemberships, type TestD1 } from "../store/helpers";
import { OAUTH_CLIENT_SECRET } from "../helpers/fake-secrets";
import type { Env } from "../../src/worker/env";

const SESSION_SECRET = ["test", "f2", "list", "params", "session", "32d"].join("-");
const TEST_KEY = Buffer.alloc(32, 14).toString("base64");
const CALLER_WS = "default";
const OWNER_WS = "ws-provider";
const SHARED_APP = "app-list-shared";
const GITHUB_APP_ID = 9911;

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

async function list(db: TestD1, login = "alice"): Promise<Response> {
  const cookie = await createSessionValue(login, null, SESSION_SECRET);
  return await worker.fetch(
    new Request(`https://worker.local/dashboard/${CALLER_WS}/api/apps`, {
      headers: { Cookie: `${SESSION_COOKIE}=${cookie}`, Accept: "application/json" },
    }),
    makeEnv(db),
  );
}

/**
 * A SHARED App of another workspace, with one live association, plus a pending
 * installation of it — the state the list must show as bindable to a manager.
 */
async function world(): Promise<TestD1> {
  const db = createMigratedTestD1();
  await createUser(db, { login: "alice", role: "member" });
  await createUser(db, { login: "mallory", role: "member" });
  seedDefaultMemberships(db, { alice: "owner", mallory: "member" });
  db.raw
    .prepare("INSERT INTO workspaces (id, slug, name, created_by, created_at) VALUES (?, ?, ?, 'x', datetime('now'))")
    .run(OWNER_WS, OWNER_WS, OWNER_WS);
  db.raw
    .prepare(
      `INSERT INTO github_apps
         (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, scope, shared_at, created_at, updated_at)
       VALUES (?, 'list-shared', ?, 'list-shared', 'enc', 'enc', 'x', 'active', 'shared',
               datetime('now'), datetime('now'), datetime('now'))`,
    )
    .run(SHARED_APP, GITHUB_APP_ID);
  db.raw.prepare("INSERT INTO app_workspaces (app_id, workspace_id) VALUES (?, ?)").run(SHARED_APP, OWNER_WS);
  db.raw
    .prepare(
      `INSERT INTO review_bots (id, workspace_id, name, scope, shared_at, multiplier, created_at, updated_at)
       VALUES (?, ?, 'list-shared', 'shared', datetime('now'), 1, datetime('now'), datetime('now'))`,
    )
    .run(SHARED_APP, OWNER_WS);
  await createReviewBotsStore(db).upsertInstallation({
    appId: SHARED_APP,
    installationId: 9901,
    accountLogin: "acme-org",
    authoritative: true,
  });
  return db;
}

describe("F2-3 — the Apps list answers 200 and binds only what its SQL uses", () => {
  test("the manager's list is a real 200 and its pending statement binds no surplus values", async () => {
    const db = await world();
    const before = db.boundValueCounts!.length;
    const res = await list(db, "alice");
    expect(res.status).toBe(200);
    const parsed = parseApps(await res.json());
    expect(parsed).not.toBeNull();
    expect((parsed as AppsPayload).pending_installations?.map((row) => row.installation_id)).toEqual([9901]);
    // The fixture throws on any bind whose value count differs from the
    // statement's parameter count, so reaching this line at all proves every
    // statement's bind matches — including the named pending statement, which
    // has NO placeholder. D1 rejects a surplus parameter; bun:sqlite does not.
    expect(db.boundValueCounts!.length).toBeGreaterThan(before);
  });

  test("an empty workspace still answers 200 with no pending rows", async () => {
    const db = createMigratedTestD1();
    await createUser(db, { login: "alice", role: "member" });
    seedDefaultMemberships(db, { alice: "owner" });
    const res = await list(db, "alice");
    expect(res.status).toBe(200);
    expect(((await res.json()) as AppsPayload).pending_installations ?? []).toEqual([]);
  });
});

describe("F2-4 — a row offers the action exactly when the route would accept it", () => {
  test("a manager reads the row as bindable while the App has a live association", async () => {
    const db = await world();
    const parsed = parseApps(await (await list(db, "alice")).json()) as AppsPayload;
    expect(parsed.pending_installations?.map((row) => row.can_bind)).toEqual([true]);
  });

  test("when the App's every associated workspace is deleted the row is gone, not offered", async () => {
    const db = await world();
    // The bind route resolves the App through its live associations, so it now
    // answers 404 for it. The list must not keep offering the action.
    db.raw.prepare("UPDATE workspaces SET deleted_at = datetime('now') WHERE id = ?").run(OWNER_WS);
    expect(await createReviewBotsStore(db).getLiveSharedAppById(SHARED_APP)).toBeNull();

    const parsed = parseApps(await (await list(db, "alice")).json()) as AppsPayload;
    expect(parsed.pending_installations ?? []).toEqual([]);
  });

  test("a member reads the same row with the action withheld", async () => {
    const db = await world();
    const parsed = parseApps(await (await list(db, "mallory")).json()) as AppsPayload;
    expect(parsed.pending_installations?.map((row) => row.can_bind)).toEqual([false]);
  });
});
