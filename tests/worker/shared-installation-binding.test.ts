import { afterEach, describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import { createReviewBotsStore } from "../../src/dashboard/apps-store";
import { createSecretbox } from "../../src/dashboard/secretbox";
import {
  SESSION_COOKIE,
  createSessionValue,
} from "../../src/dashboard/session";
import { createUser } from "../../src/dashboard/users";
import { deleteWorkspace } from "../../src/dashboard/workspace-store";
import { applyMigrations } from "../helpers/migration-shapes";
import { syncSplitPair,
  createMigratedTestD1,
  createTestD1,
  migrationNumber,
  migrationsAfter,
  seedDefaultMemberships,
  seedTarget,
  seedWorkspaceMember,
  type TestD1,
} from "../store/helpers";
import { testAppPem } from "../helpers/rsa-key";
import type { Env } from "../../src/worker/env";
import { OAUTH_CLIENT_SECRET } from "../helpers/fake-secrets";

const SESSION_SECRET = [
  "test",
  "shared",
  "binding",
  "session",
  "secret-32b",
].join("-");
const TEST_KEY = Buffer.alloc(32, 9).toString("base64");
const SHARED_BOT = "bot-shared-binding";
const WS_A = "default";
const WS_B = "ws-tenant-b";
const WS_PROVIDER = "ws-platform";
const INSTALLATION_A = 1;
const INSTALLATION_B = 2;
const BIND_COOKIE = "__Host-mstar-bind-state";

function makeEnv(db: TestD1): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} } as unknown as Env["REVIEW_QUEUE"],
    IDEMPOTENCY_KV: {
      get: async () => null,
      put: async () => {},
    } as unknown as Env["IDEMPOTENCY_KV"],
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: OAUTH_CLIENT_SECRET,
    DEPLOYMENT_MODE: "self-hosted",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DASHBOARD_ENCRYPTION_KEY: TEST_KEY,
    DB: db,
  } as unknown as Env;
}

async function headers(
  login: string,
  extraCookie = "",
): Promise<Record<string, string>> {
  const cookie = `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}`;
  return {
    Cookie: extraCookie ? `${cookie}; ${extraCookie}` : cookie,
    Accept: "application/json",
  };
}

const call = async (
  db: TestD1,
  path: string,
  init: RequestInit,
): Promise<Response> =>
  worker.fetch(new Request(`https://worker.local${path}`, init), makeEnv(db));

const getJson = async (db: TestD1, path: string, login: string) =>
  call(db, path, { method: "GET", headers: await headers(login) });

const postJson = async (
  db: TestD1,
  path: string,
  login: string,
  body: unknown,
) =>
  call(db, path, {
    method: "POST",
    headers: { ...(await headers(login)), "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

const postBind = async (
  db: TestD1,
  workspace: string,
  login: string,
  installationId: number,
) =>
  call(db, `/dashboard/${workspace}/api/apps/9501/bind-installation`, {
    method: "POST",
    headers: {
      ...(await headers(login)),
      "Content-Type": "application/x-www-form-urlencoded",
    },
    body: new URLSearchParams({
      installationId: String(installationId),
    }).toString(),
  });

type GithubWorld = {
  /** Repositories each installation grants. */
  repos: Record<number, Array<{ id: number; owner: string; name: string }>>;
  /** The account each installation is installed on. */
  accounts: Record<number, { login: string; type: "User" | "Organization" }>;
  /** The OAuth user, and the orgs they are an active admin of. */
  oauthUser: string;
  adminOf: string[];
};

function stubGithub(world: GithubWorld): string[] {
  const urls: string[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    urls.push(url);
    const json = (body: unknown, status = 200) =>
      new Response(JSON.stringify(body), {
        status,
        headers: { "content-type": "application/json" },
      });
    const auth =
      new Headers(init?.headers)
        .get("authorization")
        ?.replace(/^Bearer /, "") ?? "";
    const mint = /\/app\/installations\/(\d+)\/access_tokens$/.exec(url);
    if (mint) return json({ token: `tok-${mint[1]}` }, 201);
    const installation = /\/app\/installations\/(\d+)$/.exec(url);
    if (installation) {
      const account = world.accounts[Number(installation[1])];
      return account
        ? json({ id: Number(installation[1]), account })
        : json({ message: "Not Found" }, 404);
    }
    if (url.startsWith("https://api.github.com/installation/repositories?")) {
      const rows = world.repos[Number(/^tok-(\d+)$/.exec(auth)?.[1])] ?? [];
      return json({
        total_count: rows.length,
        repositories: rows.map((row) => ({
          id: row.id,
          name: row.name,
          owner: { login: row.owner },
        })),
      });
    }
    if (url === "https://github.com/login/oauth/access_token")
      return json({ access_token: "user-token" });
    if (url === "https://api.github.com/user") {
      return json({
        login: world.oauthUser,
        name: null,
        avatar_url: null,
        id: 1,
      });
    }
    const membership =
      /^https:\/\/api\.github\.com\/user\/memberships\/orgs\/([^/]+)$/.exec(
        url,
      );
    if (membership) {
      if (auth !== "user-token")
        return json({ message: "Bad credentials" }, 401);
      const org = decodeURIComponent(membership[1]!);
      return world.adminOf.includes(org)
        ? json({ state: "active", role: "admin" })
        : json({ state: "active", role: "member" });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return urls;
}

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});

/**
 * One shared bot, provided by a third workspace and installed on two customers' accounts: installation 1 on
 * `org-a` (workspace A's), installation 2 on `org-b` (workspace B's). Both
 * workspaces already hold a target on the bot; `alice` manages A, `bob` B.
 */
async function twoTenantWorld(): Promise<TestD1> {
  const db = createMigratedTestD1();
  await createUser(db, { login: "alice", role: "member" });
  await createUser(db, { login: "bob", role: "member" });
  seedDefaultMemberships(db, { alice: "owner" });
  db.raw
    .prepare(
      `INSERT INTO workspaces (id, slug, name, created_by, created_at) VALUES (?, ?, ?, 'bob', datetime('now'))`,
    )
    .run(WS_B, WS_B, WS_B);
  db.raw
    .prepare(
      `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
       SELECT ?, id, 'owner', datetime('now') FROM users WHERE github_login = 'bob'`,
    )
    .run(WS_B);
  const box = createSecretbox(TEST_KEY);
  db.raw.prepare(
      `INSERT INTO github_apps
         (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, scope, shared_at, created_at, updated_at)
       VALUES (?, 'platform-bot', 9501, 'platform-bot', ?, 'enc', 'alice',
               'active', 'shared', datetime('now'), datetime('now'), datetime('now'))`,
    )
    .run(
      SHARED_BOT,
      await box.encryptSecret(
        await testAppPem(),
        `github_apps.private_key_enc:${SHARED_BOT}`,
      ),
    );
  // The split pair: the bot row and the default-workspace mapping the
  // same-id invariant of this release requires beside the App row.
  syncSplitPair(db);
  db.raw
    .prepare(
      `INSERT INTO workspaces (id, slug, name, created_by, created_at) VALUES (?, ?, ?, 'alice', datetime('now'))`,
    )
    .run(WS_PROVIDER, WS_PROVIDER, WS_PROVIDER);
  db.raw
    .prepare("INSERT OR REPLACE INTO app_workspaces (app_id, workspace_id) VALUES (?, ?)")
    .run(SHARED_BOT, WS_PROVIDER);
  const apps = createReviewBotsStore(db);
  for (const [installationId, login] of [
    [INSTALLATION_A, "org-a"],
    [INSTALLATION_B, "org-b"],
  ] as const) {
    await apps.upsertInstallation({
      appId: SHARED_BOT,
      installationId,
      accountLogin: login,
      authoritative: true,
    });
  }
  seedTarget(db, SHARED_BOT, {
    workspaceId: WS_A,
    repoId: 2001,
    repoOwner: "org-a",
    repoName: "app",
  });
  seedTarget(db, SHARED_BOT, {
    workspaceId: WS_B,
    repoId: 3001,
    repoOwner: "org-b",
    repoName: "app",
  });
  return db;
}

const world = (overrides: Partial<GithubWorld> = {}): GithubWorld => ({
  repos: {
    [INSTALLATION_A]: [
      { id: 2001, owner: "org-a", name: "app" },
      { id: 2002, owner: "org-a", name: "secret" },
    ],
    [INSTALLATION_B]: [{ id: 3001, owner: "org-b", name: "app" }],
  },
  accounts: {
    [INSTALLATION_A]: { login: "org-a", type: "Organization" },
    [INSTALLATION_B]: { login: "org-b", type: "Organization" },
  },
  oauthUser: "alice",
  adminOf: ["org-a"],
  ...overrides,
});

const boundTo = (db: TestD1, installationId: number) =>
  (
    db.raw
      .query(
        "SELECT bound_workspace_id FROM github_app_installations WHERE app_id = ? AND installation_id = ?",
      )
      .get(SHARED_BOT, installationId) as { bound_workspace_id: string | null }
  ).bound_workspace_id;

/** Run the bind start and the OAuth callback as one signed-in user. */
async function bindThroughOAuth(
  db: TestD1,
  workspace: string,
  login: string,
  installationId: number,
  beforeCallback: () => void = () => {},
): Promise<Response> {
  const started = await postBind(db, workspace, login, installationId);
  expect(started.status).toBe(200);
  const body = (await started.json()) as {
    bound: boolean;
    authorize_url: string;
  };
  expect(body.bound).toBe(false);
  const authorize = new URL(body.authorize_url);
  expect(authorize.searchParams.get("scope")).toContain("read:org");
  const state = authorize.searchParams.get("state")!;
  expect(started.headers.get("set-cookie")).toContain(
    `${BIND_COOKIE}=${state}`,
  );
  beforeCallback();
  return call(
    db,
    `/dashboard/oauth/callback?code=abc123&state=${encodeURIComponent(state)}`,
    {
      method: "GET",
      headers: await headers(login, `${BIND_COOKIE}=${state}`),
      redirect: "manual",
    },
  );
}

describe("shared bot installations are bound to one workspace", () => {
  test("an unbound installation grants no workspace its repositories", async () => {
    const db = await twoTenantWorld();
    stubGithub(world());

    const listed = await getJson(
      db,
      `/dashboard/${WS_A}/api/apps/9501/installation-repositories`,
      "alice",
    );
    expect(listed.status).toBe(200);
    expect(JSON.stringify(await listed.json())).not.toContain("org-a");
  });

  test("binding needs the user's own token to show they administer the installation's account", async () => {
    const db = await twoTenantWorld();
    const urls = stubGithub(world({ adminOf: [] }));

    const denied = await bindThroughOAuth(db, WS_A, "alice", INSTALLATION_A);
    expect(denied.status).toBe(403);
    expect(boundTo(db, INSTALLATION_A)).toBeNull();
    expect(urls).toContain(
      "https://api.github.com/user/memberships/orgs/org-a",
    );

    stubGithub(world());
    const bound = await bindThroughOAuth(db, WS_A, "alice", INSTALLATION_A);
    expect(bound.status).toBe(302);
    // A successful bind lands on the App's installed face — the mount whose new
    // chain the bind just created.
    expect(bound.headers.get("location")).toBe(
      `/dashboard/${WS_A}/apps/9501?from=installed`,
    );
    expect(boundTo(db, INSTALLATION_A)).toBe(WS_A);
  });

  test("a personal-account installation binds only for that same GitHub user", async () => {
    const db = await twoTenantWorld();
    const accounts = {
      [INSTALLATION_A]: { login: "carol", type: "User" as const },
    };
    stubGithub(world({ accounts }));
    expect(
      (await bindThroughOAuth(db, WS_A, "alice", INSTALLATION_A)).status,
    ).toBe(403);
    expect(boundTo(db, INSTALLATION_A)).toBeNull();

    stubGithub(
      world({
        accounts: { [INSTALLATION_A]: { login: "alice", type: "User" } },
      }),
    );
    expect(
      (await bindThroughOAuth(db, WS_A, "alice", INSTALLATION_A)).status,
    ).toBe(302);
    expect(boundTo(db, INSTALLATION_A)).toBe(WS_A);
  });

  test("a GitHub login other than the signed-in user's is refused", async () => {
    const db = await twoTenantWorld();
    stubGithub(world({ oauthUser: "mallory" }));
    expect(
      (await bindThroughOAuth(db, WS_A, "alice", INSTALLATION_A)).status,
    ).toBe(403);
    expect(boundTo(db, INSTALLATION_A)).toBeNull();
  });

  test("a callback without this browser's bind cookie binds nothing", async () => {
    const db = await twoTenantWorld();
    stubGithub(world());
    const started = await postBind(db, WS_A, "alice", INSTALLATION_A);
    const state = new URL(
      ((await started.json()) as { authorize_url: string }).authorize_url,
    ).searchParams.get("state")!;
    const res = await call(
      db,
      `/dashboard/oauth/callback?code=abc123&state=${encodeURIComponent(state)}`,
      {
        method: "GET",
        headers: await headers("alice"),
        redirect: "manual",
      },
    );
    expect(res.status).not.toBe(302);
    expect(boundTo(db, INSTALLATION_A)).toBeNull();
  });

  test("workspace B cannot see, claim or bind installation 1 once it is bound to A", async () => {
    const db = await twoTenantWorld();
    stubGithub(world());
    expect(
      (await bindThroughOAuth(db, WS_A, "alice", INSTALLATION_A)).status,
    ).toBe(302);
    stubGithub(world({ oauthUser: "bob", adminOf: ["org-b"] }));
    expect(
      (await bindThroughOAuth(db, WS_B, "bob", INSTALLATION_B)).status,
    ).toBe(302);
    expect(boundTo(db, INSTALLATION_B)).toBe(WS_B);

    const listedA = await getJson(
      db,
      `/dashboard/${WS_A}/api/apps/9501/installation-repositories`,
      "alice",
    );
    expect(listedA.status).toBe(200);
    const textA = JSON.stringify(await listedA.json());
    expect(textA).toContain("secret");
    expect(textA).not.toContain("org-b");

    const listedB = await getJson(
      db,
      `/dashboard/${WS_B}/api/apps/9501/installation-repositories`,
      "bob",
    );
    expect(listedB.status).toBe(200);
    const textB = JSON.stringify(await listedB.json());
    expect(textB).toContain("org-b");
    expect(textB).not.toContain("org-a");

    const claim = await postJson(db, `/dashboard/${WS_B}/api/targets`, "bob", {
      bot_id: SHARED_BOT,
      repositories: [{ repo_id: 2002, owner: "org-a", name: "secret" }],
    });
    expect(claim.status).toBe(400);
    expect(((await claim.json()) as { error: string }).error).toBe(
      "repository_not_installed",
    );
    const written = db.raw
      .query(
        "SELECT COUNT(*) AS n FROM review_targets WHERE app_id = ? AND repo_id = 2002",
      )
      .get(SHARED_BOT) as { n: number };
    expect(written.n).toBe(0);

    const bind = await postBind(db, WS_B, "bob", INSTALLATION_A);
    expect(bind.status).toBe(404);
    expect(boundTo(db, INSTALLATION_A)).toBe(WS_A);

    // First binder wins: the store never moves A's binding to B either.
    expect(
      await createReviewBotsStore(db).bindInstallation(
        SHARED_BOT,
        INSTALLATION_A,
        WS_B,
        seedWorkspaceMember(db, WS_B, "bob", "owner"),
      ),
    ).toBe("bound_elsewhere");
    expect(boundTo(db, INSTALLATION_A)).toBe(WS_A);
  });

  test("a webhook upsert never binds or unbinds an installation", async () => {
    const db = await twoTenantWorld();
    const apps = createReviewBotsStore(db);
    expect(
      await apps.bindInstallation(
        SHARED_BOT,
        INSTALLATION_A,
        WS_A,
        seedWorkspaceMember(db, WS_A, "alice", "owner"),
      ),
    ).toBe("bound");
    await apps.upsertInstallation({
      appId: SHARED_BOT,
      installationId: INSTALLATION_A,
      accountLogin: "org-a",
      authoritative: true,
    });
    await apps.upsertInstallation({
      appId: SHARED_BOT,
      installationId: 99,
      accountLogin: "org-z",
      authoritative: true,
    });
    expect(boundTo(db, INSTALLATION_A)).toBe(WS_A);
    expect(boundTo(db, 99)).toBeNull();
  });

  test("a bound installation is no longer pending, and re-binding it here is a no-op", async () => {
    const db = await twoTenantWorld();
    stubGithub(world());
    expect(
      (await bindThroughOAuth(db, WS_A, "alice", INSTALLATION_A)).status,
    ).toBe(302);
    const pending = await createReviewBotsStore(db).listPendingInstallations(
      SHARED_BOT,
      true,
    );
    expect(pending.map((row) => row.installation_id)).toEqual([INSTALLATION_B]);
    const again = await postBind(db, WS_A, "alice", INSTALLATION_A);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({
      botId: SHARED_BOT,
      installationId: INSTALLATION_A,
      bound: true,
    });
  });

  test("a binding whose workspace was deleted no longer holds the installation", async () => {
    const db = await twoTenantWorld();
    const apps = createReviewBotsStore(db);
    expect(
      await apps.bindInstallation(
        SHARED_BOT,
        INSTALLATION_A,
        WS_A,
        seedWorkspaceMember(db, WS_A, "alice", "owner"),
      ),
    ).toBe("bound");
    db.raw
      .prepare(
        "UPDATE workspaces SET deleted_at = datetime('now') WHERE id = ?",
      )
      .run(WS_A);
    expect(
      (await apps.listPendingInstallations(SHARED_BOT, true)).map(
        (r) => r.installation_id,
      ),
    ).toContain(INSTALLATION_A);
    stubGithub(world({ oauthUser: "bob", adminOf: ["org-a"] }));
    expect(
      (await bindThroughOAuth(db, WS_B, "bob", INSTALLATION_A)).status,
    ).toBe(302);
    expect(boundTo(db, INSTALLATION_A)).toBe(WS_B);
  });

  test("after A is deleted, B rebinds A's installation and adds the repository A had configured", async () => {
    const db = await twoTenantWorld();
    expect(
      await createReviewBotsStore(db).bindInstallation(
        SHARED_BOT,
        INSTALLATION_A,
        WS_A,
        seedWorkspaceMember(db, WS_A, "alice", "owner"),
      ),
    ).toBe("bound");
    expect(await deleteWorkspace(db, WS_A, new Date().toISOString())).toBe(
      true,
    );
    stubGithub(world({ oauthUser: "bob", adminOf: ["org-a"] }));
    expect(
      (await bindThroughOAuth(db, WS_B, "bob", INSTALLATION_A)).status,
    ).toBe(302);

    const listed = await getJson(
      db,
      `/dashboard/${WS_B}/api/apps/9501/installation-repositories`,
      "bob",
    );
    expect(listed.status).toBe(200);
    expect(JSON.stringify(await listed.json())).toContain("org-a");
    const created = await postJson(
      db,
      `/dashboard/${WS_B}/api/targets`,
      "bob",
      {
        bot_id: SHARED_BOT,
        repositories: [{ repo_id: 2001, owner: "org-a", name: "app" }],
      },
    );
    expect(created.status).toBe(201);
    expect(
      ((await created.json()) as { created: unknown[] }).created,
    ).toHaveLength(1);
    const holders = db.raw
      .query(
        "SELECT workspace_id, deleted_at IS NOT NULL AS retired FROM review_targets WHERE repo_id = 2001 ORDER BY retired",
      )
      .all();
    expect(holders).toEqual([
      { workspace_id: WS_B, retired: 0 },
      { workspace_id: WS_A, retired: 1 },
    ]);
  });

  test("the backfill retires targets a workspace deleted before this change left live", () => {
    const backfill = "0105_retire_deleted_workspace_targets.sql";
    const db = createTestD1();
    applyMigrations(
      db,
      migrationsAfter(2).filter(
        (name) => migrationNumber(name) < migrationNumber(backfill),
      ),
    );
    db.raw
      .prepare(
        `INSERT INTO workspaces (id, slug, name, created_by, created_at, deleted_at)
                VALUES ('ws-gone', 'ws-gone', 'gone', 'x', datetime('now'), '2026-01-02T00:00:00.000Z')`,
      )
      .run();
    db.raw
      .prepare(
        `INSERT INTO workspaces (id, slug, name, created_by, created_at) VALUES ('ws-live', 'ws-live', 'live', 'x', datetime('now'))`,
      )
      .run();
    db.raw.prepare(
      `INSERT INTO review_bots (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
                                  created_by, status, created_at, updated_at)
         VALUES ('bot-x', 'bot-x', 7101, 'bot-x', 'k', 'w', 'x', 'active', datetime('now'), datetime('now'))`,
    )
    .run();
    seedTarget(db, "bot-x", {
      workspaceId: "ws-gone",
      repoId: 1,
      repoOwner: "o",
      repoName: "gone",
    });
    seedTarget(db, "bot-x", {
      workspaceId: "ws-live",
      repoId: 2,
      repoOwner: "o",
      repoName: "live",
    });
    applyMigrations(db, [backfill]);
    expect(
      db.raw
        .query(
          "SELECT workspace_id, deleted_at FROM review_targets ORDER BY workspace_id",
        )
        .all(),
    ).toEqual([
      { workspace_id: "ws-gone", deleted_at: "2026-01-02T00:00:00.000Z" },
      { workspace_id: "ws-live", deleted_at: null },
    ]);
  });

  test("a manager who loses the role during the GitHub round trip binds nothing", async () => {
    const db = await twoTenantWorld();
    stubGithub(world());
    const github = globalThis.fetch;
    // Demote alice while GitHub answers the membership read — after the first role check.
    globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
      if (String(input).includes("/user/memberships/orgs/")) {
        db.raw
          .prepare(
            `UPDATE workspace_members SET role = 'member'
              WHERE workspace_id = ? AND user_id = (SELECT id FROM users WHERE github_login = 'alice')`,
          )
          .run(WS_A);
      }
      return github(input as Parameters<typeof fetch>[0], init);
    }) as typeof fetch;
    const res = await bindThroughOAuth(db, WS_A, "alice", INSTALLATION_A);
    expect(res.status).toBe(403);
    expect(boundTo(db, INSTALLATION_A)).toBeNull();
  });

  test("a maintenance window opened during the GitHub round trip binds nothing", async () => {
    const db = await twoTenantWorld();
    stubGithub(world());
    const res = await bindThroughOAuth(
      db,
      WS_A,
      "alice",
      INSTALLATION_A,
      () => {
        db.raw
          .prepare(
            `INSERT OR REPLACE INTO review_runtime_settings (key, value, updated_at)
           VALUES ('platform.maintenance.enabled', '1', datetime('now'))`,
          )
          .run();
      },
    );
    expect(res.status).toBe(503);
    expect(boundTo(db, INSTALLATION_A)).toBeNull();
  });
});
