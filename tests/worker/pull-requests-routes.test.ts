/**
 * GET /api/apps/:appId/pull-requests[/:number] — the App-scoped PR ledger
 * faces (migration 0039).
 *
 * Both ride the SAME gate ladder as every other App JSON read: membership →
 * App-id resolution (unknown / soft-deleted / CROSS-WORKSPACE all collapse into
 * the one `unknown app` 404) → creator-or-admin. The detail face additionally
 * answers 404 for a PR number this App never received.
 */
import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { createAppsStore } from "../../src/dashboard/apps-store";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createUser } from "../../src/dashboard/users";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";

const SESSION_SECRET = ["test", "dashboard", "session", "secret", "32-bytes!"].join("-");
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");
/** Each fixture App gets its own numeric GitHub id (the App's only address). */
const ACME_APP_ID = 3001;
const OTHER_APP_ID = 3002;

function envFor(db: TestD1): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} },
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} },
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "oauth-client-secret",
    DEPLOYMENT_MODE: "self-hosted",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DASHBOARD_ENCRYPTION_KEY: TEST_KEY,
    DB: db,
  } as unknown as Env;
}

async function seedApp(
  db: TestD1,
  opts: { id: string; githubAppId: number; workspaceId: string; slug: string },
): Promise<void> {
  const now = new Date().toISOString();
  db.raw
    .prepare(
      `INSERT INTO github_apps
         (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'v1.primary.aXZpdi.cHJldGV4dA==', 'v1.primary.aXZpdi.cHJldGV4dA==',
               'octocat', 'active', ?, ?)`,
    )
    .run(opts.id, opts.slug, opts.githubAppId, opts.slug, now, now);
  db.raw
    .prepare("INSERT INTO app_workspaces (app_id, workspace_id) VALUES (?, ?)")
    .run(opts.id, opts.workspaceId);
}

/**
 * Two workspaces, one App each. `octocat` owns `acme` and belongs to nothing in
 * `other`, so the cross-workspace denial is real membership, not a missing row.
 */
async function fixture(): Promise<TestD1> {
  const db = createMigratedTestD1();
  const now = new Date().toISOString();
  const workspaces: Array<[string, string]> = [
    ["ws-acme", "acme"],
    ["ws-other", "other"],
  ];
  for (const [id, slug] of workspaces) {
    db.raw
      .prepare(
        "INSERT INTO workspaces (id, slug, name, created_by, created_at, deleted_at) VALUES (?, ?, ?, NULL, ?, NULL)",
      )
      .run(id, slug, slug, now);
  }
  const octocat = await createUser(db, { login: "octocat", role: "member" });
  db.raw
    .prepare("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ('ws-acme', ?, 'owner', ?)")
    .run(octocat.id, now);
  await seedApp(db, { id: "app-acme", githubAppId: ACME_APP_ID, workspaceId: "ws-acme", slug: "acme-app" });
  await seedApp(db, { id: "app-other", githubAppId: OTHER_APP_ID, workspaceId: "ws-other", slug: "other-app" });
  await createAppsStore(db).upsertPullRequest({
    appId: "app-acme",
    owner: "acme",
    repo: "widgets",
    prNumber: 131,
    title: "Add a thing",
    state: "open",
    headSha: "sha-1",
  });
  return db;
}

async function getFace(path: string, db: TestD1, login = "octocat"): Promise<Response> {
  return worker.fetch(
    new Request(`https://worker.local${path}`, {
      headers: { Cookie: `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}` },
    }),
    envFor(db),
  );
}

describe("GET /api/apps/:appId/pull-requests", () => {
  test("lists this App's PRs with the contract row shape", async () => {
    const res = await getFace(`/dashboard/acme/api/apps/${ACME_APP_ID}/pull-requests`, await fixture());
    expect(res.status).toBe(200);
    const body = (await res.json()) as { pull_requests: Array<Record<string, unknown>> };
    expect(body.pull_requests.length).toBe(1);
    expect(body.pull_requests[0]).toMatchObject({
      number: 131,
      owner: "acme",
      repo: "widgets",
      title: "Add a thing",
      state: "open",
      head_sha: "sha-1",
      latest_review: null,
      failure_count: 0,
    });
  });

  test("an App from another workspace answers the same 404 as an unknown one", async () => {
    const db = await fixture();
    // `octocat` owns acme; app-other lives in ws-other. Addressing it under the
    // acme workspace ref must not resolve, and the body must not name it.
    const cross = await getFace(`/dashboard/acme/api/apps/${OTHER_APP_ID}/pull-requests`, db);
    expect(cross.status).toBe(404);
    expect(await cross.json()).toEqual({ error: "unknown app" });
  });

  test("without a session → 302 to login", async () => {
    const res = await worker.fetch(
      new Request(`https://worker.local/dashboard/acme/api/apps/${ACME_APP_ID}/pull-requests`),
      envFor(await fixture()),
    );
    expect(res.status).toBe(302);
    expect(res.headers.get("Location")).toBe("/dashboard/login");
  });
});

describe("GET /api/apps/:appId/pull-requests/:number", () => {
  test("returns the row with its reviews, failures and findings", async () => {
    const res = await getFace(`/dashboard/acme/api/apps/${ACME_APP_ID}/pull-requests/131`, await fixture());
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pull_request: Record<string, unknown>;
      reviews: unknown[];
      failures: unknown[];
      findings: unknown[];
    };
    expect(body.pull_request).toMatchObject({ number: 131, owner: "acme", repo: "widgets" });
    expect(body.reviews).toEqual([]);
    expect(body.failures).toEqual([]);
    expect(body.findings).toEqual([]);
  });

  test("an unknown PR number → 404", async () => {
    const res = await getFace(`/dashboard/acme/api/apps/${ACME_APP_ID}/pull-requests/999`, await fixture());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown pull request" });
  });

  test("a non-numeric number is the same 404 (no number-spelling alias)", async () => {
    for (const number of ["0x1f", "1e3", "1.5"]) {
      const res = await getFace(`/dashboard/acme/api/apps/${ACME_APP_ID}/pull-requests/${number}`, await fixture());
      expect(res.status, number).toBe(404);
    }
  });

  test("a cross-workspace App → 404 before the PR lookup", async () => {
    const res = await getFace(`/dashboard/acme/api/apps/${OTHER_APP_ID}/pull-requests/131`, await fixture());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown app" });
  });
});
