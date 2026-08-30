/**
 * Test D1 double (plan 05 Task 1 + plan 07 Task 4) — bun:sqlite in-memory
 * database executing the REAL migration SQL (DDL single sources, applied in
 * filename order exactly like `wrangler d1 migrations apply`), exposing only
 * the narrow D1 face the store depends on (plan Clarify 5:
 * prepare/bind/first/all/run + batch).
 *
 * Two schema shapes:
 * - `createTestD1()` — the plan-07-era review-store shape (0001 + 0002),
 *   i.e. production BEFORE plan 13. Kept for fixtures that exercise the
 *   append-only ALTER sequence itself (tests/worker/apps-store.test.ts
 *   seeds rows, THEN applies 0004/0005).
 * - `createMigratedTestD1()` — the full current shape (0001 → 0009 in
 *   filename order: 0003 dashboard users, 0004 github_apps +
 *   app_installations, 0005 reviews.app_id, 0006 app_provider_keys +
 *   app_model_config, 0007 idx_reviews_app_id, 0008 github_apps
 *   review_enabled + last_webhook_at, 0009 app_model_roles), i.e. what
 *   `wrangler d1 migrations apply` produces today. The store adapter's INSERT
 *   binds `reviews.app_id` (plan 13, QC fix wave 1 F-001), so every test
 *   exercising the REAL store.put against production-shaped data runs on this
 *   one — and plan-14 fixtures get the per-App config tables without
 *   re-applying migrations by hand.
 *
 * bun:sqlite and D1 are both SQLite, so UNIQUE/ON CONFLICT semantics match;
 * if a divergence ever shows up against real D1, the remote apply is
 * authoritative and this helper must be updated (plan Clarify 5).
 */
import { Database, type Statement } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { D1BatchResult, D1Like, D1StatementLike } from "../../src/store/types";

const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");
/** Plan-07-era review-store schema (production before plan 13). */
const BASE_MIGRATIONS = ["0001_reviews.sql", "0002_mstar_review_v1.sql"];
/** Full current migration list, filename order = wrangler apply order. */
const ALL_MIGRATIONS = [
  ...BASE_MIGRATIONS,
  "0003_dashboard_users.sql",
  "0004_github_apps.sql",
  "0005_reviews_app_id.sql",
  "0006_app_provider_config.sql",
  "0007_reviews_app_id_index.sql",
  "0008_github_apps_ops.sql",
  "0009_app_model_roles.sql",
];

/** Execute the migration DDL on a fresh in-memory database. */
function applyMigration(db: Database, migrations: readonly string[]): void {
  // SQLite enforces foreign keys per-connection; D1 has them on by default.
  db.exec("PRAGMA foreign_keys = ON;");
  for (const name of migrations) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  }
}

/**
 * Wrap a bun:sqlite statement in the narrow D1 statement face. bun:sqlite
 * takes bound parameters directly on get/all/run (no separate bind step), so
 * the wrapper buffers values from `bind()` and forwards them on execution.
 */
function wrapStatement(stmt: Statement): D1StatementLike {
  let bound: unknown[] = [];
  return {
    bind(...values: unknown[]): D1StatementLike {
      bound = values;
      return this;
    },
    async first<T = Record<string, unknown>>(): Promise<T | null> {
      const row = stmt.get(...bound) as T | undefined;
      return row ?? null;
    },
    async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
      return { results: stmt.all(...bound) as T[] };
    },
    async run<T = Record<string, unknown>>(): Promise<{
      results: T[];
      meta: { changes: number; last_row_id: number };
    }> {
      const info = stmt.run(...bound);
      return {
        results: [] as T[],
        meta: { changes: Number(info.changes), last_row_id: Number(info.lastInsertRowid) },
      };
    },
  };
}

/** Wrap a bun:sqlite handle in the narrow D1 face (shared by both shapes). */
function wrapDb(db: Database): D1Like & { raw: Database } {
  return {
    raw: db,
    prepare(query: string): D1StatementLike {
      return wrapStatement(db.prepare(query));
    },
    /**
     * D1 `batch()` runs the statements sequentially as ONE transaction —
     * "if any statement fails, the entire sequence is aborted or rolled
     * back" (developers.cloudflare.com/d1/worker-api/d1-database). The
     * bun:sqlite equivalent is an explicit BEGIN/COMMIT/ROLLBACK around the
     * async `run()` calls: bun:sqlite's `db.transaction()` does not roll
     * back when the callback is async (probed), so the transaction is
     * bracketed manually. A thrown statement aborts the batch and rolls
     * back every prior statement, matching D1.
     */
    async batch(statements: D1StatementLike[]): Promise<D1BatchResult[]> {
      db.exec("BEGIN");
      try {
        const results: D1BatchResult[] = [];
        for (const stmt of statements) {
          results.push(await stmt.run());
        }
        db.exec("COMMIT");
        return results;
      } catch (error) {
        db.exec("ROLLBACK");
        throw error;
      }
    },
  };
}

/**
 * Create a fresh in-memory D1-like database with the plan-07-era
 * review-store schema (0001 + 0002) applied. Each call returns an
 * independent database (tests must not share state). The underlying
 * bun:sqlite handle is exposed for direct assertions (e.g. counting rows)
 * via the `raw` property.
 */
export function createTestD1(): D1Like & { raw: Database } {
  const db = new Database(":memory:");
  applyMigration(db, BASE_MIGRATIONS);
  return wrapDb(db);
}

/**
 * Fully-migrated variant (plan 13; extended by plans 14–17): the same double
 * with the complete migration list applied (0001 → 0009, filename order).
 * Reviews carries the `app_id` column (FK to github_apps), so tests exercising
 * the REAL store.put — whose INSERT binds `app_id` — run against the
 * production-shaped schema, the plan-14 per-App config tables
 * (app_provider_keys / app_model_config) exist without extra fixture work,
 * github_apps carries the plan-16 ops columns (review_enabled /
 * last_webhook_at), and the plan-17 per-role table (app_model_roles) exists
 * for the consumer modelOverrides tests. Each call returns an independent
 * database.
 */
export function createMigratedTestD1(): D1Like & { raw: Database } {
  const db = new Database(":memory:");
  applyMigration(db, ALL_MIGRATIONS);
  return wrapDb(db);
}
