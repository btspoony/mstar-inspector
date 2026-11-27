import { describe, expect, test } from "bun:test";
import worker from "../../src/worker/index";
import type { Env } from "../../src/worker/env";
import { SESSION_COOKIE, createSessionValue } from "../../src/dashboard/session";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import type { BotMultipliersReport } from "../../src/contracts/bot-multipliers";

const SESSION_SECRET = ["test", "bot", "multipliers", "session", "32-bytes!"].join("-");
const OPERATOR = "Multiplier-Operator";
const TS = "2026-11-27T00:00:00.000Z";

function envFor(db: TestD1): Env {
  return {
    REVIEW_QUEUE: { send: async () => {}, metrics: async () => ({ backlogCount: 0, backlogBytes: 0 }) },
    IDEMPOTENCY_KV: { get: async () => null, put: async () => {} },
    GITHUB_OAUTH_CLIENT_ID: "oauth-client-id",
    GITHUB_OAUTH_CLIENT_SECRET: "oauth-client-secret",
    DEPLOYMENT_MODE: "saas",
    DASHBOARD_SESSION_SECRET: SESSION_SECRET,
    PLATFORM_OPERATORS: OPERATOR.toLowerCase(),
    DB: db,
  } as unknown as Env;
}

function seedWorkspace(db: TestD1, id: string): void {
  db.raw
    .prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)")
    .run(id, id, id, TS);
}

function seedBot(db: TestD1, input: { id: string; workspaceId: string; multiplier: number; deletedAt?: string }): void {
  db.raw
    .prepare(
      `INSERT INTO review_bots (id, workspace_id, name, multiplier, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(input.id, input.workspaceId, input.id, input.multiplier, input.deletedAt ?? null, TS, TS);
}

function fixture(): TestD1 {
  const db = createMigratedTestD1();
  db.raw
    .prepare("INSERT INTO users (id, github_login, role, created_at, invited_by) VALUES (?, ?, 'member', ?, NULL)")
    .run(crypto.randomUUID(), OPERATOR, TS);
  seedWorkspace(db, "ws-a");
  return db;
}

async function readReport(db: TestD1): Promise<BotMultipliersReport> {
  const res = await worker.fetch(
    new Request("https://worker.local/_internal_admin/api/runtime/bot-multipliers", {
      headers: { Cookie: `${SESSION_COOKIE}=${await createSessionValue(OPERATOR, null, SESSION_SECRET)}` },
    }),
    envFor(db),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as BotMultipliersReport;
}

describe("GET /_internal_admin/api/runtime/bot-multipliers", () => {
  test("groups every live Bot by multiplier with a count and the Bots at each value", async () => {
    const db = fixture();
    seedBot(db, { id: "bot-one", workspaceId: "ws-a", multiplier: 1 });
    seedBot(db, { id: "bot-two", workspaceId: "ws-a", multiplier: 1.5 });
    seedBot(db, { id: "bot-three", workspaceId: "ws-a", multiplier: 1.5 });

    const report = await readReport(db);
    expect(report.groups.length).toBe(2);
    // Ascending by multiplier: the value the rollback question asks about first
    // is the cheapest live price.
    const [one, two] = report.groups;
    expect(one?.multiplier).toBe(1);
    expect(one?.count).toBe(1);
    expect(one?.bots).toEqual([{ botId: "bot-one", name: "bot-one", workspaceId: "ws-a" }]);
    expect(two?.multiplier).toBe(1.5);
    expect(two?.count).toBe(2);
    expect(two?.bots.map((bot) => bot.botId).sort()).toEqual(["bot-three", "bot-two"]);
    // The count is the group's own count, never a total folded across values.
    expect(two?.count).toBe(two?.bots.length);
  });

  test("answers an empty distribution when no live Bot exists", async () => {
    const db = fixture();
    expect(await readReport(db)).toEqual({ groups: [] });
  });

  test("a soft-deleted Bot is absent from every group", async () => {
    const db = fixture();
    seedBot(db, { id: "bot-live", workspaceId: "ws-a", multiplier: 2 });
    seedBot(db, { id: "bot-gone", workspaceId: "ws-a", multiplier: 2, deletedAt: TS });

    const report = await readReport(db);
    expect(report.groups.length).toBe(1);
    const [group] = report.groups;
    expect(group?.count).toBe(1);
    expect(group?.bots.map((bot) => bot.botId)).toEqual(["bot-live"]);
  });
});
