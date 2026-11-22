import { afterEach, describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import { createReviewBotsStore } from "../../src/dashboard/apps-store";
import { createSecretbox } from "../../src/dashboard/secretbox";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createUser } from "../../src/dashboard/users";
import { createMigratedTestD1, seedDefaultMemberships, seedTarget, type TestD1 } from "../store/helpers";
import { testAppPem } from "../helpers/rsa-key";
import type { Env } from "../../src/worker/env";
import { OAUTH_CLIENT_SECRET } from "../helpers/fake-secrets";

const SESSION_SECRET = ["test", "target", "settings", "secret", "32-byte!"].join("-");
const TEST_KEY = Buffer.alloc(32, 9).toString("base64");
const APP_ID = 9501;
const OTHER_WS = "ws-other";

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

async function session(login: string): Promise<Record<string, string>> {
  return {
    Cookie: `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}`,
    Accept: "application/json",
  };
}

const get = (db: TestD1, path: string, login: string): Promise<Response> =>
  session(login).then((headers) =>
    worker.fetch(new Request(`https://worker.local${path}`, { method: "GET", headers }), makeEnv(db)),
  );

const post = (db: TestD1, path: string, login: string, body: unknown): Promise<Response> =>
  session(login).then((headers) =>
    worker.fetch(
      new Request(`https://worker.local${path}`, {
        method: "POST",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      makeEnv(db),
    ),
  );

const put = (db: TestD1, path: string, login: string, body: unknown): Promise<Response> =>
  session(login).then((headers) =>
    worker.fetch(
      new Request(`https://worker.local${path}`, {
        method: "PUT",
        headers: { ...headers, "Content-Type": "application/json" },
        body: JSON.stringify(body),
      }),
      makeEnv(db),
    ),
  );

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

type World = { db: TestD1; botId: string; targetId: string; workspaceId: string };

async function seededWorld(): Promise<World> {
  const db = createMigratedTestD1();
  await createUser(db, { login: "mallory", role: "member" });
  await createUser(db, { login: "trudy", role: "member" });
  seedDefaultMemberships(db, { mallory: "owner", trudy: "member" });
  const id = crypto.randomUUID();
  const box = createSecretbox(TEST_KEY);
  await createReviewBotsStore(db).createApp({
    id,
    githubSlug: "settings-bot",
    githubAppId: APP_ID,
    name: "settings-bot",
    privateKeyEnc: await box.encryptSecret(await testAppPem(), `github_apps.private_key_enc:${id}`),
    webhookSecretEnc: await box.encryptSecret("w", `github_apps.webhook_secret_enc:${id}`),
    createdBy: "mallory",
    workspaceId: "default",
    maxApps: null,
  });
  db.raw
    .prepare(
      `UPDATE workspaces
          SET check_min_score = 45, default_review_trigger_mode = 'open',
              default_review_level = 'deep', default_check_pass_verdicts = '["ship it","blocked"]'
        WHERE id = 'default'`,
    )
    .run();
  const targetId = seedTarget(db, id, {
    workspaceId: "default",
    repoId: 660001,
    repoOwner: "acme",
    repoName: "api",
  });
  db.raw
    .prepare(
      `UPDATE review_targets
          SET follow_workspace_defaults = 1, review_trigger_mode = 'manual',
              review_level = NULL, check_min_score = 90, check_pass_verdicts = '[]'
        WHERE id = ?`,
    )
    .run(targetId);

  db.raw
    .prepare(
      `INSERT INTO workspaces (id, slug, name, created_by, created_at)
       VALUES (?, ?, ?, 'mallory', datetime('now'))`,
    )
    .run(OTHER_WS, OTHER_WS, OTHER_WS);
  db.raw
    .prepare(
      `INSERT INTO review_bots (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
                                 created_by, status, scope, created_at, updated_at)
       VALUES ('bot-other', 'other-bot', 9502, 'other-bot', 'enc', 'enc', 'mallory',
               'active', 'owned', datetime('now'), datetime('now'))`,
    )
    .run();
  db.raw
    .prepare("INSERT INTO bot_workspaces (bot_id, workspace_id) VALUES ('bot-other', ?)")
    .run(OTHER_WS);
  seedTarget(db, "bot-other", {
    workspaceId: OTHER_WS,
    repoId: 660002,
    repoOwner: "other",
    repoName: "repo",
  });
  return { db, botId: id, targetId, workspaceId: "default" };
}

const targetRow = (db: TestD1, id: string) =>
  db.raw.query("SELECT * FROM review_targets WHERE id = ?").get(id) as Record<string, unknown>;


describe("GET /dashboard/:workspaceRef/api/targets/:targetId", () => {
  test("reports the effective settings while inheriting, the row's identity, and the defaults", async () => {
    const { db, targetId, botId } = await seededWorld();

    const res = await get(db, `/dashboard/default/api/targets/${targetId}`, "trudy");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      target: {
        target_id: targetId,
        repo_id: 660001,
        repo_owner: "acme",
        repo_name: "api",
        bot_id: botId,
        app_name: "settings-bot",
        review_enabled: 1,
        follow_workspace_defaults: 1,
        review_drafts: 1,
        app_id: APP_ID,
        app_avatar_url: null,
      },
      effective: {
        trigger_mode: "open",
        review_level: "deep",
        check_min_score: 45,
        check_pass_verdicts: ["ship it", "blocked"],
        check_pass_verdicts_readable: true,
        reviewDrafts: true,
      },
      defaults: {
        trigger_mode: "open",
        review_level: "deep",
        check_min_score: 45,
        check_pass_verdicts: ["ship it", "blocked"],
        check_pass_verdicts_readable: true,
      },
    });
  });

  test("another workspace's target is a 404", async () => {
    const { db, targetId } = await seededWorld();
    db.raw
      .prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
         SELECT ?, id, 'owner', datetime('now') FROM users WHERE github_login = 'trudy'`,
      )
      .run(OTHER_WS);
    const foreign = (
      db.raw
        .query("SELECT id FROM review_targets WHERE workspace_id = ? AND repo_id = 660002")
        .get(OTHER_WS) as { id: string }
    ).id;

    const res = await get(db, `/dashboard/${OTHER_WS}/api/targets/${targetId}`, "trudy");

    expect(res.status).toBe(404);
    expect(foreign).not.toBe(targetId);
  });

  test("a soft-deleted target is a 404", async () => {
    const { db, targetId } = await seededWorld();
    db.raw.prepare("UPDATE review_targets SET deleted_at = datetime('now') WHERE id = ?").run(targetId);

    const res = await get(db, `/dashboard/default/api/targets/${targetId}`, "trudy");

    expect(res.status).toBe(404);
  });
});


describe("GET /dashboard/:workspaceRef/api/targets/all", () => {
  test("answers the workspace defaults and this workspace's live target count", async () => {
    const { db } = await seededWorld();

    const res = await get(db, "/dashboard/default/api/targets/all", "trudy");

    expect(res.status).toBe(200);
    const body = (await res.json()) as { defaults: Record<string, unknown>; target_count: number };
    expect(body.target_count).toBe(1);
    expect(body.defaults).toEqual({
      trigger_mode: "open",
      review_level: "deep",
      check_min_score: 45,
      check_pass_verdicts: ["ship it", "blocked"],
      check_pass_verdicts_readable: true,
    });
  });
});


describe("POST /dashboard/:workspaceRef/api/targets/:targetId", () => {
  test("only a trigger mode on an inheriting target keeps the other three effective values and flips follow to 0", async () => {
    const { db, targetId } = await seededWorld();

    const res = await post(db, `/dashboard/default/api/targets/${targetId}`, "mallory", {
      trigger_mode: "every_push",
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { effective: Record<string, unknown> };
    expect(body.effective).toEqual({
      trigger_mode: "every_push",
      review_level: "deep",
      check_min_score: 45,
      check_pass_verdicts: ["ship it", "blocked"],
      check_pass_verdicts_readable: true,
      reviewDrafts: true,
    });
    expect(targetRow(db, targetId)).toMatchObject({
      follow_workspace_defaults: 0,
      review_trigger_mode: "every_push",
      review_level: "deep",
      check_min_score: 45,
      check_pass_verdicts: '["ship it","blocked"]',
    });
  });

  test("follow 1 sets the flag only and leaves the row's own columns inert", async () => {
    const { db, targetId } = await seededWorld();

    const res = await post(db, `/dashboard/default/api/targets/${targetId}`, "mallory", { follow: 1 });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { target: { follow_workspace_defaults: number } };
    expect(body.target.follow_workspace_defaults).toBe(1);
    expect(targetRow(db, targetId)).toMatchObject({
      follow_workspace_defaults: 1,
      review_trigger_mode: "manual",
      check_min_score: 90,
    });
  });

  test("review_enabled pauses the target without touching its policy", async () => {
    const { db, targetId } = await seededWorld();

    const res = await post(db, `/dashboard/default/api/targets/${targetId}`, "mallory", {
      review_enabled: false,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { target: { review_enabled: number } };
    expect(body.target.review_enabled).toBe(0);
    expect(targetRow(db, targetId)).toMatchObject({
      review_enabled: 0,
      follow_workspace_defaults: 1,
      review_trigger_mode: "manual",
    });
  });

  test("review_enabled accepts the 0|1 wire value and its string form", async () => {
    const { db, targetId } = await seededWorld();

    for (const value of [0, "0"]) {
      await post(db, `/dashboard/default/api/targets/${targetId}`, "mallory", { review_enabled: 1 });
      const res = await post(db, `/dashboard/default/api/targets/${targetId}`, "mallory", {
        review_enabled: value,
      });
      expect(res.status).toBe(200);
      expect((await res.json() as { target: { review_enabled: number } }).target.review_enabled).toBe(0);
    }
    for (const value of [1, "1"]) {
      const res = await post(db, `/dashboard/default/api/targets/${targetId}`, "mallory", {
        review_enabled: value,
      });
      expect(res.status).toBe(200);
      expect((await res.json() as { target: { review_enabled: number } }).target.review_enabled).toBe(1);
    }
    const refused = await post(db, `/dashboard/default/api/targets/${targetId}`, "mallory", {
      review_enabled: 2,
    });
    expect(refused.status).toBe(400);
    expect(targetRow(db, targetId).review_enabled).toBe(1);
  });

  test("a policy save is refused while the effective gate is unreadable", async () => {
    const { db, targetId } = await seededWorld();
    const before = targetRow(db, targetId);
    db.raw.exec("PRAGMA ignore_check_constraints = ON");
    db.raw.prepare("UPDATE workspaces SET default_check_pass_verdicts = 'not json' WHERE id = 'default'").run();
    db.raw.exec("PRAGMA ignore_check_constraints = OFF");

    for (const body of [{ trigger_mode: "manual" }, { check_min_score: 70 }, { follow: 1 }]) {
      const res = await post(db, `/dashboard/default/api/targets/${targetId}`, "mallory", body);
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "review_gate_unreadable" });
    }
    expect(targetRow(db, targetId)).toEqual(before);

    const paused = await post(db, `/dashboard/default/api/targets/${targetId}`, "mallory", {
      review_enabled: 0,
    });
    expect(paused.status).toBe(200);
    expect(targetRow(db, targetId)).toMatchObject({ review_enabled: 0, follow_workspace_defaults: 1 });

    const draft = await post(db, `/dashboard/default/api/targets/${targetId}`, "mallory", {
      review_drafts: false,
    });
    expect(draft.status).toBe(200);
    expect(targetRow(db, targetId)).toMatchObject({ review_drafts: 0, follow_workspace_defaults: 1 });
  });

  test("review_drafts is target-owned: it writes alone, keeps follow, and survives a reload", async () => {
    const { db, targetId } = await seededWorld();

    const res = await post(db, `/dashboard/default/api/targets/${targetId}`, "mallory", {
      review_drafts: false,
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      target: { review_drafts: number; follow_workspace_defaults: number };
      effective: { reviewDrafts: boolean; trigger_mode: string };
    };
    expect(body.target.review_drafts).toBe(0);
    expect(body.target.follow_workspace_defaults).toBe(1);
    expect(body.effective.reviewDrafts).toBe(false);
    expect(body.effective.trigger_mode).toBe("open");
    expect(targetRow(db, targetId)).toMatchObject({
      review_drafts: 0,
      follow_workspace_defaults: 1,
      review_trigger_mode: "manual",
      check_min_score: 90,
    });

    const reloaded = await get(db, `/dashboard/default/api/targets/${targetId}`, "trudy");
    expect(reloaded.status).toBe(200);
    const read = (await reloaded.json()) as {
      target: { review_drafts: number };
      effective: { reviewDrafts: boolean };
    };
    expect(read.target.review_drafts).toBe(0);
    expect(read.effective.reviewDrafts).toBe(false);
  });

  test("a non-boolean review_drafts is a 400 that writes nothing", async () => {
    const { db, targetId } = await seededWorld();
    const before = targetRow(db, targetId);

    for (const value of [0, "0", "false", null]) {
      const res = await post(db, `/dashboard/default/api/targets/${targetId}`, "mallory", {
        review_drafts: value,
      });
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({ error: "invalid review_drafts" });
    }
    expect(targetRow(db, targetId)).toEqual(before);
  });

  test("the draft switch keeps the family's 403 and 404 refusals and writes nothing", async () => {
    const { db, targetId } = await seededWorld();
    const before = targetRow(db, targetId);
    db.raw
      .prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
         SELECT ?, id, 'owner', datetime('now') FROM users WHERE github_login = 'trudy'`,
      )
      .run(OTHER_WS);
    const foreign = (
      db.raw
        .query("SELECT id FROM review_targets WHERE workspace_id = ? AND repo_id = 660002")
        .get(OTHER_WS) as { id: string }
    ).id;

    const refused = await post(db, `/dashboard/default/api/targets/${targetId}`, "trudy", {
      review_drafts: false,
    });
    expect(refused.status).toBe(403);
    const foreignRes = await post(db, `/dashboard/${OTHER_WS}/api/targets/${targetId}`, "trudy", {
      review_drafts: false,
    });
    expect(foreignRes.status).toBe(404);
    expect(targetRow(db, targetId)).toEqual(before);
    expect(targetRow(db, foreign).review_drafts).toBe(1);

    db.raw.prepare("UPDATE review_targets SET deleted_at = datetime('now') WHERE id = ?").run(targetId);
    const deleted = await post(db, `/dashboard/default/api/targets/${targetId}`, "mallory", {
      review_drafts: false,
    });
    expect(deleted.status).toBe(404);
  });

  test("off-vocabulary values are a 400 with nothing written", async () => {
    const { db, targetId } = await seededWorld();
    const before = targetRow(db, targetId);

    for (const body of [
      { trigger_mode: "sometimes" },
      { review_level: "turbo" },
      { check_min_score: 101 },
      { check_pass_verdicts: ["lgtm"] },
    ]) {
      const res = await post(db, `/dashboard/default/api/targets/${targetId}`, "mallory", body);
      expect(res.status).toBe(400);
    }

    expect(targetRow(db, targetId)).toEqual(before);
  });

  test("a plain member is refused and a foreign target is a 404", async () => {
    const { db, targetId } = await seededWorld();

    const refused = await post(db, `/dashboard/default/api/targets/${targetId}`, "trudy", {
      trigger_mode: "open",
    });
    expect(refused.status).toBe(403);

    const missing = await post(db, "/dashboard/default/api/targets/not-a-target", "mallory", {
      trigger_mode: "open",
    });
    expect(missing.status).toBe(404);
    expect(targetRow(db, targetId)).toMatchObject({ follow_workspace_defaults: 1 });
  });
});


describe("POST /dashboard/:workspaceRef/api/targets/defaults", () => {
  test("round-trips every default, including the gate floor", async () => {
    const { db } = await seededWorld();

    const res = await post(db, "/dashboard/default/api/targets/defaults", "mallory", {
      trigger_mode: "manual",
      review_level: null,
      check_min_score: 75,
      check_pass_verdicts: ["ship it"],
    });

    expect(res.status).toBe(200);
    const body = (await res.json()) as { defaults: Record<string, unknown> };
    expect(body.defaults).toEqual({
      trigger_mode: "manual",
      review_level: null,
      check_min_score: 75,
      check_pass_verdicts: ["ship it"],
      check_pass_verdicts_readable: true,
    });

    const read = await get(db, "/dashboard/default/api/targets/all", "trudy");
    expect(((await read.json()) as { defaults: unknown }).defaults).toEqual(body.defaults);
  });

  test("an inheriting target answers the NEW defaults on its next read", async () => {
    const { db, targetId } = await seededWorld();
    await post(db, "/dashboard/default/api/targets/defaults", "mallory", { trigger_mode: "every_push" });

    const res = await get(db, `/dashboard/default/api/targets/${targetId}`, "trudy");

    expect(((await res.json()) as { effective: { trigger_mode: string } }).effective.trigger_mode).toBe(
      "every_push",
    );
  });

  test("off-vocabulary values are a 400 and the defaults stay put", async () => {
    const { db } = await seededWorld();

    for (const body of [{ review_level: "turbo" }, { check_min_score: -1 }, { check_pass_verdicts: ["ok"] }]) {
      const res = await post(db, "/dashboard/default/api/targets/defaults", "mallory", body);
      expect(res.status).toBe(400);
    }

    const read = await get(db, "/dashboard/default/api/targets/all", "trudy");
    expect(((await read.json()) as { defaults: { check_min_score: number } }).defaults.check_min_score).toBe(45);
  });

  test("a plain member is refused and the defaults are untouched", async () => {
    const { db } = await seededWorld();

    const res = await post(db, "/dashboard/default/api/targets/defaults", "trudy", {
      trigger_mode: "manual",
    });

    expect(res.status).toBe(403);
    const read = await get(db, "/dashboard/default/api/targets/all", "trudy");
    expect(((await read.json()) as { defaults: { trigger_mode: string } }).defaults.trigger_mode).toBe("open");
  });

  test("the legacy check-min-score address writes through the same store function", async () => {
    const { db } = await seededWorld();

    const res = await put(db, "/dashboard/default/api/settings/check-min-score", "mallory", { min_score: 70 });

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ min_score: 70 });
    const read = await get(db, "/dashboard/default/api/targets/all", "trudy");
    expect(((await read.json()) as { defaults: { check_min_score: number } }).defaults.check_min_score).toBe(70);
    const audits = db.raw
      .query("SELECT COUNT(*) AS n FROM platform_audit_events WHERE action = 'workspace.check_min_score.set'")
      .get() as { n: number };
    expect(audits.n).toBe(1);
  });
});
