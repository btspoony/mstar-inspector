import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import type { DashboardD1, DashboardD1Statement } from "../../src/dashboard/users";
import type { D1StatementLike } from "../../src/store/types";
import { readChain, selectReviewBot, type RelayInput } from "../../src/worker/select-review-bot";

const TS = "2026-10-24T00:00:00.000Z";

function seedWorkspace(db: TestD1, id: string): void {
  db.raw
    .prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)")
    .run(id, id, id, TS);
}

function seedApp(db: TestD1, appId: string): void {
  db.raw
    .prepare(
      `INSERT INTO github_apps
         (id, github_slug, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, scope, deleted_at, created_at, updated_at)
       VALUES (?, ?, 1, ?, 'k', 'w', 'tester', 'active', 'owned', NULL, ?, ?)`,
    )
    .run(appId, appId, appId, TS, TS);
}

function seedBot(
  db: TestD1,
  input: { id: string; workspaceId: string; scope: "owned" | "shared"; multiplier?: number; monthlyRp?: number | null },
): void {
  db.raw
    .prepare(
      `INSERT INTO review_bots (id, workspace_id, name, scope, multiplier, monthly_rp, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.id,
      input.workspaceId,
      input.id,
      input.scope,
      input.multiplier ?? 10,
      input.monthlyRp ?? null,
      TS,
      TS,
    );
}

function mountChain(db: TestD1, appId: string, workspaceId: string, botIds: readonly string[]): void {
  db.raw
    .prepare(
      "INSERT OR REPLACE INTO app_installations (github_app_id, workspace_id, created_at) VALUES (?, ?, ?)",
    )
    .run(appId, workspaceId, TS);
  db.raw.prepare("DELETE FROM app_install_bots WHERE github_app_id = ? AND workspace_id = ?").run(appId, workspaceId);
  botIds.forEach((botId, index) => {
    db.raw
      .prepare("INSERT INTO app_install_bots (github_app_id, workspace_id, position, bot_id) VALUES (?, ?, ?, ?)")
      .run(appId, workspaceId, index + 1, botId);
  });
}

function target(workspaceId: string, appId: string, level = "deep"): RelayInput["target"] {
  return {
    id: `target-${appId}`,
    workspace_id: workspaceId,
    app_id: appId,
    name: `target-${appId}`,
    repo_id: null,
    repo_owner: "acme",
    repo_name: "widgets",
    review_level: level,
    check_min_score: 70,
    review_enabled: 1,
    review_drafts: 1,
    review_trigger_mode: "every_push",
    created_by: "tester",
    created_at: TS,
    updated_at: TS,
  } as RelayInput["target"];
}

function relayInput(db: TestD1, appId: string, workspaceId = "default"): RelayInput {
  return {
    db: db as unknown as DashboardD1,
    mode: "saas",
    target: target(workspaceId, appId),
    now: new Date(),
    level: "deep",
  };
}

/**
 * A D1 face that records every statement a call issues. The relay's zero-read
 * guarantee is a STATEMENT COUNT, never an outcome: a shortcut that "happened
 * to pass because the workspace had room" is not the shortcut D15 describes.
 */
function countingDb(db: TestD1): { d1: DashboardD1; statements: () => string[] } {
  const log: string[] = [];
  const d1: DashboardD1 = {
    prepare(query: string): DashboardD1Statement {
      log.push(query.replace(/\s+/g, " ").trim());
      const inner = db.prepare(query) as unknown as D1StatementLike;
      return inner as unknown as DashboardD1Statement;
    },
    async batch(statements: D1StatementLike[]) {
      log.push(`batch(${statements.length})`);
      return db.batch(statements as unknown as D1StatementLike[]);
    },
  } as unknown as DashboardD1;
  return { d1, statements: () => log };
}

const QUOTA_TABLE = /quota_profile|usage_events|workspace_quota_binding|bot_quota_overrides|workspace_subscriptions|plans/i;

describe("selectReviewBot — the decision table", () => {
  test("[shared with room, own] selects the SHARED bot", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "provider");
    seedApp(db, "app-1");
    seedBot(db, { id: "bot-shared", workspaceId: "provider", scope: "shared" });
    seedBot(db, { id: "bot-own", workspaceId: "default", scope: "owned" });
    mountChain(db, "app-1", "default", ["bot-shared", "bot-own"]);
    // A plan that includes shared bots, with room to spare.
    db.raw
      .prepare(
        `INSERT INTO workspace_subscriptions (workspace_id, plan_id, status, created_at, updated_at)
         VALUES ('default', 'pro', 'active', ?, ?)`,
      )
      .run(TS, TS);

    expect(await selectReviewBot(relayInput(db, "app-1"))).toEqual({
      kind: "selected",
      botId: "bot-shared",
    });
    db.raw.close();
  });

  test("with the shared bot exhausted, the OWN bot is selected", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "provider");
    seedApp(db, "app-1");
    // 1 RP ceiling and a 60-RP review: the bot's own month is spent.
    seedBot(db, { id: "bot-shared", workspaceId: "provider", scope: "shared", multiplier: 10, monthlyRp: 1 });
    seedBot(db, { id: "bot-own", workspaceId: "default", scope: "owned" });
    mountChain(db, "app-1", "default", ["bot-shared", "bot-own"]);
    db.raw
      .prepare(
        `INSERT INTO workspace_subscriptions (workspace_id, plan_id, status, created_at, updated_at)
         VALUES ('default', 'pro', 'active', ?, ?)`,
      )
      .run(TS, TS);

    expect(await selectReviewBot(relayInput(db, "app-1"))).toEqual({
      kind: "selected",
      botId: "bot-own",
    });
    db.raw.close();
  });

  test("all shared bots exhausted, no own bot → ONE refusal naming the first blocked bot", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "provider");
    seedApp(db, "app-1");
    seedBot(db, { id: "bot-a", workspaceId: "provider", scope: "shared", multiplier: 10, monthlyRp: 1 });
    seedBot(db, { id: "bot-b", workspaceId: "provider", scope: "shared", multiplier: 10, monthlyRp: 1 });
    mountChain(db, "app-1", "default", ["bot-a", "bot-b"]);
    db.raw
      .prepare(
        `INSERT INTO workspace_subscriptions (workspace_id, plan_id, status, created_at, updated_at)
         VALUES ('default', 'pro', 'active', ?, ?)`,
      )
      .run(TS, TS);

    // One refusal for the whole delivery, and it names the LOWEST-position bot.
    expect(await selectReviewBot(relayInput(db, "app-1"))).toEqual({
      kind: "refused",
      refusal: { kind: "quota-bot", botId: "bot-a" },
    });
    db.raw.close();
  });

  test("an empty chain refuses no-review-bot, and that is not a quota fact", async () => {
    const db = createMigratedTestD1();
    seedApp(db, "app-1");
    mountChain(db, "app-1", "default", []);
    expect(await selectReviewBot(relayInput(db, "app-1"))).toEqual({
      kind: "refused",
      refusal: { kind: "no-review-bot" },
    });
    db.raw.close();
  });

  test("a bot the owner stopped sharing is SKIPPED, not refused", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "provider");
    seedApp(db, "app-1");
    // Owned by the provider (so not ours) but no longer shared.
    seedBot(db, { id: "bot-unshared", workspaceId: "provider", scope: "owned" });
    seedBot(db, { id: "bot-own", workspaceId: "default", scope: "owned" });
    mountChain(db, "app-1", "default", ["bot-unshared", "bot-own"]);

    expect(await selectReviewBot(relayInput(db, "app-1"))).toEqual({
      kind: "selected",
      botId: "bot-own",
    });
    db.raw.close();
  });
});

describe("selectReviewBot — the own-bot shortcut issues ZERO quota queries", () => {
  test("an own-bot-only chain reads the chain and nothing else", async () => {
    const db = createMigratedTestD1();
    seedApp(db, "app-1");
    seedBot(db, { id: "bot-own", workspaceId: "default", scope: "owned", monthlyRp: 1 });
    mountChain(db, "app-1", "default", ["bot-own"]);
    // A spent plan month: if the relay consulted any quota table, this would
    // refuse. It must select, because an own bot bypasses the plan ceiling (D15).
    db.raw
      .prepare(
        `INSERT INTO workspace_subscriptions (workspace_id, plan_id, status, created_at, updated_at)
         VALUES ('default', 'free', 'active', ?, ?)`,
      )
      .run(TS, TS);

    const { d1, statements } = countingDb(db);
    const outcome = await selectReviewBot({ ...relayInput(db, "app-1"), db: d1 });

    expect(outcome).toEqual({ kind: "selected", botId: "bot-own" });
    const issued = statements();
    // Exactly one statement: the chain read.
    expect(issued).toHaveLength(1);
    expect(issued[0]).toContain("app_install_bots");
    // PROOF, not outcome: no quota table was touched at all.
    expect(issued.filter((sql) => QUOTA_TABLE.test(sql))).toEqual([]);
    db.raw.close();
  });

  test("an own bot reached past an exhausted shared bot still issues no quota read after it", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "provider");
    seedApp(db, "app-1");
    seedBot(db, { id: "bot-shared", workspaceId: "provider", scope: "shared", multiplier: 10, monthlyRp: 1 });
    seedBot(db, { id: "bot-own", workspaceId: "default", scope: "owned" });
    mountChain(db, "app-1", "default", ["bot-shared", "bot-own"]);
    db.raw
      .prepare(
        `INSERT INTO workspace_subscriptions (workspace_id, plan_id, status, created_at, updated_at)
         VALUES ('default', 'pro', 'active', ?, ?)`,
      )
      .run(TS, TS);

    const { d1, statements } = countingDb(db);
    expect(await selectReviewBot({ ...relayInput(db, "app-1"), db: d1 })).toEqual({
      kind: "selected",
      botId: "bot-own",
    });

    // The shared bot's evaluation ran the quota reads; the own bot added NONE.
    // Cut the log at the last shared-bot quota read and assert nothing follows
    // but the selection.
    const issued = statements();
    const lastQuota = issued.reduce((last, sql, index) => (QUOTA_TABLE.test(sql) ? index : last), -1);
    expect(lastQuota).toBeGreaterThanOrEqual(0);
    expect(issued.slice(lastQuota + 1)).toEqual([]);
    db.raw.close();
  });
});

describe("readChain", () => {
  test("answers the chain in position order", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "provider");
    seedApp(db, "app-1");
    seedBot(db, { id: "bot-b", workspaceId: "provider", scope: "shared" });
    seedBot(db, { id: "bot-a", workspaceId: "provider", scope: "shared" });
    mountChain(db, "app-1", "default", ["bot-b", "bot-a"]);

    expect((await readChain(db as unknown as DashboardD1, "app-1", "default")).map((bot) => bot.botId)).toEqual([
      "bot-b",
      "bot-a",
    ]);
    db.raw.close();
  });
});
