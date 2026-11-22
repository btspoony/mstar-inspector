import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { createMigratedTestD1, seedBot, seedTarget, type TestD1 } from "../store/helpers";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { reviewUsageMonth } from "../../src/dashboard/review-usage-store";

const SESSION_SECRET = ["test", "admin", "usage", "secret", "32-bytes!"].join("-");
const OPERATOR = "Support-Bot";

function envFor(db: TestD1): Env {
  return {
    REVIEW_QUEUE: { send: async () => {} },
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} },
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    DEPLOYMENT_MODE: "saas",
    PLATFORM_OPERATORS: OPERATOR.toLowerCase(),
    DB: db,
  } as unknown as Env;
}

function seed(db: TestD1, sql: string, ...params: Array<string | number | null>): void {
  db.raw.prepare(sql).run(...params);
}

function seedUser(db: TestD1, login: string): void {
  seed(
    db,
    "INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES (?, ?, 'member', ?, NULL)",
    crypto.randomUUID(),
    login,
    "2026-10-01T00:00:00.000Z",
  );
}

function seedWorkspace(db: TestD1, id: string, name: string, deletedAt: string | null = null): void {
  seed(
    db,
    "INSERT INTO workspaces (id, slug, name, created_by, created_at, deleted_at) VALUES (?, ?, ?, NULL, ?, ?)",
    id,
    id,
    name,
    "2026-10-01T00:00:00.000Z",
    deletedAt,
  );
}

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

async function usageApi(db: TestD1, login: string | null = OPERATOR): Promise<Response> {
  const headers: Record<string, string> = { Accept: "application/json" };
  if (login !== null) headers.Cookie = `${SESSION_COOKIE}=${await createSessionValue(login, null, SESSION_SECRET)}`;
  return worker.fetch(
    new Request("https://worker.local/_internal_admin/api/usage", { headers }),
    envFor(db),
  );
}

function fixture(): TestD1 {
  const db = createMigratedTestD1();
  seedUser(db, OPERATOR);
  seedUser(db, "regular-member");
  seedWorkspace(db, "ws-alpha", "Alpha");
  seedWorkspace(db, "ws-beta", "Beta");
  seedWorkspace(db, "ws-gamma", "Gamma");
  seedWorkspace(db, "ws-retired", "Retired", "2026-11-01T00:00:00.000Z");

  seedBot(db, "bot-shared", 9201);
  seed(db, "UPDATE review_bots SET scope = 'shared', shared_at = '2026-10-01 00:00:00' WHERE id = 'bot-shared'");
  seedBot(db, "bot-alpha", 9202);
  seedBot(db, "bot-gamma", 9203);
  seedBot(db, "bot-retired", 9204);

  const alphaShared = seedTarget(db, "bot-shared", { workspaceId: "ws-alpha" });
  const alphaOwn = seedTarget(db, "bot-alpha", { workspaceId: "ws-alpha" });
  const gammaOwn = seedTarget(db, "bot-gamma", { workspaceId: "ws-gamma" });
  const retiredOwn = seedTarget(db, "bot-retired", { workspaceId: "ws-retired" });

  seedReviewNow(db, "r1", 1, alphaShared, "bot-shared");
  seedReviewNow(db, "r2", 2, alphaShared, "bot-shared");
  seedReviewNow(db, "r3", 3, alphaOwn, "bot-alpha");
  for (const id of ["r4", "r5", "r6", "r7"]) {
    seedReviewNow(db, id, Number(id.slice(1)), gammaOwn, "bot-gamma");
  }
  seedReviewNow(db, "r8", 8, retiredOwn, "bot-retired");
  return db;
}

describe("GET /_internal_admin/api/usage", () => {
  test("answers every live workspace with its two counts, in the decided order", async () => {
    const db = fixture();
    const res = await usageApi(db);
    expect(res.status).toBe(200);
    const body: unknown = await res.json();
    expect(body).toEqual({
      month: reviewUsageMonth(new Date()).month,
      workspaces: [
        { workspaceId: "ws-alpha", workspaceName: "Alpha", workspaceSlug: "ws-alpha", sharedReviews: 2, ownReviews: 1 },
        { workspaceId: "ws-gamma", workspaceName: "Gamma", workspaceSlug: "ws-gamma", sharedReviews: 0, ownReviews: 4 },
        { workspaceId: "ws-beta", workspaceName: "Beta", workspaceSlug: "ws-beta", sharedReviews: 0, ownReviews: 0 },
        { workspaceId: "default", workspaceName: "Default", workspaceSlug: "default", sharedReviews: 0, ownReviews: 0 },
      ],
    });
  });

  test("a non-operator and an anonymous caller both get the console's 404", async () => {
    const db = fixture();
    expect((await usageApi(db, "regular-member")).status).toBe(404);
    expect((await usageApi(db, null)).status).toBe(404);
  });
});
