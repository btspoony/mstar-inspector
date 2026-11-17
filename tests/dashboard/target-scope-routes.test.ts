/**
 * The target-addressed read family (plan 372 task 2 round B), driven through
 * the real worker mount:
 *
 *   GET /dashboard/<ref>/api/targets/<targetId>/insights/summary
 *   GET /dashboard/<ref>/api/targets/<targetId>/pull-requests[/<id>[/<section>]]
 *
 * Each resolves the target with `getInWorkspace(workspaceId, targetId)` and
 * binds `{ targetIds: [target.id], workspaceId }` to the same store call the
 * workspace face makes, so the payload keys cannot drift and a foreign id is
 * the resolution's own 404. The App-addressed family is removed with it.
 */
import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import type { Env } from "../../src/worker/env";
import { createMigratedTestD1, seedBot, seedTarget, type TestD1 } from "../store/helpers";
import { withSpaAssets } from "../helpers/spa";

const SESSION_SECRET = ["test", "target", "scope", "session", "32-bytes!"].join("-");

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

function seedWorkspace(db: TestD1, id: string, login: string): void {
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
    "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
    id,
    userId,
    "2026-10-01T00:00:00.000Z",
  );
}

function seedReview(db: TestD1, id: string, targetId: string, botId: string, repo: string, number: number): void {
  seed(
    db,
    `INSERT INTO reviews
       (id, installation_id, owner, repo, pr_number, head_sha, reviewed_at, verdict, summary_md, envelope, bot_id, target_id)
     VALUES (?, 1, 'acme', ?, ?, 'sha', datetime('now'), 'approved', 's', '{}', ?, ?)`,
    id,
    repo,
    number,
    botId,
    targetId,
  );
}

function seedPullRequest(db: TestD1, targetId: string, botId: string, repo: string, number: number): void {
  seed(
    db,
    `INSERT INTO pull_requests (id, bot_id, target_id, owner, repo, pr_number, title, state)
     VALUES (?, ?, ?, 'acme', ?, ?, 'A change', 'open')`,
    crypto.randomUUID(),
    botId,
    targetId,
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
 * one ledger row each); `ws-foreign` owns a target of its own and must never
 * read `ws-two`'s ids.
 */
function fixture(): { db: TestD1; widgets: string; portal: string } {
  const db = createMigratedTestD1();
  seedWorkspace(db, "ws-two", "dana");
  seedWorkspace(db, "ws-foreign", "frank");
  seedBot(db, "bot-one", 9201);
  seedBot(db, "bot-two", 9202);
  seedBot(db, "bot-foreign", 9203);
  const widgets = seedTarget(db, "bot-one", { id: "t-widgets", workspaceId: "ws-two", repoName: "widgets" });
  const portal = seedTarget(db, "bot-two", { id: "t-portal", workspaceId: "ws-two", repoName: "portal" });
  seedTarget(db, "bot-foreign", { id: "t-foreign", workspaceId: "ws-foreign" });
  seedReview(db, "r-widgets", widgets, "bot-one", "widgets", 1);
  seedReview(db, "r-portal", portal, "bot-two", "portal", 2);
  seedPullRequest(db, widgets, "bot-one", "widgets", 1);
  seedPullRequest(db, portal, "bot-two", "portal", 2);
  return { db, widgets, portal };
}

describe("GET /dashboard/<ref>/api/targets/:targetId/insights/summary", () => {
  test("answers the single-target aggregate, identical to the App face's payload keys", async () => {
    const { db } = fixture();
    const res = await get(db, "ws-two/api/targets/t-widgets/insights/summary?include=repos", "dana");
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(body).sort()).toEqual(
      [
        "window_days",
        "reviews_total",
        "findings_by_severity",
        "verdict_distribution",
        "weekly_trend",
        "daily_trend",
        "findings_distribution",
        "repos",
      ].sort(),
    );
    // Target scope, not workspace scope: one of the workspace's two reviews.
    expect(body.reviews_total).toBe(1);
    expect(body.repos).toEqual(["acme/widgets"]);
  });

  test("a target from another workspace is the same 404 as an unknown one", async () => {
    const { db } = fixture();
    for (const [path, login] of [
      ["ws-two/api/targets/t-foreign/insights/summary", "dana"],
      ["ws-two/api/targets/t-foreign/pull-requests", "dana"],
      ["ws-foreign/api/targets/t-widgets/insights/summary", "frank"],
      ["ws-two/api/targets/no-such-target/insights/summary", "dana"],
    ] as const) {
      const res = await get(db, path, login);
      expect(res.status, path).toBe(404);
      expect(await res.json(), path).toEqual({ error: "unknown target" });
    }
  });

  test("a soft-deleted target answers 404", async () => {
    const { db } = fixture();
    seed(db, "UPDATE review_targets SET deleted_at = datetime('now') WHERE id = 't-widgets'");
    const res = await get(db, "ws-two/api/targets/t-widgets/insights/summary", "dana");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown target" });
  });
});

describe("GET /dashboard/<ref>/api/targets/:targetId/pull-requests", () => {
  test("lists the target's ledger only, with the same row shape and option set", async () => {
    const { db } = fixture();
    const res = await get(db, "ws-two/api/targets/t-widgets/pull-requests", "dana");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      pull_requests: Array<{ number: number; owner: string; repo: string; title: string; state: string }>;
      repos: string[];
    };
    expect(body.pull_requests.map((row) => `${row.owner}/${row.repo}#${row.number}`)).toEqual(["acme/widgets#1"]);
    expect(body.pull_requests[0]).toMatchObject({ title: "A change", state: "open" });
    expect(body.repos).toEqual(["acme/widgets"]);
  });

  test("the detail head and its three record families are target-scoped", async () => {
    const { db } = fixture();
    const head = await get(db, "ws-two/api/targets/t-widgets/pull-requests/acme/widgets/1", "dana");
    expect(head.status).toBe(200);
    const headBody = (await head.json()) as { pull_request: { number: number }; counts: unknown };
    expect(headBody.pull_request.number).toBe(1);
    expect(headBody.counts).toEqual({ findings: 0, reviews: 1, failures: 0, must_fix: 0 });

    for (const section of ["findings", "reviews", "failures"] as const) {
      const res = await get(db, `ws-two/api/targets/t-widgets/pull-requests/acme/widgets/1/${section}`, "dana");
      expect(res.status, section).toBe(200);
      const body = (await res.json()) as { items: unknown[]; total: number; limit: number };
      expect(body.limit, section).toBe(10);
      // The family answers this target's page: one review, no findings/failures.
      expect(body.total, section).toBe(section === "reviews" ? 1 : 0);
    }

    // The other target's tuple is a miss under this target, not a fallback.
    const miss = await get(db, "ws-two/api/targets/t-widgets/pull-requests/acme/portal/2", "dana");
    expect(miss.status).toBe(404);
    expect(await miss.json()).toEqual({ error: "unknown pull request" });
  });

  test("a foreign target's ledger is a 404, never an empty 200", async () => {
    const { db } = fixture();
    const res = await get(db, "ws-two/api/targets/t-foreign/pull-requests", "dana");
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "unknown target" });
  });
});

describe("the target scope is the single-target scope", () => {
  test("the route payload equals the store's one-id aggregation", async () => {
    const { db } = fixture();
    // The App-addressed face resolved its target via `firstTargetForBot` and
    // bound `{ targetIds: [target.id], workspaceId }`; the target face binds the
    // same pair for the id in the path, so the numbers cannot differ.
    const scope = { targetIds: ["t-portal"], workspaceId: "ws-two" };
    const expected = await createInsightsStore(db, { ...scope, windowDays: 30, includeRepos: true });
    const res = await get(db, "ws-two/api/targets/t-portal/insights/summary?include=repos", "dana");
    const body = (await res.json()) as { reviews_total: number; repos: string[]; verdict_distribution: unknown[] };
    expect(body.reviews_total).toBe(expected.reviewsTotal);
    expect(body.repos).toEqual(expected.repos);
    expect(body.verdict_distribution).toEqual(expected.verdictDistribution);

    const expectedLedger = await createReviewBotsStore(db).listPullRequests(scope);
    const ledger = await get(db, "ws-two/api/targets/t-portal/pull-requests", "dana");
    const ledgerBody = (await ledger.json()) as { pull_requests: Array<{ number: number }>; repos: string[] };
    expect(ledgerBody.pull_requests.map((row) => row.number)).toEqual(expectedLedger.rows.map((row) => row.number));
    expect(ledgerBody.repos).toEqual(expectedLedger.repos);
  });
});

describe("the removed App-addressed family", () => {
  test("every retired path answers 404 while the workspace faces stay", async () => {
    const { db } = fixture();
    for (const path of [
      "ws-two/api/apps/9201/insights/summary",
      "ws-two/api/apps/9201/pull-requests",
      "ws-two/api/apps/9201/pull-requests/acme/widgets/1",
      "ws-two/api/apps/9201/pull-requests/acme/widgets/1/findings",
      "ws-two/api/apps/9201/pull-requests/acme/widgets/1/reviews",
      "ws-two/api/apps/9201/pull-requests/acme/widgets/1/failures",
    ]) {
      const res = await get(db, path, "dana");
      expect(res.status, path).toBe(404);
    }
    // The workspace-scope siblings are untouched by the removal.
    expect((await get(db, "ws-two/api/insights/summary", "dana")).status).toBe(200);
    expect((await get(db, "ws-two/api/pull-requests", "dana")).status).toBe(200);
  });
});
