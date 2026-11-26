import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import worker from "../../src/worker/index";
import { createReviewBotsStore } from "../../src/dashboard/apps-store";
import { createSecretbox } from "../../src/dashboard/secretbox";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createUser, type DashboardD1 } from "../../src/dashboard/users";
import type { Env } from "../../src/worker/env";
import { createTestD1, applyMigration as applyMigrationShared, migrationsAfter } from "../store/helpers";

const SESSION_SECRET = ["test", "dashboard", "session", "secret", "32-bytes!"].join("-");
const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const DEMO_APP_ID = 42;
const DEMO_BOT_ID = "demo-app-bot";

function createD1(): ReturnType<typeof createTestD1> {
  // The PRODUCTION chain: the hand-kept prefix stopped in the bot era, and the
  // read faces these tests exercise are post-split. migrationsAfter sorts
  // numerically, which is dependency order.
  const db = createTestD1();
  applyMigrationShared(db.raw, migrationsAfter(2));
  return db;
}

async function encryptedColumns(id: string): Promise<{ privateKeyEnc: string; webhookSecretEnc: string }> {
  const box = createSecretbox(TEST_KEY);
  return {
    privateKeyEnc: await box.encryptSecret("test-pem", `github_apps.private_key_enc:${id}`),
    webhookSecretEnc: await box.encryptSecret("secret", `github_apps.webhook_secret_enc:${id}`),
  };
}

async function seed(db: ReturnType<typeof createD1>): Promise<void> {
  await createUser(db, { login: "octocat", role: "admin" });
  db.raw
    .prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
       SELECT 'default', id, 'owner', '2026-01-01T00:00:00.000Z' FROM users WHERE github_login = 'octocat'`,
    )
    .run();
  const id = DEMO_BOT_ID;
  const enc = await encryptedColumns(id);
  await createReviewBotsStore(db).createApp({
    id,
    githubSlug: "demo-app",
    githubAppId: DEMO_APP_ID,
    name: "demo-app",
    createdBy: "octocat",
    privateKeyEnc: enc.privateKeyEnc,
    webhookSecretEnc: enc.webhookSecretEnc,
    workspaceId: "default",
    maxApps: null,
  });
}

function makeEnv(db: unknown): Env {
  return {
    GITHUB_OAUTH_CLIENT_ID: "id",
    GITHUB_OAUTH_CLIENT_SECRET: "secret",
    DEPLOYMENT_MODE: "self-hosted",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DASHBOARD_ENCRYPTION_KEY: TEST_KEY,
    DB: db,
  } as Env;
}

async function cookie(login: string): Promise<string> {
  return `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}`;
}

async function postMutation(
  path: string,
  env: Env,
  cookieHeader: string,
  headers: Record<string, string> = {},
): Promise<Response> {
  return worker.fetch(
    new Request(`https://worker.local${path}`, {
      method: "POST",
      headers: { Cookie: cookieHeader, ...headers },
    }),
    env,
  );
}

describe("POST mutation Accept routing (QC W-2)", () => {
  test("settings POST with Accept: text/html redirects to the target URL", async () => {
    const db = createD1();
    await seed(db);
    const env = makeEnv(db);
    const res = await worker.fetch(
      new Request(`https://worker.local/dashboard/default/review-bots/${DEMO_BOT_ID}/settings`, {
        method: "POST",
        headers: {
          Cookie: await cookie("octocat"),
          Accept: "text/html",
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ op: "save-chain", model_chain: "anthropic/claude" }).toString(),
      }),
      env,
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/default/repos");
  });
});
