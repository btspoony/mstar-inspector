/**
 * The list endpoints carry the operator profile's Credits rate, so the SPA
 * divides both month columns by the REAL rate instead of a hardcoded 1,000.
 * The field is omitted — never 0, never a fabricated rate — when the profile
 * is unreadable, and the reader then falls back to the documented rate.
 */
import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import { createReviewBotsStore } from "../../src/dashboard/apps-store";
import { createSecretbox } from "../../src/dashboard/secretbox";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createUser } from "../../src/dashboard/users";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import { OAUTH_CLIENT_SECRET } from "../helpers/fake-secrets";
import type { Env } from "../../src/worker/env";

const SESSION_SECRET = ["test", "list", "credits", "session", "secret-32"].join("-");
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const WORKSPACE = "default";
const APP_ID = "app-credits";
const GITHUB_APP_ID = 8611;

function makeEnv(db: TestD1): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} } as unknown as Env["REVIEW_QUEUE"],
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} } as unknown as Env["IDEMPOTENCY_KV"],
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: OAUTH_CLIENT_SECRET,
    DEPLOYMENT_MODE: "saas",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DASHBOARD_ENCRYPTION_KEY: TEST_KEY,
    DB: db,
  } as unknown as Env;
}

async function world(): Promise<TestD1> {
  const db = createMigratedTestD1();
  await createUser(db, { login: "dana", role: "member" });
  db.raw
    .prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
       SELECT ?, id, 'owner', '2026-01-01T00:00:00.000Z' FROM users WHERE github_login = 'dana'`,
    )
    .run(WORKSPACE);
  const box = createSecretbox(TEST_KEY);
  await createReviewBotsStore(db).createApp({
    id: APP_ID,
    githubSlug: "app-credits",
    githubAppId: GITHUB_APP_ID,
    name: "app-credits",
    privateKeyEnc: await box.encryptSecret("pem", `github_apps.private_key_enc:${APP_ID}`),
    webhookSecretEnc: await box.encryptSecret("secret", `github_apps.webhook_secret_enc:${APP_ID}`),
    createdBy: "dana",
    workspaceId: WORKSPACE,
    maxApps: null,
  });
  return db;
}

async function get(db: TestD1, path: string): Promise<Response> {
  const cookie = await createSessionValue("dana", null, SESSION_SECRET);
  return worker.fetch(
    new Request(`https://worker.local${path}`, { headers: { Cookie: `${SESSION_COOKIE}=${cookie}` } }),
    makeEnv(db),
  );
}

/** The profile in force, read the same way the route's reader does. */
function profileRate(db: TestD1): number {
  const row = db.raw
    .query(
      `SELECT rp_per_credit FROM quota_profiles
        WHERE effective_from <= ? ORDER BY effective_from DESC LIMIT 1`,
    )
    .get(new Date().toISOString()) as { rp_per_credit: number };
  return row.rp_per_credit;
}

const APPS = `/dashboard/${WORKSPACE}/api/apps`;
const BOTS = `/dashboard/${WORKSPACE}/api/review-bots`;

/** A SHARED bot of another workspace, so this one only consumes it. */
function seedSharedBot(
  db: TestD1,
  id: string,
  workspaceId: string,
  options: { multiplier?: number; monthlyRp?: number | null } = {},
): void {
  db.raw.run(
    `INSERT OR IGNORE INTO workspaces (id, slug, name, created_at)
       VALUES ('${workspaceId}', '${workspaceId}', '${workspaceId}', '2026-01-01T00:00:00.000Z');
     INSERT INTO review_bots
       (id, workspace_id, name, description, scope, sandbox_image_id, multiplier, monthly_rp, created_at, updated_at)
     VALUES ('${id}', '${workspaceId}', '${id}', NULL, 'shared', 'omp', ${options.multiplier ?? 4},
             ${options.monthlyRp === undefined || options.monthlyRp === null ? "NULL" : options.monthlyRp},
             '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');`,
  );
}

/**
 * The plan allowance this workspace resolves to: the seeded `free` ceiling of
 * the profile in force (it holds no subscription row, so `free` is its plan).
 */
function planCeiling(db: TestD1): number | null {
  const row = db.raw
    .query(
      `SELECT q.monthly_rp AS monthlyRp
         FROM quota_profile_plans q
        WHERE q.profile_id = (SELECT p.id FROM quota_profiles p
                               WHERE p.effective_from <= ? ORDER BY p.effective_from DESC LIMIT 1)`,
    )
    .get(new Date().toISOString()) as { monthlyRp: number | null } | null;
  return row?.monthlyRp ?? null;
}

/**
 * The directory's ceiling column is the BOT's enforced ceiling, never the
 * workspace plan's: a bot capped below the plan must not read as the plan, and
 * an override for this workspace must win over the bot's own default.
 */
describe("the bot list serves each row's effective ceiling", () => {
  test("a bot default below the plan is served as the row's ceiling, distinct from the plan", async () => {
    const db = await world();
    const plan = planCeiling(db);
    expect(plan).not.toBeNull();
    seedSharedBot(db, "bot-capped", "ws-provider", { monthlyRp: 3000 });

    const body = (await (await get(db, BOTS)).json()) as {
      plan_monthly_rp: number | null;
      bots: Array<{ id: string; effective_ceiling: number | null; monthly_rp?: number }>;
    };
    expect(body.plan_monthly_rp).toBe(plan);
    const row = body.bots.find((bot) => bot.id === "bot-capped")!;
    expect(row.effective_ceiling).toBe(3000);
    expect(row.effective_ceiling).not.toBe(plan);
    // The owner's raw default never rides the row — only the viewer's ceiling.
    expect(row).not.toHaveProperty("monthly_rp");
  });

  test("this workspace's override wins over the bot default, and an unlimited bot reads null", async () => {
    const db = await world();
    seedSharedBot(db, "bot-overridden", "ws-provider", { monthlyRp: 3000 });
    seedSharedBot(db, "bot-open", "ws-provider", { monthlyRp: null });
    db.raw.run(
      `INSERT INTO bot_quota_overrides (bot_id, workspace_id, monthly_rp, updated_at)
         VALUES ('bot-overridden', '${WORKSPACE}', 7000, '2026-01-01T00:00:00.000Z')`,
    );

    const body = (await (await get(db, BOTS)).json()) as {
      bots: Array<{ id: string; effective_ceiling: number | null }>;
    };
    expect(body.bots.find((bot) => bot.id === "bot-overridden")!.effective_ceiling).toBe(7000);
    expect(body.bots.find((bot) => bot.id === "bot-open")!.effective_ceiling).toBeNull();
  });

  test("another workspace's override never reaches this viewer", async () => {
    const db = await world();
    seedSharedBot(db, "bot-scoped", "ws-provider", { monthlyRp: 3000 });
    db.raw.run(
      `INSERT INTO bot_quota_overrides (bot_id, workspace_id, monthly_rp, updated_at)
         VALUES ('bot-scoped', 'ws-provider', 9000, '2026-01-01T00:00:00.000Z')`,
    );

    const body = (await (await get(db, BOTS)).json()) as {
      bots: Array<{ id: string; effective_ceiling: number | null }>;
    };
    expect(body.bots.find((bot) => bot.id === "bot-scoped")!.effective_ceiling).toBe(3000);
  });
});

describe("list payloads carry the real Credits rate", () => {
  test("both lists serve the profile in force's rate", async () => {
    const db = await world();
    const expected = profileRate(db);
    expect(expected).toBeGreaterThan(0);

    const apps = (await (await get(db, APPS)).json()) as Record<string, unknown>;
    expect(apps.rp_per_credit).toBe(expected);

    const bots = (await (await get(db, BOTS)).json()) as Record<string, unknown>;
    expect(bots.rp_per_credit).toBe(expected);
  });

  test("a non-default rate is served as-is, not normalised to 1,000", async () => {
    const db = await world();
    db.raw.run(`UPDATE quota_profiles SET rp_per_credit = 2000`);

    const apps = (await (await get(db, APPS)).json()) as Record<string, unknown>;
    expect(apps.rp_per_credit).toBe(2000);
    const bots = (await (await get(db, BOTS)).json()) as Record<string, unknown>;
    expect(bots.rp_per_credit).toBe(2000);
  });

  test("an empty quota_profiles table still answers 200 and omits the rate", async () => {
    const db = await world();
    // The bindings and plan ceilings reference the profiles, so they go first.
    db.raw.run(
      `DELETE FROM workspace_quota_binding;
       DELETE FROM quota_profile_plans;
       DELETE FROM quota_profiles;`,
    );

    for (const path of [APPS, BOTS]) {
      const res = await get(db, path);
      expect(res.status).toBe(200);
      const body = (await res.json()) as Record<string, unknown>;
      // Absent, never 0 — a 0 rate would divide by zero downstream.
      expect("rp_per_credit" in body).toBe(false);
    }
  });
});

describe("the bind route admits an orphan pending shared App", () => {
  const INSTALLATION = 7712;

  /** A SHARED App of another workspace, installed here but never bound. */
  async function orphanWorld(): Promise<{ db: TestD1; app: string }> {
    const db = await world();
    // The App belongs to another workspace, so this one holds no install state
    // and no target — exactly the orphan the list still shows as pending.
    db.raw.run(
      `INSERT INTO workspaces (id, slug, name, created_at)
         VALUES ('ws-provider', 'provider', 'Provider', '2026-01-01T00:00:00.000Z');
       UPDATE app_workspaces SET workspace_id = 'ws-provider' WHERE app_id = '${APP_ID}';
       UPDATE github_apps SET scope = 'shared' WHERE id = '${APP_ID}';
       DELETE FROM app_install_bots WHERE github_app_id = '${APP_ID}';
       DELETE FROM review_targets WHERE app_id = '${APP_ID}';
       DELETE FROM app_installations WHERE github_app_id = '${APP_ID}';`,
    );
    const app = createReviewBotsStore(db);
    await app.upsertInstallation({
      appId: APP_ID,
      installationId: INSTALLATION,
      accountLogin: "acme-org",
      authoritative: true,
    });
    return { db, app: APP_ID };
  }

  test("a pending installation of an unbound shared App binds instead of 404ing", async () => {
    const { db } = await orphanWorld();
    const cookie = await createSessionValue("dana", null, SESSION_SECRET);
    const res = await worker.fetch(
      new Request(`https://worker.local/dashboard/${WORKSPACE}/api/apps/${GITHUB_APP_ID}/bind-installation`, {
        method: "POST",
        headers: {
          Cookie: `${SESSION_COOKIE}=${cookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ installationId: String(INSTALLATION) }).toString(),
      }),
      makeEnv(db),
    );
    // The flow continues into the authorize step rather than "unknown app".
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.bound).toBe(false);
    expect(typeof body.authorize_url).toBe("string");
  });

  test("the same App with no pending row of that id is still unknown", async () => {
    const { db } = await orphanWorld();
    const cookie = await createSessionValue("dana", null, SESSION_SECRET);
    const res = await worker.fetch(
      new Request(`https://worker.local/dashboard/${WORKSPACE}/api/apps/${GITHUB_APP_ID}/bind-installation`, {
        method: "POST",
        headers: {
          Cookie: `${SESSION_COOKIE}=${cookie}`,
          "Content-Type": "application/x-www-form-urlencoded",
        },
        body: new URLSearchParams({ installationId: "999999" }).toString(),
      }),
      makeEnv(db),
    );
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown app" });
  });
});
