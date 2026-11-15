/**
 * The workspace usage read through the real worker mount:
 * `GET /dashboard/<ref>/api/settings/review-usage`
 * (spec bot-scope-and-claiming § Review usage).
 *
 * Pinned at the product seams: a member reads this workspace's two counts for
 * the current UTC month and nothing about another tenant, a caller who is not
 * a member of the addressed workspace gets the same 404 an unknown ref does,
 * and the shared-bot state follows the plan resolution plus the platform's
 * designated `shared` bot. The route writes nothing.
 */
import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { reviewUsageMonth } from "../../src/dashboard/review-usage-store";
import type { Env } from "../../src/worker/env";
import { createMigratedTestD1, seedBot, seedTarget, type TestD1 } from "../store/helpers";
import { withSpaAssets } from "../helpers/spa";

const SESSION_SECRET = ["test", "review", "usage", "session", "32-bytes!"].join("-");
const OPERATOR = "Support-Bot";

function envFor(db: TestD1, overrides: Partial<Env> = {}): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} },
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} },
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "oauth-client-secret",
    DEPLOYMENT_MODE: "saas",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    PLATFORM_OPERATORS: OPERATOR.toLowerCase(),
    DB: db,
    ...overrides,
  } as unknown as Env;
}

function seed(db: TestD1, sql: string, ...params: Array<string | number | null>): void {
  db.raw.prepare(sql).run(...params);
}

function seedUser(db: TestD1, login: string): string {
  const id = crypto.randomUUID();
  seed(
    db,
    "INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES (?, ?, 'member', ?, NULL)",
    id,
    login,
    "2026-10-01T00:00:00.000Z",
  );
  return id;
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
    "2026-10-01T00:00:00.000Z",
  );
}

function seedWorkspace(db: TestD1, id: string, slug: string): void {
  seed(
    db,
    "INSERT INTO workspaces (id, slug, name, created_by, created_at, deleted_at) VALUES (?, ?, ?, NULL, ?, NULL)",
    id,
    slug,
    slug,
    "2026-10-01T00:00:00.000Z",
  );
}

/** One review stamped in the route's own month (the current instant). */
function seedReviewNow(db: TestD1, id: string, prNumber: number, targetId: string, botId: string): void {
  seed(
    db,
    `INSERT INTO reviews
       (id, installation_id, owner, repo, pr_number, head_sha, reviewed_at, verdict, bot_id, target_id)
     VALUES (?, 1, 'acme', 'widgets', ?, ?, ?, 'pass', ?, ?)`,
    id,
    prNumber,
    id,
    new Date().toISOString().slice(0, 19).replace("T", " "),
    botId,
    targetId,
  );
}

async function getUsage(db: TestD1, ref: string, login: string | null): Promise<Response> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (login !== null) headers.Cookie = `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}`;
  return worker.fetch(
    new Request(`https://worker.local/dashboard/${ref}/api/settings/review-usage`, { headers }),
    withSpaAssets(envFor(db)),
  );
}

/**
 * `ws-acme` (owner `dana`, plain member `frank`) with a `pro` subscription, a
 * `shared` bot and an own bot, each with one target. `ws-other` (`olga` is its
 * member) carries four own-bot reviews of its own.
 */
function fixture(): TestD1 {
  const db = createMigratedTestD1();
  const dana = seedUser(db, "dana");
  const frank = seedUser(db, "frank");
  const olga = seedUser(db, "olga");
  seedUser(db, OPERATOR);
  seedWorkspace(db, "ws-acme", "acme");
  seedWorkspace(db, "ws-other", "other");
  seedMembership(db, "ws-acme", dana, "owner");
  seedMembership(db, "ws-acme", frank, "member");
  seedMembership(db, "ws-other", olga, "member");
  seed(
    db,
    "INSERT INTO workspace_subscriptions (workspace_id, plan_id, status, created_at, updated_at) VALUES ('ws-acme', 'pro', 'active', ?, ?)",
    "2026-10-01T00:00:00.000Z",
    "2026-10-01T00:00:00.000Z",
  );

  seedBot(db, "bot-shared", 9101);
  seed(db, "UPDATE review_bots SET scope = 'shared', shared_at = '2026-10-01 00:00:00' WHERE id = 'bot-shared'");
  seedBot(db, "bot-own", 9102);
  seedBot(db, "bot-other", 9103);
  const sharedTarget = seedTarget(db, "bot-shared", { workspaceId: "ws-acme" });
  const ownTarget = seedTarget(db, "bot-own", { workspaceId: "ws-acme" });
  const otherTarget = seedTarget(db, "bot-other", { workspaceId: "ws-other" });

  seedReviewNow(db, "r-acme-shared-1", 1, sharedTarget, "bot-shared");
  seedReviewNow(db, "r-acme-shared-2", 2, sharedTarget, "bot-shared");
  seedReviewNow(db, "r-acme-own", 3, ownTarget, "bot-own");
  for (const [index, id] of ["r-other-1", "r-other-2", "r-other-3", "r-other-4"].entries()) {
    seedReviewNow(db, id!, index + 10, otherTarget, "bot-other");
  }
  return db;
}

describe("GET /dashboard/<ref>/api/settings/review-usage", () => {
  test("a member reads this workspace's two counts and nothing about another workspace", async () => {
    const db = fixture();
    const res = await getUsage(db, "ws-acme", "frank");
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toEqual({
      month: reviewUsageMonth(new Date()).month,
      sharedReviews: 2,
      ownReviews: 1,
      sharedBot: "available",
    });
    // ws-other's four reviews stay out of this payload entirely.
    expect(JSON.stringify(body)).not.toContain("ws-other");
  });

  test("a caller who is not a member of the addressed workspace gets the tenant 404", async () => {
    const db = fixture();
    // A member of ws-other addressing ws-acme, and a member of ws-acme
    // addressing ws-other: neither can read the other tenant's row.
    expect((await getUsage(db, "ws-acme", "olga")).status).toBe(404);
    expect((await getUsage(db, "ws-other", "frank")).status).toBe(404);
    expect((await getUsage(db, "ws-acme", null)).status).toBe(302);
  });

  test("the shared-bot state follows the plan and the designated bot", async () => {
    const db = fixture();
    const stateOf = async (ref: string): Promise<unknown> => {
      const res = await getUsage(db, ref, "dana");
      expect(res.status).toBe(200);
      const body: unknown = await res.json();
      if (typeof body !== "object" || body === null || !("sharedBot" in body)) {
        throw new Error("usage payload carries no sharedBot");
      }
      return body.sharedBot;
    };

    // `pro` plus a live `shared` bot.
    expect(await stateOf("ws-acme")).toBe("available");

    // The capability without a designated shared bot: no operator has shared
    // one, so the reader has nothing to buy.
    seed(db, "UPDATE review_bots SET scope = 'owned', shared_at = NULL WHERE id = 'bot-shared'");
    expect(await stateOf("ws-acme")).toBe("not-designated");

    // A plan without the capability: the reader's own plan is the fix.
    seed(db, "DELETE FROM workspace_subscriptions WHERE workspace_id = 'ws-acme'");
    expect(await stateOf("ws-acme")).toBe("not-in-plan");
  });
});
