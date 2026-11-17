/**
 * The two workspace-scope read faces, driven through
 * the real worker mount:
 *
 *   GET /dashboard/<ref>/api/insights/summary
 *   GET /dashboard/<ref>/api/pull-requests
 *
 * Both resolve the workspace from the session-validated `:workspaceRef` and
 * read EVERY live target of it — the payload shape is the App faces', the
 * scope is not. Two cases carry the contract: a workspace with two targets
 * counts both, and a workspace with none answers empty arrays rather than an
 * error or another tenant's rows.
 */
import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import type { Env } from "../../src/worker/env";
import { createMigratedTestD1, seedBot, seedTarget, type TestD1 } from "../store/helpers";
import { withSpaAssets } from "../helpers/spa";

const SESSION_SECRET = ["test", "workspace", "scope", "session", "32-bytes!"].join("-");

function envFor(db: TestD1): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} },
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} },
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "oauth-client-secret",
    DEPLOYMENT_MODE: "self-hosted",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DB: db,
  } as unknown as Env;
}

function seed(db: TestD1, sql: string, ...params: Array<string | number | null>): void {
  db.raw.prepare(sql).run(...params);
}

function seedWorkspace(db: TestD1, id: string, login: string, role = "owner"): void {
  seed(
    db,
    "INSERT INTO workspaces (id, slug, name, created_by, created_at, deleted_at) VALUES (?, ?, ?, NULL, ?, NULL)",
    id,
    id,
    id,
    "2026-10-01T00:00:00.000Z",
  );
  const userId = crypto.randomUUID();
  seed(
    db,
    "INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES (?, ?, 'member', ?, NULL)",
    userId,
    login,
    "2026-10-01T00:00:00.000Z",
  );
  // The manage rule is the workspace role: a plain member would 403.
  seed(
    db,
    "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, ?, ?)",
    id,
    userId,
    role,
    "2026-10-01T00:00:00.000Z",
  );
}

function seedReview(db: TestD1, id: string, targetId: string, botId: string, owner: string, repo: string, number: number): void {
  seed(
    db,
    `INSERT INTO reviews
       (id, installation_id, owner, repo, pr_number, head_sha, reviewed_at, verdict, summary_md, envelope, bot_id, target_id)
     VALUES (?, 1, ?, ?, ?, 'sha', datetime('now'), 'approved', 's', '{}', ?, ?)`,
    id,
    owner,
    repo,
    number,
    botId,
    targetId,
  );
}

function seedPullRequest(
  db: TestD1,
  targetId: string,
  botId: string,
  owner: string,
  repo: string,
  number: number,
): void {
  seed(
    db,
    `INSERT INTO pull_requests (id, bot_id, target_id, owner, repo, pr_number, title, state)
     VALUES (?, ?, ?, ?, ?, ?, 'A change', 'open')`,
    crypto.randomUUID(),
    botId,
    targetId,
    owner,
    repo,
    number,
  );
}

async function get(db: TestD1, path: string, login: string): Promise<Response> {
  return worker.fetch(
    new Request(`https://worker.local/dashboard/${path}`, {
      headers: {
        Accept: "application/json",
        Cookie: `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}`,
      },
    }),
    withSpaAssets(envFor(db)),
  );
}

/**
 * `ws-two` owns two live targets on two bots (two repositories, one review and
 * one ledger row each). `ws-empty` owns a bot but no target yet.
 */
function fixture(): TestD1 {
  const db = createMigratedTestD1();
  seedWorkspace(db, "ws-two", "dana");
  seedWorkspace(db, "ws-empty", "erin");
  seedBot(db, "bot-one", 9201);
  seedBot(db, "bot-two", 9202);
  seedBot(db, "bot-idle", 9203);
  const first = seedTarget(db, "bot-one", { workspaceId: "ws-two", repoOwner: "acme", repoName: "widgets" });
  const second = seedTarget(db, "bot-two", { workspaceId: "ws-two", repoOwner: "acme", repoName: "portal" });
  seedTarget(db, "bot-idle", { workspaceId: "ws-empty" });
  seedReview(db, "r-one", first, "bot-one", "acme", "widgets", 1);
  seedReview(db, "r-two", second, "bot-two", "acme", "portal", 2);
  seedPullRequest(db, first, "bot-one", "acme", "widgets", 1);
  seedPullRequest(db, second, "bot-two", "acme", "portal", 2);
  return db;
}

describe("GET /dashboard/<ref>/api/insights/summary (workspace scope)", () => {
  test("counts both live targets of the workspace", async () => {
    const db = fixture();
    const res = await get(db, "ws-two/api/insights/summary?include=repos", "dana");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      reviews_total: number;
      repos: string[];
      verdict_distribution: Array<{ verdict: string; count: number }>;
    };
    expect(body.reviews_total).toBe(2);
    expect(body.repos).toEqual(["acme/portal", "acme/widgets"]);
    expect(body.verdict_distribution).toEqual([{ verdict: "approved", count: 2 }]);
  });

  test("a workspace with no live target answers the empty aggregate", async () => {
    const db = fixture();
    const res = await get(db, "ws-empty/api/insights/summary?include=repos", "erin");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(body.reviews_total).toBe(0);
    expect(body.repos).toEqual([]);
    expect(body.findings_by_severity).toEqual([]);
    expect(body.verdict_distribution).toEqual([]);
    expect(body.weekly_trend).toEqual([]);
  });
});

describe("GET /dashboard/<ref>/api/pull-requests (workspace scope)", () => {
  test("lists both live targets of the workspace", async () => {
    const db = fixture();
    const res = await get(db, "ws-two/api/pull-requests", "dana");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pull_requests: Array<{ number: number; owner: string; repo: string }>;
      repos: string[];
    };
    expect(body.pull_requests.map((row) => `${row.owner}/${row.repo}#${row.number}`).sort()).toEqual([
      "acme/portal#2",
      "acme/widgets#1",
    ]);
    expect(body.repos).toEqual(["acme/portal", "acme/widgets"]);
  });

  test("a workspace with no live target answers empty arrays", async () => {
    const db = fixture();
    const res = await get(db, "ws-empty/api/pull-requests", "erin");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ pull_requests: [], repos: [] });
  });

  test("a plain member (not owner/admin) is refused on both list faces", async () => {
    const db = fixture();
    seedWorkspace(db, "ws-member", "gina", "member");
    seedBot(db, "bot-member", 9204);
    seedTarget(db, "bot-member", { workspaceId: "ws-member", repoName: "memberrepo" });
    for (const path of ["ws-member/api/insights/summary", "ws-member/api/pull-requests"]) {
      const res = await get(db, path, "gina");
      expect(res.status, path).toBe(403);
      expect(await res.json()).toEqual({ error: "forbidden" });
    }
  });
});

describe("GET /dashboard/<ref>/api/pull-requests/:owner/:repo/:number (workspace scope)", () => {
  test("the detail and its three record sections read a workspace's own PR", async () => {
    const db = fixture();
    for (const path of [
      "ws-two/api/pull-requests/acme/widgets/1",
      "ws-two/api/pull-requests/acme/widgets/1/findings",
      "ws-two/api/pull-requests/acme/widgets/1/reviews",
      "ws-two/api/pull-requests/acme/widgets/1/failures",
    ]) {
      expect((await get(db, path, "dana")).status, path).toBe(200);
    }
    const detail = (await (await get(db, "ws-two/api/pull-requests/acme/widgets/1", "dana")).json()) as {
      pull_request: { number: number; owner: string; repo: string };
      counts: { reviews: number };
    };
    expect(detail.pull_request).toMatchObject({ number: 1, owner: "acme", repo: "widgets" });
    expect(detail.counts.reviews).toBe(1);
  });

  test("a foreign workspace's PR is a 404, never another tenant's row", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "ws-two", "dana");
    seedWorkspace(db, "ws-foreign", "frank");
    seedBot(db, "bot-one", 9301);
    seedBot(db, "bot-foreign", 9302);
    const widgets = seedTarget(db, "bot-one", { workspaceId: "ws-two", repoOwner: "acme", repoName: "widgets" });
    const own = seedTarget(db, "bot-foreign", { workspaceId: "ws-foreign", repoOwner: "acme", repoName: "portal" });
    seedPullRequest(db, widgets, "bot-one", "acme", "widgets", 1);
    seedPullRequest(db, own, "bot-foreign", "acme", "portal", 2);

    // Both callers are managers of their own workspace, so only the SCOPE can
    // decide: frank's own PR reads 200, the same address under dana's workspace
    // is dana's 200, and a foreign workspace asking for it is a 404.
    expect((await get(db, "ws-foreign/api/pull-requests/acme/portal/2", "frank")).status).toBe(200);
    expect((await get(db, "ws-two/api/pull-requests/acme/widgets/1", "dana")).status).toBe(200);
    for (const path of [
      "ws-foreign/api/pull-requests/acme/widgets/1",
      "ws-foreign/api/pull-requests/acme/widgets/1/findings",
      "ws-foreign/api/pull-requests/acme/widgets/1/reviews",
      "ws-foreign/api/pull-requests/acme/widgets/1/failures",
    ]) {
      const res = await get(db, path, "frank");
      expect(res.status, path).toBe(404);
      expect(await res.json()).toEqual({ error: "unknown pull request" });
    }
  });
});
