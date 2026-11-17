/**
 * QC W-2: dashboard POST mutations honor Accept + SPA postForm marker.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import worker from "../../src/worker/index";
import { createReviewBotsStore } from "../../src/dashboard/apps-store";
import { createSecretbox } from "../../src/dashboard/secretbox";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createUser, type DashboardD1 } from "../../src/dashboard/users";
import type { Env } from "../../src/worker/env";
import { createTestD1, execMigrationScript } from "../store/helpers";

const SESSION_SECRET = ["test", "dashboard", "session", "secret", "32-bytes!"].join("-");
const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
/** The App's immutable GitHub App id — the only App address form (D0). */
const DEMO_APP_ID = 42;

function createD1(): ReturnType<typeof createTestD1> {
  const db = createTestD1();
  for (const name of [
    "0003_dashboard_users.sql",
    "0004_github_apps.sql",
    "0006_app_provider_config.sql",
    "0008_github_apps_ops.sql",
    "0009_app_model_roles.sql",
    "0012_custom_providers_and_key_updated_at.sql",
    "0023_removed_logins.sql",
    // 0026: createApp also writes the App's workspace mapping.
    "0026_workspaces.sql",
    // 0028: the SPA boot reads pending invites.
    "0028_workspace_invites.sql",
    // 0036: github_apps.slug → webhook_path plus the cached github_slug.
    "0036_app_identity.sql",
    // 0038 rebuilds github_apps, so the fixture must carry every column the
    // rebuild copies.
    "0018_app_sandbox_images.sql",
    "0019_github_apps_metadata.sql",
    "0022_app_trigger_mode.sql",
    "0037_github_metadata_attempt.sql",
    "0038_webhook_path_drop.sql",
    // 0045: createApp writes the review-gate floor explicitly.
    "0045_review_gate_and_owner_allowlist.sql",
    // This fixture drives the routes through the current store, so its world
    // ends at the rename: 0056 needs every table it alters, plus the two
    // indexes it drops and recreates.
    "0005_reviews_app_id.sql",
    "0007_reviews_app_id_index.sql",
    "0011_webhook_deliveries.sql",
    "0043_webhook_delivery_repository.sql",
    "0039_pull_requests.sql",
    "0020_finding_lifecycle.sql",
    "0021_review_checks.sql",
    "0015_provider_verification.sql",
    "0017_app_model_chains.sql",
    "0024_provider_multi_key.sql",
    "0025_provider_model_evidence.sql",
    // The review configuration lives on `review_targets`, so the fixture needs
    // the installation stamp (0055), the review depth column (0047) and the
    // claim table (0048) that 0057 rewrites.
    "0055_app_installations_removed_at.sql",
    "0047_review_level_per_app.sql",
    "0048_comment_trigger_claims.sql",
    "0056_review_bots_rename.sql",
    "0057_review_targets.sql",
    // 0058: bot-scope authorization reads `review_bots.scope`, so the fixture
    // must carry the column or every bot-scoped write reads it as absent.
    "0058_review_bot_scope.sql",
  ]) {
    execMigrationScript(db.raw, readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  }
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
  const id = crypto.randomUUID();
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
      new Request(`https://worker.local/dashboard/default/apps/${DEMO_APP_ID}/settings`, {
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
    expect(res.headers.get("Location")).toBe(`/dashboard/default/targets/${DEMO_APP_ID}`);
  });
});
