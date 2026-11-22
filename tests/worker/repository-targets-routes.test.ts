import { afterEach, describe, expect, spyOn, test } from "bun:test";
import worker from "../../src/worker/index";
import { createReviewBotsStore } from "../../src/dashboard/apps-store";
import { createSecretbox } from "../../src/dashboard/secretbox";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createUser } from "../../src/dashboard/users";
import { createMigratedTestD1, seedDefaultMemberships, seedTarget, type TestD1 } from "../store/helpers";
import { testAppPem } from "../helpers/rsa-key";
import type { Env } from "../../src/worker/env";
import { OAUTH_CLIENT_SECRET } from "../helpers/fake-secrets";

const SESSION_SECRET = ["test", "targets", "session", "secret", "32-bytes!"].join("-");
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
const APP_ID = 9401;
const OTHER_WS = "ws-foreign";

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


type FetchCall = { url: string; method: string; authorization: string | null };

function stubRepositories(
  answers: Record<number, Array<{ id: number; name: string; owner: string }>>,
  failingListings: readonly number[] = [],
): FetchCall[] {
  const calls: FetchCall[] = [];
  globalThis.fetch = (async (input: unknown, init?: RequestInit) => {
    const url = String(input);
    const authorization = new Headers(init?.headers).get("authorization");
    calls.push({ url, method: init?.method ?? "GET", authorization });
    const mint = /\/app\/installations\/(\d+)\/access_tokens$/.exec(url);
    if (mint) {
      const installationId = Number(mint[1]);
      if (answers[installationId] === undefined) return new Response("upstream boom", { status: 500 });
      return new Response(JSON.stringify({ token: `tok-${installationId}` }), {
        status: 201,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.startsWith("https://api.github.com/installation/repositories?")) {
      const installationId = Number(/^tok-(\d+)$/.exec(authorization?.replace(/^Bearer /, "") ?? "")?.[1]);
      const rows = failingListings.includes(installationId) ? undefined : answers[installationId];
      if (rows === undefined) return new Response("upstream boom", { status: 500 });
      const payload = rows.map((row) => ({ id: row.id, name: row.name, owner: { login: row.owner } }));
      return new Response(JSON.stringify({ total_count: payload.length, repositories: payload }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    throw new Error(`unexpected fetch: ${url}`);
  }) as typeof fetch;
  return calls;
}

const origFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = origFetch;
});


type World = { db: TestD1; botId: string };

async function seededWorld(opts: { installations?: number[]; target?: boolean } = {}): Promise<World> {
  const db = createMigratedTestD1();
  await createUser(db, { login: "mallory", role: "member" });
  await createUser(db, { login: "trudy", role: "member" });
  seedDefaultMemberships(db, { mallory: "owner", trudy: "member" });
  const id = crypto.randomUUID();
  const box = createSecretbox(TEST_KEY);
  await createReviewBotsStore(db).createApp({
    id,
    githubSlug: "repo-bot",
    githubAppId: APP_ID,
    name: "repo-bot",
    privateKeyEnc: await box.encryptSecret(await testAppPem(), `github_apps.private_key_enc:${id}`),
    webhookSecretEnc: await box.encryptSecret("test-webhook", `github_apps.webhook_secret_enc:${id}`),
    createdBy: "mallory",
    workspaceId: "default",
    maxApps: null,
  });
  db.raw
    .prepare(
      `INSERT INTO review_bots (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
                                 created_by, status, scope, created_at, updated_at)
       VALUES ('bot-foreign', 'foreign-bot', 9402, 'foreign-bot', 'enc', 'enc', 'mallory',
               'active', 'owned', datetime('now'), datetime('now'))`,
    )
    .run();
  db.raw
    .prepare(
      `INSERT INTO workspaces (id, slug, name, created_by, created_at)
       VALUES (?, ?, ?, 'mallory', datetime('now'))`,
    )
    .run(OTHER_WS, OTHER_WS, OTHER_WS);
  await db
    .prepare("INSERT INTO bot_workspaces (bot_id, workspace_id) VALUES ('bot-foreign', ?)")
    .bind(OTHER_WS)
    .run();
  seedTarget(db, "bot-foreign", {
    workspaceId: OTHER_WS,
    repoId: 777001,
    repoOwner: "foreign",
    repoName: "repo",
  });
  for (const installationId of opts.installations ?? []) {
    await createReviewBotsStore(db).upsertInstallation({
      appId: id,
      installationId,
      accountLogin: `org-${installationId}`,
      authoritative: true,
    });
  }
  db.raw
    .prepare("UPDATE bot_installations SET seen_at = '2026-01-01 00:00:00.000' WHERE bot_id = ?")
    .run(id);
  if (opts.target !== false) {
    seedTarget(db, id, { workspaceId: "default", repoId: 555001, repoOwner: "acme", repoName: "api" });
  }
  return { db, botId: id };
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


describe("GET /dashboard/:workspaceRef/api/targets", () => {
  function seedReview(
    db: TestD1,
    row: { id: string; targetId: string; botId: string; reviewedAt: string | null },
  ): void {
    db.raw
      .prepare(
        `INSERT INTO reviews
           (id, installation_id, owner, repo, pr_number, head_sha, reviewed_at, verdict, bot_id, target_id)
         VALUES (?, 1, 'acme', 'api', ?, ?, ?, 'pass', ?, ?)`,
      )
      .run(
        row.id,
        Number(row.id.replace(/\D/g, "")) || 1,
        row.id,
        row.reviewedAt ?? new Date().toISOString().slice(0, 19).replace("T", " "),
        row.botId,
        row.targetId,
      );
  }

  test("a live target carries its repository identity, its App name and no foreign row", async () => {
    const { db, botId } = await seededWorld({});
    db.raw
      .prepare("UPDATE review_bots SET github_name = 'Acme Inspector' WHERE id = ?")
      .run(botId);

    const res = await get(db, "/dashboard/default/api/targets", "trudy");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      targets: Array<Record<string, unknown>>;
    };
    expect(body.targets).toHaveLength(1);
    const row = body.targets[0]!;
    expect(row.repo_id).toBe(555001);
    expect(row.repo_owner).toBe("acme");
    expect(row.repo_name).toBe("api");
    expect(row.app_name).toBe("Acme Inspector");
    expect(row.follow_workspace_defaults).toBe(0);
    expect(JSON.stringify(body)).not.toContain("foreign");
  });

  test("a member of the foreign workspace sees its own target only", async () => {
    const { db } = await seededWorld({});
    db.raw
      .prepare("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) SELECT ?, id, 'owner', datetime('now') FROM users WHERE github_login = 'trudy'")
      .run(OTHER_WS);

    const res = await get(db, `/dashboard/${OTHER_WS}/api/targets`, "trudy");

    const body = (await res.json()) as { targets: Array<Record<string, unknown>> };
    expect(body.targets.map((row) => row.repo_name)).toEqual(["repo"]);
  });

  test("a 待安装 row reports repo_id null with its App name still resolved", async () => {
    const { db, botId } = await seededWorld({ target: false });
    seedTarget(db, botId, {
      workspaceId: "default",
      repoId: undefined,
      repoOwner: undefined,
      repoName: undefined,
    });
    db.raw
      .prepare("UPDATE review_targets SET repo_id = NULL, repo_owner = NULL, repo_name = NULL WHERE bot_id = ?")
      .run(botId);

    const res = await get(db, "/dashboard/default/api/targets", "mallory");

    const body = (await res.json()) as { targets: Array<Record<string, unknown>> };
    expect(body.targets).toHaveLength(1);
    expect(body.targets[0]!.repo_id).toBeNull();
    expect(body.targets[0]!.app_name).toBe("repo-bot");
  });

  test("each row carries its review total and its last-7-day count", async () => {
    const { db, botId } = await seededWorld({});
    const webId = seedTarget(db, botId, {
      workspaceId: "default",
      repoId: 555002,
      repoOwner: "acme",
      repoName: "web",
    });
    const docsId = seedTarget(db, botId, {
      workspaceId: "default",
      repoId: 555003,
      repoOwner: "acme",
      repoName: "docs",
    });
    const apiId = (
      db.raw
        .query("SELECT id FROM review_targets WHERE bot_id = ? AND repo_id = 555001")
        .get(botId) as { id: string }
    ).id;
    seedReview(db, { id: "r-old-1", targetId: apiId, botId, reviewedAt: "2025-01-01 00:00:00" });
    seedReview(db, { id: "r-old-2", targetId: apiId, botId, reviewedAt: "2025-02-01 00:00:00" });
    seedReview(db, { id: "r-now-1", targetId: webId, botId, reviewedAt: null });
    void docsId;

    const res = await get(db, "/dashboard/default/api/targets", "trudy");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      targets: Array<{ repo_name: string; reviews_total: number; reviews_7d: number; last_reviewed_at: string | null }>;
    };
    const byName = new Map(body.targets.map((row) => [row.repo_name, row]));
    expect(byName.get("api")?.reviews_total).toBe(2);
    expect(byName.get("api")?.reviews_7d).toBe(0);
    expect(byName.get("api")?.last_reviewed_at).toBe("2025-02-01 00:00:00");
    expect(byName.get("web")?.reviews_total).toBe(1);
    expect(byName.get("web")?.reviews_7d).toBe(1);
    expect(byName.get("docs")?.reviews_total).toBe(0);
    expect(byName.get("docs")?.reviews_7d).toBe(0);
  });

  test("the list is review-descending, with never-reviewed rows last", async () => {
    const { db, botId } = await seededWorld({});
    const apiId = (
      db.raw
        .query("SELECT id FROM review_targets WHERE bot_id = ? AND repo_id = 555001")
        .get(botId) as { id: string }
    ).id;
    db.raw
      .prepare("UPDATE review_targets SET created_at = '2026-01-01T00:00:00.000Z' WHERE id = ?")
      .run(apiId);
    const webId = seedTarget(db, botId, {
      workspaceId: "default",
      repoId: 555002,
      repoOwner: "acme",
      repoName: "web",
      createdAt: "2026-01-02T00:00:00.000Z",
    });
    seedTarget(db, botId, {
      workspaceId: "default",
      repoId: 555003,
      repoOwner: "acme",
      repoName: "docs",
      createdAt: "2026-01-03T00:00:00.000Z",
    });
    seedReview(db, { id: "r-api", targetId: apiId, botId, reviewedAt: "2025-01-01 00:00:00" });
    seedReview(db, { id: "r-web", targetId: webId, botId, reviewedAt: null });

    const res = await get(db, "/dashboard/default/api/targets", "trudy");

    const body = (await res.json()) as { targets: Array<{ repo_name: string }> };
    expect(body.targets.map((row) => row.repo_name)).toEqual(["web", "api", "docs"]);
  });
});


describe("GET /dashboard/:workspaceRef/api/apps/:appId/installation-repositories", () => {
  test("two installations are walked once each and deduped by repo id", async () => {
    const { db } = await seededWorld({ installations: [11, 12] });
    const calls = stubRepositories({
      11: [
        { id: 501, name: "api", owner: "acme" },
        { id: 502, name: "web", owner: "acme" },
      ],
      12: [
        { id: 502, name: "web", owner: "acme" },
        { id: 503, name: "docs", owner: "other" },
      ],
    });

    const res = await get(db, `/dashboard/default/api/apps/${APP_ID}/installation-repositories`, "mallory");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      repositories: [
        { repo_id: 501, owner: "acme", name: "api", claimed: false },
        { repo_id: 502, owner: "acme", name: "web", claimed: false },
        { repo_id: 503, owner: "other", name: "docs", claimed: false },
      ],
      degraded: false,
    });
    expect(calls).toHaveLength(4);
    const mints = calls.filter((call) => call.url.endsWith("/access_tokens"));
    expect(mints.map((call) => call.url)).toEqual([
      "https://api.github.com/app/installations/11/access_tokens",
      "https://api.github.com/app/installations/12/access_tokens",
    ]);
    expect(mints.map((call) => call.method)).toEqual(["POST", "POST"]);
    expect(mints.every((call) => /^Bearer [\w-]+\.[\w-]+\.[\w-]+$/.test(call.authorization ?? ""))).toBe(true);
    const listings = calls.filter((call) => !call.url.endsWith("/access_tokens"));
    expect(listings.map((call) => call.url)).toEqual([
      "https://api.github.com/installation/repositories?per_page=100",
      "https://api.github.com/installation/repositories?per_page=100",
    ]);
    expect(listings.map((call) => call.authorization)).toEqual(["Bearer tok-11", "Bearer tok-12"]);
  });

  test("a failed token mint degrades that installation only", async () => {
    const { db } = await seededWorld({ installations: [61, 62] });
    const calls = stubRepositories({ 62: [{ id: 611, name: "api", owner: "acme" }] });

    const res = await get(db, `/dashboard/default/api/apps/${APP_ID}/installation-repositories`, "mallory");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      repositories: [{ repo_id: 611, owner: "acme", name: "api", claimed: false }],
      degraded: true,
    });
    expect(calls.filter((call) => call.url.includes("/installation/repositories"))).toHaveLength(1);
  });

  test("a failed listing degrades that installation only", async () => {
    const { db } = await seededWorld({ installations: [71, 72] });
    const calls = stubRepositories(
      { 71: [{ id: 801, name: "api", owner: "acme" }], 72: [{ id: 802, name: "web", owner: "acme" }] },
      [71],
    );

    const res = await get(db, `/dashboard/default/api/apps/${APP_ID}/installation-repositories`, "mallory");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      repositories: [{ repo_id: 802, owner: "acme", name: "web", claimed: false }],
      degraded: true,
    });
    expect(calls.filter((call) => call.url.includes("/installation/repositories"))).toHaveLength(2);
  });

  test("every installation failing to list is a 502", async () => {
    const { db } = await seededWorld({ installations: [81, 82] });
    const calls = stubRepositories(
      { 81: [{ id: 901, name: "api", owner: "acme" }], 82: [{ id: 902, name: "web", owner: "acme" }] },
      [81, 82],
    );

    const res = await get(db, `/dashboard/default/api/apps/${APP_ID}/installation-repositories`, "mallory");

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "installation_repositories_unavailable" });
    expect(calls.filter((call) => call.url.includes("/installation/repositories"))).toHaveLength(2);
  });

  test("a repository a SIBLING workspace already holds on this bot is marked claimed", async () => {
    const { db, botId } = await seededWorld({ installations: [11] });
    stubRepositories({
      11: [
        { id: 777001, owner: "foreign", name: "repo" },
        { id: 555001, owner: "acme", name: "api" },
        { id: 556001, owner: "acme", name: "free" },
      ],
    });
    seedTarget(db, botId, {
      workspaceId: OTHER_WS,
      repoId: 777001,
      repoOwner: "foreign",
      repoName: "repo",
    });

    const res = await get(db, `/dashboard/default/api/apps/${APP_ID}/installation-repositories`, "mallory");

    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      repositories: Array<{ repo_id: number; claimed: boolean }>;
    };
    const byId = new Map(body.repositories.map((row) => [row.repo_id, row.claimed]));
    expect(byId.get(555001)).toBe(true);
    expect(byId.get(777001)).toBe(true);
    expect(byId.get(556001)).toBe(false);
  });

  test("an unclaimed migrated row claims its repository by owner/name too", async () => {
    const { db, botId } = await seededWorld({ target: false, installations: [11] });
    seedTarget(db, botId, {
      workspaceId: "default",
      repoId: undefined,
      repoOwner: "acme",
      repoName: "migrated",
    });
    db.raw
      .prepare(
        "UPDATE review_targets SET repo_id = NULL, repo_owner = 'acme', repo_name = 'migrated' WHERE bot_id = ?",
      )
      .run(botId);
    stubRepositories({
      11: [
        { id: 900001, owner: "acme", name: "migrated" },
        { id: 900002, owner: "acme", name: "fresh" },
      ],
    });

    const res = await get(db, `/dashboard/default/api/apps/${APP_ID}/installation-repositories`, "mallory");

    const body = (await res.json()) as { repositories: Array<{ repo_id: number; claimed: boolean }> };
    const byId = new Map(body.repositories.map((row) => [row.repo_id, row.claimed]));
    expect(byId.get(900001)).toBe(true);
    expect(byId.get(900002)).toBe(false);
  });

  test("an installation with zero repositories answers 200 [] rather than an error", async () => {
    const { db } = await seededWorld({ installations: [21] });
    stubRepositories({ 21: [] });

    const res = await get(db, `/dashboard/default/api/apps/${APP_ID}/installation-repositories`, "mallory");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ repositories: [], degraded: false });
  });

  test("one failed installation degrades the list instead of failing it", async () => {
    const { db } = await seededWorld({ installations: [31, 32] });
    stubRepositories({ 31: [{ id: 601, name: "api", owner: "acme" }] });

    const res = await get(db, `/dashboard/default/api/apps/${APP_ID}/installation-repositories`, "mallory");

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      repositories: [{ repo_id: 601, owner: "acme", name: "api", claimed: false }],
      degraded: true,
    });
  });

  test("every installation failing is a 502 — the dialog has nothing to offer", async () => {
    const { db } = await seededWorld({ installations: [41, 42] });
    stubRepositories({});

    const res = await get(db, `/dashboard/default/api/apps/${APP_ID}/installation-repositories`, "mallory");

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "installation_repositories_unavailable" });
  });

  test("a plain member is refused and no installation is walked", async () => {
    const { db } = await seededWorld({ installations: [51] });
    const calls = stubRepositories({ 51: [{ id: 701, name: "api", owner: "acme" }] });

    const res = await get(db, `/dashboard/default/api/apps/${APP_ID}/installation-repositories`, "trudy");

    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
  });
});


describe("POST /dashboard/:workspaceRef/api/targets", () => {
  const INSTALLATION = 11;
  const grant = (repositories: Array<{ id: number; owner: string; name: string }>) =>
    stubRepositories({ [INSTALLATION]: repositories });

  test("one target per selected repository, each inheriting the workspace defaults", async () => {
    const { db } = await seededWorld({ target: false, installations: [INSTALLATION] });
    grant([
      { id: 801, owner: "acme", name: "api" },
      { id: 802, owner: "acme", name: "web" },
    ]);

    const res = await post(db, "/dashboard/default/api/targets", "mallory", {
      bot_id: (await createReviewBotsStore(db).getScopedAppByGithubId(APP_ID, "default"))!.id,
      repositories: [
        { repo_id: 801, owner: "acme", name: "api" },
        { repo_id: 802, owner: "acme", name: "web" },
      ],
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      created: Array<{ target_id: string; repo_id: number }>;
      duplicates: unknown[];
    };
    expect(body.created.map((row) => row.repo_id)).toEqual([801, 802]);
    expect(body.duplicates).toEqual([]);
    const rows = db.raw
      .query(
        "SELECT workspace_id, follow_workspace_defaults FROM review_targets WHERE workspace_id = 'default' AND deleted_at IS NULL",
      )
      .all() as Array<{ workspace_id: string; follow_workspace_defaults: number }>;
    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.follow_workspace_defaults === 1)).toBe(true);
  });

  test("a duplicate lands in `duplicates` and never rolls back the rows created with it", async () => {
    const { db, botId } = await seededWorld({ installations: [INSTALLATION] });
    grant([
      { id: 555001, owner: "acme", name: "api" },
      { id: 901, owner: "acme", name: "new" },
    ]);

    const res = await post(db, "/dashboard/default/api/targets", "mallory", {
      bot_id: botId,
      repositories: [
        { repo_id: 555001, owner: "acme", name: "api" },
        { repo_id: 901, owner: "acme", name: "new" },
      ],
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as {
      created: Array<{ repo_id: number }>;
      duplicates: Array<{ repo_id: number; owner: string; name: string }>;
    };
    expect(body.created.map((row) => row.repo_id)).toEqual([901]);
    expect(body.duplicates).toEqual([{ repo_id: 555001, owner: "acme", name: "api" }]);
    const repoIds = (
      db.raw
        .query("SELECT repo_id FROM review_targets WHERE workspace_id = 'default' AND deleted_at IS NULL")
        .all() as Array<{ repo_id: number }>
    ).map((row) => row.repo_id);
    expect(repoIds.sort((a, b) => a - b)).toEqual([901, 555001]);
  });

  test("the same repository under ANOTHER bot is a separate claim", async () => {
    const { db } = await seededWorld({ target: false, installations: [INSTALLATION] });
    grant([{ id: 777001, owner: "foreign", name: "repo" }]);

    const res = await post(db, "/dashboard/default/api/targets", "mallory", {
      bot_id: (await createReviewBotsStore(db).getScopedAppByGithubId(APP_ID, "default"))!.id,
      repositories: [{ repo_id: 777001, owner: "foreign", name: "repo" }],
    });

    expect(res.status).toBe(201);
    const body = (await res.json()) as { created: unknown[]; duplicates: unknown[] };
    expect(body.created).toHaveLength(1);
    expect(body.duplicates).toEqual([]);
    const holders = db.raw
      .query("SELECT bot_id FROM review_targets WHERE repo_id = 777001 ORDER BY workspace_id")
      .all() as Array<{ bot_id: string }>;
    expect(holders).toHaveLength(2);
    expect(new Set(holders.map((row) => row.bot_id)).size).toBe(2);
  });

  test("an id the App does not grant refuses the whole request and writes nothing", async () => {
    const { db, botId } = await seededWorld({ target: false, installations: [INSTALLATION] });
    grant([{ id: 801, owner: "acme", name: "api" }]);

    const res = await post(db, "/dashboard/default/api/targets", "mallory", {
      bot_id: botId,
      repositories: [
        { repo_id: 801, owner: "acme", name: "api" },
        { repo_id: 802, owner: "acme", name: "stolen" },
      ],
    });

    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "repository_not_installed", repo_ids: [802] });
    expect(
      (db.raw.query("SELECT COUNT(*) AS n FROM review_targets WHERE workspace_id = 'default'").get() as { n: number })
        .n,
    ).toBe(0);
  });

  test("a failed installation walk refuses the request (fail closed) and writes nothing", async () => {
    const { db, botId } = await seededWorld({ target: false, installations: [INSTALLATION] });
    stubRepositories({});

    const res = await post(db, "/dashboard/default/api/targets", "mallory", {
      bot_id: botId,
      repositories: [{ repo_id: 801, owner: "acme", name: "api" }],
    });

    expect(res.status).toBe(502);
    expect(await res.json()).toEqual({ error: "installation_repositories_unavailable" });
    expect(
      (db.raw.query("SELECT COUNT(*) AS n FROM review_targets WHERE workspace_id = 'default'").get() as { n: number })
        .n,
    ).toBe(0);
  });

  test("an empty selection is a 400 with nothing written and no installation walked", async () => {
    const { db, botId } = await seededWorld({ target: false, installations: [INSTALLATION] });
    const calls = stubRepositories({});

    const res = await post(db, "/dashboard/default/api/targets", "mallory", {
      bot_id: botId,
      repositories: [],
    });

    expect(res.status).toBe(400);
    expect(calls).toHaveLength(0);
    expect(
      (db.raw.query("SELECT COUNT(*) AS n FROM review_targets").get() as { n: number }).n,
    ).toBe(1);
  });

  test("an unknown bot is a 404", async () => {
    const { db } = await seededWorld({ target: false });

    const res = await post(db, "/dashboard/default/api/targets", "mallory", {
      bot_id: "not-a-bot",
      repositories: [{ repo_id: 1001, owner: "acme", name: "api" }],
    });

    expect(res.status).toBe(404);
  });

  test("a shared bot with no live target here is a 404, and becomes reachable once one exists", async () => {
    const { db } = await seededWorld({ target: false });
    const sharedId = "bot-shared-platform";
    const box = createSecretbox(TEST_KEY);
    db.raw
      .prepare(
        `INSERT INTO review_bots
           (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
            created_by, status, scope, shared_at, created_at, updated_at)
         VALUES (?, 'platform-bot', 9403, 'platform-bot', 'enc', 'enc', 'mallory',
                 'active', 'shared', datetime('now'), datetime('now'), datetime('now'))`,
      )
      .run(sharedId);
    db.raw
      .prepare("UPDATE review_bots SET private_key_enc = ? WHERE id = ?")
      .run(await box.encryptSecret(await testAppPem(), `github_apps.private_key_enc:${sharedId}`), sharedId);
    db.raw
      .prepare("INSERT INTO bot_workspaces (bot_id, workspace_id) VALUES (?, ?)")
      .run(sharedId, OTHER_WS);
    await createReviewBotsStore(db).upsertInstallation({
      appId: sharedId,
      installationId: INSTALLATION,
      accountLogin: "org-platform",
      authoritative: true,
    });
    grant([
      { id: 1301, owner: "acme", name: "api" },
      { id: 1302, owner: "acme", name: "web" },
    ]);

    const body = {
      bot_id: sharedId,
      repositories: [{ repo_id: 1301, owner: "acme", name: "api" }],
    };
    const refused = await post(db, "/dashboard/default/api/targets", "mallory", body);
    expect(refused.status).toBe(404);
    expect(await refused.json()).toEqual({ error: "unknown app" });
    const written = db.raw
      .query("SELECT COUNT(*) AS n FROM review_targets WHERE bot_id = ?")
      .get(sharedId) as { n: number };
    expect(written.n).toBe(0);

    seedTarget(db, sharedId, { workspaceId: "default", repoId: 1302, repoOwner: "acme", repoName: "web" });
    const accepted = await post(db, "/dashboard/default/api/targets", "mallory", body);
    expect(accepted.status).toBe(201);
    const acceptedBody = (await accepted.json()) as { created: Array<{ repo_id: number }>; duplicates: unknown[] };
    expect(acceptedBody.created.map((row) => row.repo_id)).toEqual([1301]);
    expect(acceptedBody.duplicates).toEqual([]);
  });

  test("a plain member is refused before any write", async () => {
    const { db, botId } = await seededWorld({ target: false, installations: [INSTALLATION] });
    const calls = stubRepositories({ [INSTALLATION]: [{ id: 1101, owner: "acme", name: "api" }] });

    const res = await post(db, "/dashboard/default/api/targets", "trudy", {
      bot_id: botId,
      repositories: [{ repo_id: 1101, owner: "acme", name: "api" }],
    });

    expect(res.status).toBe(403);
    expect(calls).toHaveLength(0);
    const written = db.raw
      .query("SELECT COUNT(*) AS n FROM review_targets WHERE workspace_id = 'default'")
      .get() as { n: number };
    expect(written.n).toBe(0);
  });
});

test("the list route never calls GitHub", async () => {
  const { db } = await seededWorld({});
  const spy = spyOn(globalThis, "fetch");
  try {
    await get(db, "/dashboard/default/api/targets", "mallory");
    expect(spy).not.toHaveBeenCalled();
  } finally {
    spy.mockRestore();
  }
});

