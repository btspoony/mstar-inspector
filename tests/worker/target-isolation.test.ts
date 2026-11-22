import { describe, expect, spyOn, test } from "bun:test";
import worker from "../../src/worker/index";
import { createReviewBotsStore } from "../../src/dashboard/apps-store";
import { createInsightsStore } from "../../src/dashboard/insights-store";
import { SHARED_BOT_REFUSAL } from "../../src/dashboard/entitlement";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import type { Env } from "../../src/worker/env";
import { createMigratedTestD1, seedTarget, type TestD1 } from "../store/helpers";

const SESSION_SECRET = ["test", "target", "session", "secret", "32-bytes!"].join("-");
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

const BOT_ID = "app-shared";
const GITHUB_APP_ID = 7001;
const WORKSPACE_A = "default";
const WORKSPACE_B = "ws-b";

function envFor(db: TestD1, mode: "saas" | "self-hosted" = "self-hosted"): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} },
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} },
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "oauth-client-secret",
    DEPLOYMENT_MODE: mode,
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DASHBOARD_ENCRYPTION_KEY: TEST_KEY,
    DB: db,
  } as unknown as Env;
}

async function request(path: string, login: string | null): Promise<Request> {
  const headers: Record<string, string> = {};
  if (login !== null) {
    headers.Cookie = `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}`;
  }
  return new Request(`https://worker.local${path}`, { method: "GET", headers });
}

const seed = (db: TestD1, sql: string, ...params: Array<string | number | null>): void => {
  db.raw.prepare(sql).run(...params);
};

function seedReview(
  db: TestD1,
  input: { id: string; owner: string; repo: string; prNumber: number; headSha: string; targetId: string | null },
): void {
  seed(
    db,
    `INSERT INTO reviews
       (id, installation_id, owner, repo, pr_number, head_sha, reviewed_at, verdict, summary_md, envelope, bot_id, target_id)
     VALUES (?, 123, ?, ?, ?, ?, datetime('now'), 'approved', 's', '{}', ?, ?)`,
    input.id,
    input.owner,
    input.repo,
    input.prNumber,
    input.headSha,
    BOT_ID,
    input.targetId,
  );
}

function seedFinding(
  db: TestD1,
  input: {
    id: string;
    targetId: string | null;
    owner: string;
    repo: string;
    prNumber: number;
    mergeClass: string;
    state?: "open" | "addressed";
  },
): void {
  seed(
    db,
    `INSERT INTO review_publications
       (id, bot_id, installation_id, owner, repo, pr_number, head_sha, kind, phase,
        payload_json, created_ms, updated_ms)
     VALUES (?, ?, 123, ?, ?, ?, ?, 'review', 'applied', '{}', 1, 1)`,
    `pub-${input.id}`,
    BOT_ID,
    input.owner,
    input.repo,
    input.prNumber,
    `sha-${input.id}`,
  );
  seed(
    db,
    `INSERT INTO review_findings
       (id, bot_id, installation_id, owner, repo, pr_number, finding_id, original_json,
        first_publication_id, last_publication_id, first_seen_sha, last_seen_sha,
        first_seen_round, last_seen_round, state, created_ms, updated_ms, target_id)
     VALUES (?, ?, 123, ?, ?, ?, ?, ?, ?, ?, 'sha', 'sha', 1, 1, ?, 1, 1, ?)`,
    input.id,
    BOT_ID,
    input.owner,
    input.repo,
    input.prNumber,
    `finding-${input.id}`,
    JSON.stringify({ mergeClass: input.mergeClass, title: input.id }),
    `pub-${input.id}`,
    `pub-${input.id}`,
    input.state ?? "open",
    input.targetId,
  );
}

function seedFailure(
  db: TestD1,
  input: { id: string; targetId: string | null; owner: string; repo: string; prNumber: number },
): void {
  seed(
    db,
    `INSERT INTO review_failures
       (id, installation_id, owner, repo, pr_number, head_sha, stage, error, target_id)
     VALUES (?, 123, ?, ?, ?, 'sha', 'runner', 'boom', ?)`,
    input.id,
    input.owner,
    input.repo,
    input.prNumber,
    input.targetId,
  );
}

function isolationFixture() {
  const db = createMigratedTestD1();
  seed(
    db,
    "INSERT INTO workspaces (id, slug, name, created_by, created_at, deleted_at) VALUES (?, 'b', 'b', NULL, datetime('now'), NULL)",
    WORKSPACE_B,
  );
  seed(
    db,
    "INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES ('user-octocat', 'octocat', 'member', datetime('now'), NULL)",
  );
  for (const workspaceId of [WORKSPACE_A, WORKSPACE_B]) {
    seed(
      db,
      "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, 'user-octocat', 'owner', datetime('now'))",
      workspaceId,
    );
  }
  seed(
    db,
    `INSERT INTO review_bots
       (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
        created_by, status, created_at, updated_at)
     VALUES (?, 'shared-app', ?, 'shared-app', 'v1.primary.aXZpdi.cHJldGV4dA==', 'v1.primary.aXZpdi.cHJldGV4dA==',
             'octocat', 'active', datetime('now'), datetime('now'))`,
    BOT_ID,
    GITHUB_APP_ID,
  );
  seed(db, "INSERT INTO bot_workspaces (bot_id, workspace_id) VALUES (?, ?)", BOT_ID, WORKSPACE_A);

  const targetA = seedTarget(db, BOT_ID, {
    id: "target-a",
    workspaceId: WORKSPACE_A,
    repoId: 700001,
    repoOwner: "acme",
    repoName: "widgets",
  });
  const targetB = seedTarget(db, BOT_ID, {
    id: "target-b",
    workspaceId: WORKSPACE_B,
    repoId: 700002,
    repoOwner: "other",
    repoName: "lib",
  });
  seed(db, "UPDATE review_targets SET review_enabled = 0 WHERE id = ?", targetB);
  seed(db, "UPDATE review_targets SET review_trigger_mode = 'manual' WHERE id = ?", targetA);

  seedReview(db, { id: "review-a", owner: "acme", repo: "widgets", prNumber: 101, headSha: "sha-a", targetId: targetA });
  seedReview(db, { id: "review-b", owner: "other", repo: "lib", prNumber: 202, headSha: "sha-b", targetId: targetB });
  seedReview(db, { id: "review-legacy", owner: "legacy", repo: "old", prNumber: 303, headSha: "sha-l", targetId: null });

  for (const row of [
    { target: targetA, owner: "acme", repo: "widgets", number: 101 },
    { target: targetB, owner: "other", repo: "lib", number: 202 },
  ]) {
    seed(
      db,
      `INSERT INTO pull_requests (id, bot_id, target_id, owner, repo, pr_number, title, state, head_sha, first_seen_at, last_seen_at)
       VALUES (?, ?, ?, ?, ?, ?, 'PR', 'open', 'sha', datetime('now'), datetime('now'))`,
      `pr-${row.number}`,
      BOT_ID,
      row.target,
      row.owner,
      row.repo,
      row.number,
    );
  }

  seedFinding(db, { id: "finding-a", targetId: targetA, owner: "acme", repo: "widgets", prNumber: 101, mergeClass: "must-fix" });
  seedFinding(db, { id: "finding-a2", targetId: targetA, owner: "acme", repo: "widgets", prNumber: 101, mergeClass: "nit", state: "addressed" });
  seedFailure(db, { id: "failure-a", targetId: targetA, owner: "acme", repo: "widgets", prNumber: 101 });
  seedFinding(db, { id: "finding-b", targetId: targetB, owner: "other", repo: "lib", prNumber: 202, mergeClass: "should-fix" });
  seedFailure(db, { id: "failure-b", targetId: targetB, owner: "other", repo: "lib", prNumber: 202 });
  seedFailure(db, { id: "failure-legacy", targetId: null, owner: "legacy", repo: "old", prNumber: 303 });

  return { db, targetA, targetB };
}

const SCOPE_A = { kind: "target", targetId: "target-a", workspaceId: WORKSPACE_A } as const;
const SCOPE_B = { kind: "target", targetId: "target-b", workspaceId: WORKSPACE_B } as const;
const SCOPE_CROSSED = { kind: "target", targetId: "target-b", workspaceId: WORKSPACE_A } as const;

describe("insights aggregation is tenant-scoped", () => {
  test("each target's workspace reads only its own reviews", async () => {
    const { db } = isolationFixture();
    const fromA = await createInsightsStore(db, { ...SCOPE_A, includeRepos: true });
    expect(fromA.reviewsTotal).toBe(1);
    expect(fromA.repos).toEqual(["acme/widgets"]);
    expect(fromA.findingsBySeverity).toEqual([]);

    const fromB = await createInsightsStore(db, { ...SCOPE_B, includeRepos: true });
    expect(fromB.reviewsTotal).toBe(1);
    expect(fromB.repos).toEqual(["other/lib"]);
  });

  test("a target id from another workspace aggregates to nothing", async () => {
    const { db } = isolationFixture();
    const crossed = await createInsightsStore(db, { ...SCOPE_CROSSED, includeRepos: true });
    expect(crossed.reviewsTotal).toBe(0);
    expect(crossed.verdictDistribution).toEqual([]);
    expect(crossed.repos).toEqual([]);
    expect(crossed.weeklyTrend).toEqual([]);
  });
});

describe("the pull-request ledger is tenant-scoped", () => {
  test("each target reads only its own rows; the crossed pair reads nothing", async () => {
    const { db } = isolationFixture();
    const local = createReviewBotsStore(db);
    expect((await local.listPullRequests(SCOPE_A)).rows.map((row) => row.number)).toEqual([101]);
    expect((await local.listPullRequests(SCOPE_B)).rows.map((row) => row.number)).toEqual([202]);
    expect((await local.listPullRequests(SCOPE_CROSSED)).rows).toEqual([]);
    expect((await local.listPullRequests(SCOPE_CROSSED)).repos).toEqual([]);
  });

  test("the record counts bind the tenant pair too", async () => {
    const { db } = isolationFixture();
    const store = createReviewBotsStore(db);
    expect(await store.countPullRequestRecords(SCOPE_B, "other", "lib", 202)).toEqual({
      findings: 1,
      reviews: 1,
      failures: 1,
      must_fix: 0,
    });
    expect(await store.countPullRequestRecords(SCOPE_CROSSED, "other", "lib", 202)).toEqual({
      findings: 0,
      reviews: 0,
      failures: 0,
      must_fix: 0,
    });
  });

  test("a foreign target's PR is invisible on the detail faces (the route's 404)", async () => {
    const { db } = isolationFixture();
    const store = createReviewBotsStore(db);
    expect(await store.getPullRequestHead(SCOPE_CROSSED, "other", "lib", 202)).toBeNull();
    expect(await store.listPullRequestReviews(SCOPE_CROSSED, "other", "lib", 202, { offset: 0, limit: 10 })).toBeNull();
    expect(await store.listPullRequestFindings(SCOPE_CROSSED, "other", "lib", 202, { offset: 0, limit: 10 })).toBeNull();
    expect(await store.listPullRequestFailures(SCOPE_CROSSED, "other", "lib", 202, { offset: 0, limit: 10 })).toBeNull();
    const own = await store.getPullRequestHead(SCOPE_B, "other", "lib", 202);
    expect(own?.pr_number).toBe(202);
  });

  test("a write that omits the target is refused", async () => {
    const { db } = isolationFixture();
    const store = createReviewBotsStore(db);
    await expect(
      store.upsertPullRequest({ appId: BOT_ID, owner: "acme", repo: "widgets", prNumber: 999, state: "open" } as never),
    ).rejects.toThrow(/target/);
  });
});

describe("the execution ledgers are tenant-scoped by their own target", () => {
  const PAGE = { offset: 0, limit: 10 };

  test("each target counts and pages only its own findings and failures", async () => {
    const { db } = isolationFixture();
    const store = createReviewBotsStore(db);

    expect(await store.countPullRequestRecords(SCOPE_A, "acme", "widgets", 101)).toEqual({
      findings: 1,
      reviews: 1,
      failures: 1,
      must_fix: 1,
    });
    expect((await store.listPullRequestFindings(SCOPE_A, "acme", "widgets", 101, PAGE))!.items.map((row) => row.title)).toEqual([
      "finding-a",
    ]);
    expect(
      (await store.listPullRequestFailures(SCOPE_A, "acme", "widgets", 101, PAGE))!.items.map((row) => row.stage),
    ).toEqual(["runner"]);

    expect(await store.countPullRequestRecords(SCOPE_B, "other", "lib", 202)).toEqual({
      findings: 1,
      reviews: 1,
      failures: 1,
      must_fix: 0,
    });
    expect((await store.listPullRequestFindings(SCOPE_B, "other", "lib", 202, PAGE))!.items.map((row) => row.title)).toEqual([
      "finding-b",
    ]);
  });

  test("the crossed pair reads none of another workspace's ledger rows", async () => {
    const { db } = isolationFixture();
    const store = createReviewBotsStore(db);
    expect(await store.countPullRequestRecords(SCOPE_CROSSED, "other", "lib", 202)).toEqual({
      findings: 0,
      reviews: 0,
      failures: 0,
      must_fix: 0,
    });
    expect(await store.listPullRequestFindings(SCOPE_CROSSED, "other", "lib", 202, PAGE)).toBeNull();
    expect(await store.listPullRequestFailures(SCOPE_CROSSED, "other", "lib", 202, PAGE)).toBeNull();
  });

  test("an unattributed row is written, held, and never counted by a tenant read", async () => {
    const { db } = isolationFixture();
    expect(db.raw.query("SELECT COUNT(*) AS n FROM review_failures").get()).toEqual({ n: 3 });
    const store = createReviewBotsStore(db);
    const a = await store.countPullRequestRecords(SCOPE_A, "acme", "widgets", 101);
    const b = await store.countPullRequestRecords(SCOPE_B, "other", "lib", 202);
    expect(a.failures + b.failures).toBe(2);
  });
});

describe("the dashboard routes resolve the target inside the session workspace", () => {
  const INSIGHTS = `/dashboard/${WORKSPACE_A}/api/targets/target-a/insights/summary?include=repos`;
  const LEDGER = `/dashboard/${WORKSPACE_A}/api/targets/target-a/pull-requests`;
  const SETTINGS = `/dashboard/${WORKSPACE_A}/api/apps/${GITHUB_APP_ID}/settings`;

  test("insights and the ledger serve this workspace's target only, with no GitHub call", async () => {
    const { db } = isolationFixture();
    const fetchSpy = spyOn(globalThis, "fetch");
    try {
      const env = envFor(db);
      const insights = await worker.fetch(await request(INSIGHTS, "octocat"), env);
      expect(insights.status).toBe(200);
      const body = (await insights.json()) as { reviews_total: number; repos: string[] };
      expect(body.reviews_total).toBe(1);
      expect(body.repos).toEqual(["acme/widgets"]);

      const ledger = await worker.fetch(await request(LEDGER, "octocat"), env);
      expect(ledger.status).toBe(200);
      const ledgerBody = (await ledger.json()) as { pull_requests: Array<{ number: number }>; repos: string[] };
      expect(ledgerBody.pull_requests.map((row) => row.number)).toEqual([101]);
      expect(ledgerBody.repos).toEqual(["acme/widgets"]);
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  test("the settings payload carries the target id and reads the target's policy", async () => {
    const { db } = isolationFixture();
    const response = await worker.fetch(await request(SETTINGS, "octocat"), envFor(db));
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      target_id: string;
      workspace_id: string;
      app: { review_enabled: boolean; review_trigger_mode: string };
    };
    expect(body.workspace_id).toBe(WORKSPACE_A);
    expect(body.target_id).toBe("target-a");
    expect(body.app.review_enabled).toBe(true);
    expect(body.app.review_trigger_mode).toBe("manual");
  });

  test("a target is invisible from a workspace that does not own it: 404 on both faces", async () => {
    const { db } = isolationFixture();
    seed(
      db,
      `INSERT INTO workspaces (id, slug, name, created_by, created_at)
       VALUES ('ws-c', 'ws-c', 'ws-c', NULL, datetime('now'))`,
    );
    seed(
      db,
      `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
       VALUES ('ws-c', 'user-octocat', 'owner', datetime('now'))`,
    );
    const env = envFor(db);
    for (const path of [
      `/dashboard/ws-c/api/targets/target-a/insights/summary`,
      `/dashboard/ws-c/api/targets/target-a/pull-requests`,
      `/dashboard/ws-c/api/apps/${GITHUB_APP_ID}/settings`,
    ]) {
      const response = await worker.fetch(await request(path, "octocat"), env);
      expect(response.status, path).toBe(404);
    }
  });

  test("a workspace holding a target on the bot reads that target, even when the bot is owned elsewhere", async () => {
    const { db } = isolationFixture();
    const env = envFor(db);
    for (const path of [
      `/dashboard/${WORKSPACE_B}/api/targets/target-b/insights/summary`,
      `/dashboard/${WORKSPACE_B}/api/targets/target-b/pull-requests`,
      `/dashboard/${WORKSPACE_B}/api/apps/${GITHUB_APP_ID}/settings`,
    ]) {
      const response = await worker.fetch(await request(path, "octocat"), env);
      expect(response.status, path).toBe(200);
    }
  });
});

describe("a target whose bot is no longer shared reads Blocked", () => {
  test("blocked is true exactly when the bot is owned and the target is elsewhere", async () => {
    const { db } = isolationFixture();
    const env = envFor(db);
    const read = async (workspace: string) => {
      const response = await worker.fetch(await request(`/dashboard/${workspace}/api/apps/${GITHUB_APP_ID}/settings`, "octocat"), env);
      expect(response.status, workspace).toBe(200);
      return (await response.json()) as {
        blocked: boolean;
        blocked_reason: string | null;
        workspace_id: string;
        app: { scope: string };
        check_gate: { min_score: number } | null;
      };
    };

    const fromB = await read(WORKSPACE_B);
    expect(fromB.app.scope).toBe("owned");
    expect(fromB.workspace_id).toBe(WORKSPACE_B);
    expect(fromB.blocked).toBe(true);
    expect(fromB.blocked_reason).toBe("bot_not_shared");
    expect(fromB.check_gate).not.toBeNull();

    const fromA = await read(WORKSPACE_A);
    expect(fromA.blocked).toBe(false);
    expect(fromA.blocked_reason).toBeNull();

    seed(db, "UPDATE review_bots SET scope = 'shared' WHERE id = ?", BOT_ID);
    const reshared = await read(WORKSPACE_B);
    expect(reshared.blocked).toBe(false);
    expect(reshared.blocked_reason).toBeNull();
  });
});

