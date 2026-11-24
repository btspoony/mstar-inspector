import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMigratedTestD1, execMigrationScript, type TestD1 } from "./helpers";
import { tokenUsageStatements, type TokenUsageRow } from "../../src/store/token-usage-store";

const MIGRATION = "0109_review_token_usage.sql";
const ATTEMPT_A = "2b0c4f8e-7a11-4a4e-9b1f-2a5f4f2f1c01";
const ATTEMPT_B = "8f3d1a2b-9c44-4e55-b6d7-0e8f9a0b1c02";
const TARGET = "target-id-1";
const WORKSPACE = "workspace-id-1";

function buckets(): TokenUsageRow[] {
  return [
    { provider: "ark", model: "deepseek-v4-flash", input: 100, output: 40, cacheRead: 10, cacheWrite: 5, total: 155, requests: 3, costUsd: 0.0123 },
    { provider: "openai", model: "gpt-5.2", input: 7, output: 3, cacheRead: 0, cacheWrite: 0, total: 10, requests: 1, costUsd: 0.0004 },
  ];
}

function write(db: TestD1, attemptId: string, rows: TokenUsageRow[], occurredAt = "2026-11-25T10:00:00.000Z") {
  return tokenUsageStatements(db, { attemptId, targetId: TARGET, workspaceId: WORKSPACE, occurredAt, buckets: rows });
}

function rowsFor(db: TestD1, attemptId: string) {
  return db.raw
    .query("SELECT * FROM review_token_usage WHERE attempt_id = ? ORDER BY provider, model")
    .all(attemptId) as Array<Record<string, unknown>>;
}

describe("migrations/0109_review_token_usage.sql", () => {
  test("applies to bun:sqlite as DDL and the row shape matches the writer", async () => {
    const db = new Database(":memory:");
    execMigrationScript(db, readFileSync(join(import.meta.dir, "../../migrations", MIGRATION), "utf8"));

    const columns = (db.query("PRAGMA table_info(review_token_usage)").all() as Array<{ name: string }>).map(
      (column) => column.name,
    );
    expect(columns).toEqual([
      "attempt_id",
      "provider",
      "model",
      "target_id",
      "workspace_id",
      "input_tokens",
      "output_tokens",
      "cache_read_tokens",
      "cache_write_tokens",
      "total_tokens",
      "requests",
      "cost_usd",
      "occurred_at",
    ]);
    const index = db
      .query("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_review_token_usage_target'")
      .get() as { name: string } | null;
    expect(index?.name).toBe("idx_review_token_usage_target");

    const wrapped = createMigratedTestD1();
    await wrapped.batch(write(wrapped, ATTEMPT_A, [buckets()[0]!]));
    expect(rowsFor(wrapped, ATTEMPT_A)).toEqual([
      {
        attempt_id: ATTEMPT_A,
        provider: "ark",
        model: "deepseek-v4-flash",
        target_id: TARGET,
        workspace_id: WORKSPACE,
        input_tokens: 100,
        output_tokens: 40,
        cache_read_tokens: 10,
        cache_write_tokens: 5,
        total_tokens: 155,
        requests: 3,
        cost_usd: 0.0123,
        occurred_at: "2026-11-25T10:00:00.000Z",
      },
    ]);
  });
});

describe("review_token_usage is idempotent on (attempt_id, provider, model)", () => {
  test("writing the same attempt twice keeps the latest values, and a shorter replay drops the stale row", async () => {
    const db = createMigratedTestD1();
    await db.batch(write(db, ATTEMPT_A, buckets()));

    const replay: TokenUsageRow[] = [
      { provider: "ark", model: "deepseek-v4-flash", input: 200, output: 80, cacheRead: 20, cacheWrite: 10, total: 310, requests: 6, costUsd: 0.0246 },
      { provider: "openai", model: "gpt-5.2", input: 7, output: 3, cacheRead: 0, cacheWrite: 0, total: 10, requests: 1, costUsd: 0.0004 },
    ];
    await db.batch(write(db, ATTEMPT_A, replay, "2026-11-25T10:05:00.000Z"));

    expect(rowsFor(db, ATTEMPT_A)).toEqual([
      {
        attempt_id: ATTEMPT_A,
        provider: "ark",
        model: "deepseek-v4-flash",
        target_id: TARGET,
        workspace_id: WORKSPACE,
        input_tokens: 200,
        output_tokens: 80,
        cache_read_tokens: 20,
        cache_write_tokens: 10,
        total_tokens: 310,
        requests: 6,
        cost_usd: 0.0246,
        occurred_at: "2026-11-25T10:05:00.000Z",
      },
      {
        attempt_id: ATTEMPT_A,
        provider: "openai",
        model: "gpt-5.2",
        target_id: TARGET,
        workspace_id: WORKSPACE,
        input_tokens: 7,
        output_tokens: 3,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        total_tokens: 10,
        requests: 1,
        cost_usd: 0.0004,
        occurred_at: "2026-11-25T10:05:00.000Z",
      },
    ]);
    // A replay reporting fewer pairs keeps no stale row — the attempt-scoped
    // wipe inside the write set clears what the upserts no longer cover.
    await db.batch(write(db, ATTEMPT_A, [replay[0]!], "2026-11-25T10:10:00.000Z"));
    expect(rowsFor(db, ATTEMPT_A)).toEqual([
      {
        attempt_id: ATTEMPT_A,
        provider: "ark",
        model: "deepseek-v4-flash",
        target_id: TARGET,
        workspace_id: WORKSPACE,
        input_tokens: 200,
        output_tokens: 80,
        cache_read_tokens: 20,
        cache_write_tokens: 10,
        total_tokens: 310,
        requests: 6,
        cost_usd: 0.0246,
        occurred_at: "2026-11-25T10:10:00.000Z",
      },
    ]);

  });

  test("two attempts produce two row sets — a retried attempt never displaces another's rows", async () => {
    const db = createMigratedTestD1();
    await db.batch(write(db, ATTEMPT_A, buckets()));
    await db.batch(write(db, ATTEMPT_B, [buckets()[0]!]));

    expect(rowsFor(db, ATTEMPT_A)).toHaveLength(2);
    expect(rowsFor(db, ATTEMPT_B)).toHaveLength(1);
    expect(db.raw.query("SELECT COUNT(*) AS n FROM review_token_usage").get() as { n: number }).toEqual({ n: 3 });
  });
});
