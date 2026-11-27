/**
 * QC F2-6 / F2-8: the bind completes, and the installation-only manager can
 * open the App it still mounts.
 *
 * F2-6 — the start route admits a pending shared App precisely when the
 * requesting workspace holds no install state and no target; that is what a
 * FIRST bind is. The callback must therefore resolve by the SIGNED identity
 * (App + installation), never through the relation-scoped lookup that answers
 * "may you see it" — the bind is what creates that relation.
 *
 * F2-8 — once the owner stops sharing, an installation-only manager reads a
 * blocked App with ZERO targets. The worker states it as `target_id: null` +
 * `targets_many: false`; the parser must accept that as its own face rather
 * than folding it into the several-targets one.
 */
import { afterEach, describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import { createReviewBotsStore } from "../../src/dashboard/apps-store";
import { createSecretbox } from "../../src/dashboard/secretbox";
import { SESSION_COOKIE, createSessionValue, verifyValue } from "../../src/dashboard/session";
import { createUser } from "../../src/dashboard/users";
import { parseSettings, type SettingsPayload } from "../../src/spa/pages/data";
import { createMigratedTestD1, seedDefaultMemberships, type TestD1 } from "../store/helpers";
import { testAppPem } from "../helpers/rsa-key";
import { OAUTH_CLIENT_SECRET } from "../helpers/fake-secrets";
import type { Env } from "../../src/worker/env";

const SESSION_SECRET = ["test", "f2", "bind", "session", "secret", "32b"].join("-");
const TEST_KEY = Buffer.alloc(32, 11).toString("base64");
const BIND_COOKIE = "__Host-mstar-bind-state";
const OWNER_WS = "ws-provider";
const CALLER_WS = "default";
const APP_ROW = "app-f2-shared";
const GITHUB_APP_ID = 9701;
const INSTALLATION = 5151;

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
 * A SHARED App of another workspace, installed on the caller's account but
 * never bound: no `app_installations` row, no target, no chain. Exactly the
 * state the start route admits and the old callback could not finish.
 */
async function orphanWorld(): Promise<TestD1> {
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
       VALUES (?, 'f2-app', ?, 'f2-app', ?, 'enc', 'x', 'active', 'shared', datetime('now'), datetime('now'), datetime('now'))`,
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
       VALUES (?, ?, 'f2-app', 'shared', datetime('now'), 1, datetime('now'), datetime('now'))`,
    )
    .run(APP_ROW, OWNER_WS);
  await createReviewBotsStore(db).upsertInstallation({
    appId: APP_ROW,
    installationId: INSTALLATION,
    accountLogin: "acme-org",
    authoritative: true,
  });
  return db;
}

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

/** GitHub answering the callback: org installation, alice an active org admin. */
function stubGithub(options: { org?: string; adminOf?: string[]; user?: string } = {}): void {
  const org = options.org ?? "acme-org";
  const adminOf = options.adminOf ?? [org];
  const user = options.user ?? "alice";
  globalThis.fetch = (async (input: unknown) => {
    const url = String(input);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
    if (url === "https://github.com/login/oauth/access_token") return json({ access_token: "user-token" });
    if (url === "https://api.github.com/user") return json({ login: user, name: null, avatar_url: null, id: 1 });
    if (/\/app\/installations\/\d+\/access_tokens$/.test(url)) return json({ token: "tok" }, 201);
    if (/\/app\/installations\/\d+$/.test(url)) return json({ id: INSTALLATION, account: { login: org, type: "Organization" } });
    const membership = /^https:\/\/api\.github\.com\/user\/memberships\/orgs\/([^/]+)$/.exec(url);
    if (membership) {
      const target = decodeURIComponent(membership[1]!);
      return json({ state: "active", role: adminOf.includes(target) ? "admin" : "member" });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as unknown as typeof fetch;
}

/** Run the bind start and its OAuth callback as the signed-in user. */
async function bindThroughOAuth(
  db: TestD1,
  workspace: string,
  installationId: number,
): Promise<{ started: Response; callback: Response }> {
  const started = await call(db, `/dashboard/${workspace}/api/apps/${GITHUB_APP_ID}/bind-installation`, {
    method: "POST",
    headers: { ...(await headers("alice")), "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ installationId: String(installationId) }).toString(),
  });
  const body = (await started.clone().json()) as { authorize_url?: string };
  const state = body.authorize_url === undefined ? "" : new URL(body.authorize_url).searchParams.get("state")!;
  const callback = await call(
    db,
    `/dashboard/oauth/callback?code=abc123&state=${encodeURIComponent(state)}`,
    {
      method: "GET",
      headers: await headers("alice", `${BIND_COOKIE}=${state}`),
      redirect: "manual",
    },
  );
  return { started, callback };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const boundTo = (db: TestD1): string | null =>
  (
    db.raw
      .query("SELECT bound_workspace_id FROM github_app_installations WHERE app_id = ? AND installation_id = ?")
      .get(APP_ROW, INSTALLATION) as { bound_workspace_id: string | null }
  ).bound_workspace_id;

/**
 * The state the START route signs. Every field is validated by the callback's
 * reader, so an absent installation identity would make the whole flow
 * impossible — the signed state is where the identity lives.
 */
async function signedStateOf(started: Response): Promise<Record<string, unknown>> {
  const body: unknown = await started.json();
  const authorizeUrl = isRecord(body) && typeof body.authorize_url === "string" ? body.authorize_url : null;
  expect(authorizeUrl).not.toBeNull();
  const raw = new URL(authorizeUrl!).searchParams.get("state")!;
  const decoded = await verifyValue(raw, SESSION_SECRET);
  expect(decoded).not.toBeNull();
  return JSON.parse(decoded!) as Record<string, unknown>;
}

describe("F2-6 — the signed state carries the App AND the installation", () => {
  test("both identities ride the signed state", async () => {
    const db = await orphanWorld();
    stubGithub();
    const started = await call(db, `/dashboard/${CALLER_WS}/api/apps/${GITHUB_APP_ID}/bind-installation`, {
      method: "POST",
      headers: { ...(await headers("alice")), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ installationId: String(INSTALLATION) }).toString(),
    });
    const state = await signedStateOf(started);
    expect(state.botId).toBe(APP_ROW);
    expect(state.githubAppId).toBe(GITHUB_APP_ID);
    expect(state.installationId).toBe(INSTALLATION);
    expect(state.workspaceId).toBe(CALLER_WS);
  });
});

describe("F2-6 — a first bind FINISHES", () => {
  test("pending shared App + matching state installs and binds", async () => {
    const db = await orphanWorld();
    stubGithub();
    const { started, callback } = await bindThroughOAuth(db, CALLER_WS, INSTALLATION);

    expect(started.status).toBe(200);
    expect(callback.status).toBe(302);
    expect(boundTo(db)).toBe(CALLER_WS);

    // …and the install state the bind is *for* now exists, so the App is in the
    // caller's installed list and its detail opens.
    const state = db.raw
      .query("SELECT 1 AS present FROM app_installations WHERE github_app_id = ? AND workspace_id = ?")
      .get(APP_ROW, CALLER_WS);
    expect(state).not.toBeNull();
  });

  test("a mismatched GitHub account is refused and binds nothing", async () => {
    const db = await orphanWorld();
    // The installation belongs to `acme-org`, but alice administers only another org.
    stubGithub({ adminOf: ["other-org"] });
    const { callback } = await bindThroughOAuth(db, CALLER_WS, INSTALLATION);
    expect(callback.status).toBe(403);
    expect(boundTo(db)).toBeNull();
  });

  test("a state whose installation left the caller's pending list is refused", async () => {
    const db = await orphanWorld();
    stubGithub();
    // The start route admits it, then the installation disappears before the
    // callback: the re-check must refuse, never bind a row that is gone.
    const started = await call(db, `/dashboard/${CALLER_WS}/api/apps/${GITHUB_APP_ID}/bind-installation`, {
      method: "POST",
      headers: { ...(await headers("alice")), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ installationId: String(INSTALLATION) }).toString(),
    });
    const state = new URL(((await started.json()) as { authorize_url: string }).authorize_url).searchParams.get(
      "state",
    )!;
    db.raw.prepare("UPDATE github_app_installations SET removed_at = datetime('now') WHERE app_id = ?").run(APP_ROW);
    const callback = await call(
      db,
      `/dashboard/oauth/callback?code=abc123&state=${encodeURIComponent(state)}`,
      { method: "GET", headers: await headers("alice", `${BIND_COOKIE}=${state}`), redirect: "manual" },
    );
    expect(callback.status).toBe(404);
    expect(boundTo(db)).toBeNull();
  });

  test("a foreign workspace's manager cannot finish another workspace's bind", async () => {
    const db = await orphanWorld();
    stubGithub();
    const started = await call(db, `/dashboard/${CALLER_WS}/api/apps/${GITHUB_APP_ID}/bind-installation`, {
      method: "POST",
      headers: { ...(await headers("alice")), "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ installationId: String(INSTALLATION) }).toString(),
    });
    const state = new URL(((await started.json()) as { authorize_url: string }).authorize_url).searchParams.get(
      "state",
    )!;
    const callback = await call(
      db,
      `/dashboard/oauth/callback?code=abc123&state=${encodeURIComponent(state)}`,
      { method: "GET", headers: await headers("alice", `${BIND_COOKIE}=${state}`), redirect: "manual" },
    );
    expect(callback.status).toBe(302);
    expect(boundTo(db)).toBe(CALLER_WS);

    // Now the SAME signed state replayed from a workspace alice does not manage.
    await createUser(db, { login: "bob", role: "member" });
    db.raw
      .prepare("INSERT INTO workspaces (id, slug, name, created_by, created_at) VALUES ('ws-stranger', 'ws-stranger', 'Stranger', 'x', datetime('now'))")
      .run();
    const replay = await call(
      db,
      `/dashboard/oauth/callback?code=abc123&state=${encodeURIComponent(state)}`,
      { method: "GET", headers: await headers("bob", `${BIND_COOKIE}=${state}`), redirect: "manual" },
    );
    // The bind cookie is bound to alice's session, so bob's replay never starts.
    expect(replay.status).not.toBe(302);
  });
});

describe("F2-8 — an installation-only manager reads the blocked zero-target face", () => {
  /** A bound installation, no target of its own, and the owner now unshared. */
  async function installerOnlyWorld(): Promise<TestD1> {
    const db = await orphanWorld();
    const apps = createReviewBotsStore(db);
    expect(await apps.bindInstallation(APP_ROW, INSTALLATION, CALLER_WS)).toBe("bound");
    // The owner stops sharing — the mount stays, the configuration does not.
    db.raw
      .prepare("UPDATE review_bots SET scope = 'owned' WHERE id = ?")
      .run(APP_ROW);
    db.raw.prepare("UPDATE github_apps SET scope = 'owned' WHERE id = ?").run(APP_ROW);
    return db;
  }

  test("the worker states zero targets as target_id: null + targets_many: false", async () => {
    const db = await installerOnlyWorld();
    const res = await call(db, `/dashboard/${CALLER_WS}/api/apps/${GITHUB_APP_ID}`, {
      method: "GET",
      headers: await headers("alice"),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.can_manage).toBe(true);
    expect(body.blocked).toBe(true);
    expect(body.blocked_reason).toBe("bot_not_shared");
    expect(body.target_id).toBeNull();
    expect(body.targets_many).toBe(false);
    expect(body.viewer_relation).toBe("installed");
    // The roster and the chain the workspace still mounts are what the face
    // renders beside the warning — they are the reason the page must open.
    expect(body.installations).toEqual([
      expect.objectContaining({ installation_id: INSTALLATION, account_login: "acme-org" }),
    ]);
    expect(Array.isArray(body.chain)).toBe(true);
  });

  test("that real response round-trips through the SPA parser as its own face", async () => {
    const db = await installerOnlyWorld();
    const body = (await (
      await call(db, `/dashboard/${CALLER_WS}/api/apps/${GITHUB_APP_ID}`, {
        method: "GET",
        headers: await headers("alice"),
      })
    ).json()) as unknown;

    const parsed = parseSettings(body);
    expect(parsed).not.toBeNull();
    const face = parsed as SettingsPayload;
    expect(face.blocked).toBe(true);
    expect(face.target_id).toBeNull();
    expect(face.targets_many).toBe(false);
    // The installed face's roster and chain survive — that is what it renders.
    expect(face.installations).toEqual([
      expect.objectContaining({ installation_id: INSTALLATION, account_login: "acme-org" }),
    ]);
    expect(Array.isArray(face.chain)).toBe(true);
  });

  test("several targets and zero targets are told apart, and neither is invented", async () => {
    const db = await installerOnlyWorld();
    const body = (await (
      await call(db, `/dashboard/${CALLER_WS}/api/apps/${GITHUB_APP_ID}`, {
        method: "GET",
        headers: await headers("alice"),
      })
    ).json()) as Record<string, unknown>;

    // Zero targets: accepted, and the flag says ZERO.
    expect(parseSettings(body)).not.toBeNull();
    // Several targets: accepted when the flag says so.
    expect(parseSettings({ ...body, targets_many: true })).not.toBeNull();
    // Neither stated: refused — a blocked null target must say which it is.
    expect(parseSettings({ ...body, targets_many: undefined })).toBeNull();
  });
});
