import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import { createSecretbox } from "../../src/dashboard/secretbox";
import type { Env } from "../../src/worker/env";
import { createReviewBotsStore } from "../../src/dashboard/apps-store";
import { createTargetsStore } from "../../src/dashboard/targets-store";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createUser, type DashboardD1 } from "../../src/dashboard/users";
import { applyMigrations, APPS_UI_MIGRATIONS } from "../helpers/migration-shapes";
import { createTestD1 } from "../store/helpers";
import { OAUTH_CLIENT_SECRET } from "../helpers/fake-secrets";

const SESSION_SECRET = ["test", "chain", "route", "session", "32-bytes!"].join("-");
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const GH_APP_ID = 4242;

function makeEnv(db: unknown): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} } as unknown as Env["REVIEW_QUEUE"],
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} } as unknown as Env["IDEMPOTENCY_KV"],
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: OAUTH_CLIENT_SECRET,
    DEPLOYMENT_MODE: "self-hosted",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DASHBOARD_ENCRYPTION_KEY: TEST_KEY,
    DB: db,
  } as Env;
}

const cookie = (login: string) => createSessionValue(login, null, SESSION_SECRET);

async function patch(path: string, login: string, env: Env, body: unknown): Promise<Response> {
  return worker.fetch(
    new Request(`https://worker.local${path}`, {
      method: "PATCH",
      headers: { Cookie: `${SESSION_COOKIE}=${await cookie(login)}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }),
    env,
  );
}

/**
 * A real App row: the URL segment is its NUMERIC GitHub App id, while
 * `app_installations.github_app_id` holds the INTERNAL row id. A route that
 * forgets to resolve one to the other answers 404 on every call — which is
 * exactly what the mocked component test could not see.
 */
async function world(): Promise<{ db: ReturnType<typeof createTestD1>; internalId: string }> {
  const db = createTestD1();
  applyMigrations(db, APPS_UI_MIGRATIONS);
  await createUser(db as DashboardD1, { login: "octocat", role: "admin" });
  db.raw
    .prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
       SELECT 'default', id, 'owner', '2026-01-01T00:00:00.000Z' FROM users`,
    )
    .run();

  const internalId = "app-internal-1";
  const box = createSecretbox(TEST_KEY);
  await createReviewBotsStore(db as DashboardD1).createApp({
    id: internalId,
    githubSlug: "chain-app",
    githubAppId: GH_APP_ID,
    name: "chain-app",
    privateKeyEnc: await box.encryptSecret("pem", `github_apps.private_key_enc:${internalId}`),
    webhookSecretEnc: await box.encryptSecret("whsec", `github_apps.webhook_secret_enc:${internalId}`),
    createdBy: "octocat",
    workspaceId: "default",
    maxApps: null,
  });
  await createTargetsStore(db as DashboardD1).create({
    workspaceId: "default",
    botId: internalId,
    repoId: 9001,
    repoOwner: "acme",
    repoName: "widgets",
    createdBy: "octocat",
  });
  return { db, internalId };
}

describe("PATCH /api/apps/:appId/chain", () => {
  test("the NUMERIC GitHub App id in the URL resolves to the row the store writes", async () => {
    const { db, internalId } = await world();
    // The owner's own chain starts with the App's bot (createApp wrote it).
    db.raw
      .prepare("INSERT OR IGNORE INTO review_bots (id, workspace_id, name, multiplier, created_at, updated_at) VALUES ('bot-extra', 'default', 'bot-extra', 1, datetime('now'), datetime('now'))")
      .run();

    const res = await patch(`/dashboard/default/api/apps/${GH_APP_ID}/chain`, "octocat", makeEnv(db), {
      botIds: ["bot-extra", internalId],
    });

    // NOT a mock: the route's own answer, from the store's write.
    expect(res.status).toBe(200);
    const body = (await res.json()) as { chain: Array<{ position: number; bot_id: string }> };
    expect(body.chain.map((row) => row.bot_id)).toEqual(["bot-extra", internalId]);
    expect(
      db.raw
        .query("SELECT position, bot_id FROM app_install_bots WHERE github_app_id = ? ORDER BY position")
        .all(internalId),
    ).toEqual([
      { position: 1, bot_id: "bot-extra" },
      { position: 2, bot_id: internalId },
    ]);
    db.raw.close();
  });

  test("an unknown numeric id is 404 and writes nothing", async () => {
    const { db } = await world();
    const before = db.raw.query("SELECT COUNT(*) AS n FROM app_install_bots").get();
    const res = await patch(`/dashboard/default/api/apps/999999/chain`, "octocat", makeEnv(db), { botIds: [] });
    expect(res.status).toBe(404);
    expect(db.raw.query("SELECT COUNT(*) AS n FROM app_install_bots").get()).toEqual(before);
    db.raw.close();
  });
});
