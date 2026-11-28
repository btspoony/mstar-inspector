import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import type { DashboardD1, DashboardD1Statement } from "../../src/dashboard/users";
import type { D1StatementLike } from "../../src/store/types";
import { readChain, selectReviewBot, type RelayInput } from "../../src/worker/select-review-bot";

// The archived Review Bot (migration 0127) is SKIPPED by the relay exactly the
// way an unshared one is (D29): it stays mounted in the chain as an unavailable
// row, no quota read is spent on it, and it never becomes a refusal of its own.
//
// Skipping happens in the chain statement, not in the walk: an archived bot
// returns no row, so not even the ownership shortcut can select it.

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
  input: { id: string; workspaceId: string; scope: "owned" | "shared"; archived?: boolean },
): void {
  db.raw
    .prepare(
      `INSERT INTO review_bots (id, workspace_id, name, scope, multiplier, archived_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 10, ?, ?, ?)`,
    )
    .run(input.id, input.workspaceId, input.id, input.scope, input.archived ? TS : null, TS, TS);
}

function mountChain(db: TestD1, appId: string, workspaceId: string, botIds: readonly string[]): void {
  db.raw
    .prepare("INSERT OR REPLACE INTO app_installations (github_app_id, workspace_id, created_at) VALUES (?, ?, ?)")
    .run(appId, workspaceId, TS);
  db.raw.prepare("DELETE FROM app_install_bots WHERE github_app_id = ? AND workspace_id = ?").run(appId, workspaceId);
  botIds.forEach((botId, index) => {
    db.raw
      .prepare("INSERT INTO app_install_bots (github_app_id, workspace_id, position, bot_id) VALUES (?, ?, ?, ?)")
      .run(appId, workspaceId, index + 1, botId);
  });
}

function includeSharedBots(db: TestD1): void {
  db.raw
    .prepare(
      `INSERT INTO workspace_subscriptions (workspace_id, plan_id, status, created_at, updated_at)
       VALUES ('default', 'pro', 'active', ?, ?)`,
    )
    .run(TS, TS);
}

function relayInput(db: TestD1, appId: string, workspaceId = "default"): RelayInput {
  return {
    db: db as unknown as DashboardD1,
    mode: "saas",
    target: {
      id: `target-${appId}`,
      workspace_id: workspaceId,
      app_id: appId,
      name: `target-${appId}`,
      repo_id: null,
      repo_owner: "acme",
      repo_name: "widgets",
      review_level: "deep",
      check_min_score: 70,
      review_enabled: 1,
      review_drafts: 1,
      review_trigger_mode: "every_push",
      created_by: "tester",
      created_at: TS,
      updated_at: TS,
    } as RelayInput["target"],
    now: new Date(),
    level: "deep",
  };
}

/** A D1 face that records every statement a call issues. */
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

function failureRows(db: TestD1): number {
  const row = db.raw.query("SELECT COUNT(*) AS n FROM review_failures").get();
  if (row === null || typeof row !== "object" || !("n" in row)) return 0;
  return Number(row.n);
}

describe("an archived bot is off the chain, not a refusal", () => {
  test("chain [archived, live] selects the LIVE bot", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "provider");
    seedApp(db, "app-1");
    seedBot(db, { id: "bot-archived", workspaceId: "default", scope: "owned", archived: true });
    seedBot(db, { id: "bot-live", workspaceId: "default", scope: "owned" });
    mountChain(db, "app-1", "default", ["bot-archived", "bot-live"]);

    expect(await selectReviewBot(relayInput(db, "app-1"))).toEqual({ kind: "selected", botId: "bot-live" });
    db.raw.close();
  });

  test("an archived OWN bot is not selected by the ownership shortcut", async () => {
    const db = createMigratedTestD1();
    seedApp(db, "app-1");
    // Owned by the calling workspace: without the archive predicate the relay's
    // zero-read shortcut would return it.
    seedBot(db, { id: "bot-archived", workspaceId: "default", scope: "owned", archived: true });
    mountChain(db, "app-1", "default", ["bot-archived"]);

    expect(await selectReviewBot(relayInput(db, "app-1"))).toEqual({
      kind: "refused",
      refusal: { kind: "no-review-bot" },
    });
    db.raw.close();
  });

  test("an archived SHARED bot issues no quota read at all", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "provider");
    seedApp(db, "app-1");
    seedBot(db, { id: "bot-archived", workspaceId: "provider", scope: "shared", archived: true });
    seedBot(db, { id: "bot-own", workspaceId: "default", scope: "owned" });
    mountChain(db, "app-1", "default", ["bot-archived", "bot-own"]);
    includeSharedBots(db);

    const { d1, statements } = countingDb(db);
    expect(await selectReviewBot({ ...relayInput(db, "app-1"), db: d1 })).toEqual({
      kind: "selected",
      botId: "bot-own",
    });

    // One statement for the whole walk: the chain read. An archived shared bot
    // must cost the plan allowance nothing, so nothing quota-shaped is issued.
    expect(statements()).toHaveLength(1);
    expect(statements()[0]).toContain("archived_at IS NULL");
    db.raw.close();
  });

  test("an ALL-archived chain is no-review-bot, and the relay writes no failure row", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "provider");
    seedApp(db, "app-1");
    seedBot(db, { id: "bot-a", workspaceId: "default", scope: "owned", archived: true });
    seedBot(db, { id: "bot-b", workspaceId: "provider", scope: "shared", archived: true });
    mountChain(db, "app-1", "default", ["bot-a", "bot-b"]);
    includeSharedBots(db);

    const { d1, statements } = countingDb(db);
    expect(await selectReviewBot({ ...relayInput(db, "app-1"), db: d1 })).toEqual({
      kind: "refused",
      refusal: { kind: "no-review-bot" },
    });

    // Skipping is a read-side decision: the walk issues the chain statement and
    // records nothing — no failure row, no UPDATE of any kind.
    expect(statements().every((sql) => sql.startsWith("SELECT"))).toBe(true);
    expect(statements().filter((sql) => /review_failures/i.test(sql))).toEqual([]);
    expect(failureRows(db)).toBe(0);
    db.raw.close();
  });

  test("readChain answers only the live bots and keeps position order", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "provider");
    seedApp(db, "app-1");
    seedBot(db, { id: "bot-b", workspaceId: "provider", scope: "shared" });
    seedBot(db, { id: "bot-archived", workspaceId: "provider", scope: "shared", archived: true });
    seedBot(db, { id: "bot-a", workspaceId: "provider", scope: "shared" });
    mountChain(db, "app-1", "default", ["bot-b", "bot-archived", "bot-a"]);

    expect((await readChain(db as unknown as DashboardD1, "app-1", "default")).map((bot) => bot.botId)).toEqual([
      "bot-b",
      "bot-a",
    ]);
    db.raw.close();
  });

  test("restoring a bot (archived_at back to NULL) puts it back on the chain", async () => {
    const db = createMigratedTestD1();
    seedApp(db, "app-1");
    seedBot(db, { id: "bot-own", workspaceId: "default", scope: "owned", archived: true });
    mountChain(db, "app-1", "default", ["bot-own"]);
    expect(await selectReviewBot(relayInput(db, "app-1"))).toEqual({
      kind: "refused",
      refusal: { kind: "no-review-bot" },
    });

    db.raw.prepare("UPDATE review_bots SET archived_at = NULL WHERE id = 'bot-own'").run();
    expect(await selectReviewBot(relayInput(db, "app-1"))).toEqual({ kind: "selected", botId: "bot-own" });
    db.raw.close();
  });
});
