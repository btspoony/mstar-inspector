import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import { orphanLedgerAttributionBot } from "../../src/admin/data-upgrades/usage-bot-attribution";

const TS = "2026-10-24T00:00:00.000Z";

function seedWorkspace(db: TestD1, id: string): void {
  db.raw
    .prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES (?, ?, ?, ?)")
    .run(id, id, id, TS);
}

function seedBot(db: TestD1, id: string, workspaceId: string): void {
  db.raw
    .prepare(
      `INSERT INTO review_bots (id, workspace_id, name, multiplier, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
    )
    .run(id, workspaceId, id, TS, TS);
}

/** One review row naming `botId`, and one usage row for it. */
function seedPair(
  db: TestD1,
  input: { review: string; token: string; workspaceId: string; botId: string | null; rp: number },
): void {
  db.raw
    .prepare(
      `INSERT INTO reviews (id, installation_id, owner, repo, pr_number, head_sha, reviewed_at, verdict, bot_id)
       VALUES (?, 1, 'acme', 'widgets', 1, ?, ?, 'pass', ?)`,
    )
    .run(input.review, `sha-${input.review}`, TS, input.botId);
  db.raw
    .prepare(
      `INSERT INTO usage_events (review_id, seq, execution_token, workspace_id, occurred_at, rp, source)
       VALUES (?, 1, ?, ?, ?, ?, 'shared')`,
    )
    .run(input.review, input.token, input.workspaceId, TS, input.rp);
}

function attributed(db: TestD1): Array<{ token: string; bot_id: string | null }> {
  return db.raw
    .query("SELECT execution_token AS token, bot_id FROM usage_events ORDER BY execution_token")
    .all() as Array<{ token: string; bot_id: string | null }>;
}

describe("usage-bot-attribution — preflight", () => {
  test("counts attributed, unattributed, cross-workspace and evidenceless rows with rp > 0", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "ws-a");
    seedWorkspace(db, "ws-b");
    seedBot(db, "bot-a", "ws-a");
    seedBot(db, "bot-b", "ws-b");
    seedPair(db, { review: "r-mine", token: "t-mine", workspaceId: "ws-a", botId: "bot-a", rp: 10 });
    seedPair(db, { review: "r-none", token: "t-none", workspaceId: "ws-a", botId: null, rp: 10 });
    seedPair(db, { review: "r-cross", token: "t-cross", workspaceId: "ws-a", botId: "bot-b", rp: 10 });
    // A pre-metering row spends nothing and is out of the report's scope.
    seedPair(db, { review: "r-zero", token: "t-zero", workspaceId: "ws-a", botId: null, rp: 0 });

    // `unattributed_rows` is the WORK QUEUE: only rows this item can attribute.
    // The cross-workspace and evidenceless rows are reported on their own and
    // are permanently out of scope.
    expect(await orphanLedgerAttributionBot.preflight(db)).toEqual({
      attributed_rows: 0,
      unattributed_rows: 1,
      cross_workspace_rows: 1,
      no_evidence_rows: 1,
    });
    db.raw.close();
  });
});

describe("usage-bot-attribution — runBatch", () => {
  test("attributes a row to its review's bot when that bot is the payer's own", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "ws-a");
    seedBot(db, "bot-a", "ws-a");
    seedPair(db, { review: "r-mine", token: "t-mine", workspaceId: "ws-a", botId: "bot-a", rp: 10 });

    const batch = await orphanLedgerAttributionBot.runBatch(db, null);
    expect(batch).toMatchObject({ done: true, processed: 1, log: { attributed: 1, remaining: 0 } });
    expect(attributed(db)).toEqual([{ token: "t-mine", bot_id: "bot-a" }]);
    db.raw.close();
  });

  test("leaves a cross-workspace row NULL and advances past it, so the item still finishes", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "ws-a");
    seedWorkspace(db, "ws-b");
    seedBot(db, "bot-b", "ws-b");
    seedPair(db, { review: "r-cross", token: "t-cross", workspaceId: "ws-a", botId: "bot-b", rp: 10 });

    const batch = await orphanLedgerAttributionBot.runBatch(db, null);
    // The page was walked (processed 1) but the UPDATE's workspace guard refused
    // it, so nothing was attributed and nothing is left that COULD be.
    expect(batch).toMatchObject({ done: true, processed: 1, log: { attributed: 0, remaining: 0 } });
    expect(attributed(db)).toEqual([{ token: "t-cross", bot_id: null }]);
    db.raw.close();
  });

  test("a row whose review names no bot is never guessed and the cursor moves past it", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "ws-a");
    seedPair(db, { review: "r-none", token: "t-none", workspaceId: "ws-a", botId: null, rp: 10 });

    const first = await orphanLedgerAttributionBot.runBatch(db, null);
    // The page does not include it — its review names no bot, so no UPDATE is
    // even attempted — and the cursor is therefore null because nothing was read.
    expect(first.processed).toBe(0);
    expect(attributed(db)).toEqual([{ token: "t-none", bot_id: null }]);
    // The cursor is past the row, so a second call does not re-read it forever.
    const second = await orphanLedgerAttributionBot.runBatch(db, first.cursor);
    expect(second).toMatchObject({ processed: 0, done: true });
    db.raw.close();
  });

  test("resumes from a cursor without rewriting the rows it already passed", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "ws-a");
    seedBot(db, "bot-a", "ws-a");
    for (let i = 0; i < 3; i += 1) {
      seedPair(db, { review: `r-${i}`, token: `t-${i}`, workspaceId: "ws-a", botId: "bot-a", rp: 10 });
    }
    const first = await orphanLedgerAttributionBot.runBatch(db, null);
    expect(first.log?.attributed).toBe(3);
    // Re-running from the returned cursor finds nothing: the work is done.
    const second = await orphanLedgerAttributionBot.runBatch(db, first.cursor);
    expect(second).toMatchObject({ processed: 0, done: true, log: { attributed: 0 } });
    expect(attributed(db).every((row) => row.bot_id === "bot-a")).toBe(true);
    db.raw.close();
  });

  test("verify reports zero once attributed, and the remaining count before that", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "ws-a");
    seedBot(db, "bot-a", "ws-a");
    seedPair(db, { review: "r-mine", token: "t-mine", workspaceId: "ws-a", botId: "bot-a", rp: 10 });
    expect(await orphanLedgerAttributionBot.verify(db, { runStartedAt: null })).toEqual({
      unattributed_rows: 1,
    });
    await orphanLedgerAttributionBot.runBatch(db, null);
    expect(await orphanLedgerAttributionBot.verify(db, { runStartedAt: null })).toEqual({
      unattributed_rows: 0,
    });
    db.raw.close();
  });
});
