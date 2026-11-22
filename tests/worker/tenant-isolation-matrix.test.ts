import { describe, expect, test } from "bun:test";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import type { Env } from "../../src/worker/env";
import { insertSupportGrant } from "../../src/dashboard/operator-store";
import { createMigratedTestD1, seedTarget, type TestD1 } from "../store/helpers";

const { default: worker } = await import("../../src/worker/index");

const SESSION_SECRET = ["test", "matrix", "session", "secret", "32-bytes!"].join("-");
const TEST_ENCRYPTION_KEY = Buffer.alloc(32, 7).toString("base64");

function envFor(db: TestD1, operators?: string): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} },
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} },
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "oauth-client-secret",
    DEPLOYMENT_MODE: "self-hosted",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DASHBOARD_ENCRYPTION_KEY: TEST_ENCRYPTION_KEY,
    DB: db,
    ...(operators === undefined ? {} : { PLATFORM_OPERATORS: operators }),
  } as unknown as Env;
}

async function request(
  path: string,
  login: string,
  init: { method?: string; body?: string } = {},
): Promise<Request> {
  const session = await createSessionValue(login, null, SESSION_SECRET);
  const headers: Record<string, string> = { Cookie: `${SESSION_COOKIE}=${session}` };
  if (init.body !== undefined) headers["Content-Type"] = "application/x-www-form-urlencoded";
  return new Request(`https://worker.local${path}`, {
    method: init.method ?? "GET",
    headers,
    ...(init.body === undefined ? {} : { body: init.body }),
  });
}

const seed = (db: TestD1, sql: string, ...params: Array<string | number | null>): void => {
  db.raw.prepare(sql).run(...params);
};

function seedUser(db: TestD1, login: string, role: "admin" | "member"): string {
  const id = crypto.randomUUID();
  seed(
    db,
    "INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES (?, ?, ?, ?, NULL)",
    id,
    login,
    role,
    new Date().toISOString(),
  );
  return id;
}

function seedWorkspace(
  db: TestD1,
  id: string,
  slug: string,
  deletedAt: string | null = null,
): void {
  seed(
    db,
    "INSERT INTO workspaces (id, slug, name, created_by, created_at, deleted_at) VALUES (?, ?, ?, NULL, ?, ?)",
    id,
    slug,
    slug,
    new Date().toISOString(),
    deletedAt,
  );
}

function seedMembership(
  db: TestD1,
  workspaceId: string,
  userId: string,
  role: "owner" | "admin" | "member",
): void {
  seed(
    db,
    "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
    workspaceId,
    userId,
    role,
    new Date().toISOString(),
  );
}

const ACME_APP_ID = 5001;
const OTHER_APP_ID = 5002;
const ORPHAN_APP_ID = 5003;
const GONE_APP_ID = 5004;

function seedApp(
  db: TestD1,
  id: string,
  slug: string,
  workspaceId: string | null,
  githubAppId: number,
): void {
  const now = new Date().toISOString();
  seed(
    db,
    `INSERT INTO review_bots
       (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
        created_by, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, 'v1.primary.aXZpdi.cHJldGV4dA==', 'v1.primary.aXZpdi.cHJldGV4dA==',
             'octocat', 'active', ?, ?)`,
    id,
    slug,
    githubAppId,
    slug,
    now,
    now,
  );
  if (workspaceId !== null) {
    seed(db, "INSERT INTO bot_workspaces (bot_id, workspace_id) VALUES (?, ?)", id, workspaceId);
    seedTarget(db, id, { id: `target-${id}`, workspaceId });
  }
}

function matrixFixture() {
  const db = createMigratedTestD1();
  const users = {
    legacyAdmin: seedUser(db, "octocat", "admin"),
    dana: seedUser(db, "dana", "member"),
    mallory: seedUser(db, "mallory", "member"),
    bob: seedUser(db, "bob", "member"),
  };
  seedWorkspace(db, "ws-acme", "acme");
  seedWorkspace(db, "ws-other", "other");
  seedWorkspace(db, "ws-gone", "gone", new Date().toISOString());
  seedMembership(db, "ws-acme", users.legacyAdmin, "member");
  seedMembership(db, "ws-acme", users.dana, "owner");
  seedMembership(db, "ws-acme", users.mallory, "member");
  seedMembership(db, "ws-other", users.dana, "owner");
  seedMembership(db, "ws-other", users.bob, "owner");
  seedMembership(db, "ws-gone", users.dana, "owner");
  seedApp(db, "app-acme", "acme-app", "ws-acme", ACME_APP_ID);
  seedApp(db, "app-other", "other-app", "ws-other", OTHER_APP_ID);
  seedApp(db, "app-orphan", "orphan-app", null, ORPHAN_APP_ID);
  seedApp(db, "app-gone", "gone-app", "ws-gone", GONE_APP_ID);
  return { db, users };
}

type ListBody = { viewer: { login: string }; apps: Array<{ github_app_id: number; github_slug: string | null }> };

function appSnapshot(db: TestD1, appId = "app-acme") {
  return {
    app: db.raw
      .query(`SELECT status, sandbox_image_id, deleted_at, updated_at FROM review_bots WHERE id = ?`)
      .get(appId),
    target: db.raw
      .query(
        `SELECT review_enabled, review_trigger_mode, review_level, check_min_score
           FROM review_targets WHERE bot_id = ?`,
      )
      .get(appId),
    config: db.raw.query("SELECT model_chain FROM bot_model_config WHERE bot_id = ?").get(appId) ?? null,
    keys: db.raw.query("SELECT COUNT(*) AS n FROM bot_provider_keys WHERE bot_id = ?").get(appId),
    custom: db.raw.query("SELECT COUNT(*) AS n FROM bot_custom_providers WHERE bot_id = ?").get(appId),
  };
}

const MANAGEMENT_WRITES: ReadonlyArray<{ route: string; body?: string; ownerStatus?: number }> = [
  { route: `/apps/${ACME_APP_ID}/disable`, ownerStatus: 200 },
  { route: `/apps/${ACME_APP_ID}/enable`, ownerStatus: 200 },
  { route: `/apps/${ACME_APP_ID}/settings`, body: "op=save-chain&model_chain=", ownerStatus: 200 },
  {
    route: `/apps/${ACME_APP_ID}/settings`,
    body: "op=save-sandbox-image&sandbox_image_id=omp",
    ownerStatus: 200,
  },
  {
    route: `/apps/${ACME_APP_ID}/settings/key/delete`,
    body: "provider=anthropic&key_id=seeded-key",
    ownerStatus: 200,
  },
  { route: `/api/apps/${ACME_APP_ID}/keys/verify`, body: "provider=anthropic&key=sk-not-a-real-key" },
  { route: `/api/apps/${ACME_APP_ID}/refresh-metadata` },
  { route: `/apps/${ACME_APP_ID}/delete`, ownerStatus: 200 },
];

describe("tenant isolation matrix (scenario × layer)", () => {
  test("row 1 · cross-workspace App serves only inside its own workspace, 404 in the sibling — on both ref forms", async () => {
    const { db } = matrixFixture();
    const env = envFor(db);

    for (const [ownRefs, ownApp, siblingRefs] of [
      [["acme", "ws-acme"], ACME_APP_ID, ["other", "ws-other"]],
      [["other", "ws-other"], OTHER_APP_ID, ["acme", "ws-acme"]],
    ] as const) {
      for (const own of ownRefs) {
        const served = await worker.fetch(
          await request(`/dashboard/${own}/apps/${ownApp}/onboarding`, "dana"),
          env,
        );
        expect(served.status, `${own}/${ownApp}`).toBe(200);
      }

      for (const sibling of siblingRefs) {
        const crossed = await worker.fetch(
          await request(`/dashboard/${sibling}/apps/${ownApp}/onboarding`, "dana"),
          env,
        );
        expect(crossed.status, `${sibling}/${ownApp}`).toBe(404);
      }
    }
  });

  test("row 2 · a signed-in non-member gets 404 — never 403 — on the list and the detail face, on both ref forms", async () => {
    const { db } = matrixFixture();
    const env = envFor(db);

    for (const ref of ["acme", "ws-acme"]) {
      const list = await worker.fetch(await request(`/dashboard/${ref}/api/apps`, "bob"), env);
      const detail = await worker.fetch(
        await request(`/dashboard/${ref}/apps/${ACME_APP_ID}/onboarding`, "bob"),
        env,
      );
      for (const [face, res] of [
        ["list", list],
        ["detail", detail],
      ] as const) {
        expect(res.status, `${ref} ${face}`).toBe(404);
        expect(res.status, `${ref} ${face}`).not.toBe(403);
      }
    }
  });

  test("row 3 · a workspace member reads the App list but every management write is 403 and lands nothing", async () => {
    const { db } = matrixFixture();
    const env = envFor(db);
    seed(
      db,
      "INSERT INTO bot_model_config (bot_id, model_chain, updated_at) VALUES (?, ?, datetime('now'))",
      "app-acme",
      "ark/deepseek-v4-flash",
    );
    seed(
      db,
      `INSERT INTO bot_provider_keys (bot_id, provider, key_id, key_enc, created_at)
       VALUES (?, 'anthropic', 'seeded-key', 'v1.primary.aXZpdi.c2VlZA==', datetime('now'))`,
      "app-acme",
    );

    const list = await worker.fetch(await request("/dashboard/acme/api/apps", "mallory"), env);
    expect(list.status).toBe(200);
    const body = (await list.json()) as ListBody;
    expect(body.viewer.login).toBe("mallory");
    expect(body.apps.map((app) => app.github_app_id)).toContain(ACME_APP_ID);

    const onboarding = await worker.fetch(
      await request(`/dashboard/acme/apps/${ACME_APP_ID}/onboarding`, "mallory"),
      env,
    );
    expect(onboarding.status).toBe(403);

    const post = (login: string, route: string, form?: string) =>
      request(`/dashboard/acme${route}`, login, { method: "POST", body: form ?? "" });

    const pristine = appSnapshot(db);
    for (const { route, body: form } of MANAGEMENT_WRITES) {
      const res = await worker.fetch(await post("mallory", route, form), env);
      expect(res.status, route).toBe(403);
      expect(appSnapshot(db), route).toEqual(pristine);
    }
    expect((pristine.config as { model_chain: string }).model_chain).toBe("ark/deepseek-v4-flash");

    for (const { route, body: form, ownerStatus } of MANAGEMENT_WRITES) {
      if (ownerStatus === undefined) continue;
      const res = await worker.fetch(await post("dana", route, form), env);
      expect(res.status, route).toBe(ownerStatus);
    }
    const after = appSnapshot(db);
    expect((after.keys as { n: number }).n).toBe(0);
    expect((after.app as { deleted_at: string | null }).deleted_at).not.toBeNull();
  });

  test("row 4 · an orphan App is absent from every workspace list, on both ref forms", async () => {
    const { db } = matrixFixture();

    for (const ref of ["acme", "ws-acme"]) {
      const list = await worker.fetch(
        await request(`/dashboard/${ref}/api/apps`, "dana"),
        envFor(db),
      );
      expect(list.status, ref).toBe(200);
      const appIds = ((await list.json()) as ListBody).apps.map((app) => app.github_app_id);
      expect(appIds, ref).toContain(ACME_APP_ID);
      expect(appIds, ref).not.toContain(ORPHAN_APP_ID);

      const detail = await worker.fetch(
        await request(`/dashboard/${ref}/apps/${ORPHAN_APP_ID}/onboarding`, "dana"),
        envFor(db),
      );
      expect(detail.status, ref).toBe(404);
    }
  });

  test("row 5 · a soft-deleted workspace answers 404 under strict on both ref forms despite membership and a mapped App", async () => {
    const { db } = matrixFixture();
    const env = envFor(db);

    for (const ref of ["gone", "ws-gone"]) {
      const list = await worker.fetch(await request(`/dashboard/${ref}/api/apps`, "dana"), env);
      expect(list.status, ref).toBe(404);

      const detail = await worker.fetch(
        await request(`/dashboard/${ref}/apps/${GONE_APP_ID}/onboarding`, "dana"),
        env,
      );
      expect(detail.status, ref).toBe(404);
    }

    const live = db.raw
      .query(
        `SELECT (SELECT COUNT(*) FROM workspace_members WHERE workspace_id = 'ws-gone') AS members,
                (SELECT COUNT(*) FROM bot_workspaces WHERE workspace_id = 'ws-gone') AS apps`,
      )
      .get() as { members: number; apps: number };
    expect(live).toEqual({ members: 1, apps: 1 });
  });

  test("row 6 · a retired workspace serves none of its Apps", async () => {
    const { db } = matrixFixture();
    const env = envFor(db);

    const legacy = await worker.fetch(
      await request(`/dashboard/apps/${GONE_APP_ID}/onboarding`, "octocat"),
      env,
    );
    expect(legacy.status).toBe(404);
    for (const ref of ["gone", "ws-gone"]) {
      const scoped = await worker.fetch(
        await request(`/dashboard/${ref}/apps/${GONE_APP_ID}/onboarding`, "dana"),
        env,
      );
      expect(scoped.status, ref).toBe(404);
    }
  });

  test("row 7 · a workspace answers on its id and on its slug, and every hidden ref form answers 404", async () => {
    const { db } = matrixFixture();
    const env = envFor(db);
    const list = async (ref: string) => {
      const res = await worker.fetch(await request(`/dashboard/${ref}/api/apps`, "dana"), env);
      expect(res.status, ref).toBe(200);
      return ((await res.json()) as ListBody).apps.map((app) => app.github_app_id);
    };
    expect(await list("acme")).toEqual(await list("ws-acme"));
    expect(await list("acme")).toEqual([ACME_APP_ID]);

    for (const ref of ["ghost", "gone", "ws-gone"]) {
      const res = await worker.fetch(await request(`/dashboard/${ref}/api/apps`, "dana"), env);
      expect(res.status, ref).toBe(404);
    }
  });

  test("row 8 · another spelling of an App id is 404, never a second address for the same App", async () => {
    const { db } = matrixFixture();
    const env = envFor(db);

    const literal = await worker.fetch(
      await request(`/dashboard/acme/apps/${ACME_APP_ID}/onboarding`, "dana"),
      env,
    );
    expect(literal.status, String(ACME_APP_ID)).toBe(200);

    for (const alias of ["0x1389", "5.001e3", "+5001", "0x138a", "5.002e3"]) {
      const res = await worker.fetch(await request(`/dashboard/acme/apps/${alias}/onboarding`, "dana"), env);
      expect(res.status, alias).toBe(404);
    }
  });

  test("row 9 · a support grant on one workspace opens that tenant only, on both ref forms", async () => {
    const { db } = matrixFixture();
    seedUser(db, "support-bot", "member");
    await insertSupportGrant(db, {
      workspaceId: "ws-acme",
      operatorLogin: "support-bot",
      reason: "tenant-reported incident",
      grantedBy: "deployer",
      now: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
    const env = envFor(db, "support-bot");

    for (const ref of ["acme", "ws-acme"]) {
      const res = await worker.fetch(
        await request(`/dashboard/${ref}/api/support/workspace`, "support-bot"),
        env,
      );
      expect(res.status, ref).toBe(200);
    }

    for (const ref of ["other", "ws-other"]) {
      const res = await worker.fetch(
        await request(`/dashboard/${ref}/api/support/workspace`, "support-bot"),
        env,
      );
      expect(res.status, ref).toBe(404);
    }

    const rows = db.raw
      .query("SELECT workspace_id, action FROM audit_events")
      .all() as Array<{ workspace_id: string; action: string }>;
    expect(rows.filter((row) => row.workspace_id === "ws-acme").map((row) => row.action)).toEqual([
      "support.read",
      "support.read",
    ]);
    expect(rows.filter((row) => row.workspace_id === "ws-other").map((row) => row.action)).toEqual([
      "support.denied",
      "support.denied",
    ]);
  });
});
