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
 *   - refusals name their reason: a second target of an already bound
 *     installation, and a bot that was unshared between claim and callback.
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
  /** The bot's first target — the one a single claim names. */
  targetId: string;
  userId: string;
  store: ReturnType<typeof createInstallClaimsStore>;
};

/** One shared bot with one unbound target, its slug, and a signed-in user. */
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
  });
  db.raw.prepare("UPDATE review_bots SET scope = 'shared' WHERE id = ?").run(botId);
  const targetRow = db.raw.query("SELECT id FROM review_targets WHERE bot_id = ?").get(botId);
  if (targetRow === null || typeof targetRow !== "object" || !("id" in targetRow) || typeof targetRow.id !== "string") {
    throw new Error(`createApp wrote no target for ${botId}`);
  }
  const targetId = targetRow.id;
  const userId = (await createUser(db, { login: LOGIN, role: "member" })).id;
  return { db, botId, targetId, userId, store: createInstallClaimsStore(db) };
}

/** A second live target of the same bot (the "same installation, two targets" fixture). */
function addTarget(db: TestD1, botId: string, installationId: number | null = null): string {
  const id = `second-${crypto.randomUUID()}`;
  db.raw
    .prepare(
      `INSERT INTO review_targets
         (id, workspace_id, bot_id, name, installation_id, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'acme', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
    .run(id, WS, botId, id, installationId);
  return id;
}

/** A live claim on `targetId` for the seeded user, through the shipped store. */
async function claimFor(world: World, targetId: string): Promise<{ id: string; expiresAt: string }> {
  return world.store.createOrRefreshClaim({
    userId: world.userId,
    workspaceId: WS,
    targetId,
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

function targetBinding(db: TestD1, targetId: string): { installation_id: number | null } {
  const row = db.raw.query("SELECT installation_id FROM review_targets WHERE id = ?").get(targetId) as {
    installation_id: number | null;
  } | null;
  if (row === null) throw new Error(`review target ${targetId} is missing`);
  return row;
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
    const { db, targetId, store, userId } = await seededWorld();
    const claim = await store.createOrRefreshClaim({
      userId,
      workspaceId: WS,
      targetId,
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
    expect(targetBinding(db, targetId).installation_id).toBeNull();
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
    expect(await res.text()).toContain("no_live_claim");
    expect(installationCount(db)).toBe(0);
  });

  test("one live claim binds exactly that target and consumes it", async () => {
    const { db, targetId, store, userId } = await seededWorld();
    const claim = await store.createOrRefreshClaim({
      userId,
      workspaceId: WS,
      targetId,
      now: new Date().toISOString(),
    });
    const res = await setupGet(makeEnv(db), `installation_id=${INSTALLATION}&setup_action=install`);

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("bound");
    expect(body).toContain(targetId);
    expect(claimRow(db, claim.id)?.consumed_at).not.toBeNull();
    expect(targetBinding(db, targetId).installation_id).toBe(INSTALLATION);
    expect(installationCount(db)).toBe(1);
  });

  test("two live claims bind nothing and list both for confirmation", async () => {
    const world = await seededWorld();
    const second = addTarget(world.db, world.botId);
    const firstClaim = await claimFor(world, world.targetId);
    const secondClaim = await claimFor(world, second);
    const res = await setupGet(makeEnv(world.db), `installation_id=${INSTALLATION}&setup_action=install`);

    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain("confirm_required");
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
  test("naming one of two claims binds it and leaves the other live", async () => {
    const world = await seededWorld();
    const second = addTarget(world.db, world.botId);
    const firstClaim = await claimFor(world, world.targetId);
    const secondClaim = await claimFor(world, second);

    const res = await setupPost(makeEnv(world.db), {
      installation_id: String(INSTALLATION),
      claim_id: firstClaim.id,
    });

    expect(res.status).toBe(200);
    expect(await res.text()).toContain("bound");
    expect(targetBinding(world.db, world.targetId).installation_id).toBe(INSTALLATION);
    expect(claimRow(world.db, firstClaim.id)?.consumed_at).not.toBeNull();
    expect(claimRow(world.db, secondClaim.id)?.consumed_at).toBeNull();
    expect(targetBinding(world.db, second).installation_id).toBeNull();
  });

  test("a cross-user or unknown claim answers 404 claim not found and writes nothing", async () => {
    const world = await seededWorld();
    await createUser(world.db, { login: "trudy", role: "member" });
    const claim = await claimFor(world, world.targetId);

    const unknown = await setupPost(makeEnv(world.db), {
      installation_id: String(INSTALLATION),
      claim_id: "no-such-claim",
    });
    expect(unknown.status).toBe(404);
    expect(await unknown.text()).toBe("claim not found");

    // Another session holding the id is indistinguishable from a missing claim.
    const crossUser = await setupPost(
      makeEnv(world.db),
      { installation_id: String(INSTALLATION), claim_id: claim.id },
      "trudy",
    );
    expect(crossUser.status).toBe(404);
    expect(await crossUser.text()).toBe("claim not found");
    expect(claimRow(world.db, claim.id)?.consumed_at).toBeNull();
    expect(installationCount(world.db)).toBe(0);
  });

  test("a second claim of an already bound installation answers 409 installation already bound", async () => {
    const world = await seededWorld();
    // The first target already holds this installation; the new claim names a
    // second target, so the bind would collide on the target partial index.
    world.db.raw
      .prepare("UPDATE review_targets SET installation_id = ? WHERE id = ?")
      .run(INSTALLATION, world.targetId);
    const second = addTarget(world.db, world.botId);
    const claim = await claimFor(world, second);

    const res = await setupGet(makeEnv(world.db), `installation_id=${INSTALLATION}&setup_action=install`);

    expect(res.status).toBe(409);
    expect(await res.text()).toBe("installation already bound");
    // The batch rolled back: the claim is still live for another attempt.
    expect(claimRow(world.db, claim.id)?.consumed_at).toBeNull();
    expect(targetBinding(world.db, second).installation_id).toBeNull();
  });

  test("a bot unshared between claim and callback answers 409 bot is not shared and binds nothing", async () => {
    const world = await seededWorld();
    const claim = await claimFor(world, world.targetId);
    world.db.raw.prepare("UPDATE review_bots SET scope = 'owned' WHERE id = ?").run(world.botId);

    const res = await setupGet(makeEnv(world.db), `installation_id=${INSTALLATION}&setup_action=install`);

    expect(res.status).toBe(409);
    expect(await res.text()).toBe("bot is not shared");
    expect(claimRow(world.db, claim.id)?.consumed_at).toBeNull();
    expect(installationCount(world.db)).toBe(0);
  });
});
