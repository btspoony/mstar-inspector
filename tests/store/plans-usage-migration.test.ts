/**
 * Migration 0031: plan catalogue, workspace subscriptions, usage ledger.
 *
 * The migration is the product here, so the assertions pin its contract rather
 * than the DDL text: free.monthly_price_cents is 0 (a configured free plan),
 * while pro.monthly_price_cents and both extra_member_price_cents are NULL
 * (not configured); absence-of-subscription is the free default; and the
 * (review_id, seq) usage ledger key. The fixture is the fully-migrated D1
 * double, which walks `migrations/` in filename order exactly like
 * `wrangler d1 migrations apply`.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMigratedTestD1 } from "./helpers";

const MIGRATION = "0031_plans_usage.sql";

describe("migration 0031 (plans + workspace_subscriptions + usage_events)", () => {
  // 0032 replaced the catalogue with a nullable-seat shape and added the
  // `unlimited` tier, so the applied DB carries three rows: 0031's free/pro
  // seed plus 0032's every-quota-NULL tier (timestamps stay the fixed seeds).
  test("plans has the three catalogue rows — free, pro and the unlimited tier — with the fixed timestamps", () => {
    const db = createMigratedTestD1();
    expect(db.raw.query("SELECT * FROM plans ORDER BY id").all()).toEqual([
      {
        id: "free",
        name: "Free",
        monthly_price_cents: 0,
        included_members: 5,
        extra_member_price_cents: null,
        platform_key_limit: null,
        reviews_included: null,
        apps_per_workspace: null,
        created_at: "2026-10-24T00:00:00.000Z",
      },
      {
        id: "pro",
        name: "Pro",
        monthly_price_cents: null,
        included_members: 5,
        extra_member_price_cents: null,
        platform_key_limit: null,
        reviews_included: null,
        apps_per_workspace: null,
        created_at: "2026-10-24T00:00:00.000Z",
      },
      {
        id: "unlimited",
        name: "Unlimited",
        monthly_price_cents: null,
        included_members: null,
        extra_member_price_cents: null,
        platform_key_limit: null,
        reviews_included: null,
        apps_per_workspace: null,
        created_at: "2026-10-25T00:00:00.000Z",
      },
    ]);
    db.raw.close();
  });

  test("a workspace without a subscription row is the free default (no backfill)", () => {
    const db = createMigratedTestD1();
    const row = db.raw
      .query("SELECT count(*) AS n FROM workspace_subscriptions")
      .get() as { n: number };
    expect(row.n).toBe(0);
    db.raw.close();
  });

  test("workspace_subscriptions points at an existing workspace and plan", () => {
    const db = createMigratedTestD1();
    const insert = db.raw.prepare(
      "INSERT INTO workspace_subscriptions (workspace_id, plan_id, status, created_at, updated_at) VALUES (?, ?, 'active', ?, ?)",
    );
    const ts = "2026-10-24T00:00:00.000Z";
    insert.run("default", "free", ts, ts);
    expect(() => insert.run("missing", "free", ts, ts)).toThrow();
    expect(() => insert.run("default", "missing", ts, ts)).toThrow();
    db.raw.close();
  });

  test("usage_events keys usage per (review_id, seq) and needs a real workspace", () => {
    const db = createMigratedTestD1();
    const insert = db.raw.prepare(
      "INSERT INTO usage_events (review_id, seq, execution_token, workspace_id, occurred_at) VALUES (?, ?, ?, ?, ?)",
    );
    const at = "2026-10-24T00:00:00.000Z";
    insert.run("review-1", 1, "token-1", "default", at);
    expect(() => insert.run("review-1", 1, "token-2", "default", at)).toThrow();
    insert.run("review-1", 2, "token-3", "default", at);
    // One execution, one row: the same token can never be counted twice.
    expect(() => insert.run("review-1", 3, "token-3", "default", at)).toThrow();
    expect(() => insert.run("review-2", 1, "token-4", "missing", at)).toThrow();
    db.raw.close();
  });

  test("the month-window count has its own index", () => {
    const db = createMigratedTestD1();
    const indexes = db.raw.query("PRAGMA index_list('usage_events')").all() as Array<{ name: string }>;
    expect(indexes.map((index) => index.name)).toContain("usage_events_workspace_occurred");
    // The execution identity is unique, so a replayed write cannot double-count.
    expect(indexes.map((index) => index.name)).toContain("usage_events_execution_token");
    db.raw.close();
  });

  test("the file is not re-runnable: a second apply fails on the existing tables", () => {
    const db = createMigratedTestD1();
    const sql = readFileSync(join(import.meta.dir, "../../migrations", MIGRATION), "utf8");
    expect(() => db.raw.exec(sql)).toThrow(/already exists/);
    db.raw.close();
  });
});
