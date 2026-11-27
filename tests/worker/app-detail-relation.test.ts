import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import { createSecretbox } from "../../src/dashboard/secretbox";
import type { Env } from "../../src/worker/env";
import { createReviewBotsStore } from "../../src/dashboard/apps-store";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createUser } from "../../src/dashboard/users";
import { createMigratedTestD1, seedTarget, type TestD1 } from "../store/helpers";
import { OAUTH_CLIENT_SECRET } from "../helpers/fake-secrets";

const SESSION_SECRET = ["test", "relation", "session", "secret", "32-bytes!"].join("-");
const TEST_KEY = Buffer.alloc(32, 5).toString("base64");

const OWNER_WS = "default";
const TENANT_WS = "ws-tenant";
/** The numeric GitHub App id the URL segment names. */
const GITHUB_APP_ID = 7301;
const APP_ID = "app-relation";

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

async function get(db: TestD1, path: string, login: string): Promise<Response> {
  const cookie = await createSessionValue(login, null, SESSION_SECRET);
  return worker.fetch(
    new Request(`https://worker.local${path}`, { headers: { Cookie: `${SESSION_COOKIE}=${cookie}` } }),
    makeEnv(db),
  );
}

async function seedMembership(
  db: TestD1,
  workspaceId: string,
  login: string,
  role: "owner" | "admin" | "member",
): Promise<void> {
  if (workspaceId !== OWNER_WS) {
    db.raw
      .prepare(
        "INSERT OR IGNORE INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')",
      )
      .run(workspaceId, workspaceId, workspaceId);
  }
  await createUser(db, { login, role: "member" });
  db.raw
    .prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
       SELECT ?, id, ?, '2026-01-01T00:00:00.000Z' FROM users WHERE github_login = ?`,
    )
    .run(workspaceId, role, login);
}

/**
 * The App `default` created, plus (optionally) the tenant's install state, its
 * one mounted chain row and the live target that makes the App scoped-visible
 * there — the same rows `bindInstallation` and `replaceInstallChain` write.
 */
async function world(): Promise<TestD1> {
  const db = createMigratedTestD1();
  await seedMembership(db, OWNER_WS, "dana", "owner");
  await seedMembership(db, TENANT_WS, "carol", "admin");
  await seedMembership(db, TENANT_WS, "mallory", "member");

  const box = createSecretbox(TEST_KEY);
  await createReviewBotsStore(db).createApp({
    id: APP_ID,
    githubSlug: "app-relation",
    githubAppId: GITHUB_APP_ID,
    name: "app-relation",
    privateKeyEnc: await box.encryptSecret("pem", `github_apps.private_key_enc:${APP_ID}`),
    webhookSecretEnc: await box.encryptSecret("secret", `github_apps.webhook_secret_enc:${APP_ID}`),
    createdBy: "dana",
    workspaceId: OWNER_WS,
    maxApps: null,
  });
  // The App is shared so the tenant may consume it; `createApp` wrote the
  // creator's own install state already.
  db.raw.run(`UPDATE review_bots SET scope = 'shared' WHERE id = '${APP_ID}'`);
  db.raw.run(
    `INSERT INTO app_installations (github_app_id, workspace_id, created_at)
     VALUES ('${APP_ID}', '${TENANT_WS}', '2026-01-01T00:00:00.000Z');
     INSERT INTO app_install_bots (github_app_id, workspace_id, position, bot_id)
     VALUES ('${APP_ID}', '${TENANT_WS}', 1, '${APP_ID}');`,
  );
  seedTarget(db, APP_ID, { workspaceId: TENANT_WS, id: "target-tenant" });
  return db;
}

const DETAIL = `/dashboard/${OWNER_WS}/api/apps/${GITHUB_APP_ID}`;
const TENANT_DETAIL = `/dashboard/${TENANT_WS}/api/apps/${GITHUB_APP_ID}`;
const TENANT_LIST = `/dashboard/${TENANT_WS}/api/apps`;

/** The profile in force, read the way the credit block reads it. */
function profileRow(db: TestD1): { rp_per_credit: number } {
  const at = new Date().toISOString();
  return db.raw
    .query(
      `SELECT rp_per_credit FROM quota_profiles
        WHERE effective_from <= ? ORDER BY effective_from DESC LIMIT 1`,
    )
    .get(at) as { rp_per_credit: number };
}

describe("GET /api/apps/:appId — viewer_relation", () => {
  test("an owner that also holds install state reads both", async () => {
    const body = (await (await get(await world(), DETAIL, "dana")).json()) as Record<string, unknown>;
    expect(body.can_manage).toBe(true);
    expect(body.viewer_relation).toBe("both");
  });

  test("an owner with no install-state row reads created", async () => {
    const db = await world();
    // The chain rows reference the install state, so they go first.
    db.raw.run(
      `DELETE FROM app_install_bots WHERE github_app_id = '${APP_ID}' AND workspace_id = '${OWNER_WS}';
       DELETE FROM app_installations WHERE github_app_id = '${APP_ID}' AND workspace_id = '${OWNER_WS}';`,
    );
    const body = (await (await get(db, DETAIL, "dana")).json()) as Record<string, unknown>;
    expect(body.viewer_relation).toBe("created");
  });

  test("a consumer reads installed on the non-manager shape", async () => {
    const body = (await (await get(await world(), TENANT_DETAIL, "mallory")).json()) as Record<
      string,
      unknown
    >;
    // The role split still decides the shape; the relation is a separate fact.
    expect(body.can_manage).toBe(false);
    expect(body.viewer_relation).toBe("installed");
  });

  test("a blocked manager still reads relation and credits rate", async () => {
    const db = await world();
    // A manager whose workspace holds the App through a target but does not
    // own it is the blocked face — it must still answer the two facts.
    db.raw.run(`UPDATE github_apps SET scope = 'owned' WHERE id = '${APP_ID}'`);
    const body = (await (await get(db, TENANT_DETAIL, "carol")).json()) as Record<string, unknown>;
    expect(body.can_manage).toBe(true);
    expect(body.blocked).toBe(true);
    expect(body.blocked_reason).toBe("bot_not_shared");
    expect(body.viewer_relation).toBe("installed");
    expect(body.rp_per_credit).toBe(profileRow(db).rp_per_credit);
  });
});

describe("GET /api/apps/:appId — rp_per_credit", () => {
  test("both manager shapes resolve the profile in force's rate", async () => {
    const db = await world();
    const expected = profileRow(db).rp_per_credit;
    expect(expected).toBeGreaterThan(0);

    const owner = (await (await get(db, DETAIL, "dana")).json()) as Record<string, unknown>;
    expect(owner.rp_per_credit).toBe(expected);

    const consumer = (await (await get(db, TENANT_DETAIL, "mallory")).json()) as Record<string, unknown>;
    expect(consumer.rp_per_credit).toBe(expected);
  });

  test("an empty quota_profiles table omits the rate instead of failing the read", async () => {
    const db = await world();
    // The bindings and the plan ceilings reference the profiles, so they go
    // first; the table then holds no version at all.
    db.raw.run(
      `DELETE FROM workspace_quota_binding;
       DELETE FROM quota_profile_plans;
       DELETE FROM quota_profiles;`,
    );

    const owner = await get(db, DETAIL, "dana");
    expect(owner.status).toBe(200);
    const body = (await owner.json()) as Record<string, unknown>;
    expect(body.viewer_relation).toBe("both");
    expect("rp_per_credit" in body).toBe(false);

    const consumer = await get(db, TENANT_DETAIL, "mallory");
    expect(consumer.status).toBe(200);
    expect("rp_per_credit" in ((await consumer.json()) as Record<string, unknown>)).toBe(false);
  });
});

describe("GET /api/apps/:appId — visibility follows the install state", () => {
  test("an installer with no live target resolves the App", async () => {
    const db = await world();
    // The installed face exists for exactly this viewer: install state, no
    // target. The scoped resolve must admit it.
    db.raw.run(`DELETE FROM review_targets WHERE workspace_id = '${TENANT_WS}'`);

    const res = await get(db, TENANT_DETAIL, "mallory");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.viewer_relation).toBe("installed");
  });

  test("a live target without install state reads installed, but claims no installation", async () => {
    const db = await world();
    // The reverse edge: the target admits the App and is itself a use relation,
    // so the face is `installed` — while the list's `installed` boolean stays
    // the installation fact and reads false.
    db.raw.run(
      `DELETE FROM app_install_bots WHERE github_app_id = '${APP_ID}' AND workspace_id = '${TENANT_WS}';
       DELETE FROM app_installations WHERE github_app_id = '${APP_ID}' AND workspace_id = '${TENANT_WS}';`,
    );

    const res = await get(db, TENANT_DETAIL, "mallory");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.can_manage).toBe(false);
    expect(body.viewer_relation).toBe("installed");

    // The list's membership IS the install state (D43), so this viewer's App
    // is absent there — the false the relation must not blur.
    const list = (await (await get(db, TENANT_LIST, "mallory")).json()) as {
      apps: Array<{ bot_id: string }>;
    };
    expect(list.apps.some((app) => app.bot_id === APP_ID)).toBe(false);
  });

  test("an owner reaching the App through a target but no install row reads both", async () => {
    const db = await world();
    db.raw.run(
      `DELETE FROM app_install_bots WHERE github_app_id = '${APP_ID}' AND workspace_id = '${OWNER_WS}';
       DELETE FROM app_installations WHERE github_app_id = '${APP_ID}' AND workspace_id = '${OWNER_WS}';`,
    );
    seedTarget(db, APP_ID, { workspaceId: OWNER_WS, id: "target-owner" });

    const body = (await (await get(db, DETAIL, "dana")).json()) as Record<string, unknown>;
    expect(body.can_manage).toBe(true);
    expect(body.viewer_relation).toBe("both");

    // The relation counts the target; the list's `installed` does not — it is
    // the installation fact alone.
    const list = (await (await get(db, `/dashboard/${OWNER_WS}/api/apps`, "dana")).json()) as {
      apps: Array<{ bot_id: string; installed: boolean }>;
    };
    expect(list.apps.find((app) => app.bot_id === APP_ID)?.installed).toBe(false);
  });
});

describe("chain rows carry archived", () => {
  test("a live chain row reads archived: false, and a consumer sees the same fact", async () => {
    const db = await world();
    const body = (await (await get(db, TENANT_DETAIL, "mallory")).json()) as {
      chain: Array<Record<string, unknown>>;
    };
    expect(body.chain.map((row) => row.archived)).toEqual([false]);
  });

  test("an archived bot stays mounted and listed, with archived: true, on detail and list", async () => {
    const db = await world();
    db.raw.run(`UPDATE review_bots SET archived_at = '2026-02-01T00:00:00.000Z' WHERE id = '${APP_ID}'`);

    const detail = (await (await get(db, TENANT_DETAIL, "mallory")).json()) as {
      chain: Array<Record<string, unknown>>;
    };
    expect(detail.chain.map((row) => row.bot_id)).toEqual([APP_ID]);
    expect(detail.chain.map((row) => row.archived)).toEqual([true]);

    const list = (await (await get(db, TENANT_LIST, "mallory")).json()) as {
      apps: Array<{ bot_id: string; chain: Array<Record<string, unknown>> }>;
    };
    const row = list.apps.find((app) => app.bot_id === APP_ID)!;
    expect(row.chain.map((entry) => entry.archived)).toEqual([true]);
  });
});
