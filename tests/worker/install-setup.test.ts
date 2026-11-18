/**
 * `/bot/setup` — GitHub's setup redirect, answered as an ordinary worker
 * request. GitHub's role is only to append `installation_id` and
 * `setup_action`; there is no live GitHub call anywhere in this file (and no
 * fetch stub — the route never calls GitHub, so a stub would only prove the
 * stub).
 *
 * Pinned here, per contract § 8.6/§ 8.7 and § 9:
 *   - validation first: a malformed installation id or an unknown
 *     `setup_action` answers 400 `bad setup request` and writes nothing;
 *   - the session is the identity: no cookie, or a login with no `users` row,
 *     answers 401 `unauthenticated` and writes nothing;
 *   - 0 live claims bind nothing, 1 binds and consumes exactly that claim,
 *     N bind nothing and list every claim with a confirming form;
 *   - the confirming `POST` binds the named claim and leaves the other live;
 *   - a claim names the APP (migration 0067 / D19): the bind writes
 *     `bot_installations` and never `review_targets`;
 *   - the refusal names its reason: a bot unshared between claim and callback.
 */
import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import { createReviewBotsStore } from "../../src/dashboard/apps-store";
import { createInstallClaimsStore } from "../../src/dashboard/install-claims-store";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createUser } from "../../src/dashboard/users";
import type { Env } from "../../src/worker/env";
import worker from "../../src/worker/index";
import { OAUTH_CLIENT_SECRET } from "../helpers/fake-secrets";

const SESSION_SECRET = ["test", "dashboard", "session", "secret", "32-bytes!"].join("-");
const WS = "default";
const LOGIN = "mallory";
const INSTALLATION = 4242;

function makeEnv(db: TestD1, overrides: Partial<Env> = {}): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} } as unknown as Env["REVIEW_QUEUE"],
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} } as unknown as Env["IDEMPOTENCY_KV"],
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: OAUTH_CLIENT_SECRET,
    DEPLOYMENT_MODE: "self-hosted",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DB: db,
    ...overrides,
  } as Env;
}

type World = {
  db: TestD1;
  botId: string;
  userId: string;
  store: ReturnType<typeof createInstallClaimsStore>;
};

/** One shared bot, its slug, and a signed-in user. */
async function seededWorld(): Promise<World> {
  const db = createMigratedTestD1();
  const botId = "bot-setup";
  await createReviewBotsStore(db).createApp({
    id: botId,
    githubAppId: 8101,
    githubSlug: "shared-bot",
    name: botId,
    privateKeyEnc: "enc",
    webhookSecretEnc: "enc",
    createdBy: "acme",
    workspaceId: WS,
    maxApps: null,
  });
  db.raw.prepare("UPDATE review_bots SET scope = 'shared' WHERE id = ?").run(botId);
  // No target is minted at setup (0067/D19): a claim names the App, and the
  // repositories a manager adds are the targets.
  const userId = (await createUser(db, { login: LOGIN, role: "member" })).id;
  return { db, botId, userId, store: createInstallClaimsStore(db) };
}

/** A second shared bot — the fixture for "N live claims" (one per bot). */
async function addBot(world: World, id: string): Promise<string> {
  await createReviewBotsStore(world.db).createApp({
    id,
    githubAppId: 8102,
    githubSlug: id,
    name: id,
    privateKeyEnc: "enc",
    webhookSecretEnc: "enc",
    createdBy: "acme",
    workspaceId: WS,
    maxApps: null,
  });
  world.db.raw.prepare("UPDATE review_bots SET scope = 'shared' WHERE id = ?").run(id);
  return id;
}

/** A live claim on `botId` for the seeded user, through the shipped store. */
async function claimFor(world: World, botId: string): Promise<{ id: string; expiresAt: string }> {
  return world.store.createOrRefreshClaim({
    userId: world.userId,
    workspaceId: WS,
    botId,
    now: new Date().toISOString(),
  });
}

async function setupRequest(
  env: Env,
  init: { path: string; login?: string | null; method?: "GET" | "POST"; body?: Record<string, string> },
): Promise<Response> {
  const headers: Record<string, string> = {};
  if (init.login !== null) {
    const cookie = await createSessionValue(init.login ?? LOGIN, null, SESSION_SECRET);
    headers.Cookie = `${SESSION_COOKIE}=${cookie}`;
  }
  const payload = init.body === undefined ? undefined : new URLSearchParams(init.body);
  if (payload !== undefined) headers["Content-Type"] = "application/x-www-form-urlencoded";
  return worker.fetch(
    new Request(`https://worker.local${init.path}`, {
      method: init.method ?? "GET",
      headers,
      ...(payload === undefined ? {} : { body: payload }),
    }),
    env,
  );
}

function setupGet(env: Env, query: string, login: string | null = LOGIN): Promise<Response> {
  return setupRequest(env, { path: `/bot/setup?${query}`, login });
}

function setupPost(env: Env, body: Record<string, string>, login: string | null = LOGIN): Promise<Response> {
  return setupRequest(env, { path: "/bot/setup", method: "POST", body, login });
}

function claimRow(db: TestD1, claimId: string): { consumed_at: string | null } | null {
  return db.raw.query("SELECT consumed_at FROM install_claims WHERE id = ?").get(claimId) as {
    consumed_at: string | null;
  } | null;
}

function installationCount(db: TestD1): number {
  const row = db.raw.query("SELECT COUNT(*) AS n FROM bot_installations").get();
  if (row === null || typeof row !== "object" || !("n" in row) || typeof row.n !== "number") {
    throw new Error("SELECT COUNT(*) on bot_installations returned no count");
  }
  return row.n;
}

/** The bot's live installation ids — the only thing the bind writes. */
function installedIds(db: TestD1, botId: string): number[] {
  return (
    db.raw
      .query("SELECT installation_id FROM bot_installations WHERE bot_id = ? AND removed_at IS NULL")
      .all(botId) as Array<{ installation_id: number }>
  ).map((row) => row.installation_id);
}

describe("GET /bot/setup validation", () => {
  test("a malformed installation_id answers 400 bad setup request and writes nothing", async () => {
    const { db } = await seededWorld();
    const env = makeEnv(db);
    for (const installationId of ["", "abc", "0", "-1", "12.5", "1 2"]) {
      const res = await setupGet(env, `installation_id=${encodeURIComponent(installationId)}&setup_action=install`);
      expect(res.status, `installation_id=${installationId}`).toBe(400);
      expect(await res.text()).toBe("bad setup request");
    }
    expect(db.raw.query("SELECT COUNT(*) AS n FROM install_claims").get()).toEqual({ n: 0 });
  });

  test("a missing or unknown setup_action answers 400 bad setup request and writes nothing", async () => {
    const { db } = await seededWorld();
    const env = makeEnv(db);
    for (const query of [
      `installation_id=${INSTALLATION}`,
      `installation_id=${INSTALLATION}&setup_action=deleted`,
      `installation_id=${INSTALLATION}&setup_action=`,
    ]) {
      const res = await setupGet(env, query);
      expect(res.status, query).toBe(400);
      expect(await res.text()).toBe("bad setup request");
    }
  });

  test("an unbound DASHBOARD_SESSION_SECRET answers 500 and writes nothing", async () => {
    const { db } = await seededWorld();
    const res = await setupGet(
      makeEnv(db, { DASHBOARD_SESSION_SECRET: undefined }),
      `installation_id=${INSTALLATION}&setup_action=install`,
    );
    expect(res.status).toBe(500);
    expect(await res.text()).toBe("dashboard OAuth is not configured");
    expect(installationCount(db)).toBe(0);
  });

  test("no session cookie answers 401 unauthenticated and writes nothing", async () => {
    const { db, botId, store, userId } = await seededWorld();
    const claim = await store.createOrRefreshClaim({
      userId,
      workspaceId: WS,
      botId,
      now: new Date().toISOString(),
    });
    const res = await setupGet(makeEnv(db), `installation_id=${INSTALLATION}&setup_action=install`, null);

    expect(res.status).toBe(401);
    const body = await res.text();
    expect(body).toContain("unauthenticated");
    expect(body).toContain("/dashboard/login");
    // The claim survives, so signing in and pressing install again converges.
    expect(claimRow(db, claim.id)?.consumed_at).toBeNull();
    expect(installationCount(db)).toBe(0);
  });

  test("a valid session whose login has no users row answers 401 and writes nothing", async () => {
    const { db } = await seededWorld();
    const res = await setupGet(
      makeEnv(db),
      `installation_id=${INSTALLATION}&setup_action=install`,
      "nobody",
    );
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("unauthenticated");
    expect(installationCount(db)).toBe(0);
  });
});

describe("GET /bot/setup — zero, one and N live claims", () => {
  test("no live claim binds nothing and says no_live_claim", async () => {
    const { db } = await seededWorld();
    const res = await setupGet(makeEnv(db), `installation_id=${INSTALLATION}&setup_action=install`);

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("no_live_claim");
    // There is no claim, so no target can be named: the way back is the shell.
    expect(body).toContain('href="/dashboard"');
    expect(installationCount(db)).toBe(0);
  });

  test("one live claim renders the confirm page and binds nothing", async () => {
    const { db, botId, store, userId } = await seededWorld();
    const claim = await store.createOrRefreshClaim({
      userId,
      workspaceId: WS,
      botId,
      now: new Date().toISOString(),
    });
    const res = await setupGet(makeEnv(db), `installation_id=${INSTALLATION}&setup_action=install`);

    expect(res.status).toBe(200);
    const body = await res.text();
    // The GET never binds: it shows the installation it was told about, the
    // APP the claim names, and one form the user has to submit.
    expect(body).toContain("confirm_required");
    expect(body).toContain(String(INSTALLATION));
    expect(body).toContain(botId);
    expect(body).toContain(`value="${claim.id}"`);
    expect(claimRow(db, claim.id)?.consumed_at).toBeNull();
    expect(installationCount(db)).toBe(0);
  });

  test("a mailed GET naming another installation binds nothing", async () => {
    // The reviewer's scenario: a signed-in manager holding ONE live claim opens
    // a crafted link. The installation id is caller-supplied and unverified, so
    // the page must not act on it — it only shows it back.
    const { db, botId, store, userId } = await seededWorld();
    const claim = await store.createOrRefreshClaim({
      userId,
      workspaceId: WS,
      botId,
      now: new Date().toISOString(),
    });
    const res = await setupGet(makeEnv(db), "installation_id=666&setup_action=install");

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("confirm_required");
    expect(body).toContain("<code>666</code>");
    // Nothing was consumed, recorded or bound.
    expect(claimRow(db, claim.id)?.consumed_at).toBeNull();
    expect(installationCount(db)).toBe(0);
  });

  test("two live claims bind nothing and list both for confirmation", async () => {
    const world = await seededWorld();
    const second = await addBot(world, "bot-setup-second");
    const firstClaim = await claimFor(world, world.botId);
    const secondClaim = await claimFor(world, second);
    const res = await setupGet(makeEnv(world.db), `installation_id=${INSTALLATION}&setup_action=install`);

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("confirm_required");
    // The installation the callback was told about rides the page, so the user
    // can check it before anything binds.
    expect(body).toContain(String(INSTALLATION));
    // Both claims are on the page, each with its own confirming form.
    expect(body).toContain(firstClaim.id);
    expect(body).toContain(secondClaim.id);
    expect(body).toContain('name="claim_id"');
    expect(body).toContain(`name="installation_id"`);
    // Nothing was chosen on the user's behalf.
    expect(claimRow(world.db, firstClaim.id)?.consumed_at).toBeNull();
    expect(claimRow(world.db, secondClaim.id)?.consumed_at).toBeNull();
    expect(installationCount(world.db)).toBe(0);
  });
});

describe("POST /bot/setup — the confirming action", () => {
  test("confirming the single claim records the installation on the app and consumes it", async () => {
    const { db, botId, store, userId } = await seededWorld();
    const claim = await store.createOrRefreshClaim({
      userId,
      workspaceId: WS,
      botId,
      now: new Date().toISOString(),
    });

    const res = await setupPost(makeEnv(db), {
      installation_id: String(INSTALLATION),
      claim_id: claim.id,
    });

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("bound");
    expect(body).toContain(botId);
    expect(claimRow(db, claim.id)?.consumed_at).not.toBeNull();
    expect(installedIds(db, botId)).toEqual([INSTALLATION]);
    // The App's installation, never a target: setup mints no target row.
    expect(db.raw.query("SELECT COUNT(*) AS n FROM review_targets").get()).toEqual({ n: 0 });
  });

  test("naming one of two claims binds it and leaves the other live", async () => {
    const world = await seededWorld();
    const second = await addBot(world, "bot-setup-second");
    const firstClaim = await claimFor(world, world.botId);
    const secondClaim = await claimFor(world, second);

    const res = await setupPost(makeEnv(world.db), {
      installation_id: String(INSTALLATION),
      claim_id: firstClaim.id,
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("bound");
    expect(installedIds(world.db, world.botId)).toEqual([INSTALLATION]);
    expect(installedIds(world.db, second)).toEqual([]);
    expect(claimRow(world.db, firstClaim.id)?.consumed_at).not.toBeNull();
    expect(claimRow(world.db, secondClaim.id)?.consumed_at).toBeNull();
  });

  test("a cross-user or unknown claim answers 404 claim not found and writes nothing", async () => {
    const world = await seededWorld();
    await createUser(world.db, { login: "trudy", role: "member" });
    const claim = await claimFor(world, world.botId);

    const unknown = await setupPost(makeEnv(world.db), {
      installation_id: String(INSTALLATION),
      claim_id: "no-such-claim",
    });
    expect(unknown.status).toBe(404);
    expect(await unknown.json()).toEqual({ error: "claim not found" });

    // Another session holding the id is indistinguishable from a missing claim.
    const crossUser = await setupPost(
      makeEnv(world.db),
      { installation_id: String(INSTALLATION), claim_id: claim.id },
      "trudy",
    );
    expect(crossUser.status).toBe(404);
    expect(await crossUser.json()).toEqual({ error: "claim not found" });
    expect(claimRow(world.db, claim.id)?.consumed_at).toBeNull();
    expect(installationCount(world.db)).toBe(0);
  });

  test("claiming the app again for a known installation is a converging reinstall", async () => {
    const world = await seededWorld();
    // The webhook recorded the installation first; a second claim of the same
    // app for the same installation must converge instead of stacking rows.
    world.db.raw
      .prepare(
        `INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at, removed_at)
         VALUES ('install-known', ?, ?, 'acme', '2026-01-01T00:00:00.000Z', '2026-01-02T00:00:00.000Z')`,
      )
      .run(world.botId, INSTALLATION);
    const claim = await claimFor(world, world.botId);

    const res = await setupPost(makeEnv(world.db), {
      installation_id: String(INSTALLATION),
      claim_id: claim.id,
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("bound");
    expect(installedIds(world.db, world.botId)).toEqual([INSTALLATION]);
    // The login the webhook recorded survives; the reinstall clears `removed_at`.
    expect(
      world.db.raw
        .query("SELECT account_login, removed_at FROM bot_installations WHERE bot_id = ?")
        .get(world.botId),
    ).toEqual({ account_login: "acme", removed_at: null });
  });

  test("a bot unshared between claim and callback answers 409 bot is not shared and binds nothing", async () => {
    const world = await seededWorld();
    const claim = await claimFor(world, world.botId);
    world.db.raw.prepare("UPDATE review_bots SET scope = 'owned' WHERE id = ?").run(world.botId);

    const res = await setupPost(makeEnv(world.db), {
      installation_id: String(INSTALLATION),
      claim_id: claim.id,
    });

    expect(res.status).toBe(409);
    expect(await res.text()).toBe("bot is not shared");
    expect(claimRow(world.db, claim.id)?.consumed_at).toBeNull();
    expect(installationCount(world.db)).toBe(0);
  });
});
