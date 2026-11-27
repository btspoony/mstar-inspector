/**
 * QC F2-1 (Critical): the bind's admission is ATOMIC with its write.
 *
 * The callback proves several facts over a GitHub round trip: the signed state,
 * the workspace manager, the account administration, the App's live+shared
 * state and the installation's pending state. Every one of those can change in
 * that window. A check that runs BEFORE the write and a write that does not
 * re-check leaves exactly one gap: the App can be unshared (or deleted, or lose
 * every live association) between the admission and the UPDATE, and the bind
 * still lands — granting a workspace a chain through an App it should no longer
 * reach.
 *
 * The guard therefore lives IN the write's own statement (`bindUpdate`), whose
 * WHERE clause is the same predicate `bindAdmission` and `getLiveSharedAppById`
 * apply. These cases drive that interleaving through the real store and through
 * the real Worker.
 */
import { afterEach, describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import { createReviewBotsStore } from "../../src/dashboard/apps-store";
import { createSecretbox } from "../../src/dashboard/secretbox";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createUser } from "../../src/dashboard/users";
import { createMigratedTestD1, seedDefaultMemberships, type TestD1 } from "../store/helpers";
import { testAppPem } from "../helpers/rsa-key";
import { OAUTH_CLIENT_SECRET } from "../helpers/fake-secrets";
import type { Env } from "../../src/worker/env";

const SESSION_SECRET = ["test", "f2", "atomic", "bind", "secret", "32c"].join("-");
const TEST_KEY = Buffer.alloc(32, 12).toString("base64");
const BIND_COOKIE = "__Host-mstar-bind-state";
const OWNER_WS = "ws-provider";
const CALLER_WS = "default";
const APP_ROW = "app-atomic-shared";
const GITHUB_APP_ID = 9801;
const INSTALLATION = 5251;

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

async function headers(login: string, extraCookie = ""): Promise<Record<string, string>> {
  const cookie = `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}`;
  return { Cookie: extraCookie ? `${cookie}; ${extraCookie}` : cookie, Accept: "application/json" };
}

const call = async (db: TestD1, path: string, init: RequestInit): Promise<Response> =>
  await worker.fetch(new Request(`https://worker.local${path}`, init), makeEnv(db));

/**
 * A shared App of another workspace with ONE live association (its owner), and
 * a pending installation the caller may bind. That single association is the
 * fact the case below removes.
 */
async function world(): Promise<TestD1> {
  const db = createMigratedTestD1();
  await createUser(db, { login: "alice", role: "member" });
  seedDefaultMemberships(db, { alice: "owner" });
  db.raw
    .prepare("INSERT INTO workspaces (id, slug, name, created_by, created_at) VALUES (?, ?, ?, 'x', datetime('now'))")
    .run(OWNER_WS, OWNER_WS, OWNER_WS);
  const box = createSecretbox(TEST_KEY);
  db.raw
    .prepare(
      `INSERT INTO github_apps
         (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, scope, shared_at, created_at, updated_at)
       VALUES (?, 'atomic-app', ?, 'atomic-app', ?, 'enc', 'x', 'active', 'shared', datetime('now'), datetime('now'), datetime('now'))`,
    )
    .run(
      APP_ROW,
      GITHUB_APP_ID,
      await box.encryptSecret(await testAppPem(), `github_apps.private_key_enc:${APP_ROW}`),
    );
  db.raw.prepare("INSERT INTO app_workspaces (app_id, workspace_id) VALUES (?, ?)").run(APP_ROW, OWNER_WS);
  db.raw
    .prepare(
      `INSERT INTO review_bots (id, workspace_id, name, scope, shared_at, multiplier, created_at, updated_at)
       VALUES (?, ?, 'atomic-app', 'shared', datetime('now'), 1, datetime('now'), datetime('now'))`,
    )
    .run(APP_ROW, OWNER_WS);
  await createReviewBotsStore(db).upsertInstallation({
    appId: APP_ROW,
    installationId: INSTALLATION,
    accountLogin: "acme-org",
    authoritative: true,
  });
  // The owner's install state: `createApp` writes it in production, and it is
  // the row that must survive every refused bind below.
  db.raw
    .prepare("INSERT INTO app_installations (github_app_id, workspace_id, created_at) VALUES (?, ?, datetime('now'))")
    .run(APP_ROW, OWNER_WS);
  return db;
}

const boundTo = (db: TestD1): string | null =>
  (
    db.raw
      .query("SELECT bound_workspace_id FROM github_app_installations WHERE app_id = ? AND installation_id = ?")
      .get(APP_ROW, INSTALLATION) as { bound_workspace_id: string | null }
  ).bound_workspace_id;

const installStates = (db: TestD1): Array<{ workspace_id: string }> =>
  db.raw
    .query("SELECT workspace_id FROM app_installations WHERE github_app_id = ? ORDER BY workspace_id")
    .all(APP_ROW) as Array<{ workspace_id: string }>;

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

/** GitHub answering a callback for alice, an active admin of acme-org. */
function stubGithub(): void {
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url === "https://github.com/login/oauth/access_token") return json({ access_token: "user-token" });
    if (url === "https://api.github.com/user") return json({ login: "alice", name: null, avatar_url: null, id: 1 });
    if (/\/app\/installations\/\d+\/access_tokens$/.test(url)) return json({ token: "tok" }, 201);
    if (/\/app\/installations\/\d+$/.test(url)) {
      return json({ id: INSTALLATION, account: { login: "acme-org", type: "Organization" } });
    }
    if (/\/user\/memberships\/orgs\//.test(url)) return json({ state: "active", role: "admin" });
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

describe("F2-1 — the write re-checks the App's bindability, not only the route", () => {
  test("an App unshared after the admission refuses the write and leaves nothing behind", async () => {
    const db = await world();
    const apps = createReviewBotsStore(db);
    // The admission the callback ran a moment ago.
    expect(await apps.getLiveSharedAppById(APP_ROW)).not.toBeNull();
    expect((await apps.listPendingInstallations(APP_ROW, true)).map((r) => r.installation_id)).toEqual([
      INSTALLATION,
    ]);

    // The owner unshares between the check and the write.
    db.raw.run(`UPDATE github_apps SET scope = 'owned', shared_at = NULL WHERE id = '${APP_ROW}'`);

    expect(await apps.bindInstallation(APP_ROW, INSTALLATION, CALLER_WS)).toBe("app_unavailable");
    expect(boundTo(db)).toBeNull();
    // No install state and no chain row either: the batch's guard is the UPDATE.
    expect(installStates(db)).toEqual([{ workspace_id: OWNER_WS }]);
    expect(
      db.raw.query("SELECT COUNT(*) AS n FROM app_install_bots WHERE workspace_id = ?").get(CALLER_WS),
    ).toEqual({ n: 0 });
  });

  test("an App deleted after the admission refuses the write", async () => {
    const db = await world();
    const apps = createReviewBotsStore(db);
    expect(await apps.getLiveSharedAppById(APP_ROW)).not.toBeNull();
    db.raw
      .prepare("UPDATE github_apps SET deleted_at = datetime('now') WHERE id = ?")
      .run(APP_ROW);

    expect(await apps.bindInstallation(APP_ROW, INSTALLATION, CALLER_WS)).toBe("app_unavailable");
    expect(boundTo(db)).toBeNull();
    expect(installStates(db)).toEqual([{ workspace_id: OWNER_WS }]);
  });

  test("the App's LAST live association disappearing refuses the write", async () => {
    const db = await world();
    const apps = createReviewBotsStore(db);
    expect(await apps.getLiveSharedAppById(APP_ROW)).not.toBeNull();
    // The owner workspace is deleted. `getLiveSharedAppById` joins live
    // associations, so the App is no longer bindable even though its own row is
    // untouched — the case a predicate on `github_apps` alone would miss.
    db.raw
      .prepare("UPDATE workspaces SET deleted_at = datetime('now') WHERE id = ?")
      .run(OWNER_WS);
    expect(await apps.getLiveSharedAppById(APP_ROW)).toBeNull();

    expect(await apps.bindInstallation(APP_ROW, INSTALLATION, CALLER_WS)).toBe("app_unavailable");
    expect(boundTo(db)).toBeNull();
    expect(installStates(db)).toEqual([{ workspace_id: OWNER_WS }]);
  });

  test("a still-bindable App binds exactly as before — the guard refuses only what changed", async () => {
    const db = await world();
    expect(await createReviewBotsStore(db).bindInstallation(APP_ROW, INSTALLATION, CALLER_WS)).toBe("bound");
    expect(boundTo(db)).toBe(CALLER_WS);
    expect(installStates(db)).toEqual([{ workspace_id: CALLER_WS }, { workspace_id: OWNER_WS }]);
  });
});

describe("F2-1 — the OAuth callback answers an unshared App, and binds nothing", () => {
  test("unsharing between the START and the CALLBACK is refused with the opaque 404", async () => {
    const db = await world();
    stubGithub();
    const started = await call(db, `/dashboard/${CALLER_WS}/api/apps/${GITHUB_APP_ID}/bind-installation`, {
      method: "POST",
      headers: { ...(await headers("alice")), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ installationId: String(INSTALLATION) }).toString(),
    });
    expect(started.status).toBe(200);
    const state = new URL(((await started.json()) as { authorize_url: string }).authorize_url).searchParams.get(
      "state",
    )!;

    // The owner unshares while alice is on GitHub's consent screen.
    db.raw.run("UPDATE github_apps SET scope = 'owned', shared_at = NULL WHERE id = 'app-atomic-shared'");

    const callback = await call(
      db,
      `/dashboard/oauth/callback?code=abc123&state=${encodeURIComponent(state)}`,
      { method: "GET", headers: await headers("alice", `${BIND_COOKIE}=${state}`), redirect: "manual" },
    );
    expect(callback.status).toBe(404);
    expect(boundTo(db)).toBeNull();
    expect(installStates(db)).toEqual([{ workspace_id: OWNER_WS }]);
  });
});
