/**
 * Tenant isolation after the target split: ONE bot, TWO targets in two
 * workspaces. The bot keeps its single owning workspace (`bot_workspaces`),
 * so the dashboard's numeric App address resolves in that workspace only —
 * and every read face must bind the target AND its owning workspace in SQL,
 * not trust the route to have done it.
 *
 * The fixture inserts the second target itself: the backfill creates exactly
 * one target per existing bot, so a two-target bot only exists once someone
 * writes the second row.
 *
 * Nothing here reaches GitHub: the routes' only outbound client is `fetch`,
 * and every case asserts it was never called.
 */
import { describe, expect, spyOn, test } from "bun:test";
import worker from "../../src/worker/index";
import { createReviewBotsStore } from "../../src/dashboard/apps-store";
import { createInsightsStore } from "../../src/dashboard/insights-store";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import type { Env } from "../../src/worker/env";
import { createMigratedTestD1, seedTarget, type TestD1 } from "../store/helpers";

const SESSION_SECRET = ["test", "target", "session", "secret", "32-bytes!"].join("-");
const TEST_KEY = Buffer.alloc(32, 7).toString("base64");

/** The single bot both targets configure. */
const BOT_ID = "app-shared";
const GITHUB_APP_ID = 7001;
/** The bot's owning workspace ('default' is seeded by the migration chain). */
const WORKSPACE_A = "default";
/** The second workspace, which owns the second target only. */
const WORKSPACE_B = "ws-b";

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

/** One v1 review row (the era gate needs the envelope). */
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

/**
 * Two workspaces, one bot, two targets, and one of each tenant row per target.
 * `octocat` manages both workspaces, so a 404 in `ws-b` is SCOPING, never
 * membership; `dana` is a plain member of both.
 */
function isolationFixture() {
  const db = createMigratedTestD1();
  seed(
    db,
    "INSERT INTO workspaces (id, slug, name, created_by, created_at, deleted_at) VALUES (?, 'b', 'b', NULL, datetime('now'), NULL)",
    WORKSPACE_B,
  );
  for (const login of ["octocat", "dana"]) {
    seed(
      db,
      "INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES (?, ?, 'member', datetime('now'), NULL)",
      `user-${login}`,
      login,
    );
  }
  for (const workspaceId of [WORKSPACE_A, WORKSPACE_B]) {
    for (const login of ["octocat", "dana"]) {
      seed(
        db,
        "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, datetime('now'))",
        workspaceId,
        `user-${login}`,
        login === "octocat" ? "owner" : "member",
      );
    }
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

  // Target A is the workspace's live configuration; target B is PAUSED, so a
  // settings read that served B's row would answer review_enabled: false.
  const targetA = seedTarget(db, BOT_ID, { id: "target-a", workspaceId: WORKSPACE_A });
  const targetB = seedTarget(db, BOT_ID, { id: "target-b", workspaceId: WORKSPACE_B });
  seed(db, "UPDATE review_targets SET review_enabled = 0 WHERE id = ?", targetB);
  seed(db, "UPDATE review_targets SET review_trigger_mode = 'manual' WHERE id = ?", targetA);

  seedReview(db, { id: "review-a", owner: "acme", repo: "widgets", prNumber: 101, headSha: "sha-a", targetId: targetA });
  seedReview(db, { id: "review-b", owner: "other", repo: "lib", prNumber: 202, headSha: "sha-b", targetId: targetB });
  // Legacy unattributed row: invisible to every tenant read, filtered by
  // `target_id = ?` exactly as a NULL bot attribution was before the split.
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
  return { db, targetA, targetB };
}

const SCOPE_A = { targetId: "target-a", workspaceId: WORKSPACE_A, botId: BOT_ID };
const SCOPE_B = { targetId: "target-b", workspaceId: WORKSPACE_B, botId: BOT_ID };
/** A foreign pair: target B's id presented under target A's workspace. */
const SCOPE_CROSSED = { targetId: "target-b", workspaceId: WORKSPACE_A, botId: BOT_ID };

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

  test("a foreign target's PR is invisible on the detail faces (the route's 404)", async () => {
    const { db } = isolationFixture();
    const store = createReviewBotsStore(db);
    expect(await store.getPullRequestHead(SCOPE_CROSSED, "other", "lib", 202)).toBeNull();
    expect(await store.listPullRequestReviews(SCOPE_CROSSED, "other", "lib", 202, { offset: 0, limit: 10 })).toBeNull();
    expect(await store.listPullRequestFindings(SCOPE_CROSSED, "other", "lib", 202, { offset: 0, limit: 10 })).toBeNull();
    expect(await store.listPullRequestFailures(SCOPE_CROSSED, "other", "lib", 202, { offset: 0, limit: 10 })).toBeNull();
    // ...and its own workspace still reads it.
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

describe("the dashboard routes resolve the target inside the session workspace", () => {
  const INSIGHTS = `/dashboard/${WORKSPACE_A}/api/apps/${GITHUB_APP_ID}/insights/summary?include=repos`;
  const LEDGER = `/dashboard/${WORKSPACE_A}/api/apps/${GITHUB_APP_ID}/pull-requests`;
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
    // Target A's values — target B is paused and on `every_push`.
    expect(body.app.review_enabled).toBe(true);
    expect(body.app.review_trigger_mode).toBe("manual");
  });

  test("the bot is invisible from the other workspace: 404 on every face", async () => {
    const { db } = isolationFixture();
    const env = envFor(db);
    for (const path of [
      `/dashboard/${WORKSPACE_B}/api/apps/${GITHUB_APP_ID}/insights/summary`,
      `/dashboard/${WORKSPACE_B}/api/apps/${GITHUB_APP_ID}/pull-requests`,
      `/dashboard/${WORKSPACE_B}/api/apps/${GITHUB_APP_ID}/settings`,
    ]) {
      const response = await worker.fetch(await request(path, "octocat"), env);
      expect(response.status).toBe(404);
    }
  });
});
