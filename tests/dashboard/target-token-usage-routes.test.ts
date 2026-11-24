import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import type { Env } from "../../src/worker/env";
import { tokenUsageStatements, type TokenUsageRow } from "../../src/store/token-usage-store";
import { createMigratedTestD1, seedBot, seedTarget, type TestD1 } from "../store/helpers";
import { withSpaAssets } from "../helpers/spa";

/**
 * Seed ages land on `occurred_at` in the exact `new Date().toISOString()`
 * format the pipeline writes — matching the production write face is what
 * makes the window predicate's string comparison exercised at all.
 */
const DAY_MS = 86_400_000;

const SESSION_SECRET = ["test", "token", "usage", "session", "32-bytes!"].join("-");

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
  seed(
    db,
    "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES (?, ?, 'owner', ?)",
    id,
    userId,
    "2026-10-01T00:00:00.000Z",
  );
}

let attemptCounter = 0;

/**
 * One usage row for `targetId`, written through the same statements the
 * pipeline batches — `occurredAt` is the write-time instant, so a seeded
 * age lands inside/outside the window the same way a live row would.
 */
async function seedUsage(
  db: TestD1,
  targetId: string,
  workspaceId: string,
  bucket: TokenUsageRow,
  daysAgo: number,
): Promise<void> {
  await db.batch(
    tokenUsageStatements(db, {
      attemptId: `attempt-${(attemptCounter += 1)}`,
      targetId,
      workspaceId,
      occurredAt: new Date(Date.now() - daysAgo * DAY_MS).toISOString(),
      buckets: [bucket],
    }),
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

const ARK = { provider: "ark", model: "deepseek-v4-flash" };
const OPENAI = { provider: "openai", model: "gpt-5.2" };

function fixture(): { db: TestD1; widgets: string; portal: string } {
  const db = createMigratedTestD1();
  seedWorkspace(db, "ws-two", "dana");
  seedWorkspace(db, "ws-foreign", "frank");
  seedBot(db, "bot-one", 9301);
  seedBot(db, "bot-two", 9302);
  seedBot(db, "bot-foreign", 9303);
  const widgets = seedTarget(db, "bot-one", { id: "t-widgets", workspaceId: "ws-two", repoName: "widgets" });
  const portal = seedTarget(db, "bot-two", { id: "t-portal", workspaceId: "ws-two", repoName: "portal" });
  seedTarget(db, "bot-foreign", { id: "t-foreign", workspaceId: "ws-foreign" });
  return { db, widgets, portal };
}

describe("GET /dashboard/<ref>/api/targets/:targetId/token-usage", () => {
  test("two providers aggregate separately, with a total, scoped to the target", async () => {
    const { db, widgets, portal } = fixture();
    // Exact binary fractions so SUM and JS addition agree to the bit.
    await seedUsage(db, widgets, "ws-two", { ...ARK, input: 100, output: 40, cacheRead: 10, cacheWrite: 5, total: 155, requests: 3, costUsd: 0.5 }, 1);
    await seedUsage(db, widgets, "ws-two", { ...ARK, input: 50, output: 20, cacheRead: 0, cacheWrite: 0, total: 70, requests: 2, costUsd: 0.25 }, 2);
    await seedUsage(db, widgets, "ws-two", { ...OPENAI, input: 7, output: 3, cacheRead: 0, cacheWrite: 0, total: 10, requests: 1, costUsd: 0.125 }, 1);
    // Same workspace, other target — must never leak into this read.
    await seedUsage(db, portal, "ws-two", { ...OPENAI, input: 900, output: 90, cacheRead: 9, cacheWrite: 9, total: 1008, requests: 9, costUsd: 9.9 }, 1);

    const res = await get(db, "ws-two/api/targets/t-widgets/token-usage?window=30", "dana");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      window_days: number;
      buckets: Array<Record<string, number | string>>;
      total: Record<string, number>;
    };
    expect(body.window_days).toBe(30);
    expect(body.buckets).toEqual([
      { provider: "ark", model: "deepseek-v4-flash", requests: 5, input: 150, cache_read: 10, cache_write: 5, output: 60, total: 225, cost_usd: 0.75 },
      { provider: "openai", model: "gpt-5.2", requests: 1, input: 7, cache_read: 0, cache_write: 0, output: 3, total: 10, cost_usd: 0.125 },
    ]);
    expect(body.total).toEqual({
      requests: 6,
      input: 157,
      cache_read: 10,
      cache_write: 5,
      output: 63,
      total: 235,
      cost_usd: 0.875,
    });
  });

  test("the window predicate is UTC and half-open: old rows fall out, a just-written row stays in", async () => {
    const { db, widgets } = fixture();
    await seedUsage(db, widgets, "ws-two", { ...ARK, input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15, requests: 1, costUsd: 0.001 }, 2);
    // Written at the current instant — the case a space-formatted upper bound hid.
    await seedUsage(db, widgets, "ws-two", { ...ARK, input: 2, output: 1, cacheRead: 0, cacheWrite: 0, total: 7, requests: 1, costUsd: 0.001 }, 0);
    await seedUsage(db, widgets, "ws-two", { ...ARK, input: 40, output: 8, cacheRead: 0, cacheWrite: 0, total: 48, requests: 1, costUsd: 0.004 }, 40);
    const res = await get(db, "ws-two/api/targets/t-widgets/token-usage", "dana");
    expect(res.status).toBe(200);
    const body = (await res.json()) as {
      window_days: number;
      buckets: Array<{ input: number; total: number }>;
      total: { total: number };
    };
    expect(body.window_days).toBe(30);
    expect(body.buckets).toHaveLength(1);
    expect(body.buckets[0]).toMatchObject({ input: 12, total: 22 });
    expect(body.total.total).toBe(22);
  });

  test("a target with no rows answers the empty shape, not an error", async () => {
    const { db } = fixture();
    const res = await get(db, "ws-two/api/targets/t-portal/token-usage?window=7", "dana");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { window_days: number; buckets: unknown[]; total: { total: number } };
    expect(body.window_days).toBe(7);
    expect(body.buckets).toEqual([]);
    expect(body.total.total).toBe(0);
  });

  test("a foreign or unknown target is refused exactly like the sibling target routes", async () => {
    const { db } = fixture();
    for (const [path, login] of [
      ["ws-two/api/targets/t-foreign/token-usage", "dana"],
      ["ws-foreign/api/targets/t-widgets/token-usage", "frank"],
      ["ws-two/api/targets/no-such-target/token-usage", "dana"],
    ] as const) {
      const res = await get(db, path, login);
      expect(res.status, path).toBe(404);
      expect(await res.json(), path).toEqual({ error: "unknown target" });
    }
  });

  test("a non-numeric window answers the insights parser's 400", async () => {
    const { db } = fixture();
    const res = await get(db, "ws-two/api/targets/t-widgets/token-usage?window=soon", "dana");
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "window must be a non-negative integer number of days" });
  });
});
