/**
 * Plan 29 QC W-2: dashboard POST mutations honor Accept + SPA postForm marker.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import worker from "../../src/worker/index";
import { createAppsStore } from "../../src/dashboard/apps-store";
import { createSecretbox } from "../../src/dashboard/secretbox";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createUser, type DashboardD1 } from "../../src/dashboard/users";
import { SPA_POST_FORM_HEADER, SPA_POST_FORM_VALUE } from "../../src/spa/post-form-headers";
import type { Env } from "../../src/worker/env";
import { createTestD1 } from "../store/helpers";

const SESSION_SECRET = "test-dashboard-session-secret-32-bytes!";
const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

function createD1(): ReturnType<typeof createTestD1> {
  const db = createTestD1();
  for (const name of [
    "0003_dashboard_users.sql",
    "0004_github_apps.sql",
    "0006_app_provider_config.sql",
    "0008_github_apps_ops.sql",
    "0009_app_model_roles.sql",
    "0012_custom_providers_and_key_updated_at.sql",
  ]) {
    db.raw.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
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

async function seed(db: DashboardD1): Promise<void> {
  await createUser(db, { login: "octocat", role: "admin" });
  const id = crypto.randomUUID();
  const enc = await encryptedColumns(id);
  await createAppsStore(db).createApp({
    id,
    slug: "demo-app",
    githubAppId: 42,
    name: "demo-app",
    createdBy: "octocat",
    privateKeyEnc: enc.privateKeyEnc,
    webhookSecretEnc: enc.webhookSecretEnc,
  });
}

function makeEnv(db: unknown): Env {
  return {
    GITHUB_OAUTH_CLIENT_ID: "id",
    GITHUB_OAUTH_CLIENT_SECRET: "secret",
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

describe("POST mutation Accept routing (plan 29 QC W-2)", () => {
  test("default Accept keeps plain-text ok for SPA fetch-style POST", async () => {
    const db = createD1();
    await seed(db);
    const env = makeEnv(db);
    const res = await postMutation("/dashboard/apps/demo-app/pause", env, await cookie("octocat"));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("Accept: text/html redirects to /dashboard for apps actions", async () => {
    const db = createD1();
    await seed(db);
    const env = makeEnv(db);
    const res = await postMutation("/dashboard/apps/demo-app/pause", env, await cookie("octocat"), {
      Accept: "text/html",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard");
  });

  test("SPA postForm marker keeps plain-text even with Accept: text/html", async () => {
    const db = createD1();
    await seed(db);
    const env = makeEnv(db);
    const res = await postMutation("/dashboard/apps/demo-app/pause", env, await cookie("octocat"), {
      Accept: "text/html",
      [SPA_POST_FORM_HEADER]: SPA_POST_FORM_VALUE,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("HTML-nav pause from settings Referer redirects to the SPA settings URL", async () => {
    const db = createD1();
    await seed(db);
    const env = makeEnv(db);
    const res = await postMutation("/dashboard/apps/demo-app/pause", env, await cookie("octocat"), {
      Accept: "text/html",
      Referer: "https://worker.local/dashboard/apps/demo-app/settings",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/apps/demo-app/settings");
  });

  test("HTML-nav resume from settings Referer redirects to the SPA settings URL", async () => {
    const db = createD1();
    await seed(db);
    const env = makeEnv(db);
    const cookieHeader = await cookie("octocat");
    const paused = await postMutation("/dashboard/apps/demo-app/pause", env, cookieHeader);
    expect(paused.status).toBe(200);
    const res = await postMutation("/dashboard/apps/demo-app/resume", env, cookieHeader, {
      Accept: "text/html",
      Referer: "https://worker.local/dashboard/apps/demo-app/settings",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/apps/demo-app/settings");
  });

  test("HTML-nav pause with apps-list Referer redirects to /dashboard/apps", async () => {
    const db = createD1();
    await seed(db);
    const env = makeEnv(db);
    const res = await postMutation("/dashboard/apps/demo-app/pause", env, await cookie("octocat"), {
      Accept: "text/html",
      Referer: "https://worker.local/dashboard/apps",
    });
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/apps");
  });

  test("SPA fetch pause with settings Referer keeps plain-text", async () => {
    const db = createD1();
    await seed(db);
    const env = makeEnv(db);
    const res = await postMutation("/dashboard/apps/demo-app/pause", env, await cookie("octocat"), {
      Accept: "text/html",
      Referer: "https://worker.local/dashboard/apps/demo-app/settings",
      [SPA_POST_FORM_HEADER]: SPA_POST_FORM_VALUE,
    });
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  test("settings POST with Accept: text/html redirects to the SPA settings URL", async () => {
    const db = createD1();
    await seed(db);
    const env = makeEnv(db);
    const res = await worker.fetch(
      new Request("https://worker.local/dashboard/apps/demo-app/settings", {
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
    expect(res.headers.get("Location")).toBe("/dashboard/apps/demo-app/settings");
  });
});
