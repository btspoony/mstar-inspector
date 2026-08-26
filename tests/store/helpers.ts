/**
 * Test D1 double (plan 05 Task 1) — bun:sqlite in-memory database executing
 * the REAL migration SQL (`migrations/0001_reviews.sql`, DDL single source),
 * exposing only the narrow D1 face the store depends on (plan Clarify 5:
 * prepare/bind/first/all/run + batch).
 *
 * bun:sqlite and D1 are both SQLite, so UNIQUE/ON CONFLICT semantics match;
 * if a divergence ever shows up against real D1, the remote apply is
 * authoritative and this helper must be updated (plan Clarify 5).
 */
import { Database, type Statement } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { D1BatchResult, D1Like, D1StatementLike } from "../../src/store/types";

const MIGRATION_PATH = join(import.meta.dir, "../../migrations/0001_reviews.sql");

/** Execute the migration DDL on a fresh in-memory database. */
function applyMigration(db: Database): void {
  // SQLite enforces foreign keys per-connection; D1 has them on by default.
  db.exec("PRAGMA foreign_keys = ON;");
  const sql = readFileSync(MIGRATION_PATH, "utf8");
  db.exec(sql);
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

/**
 * Create a fresh in-memory D1-like database with the review-store schema
 * applied. Each call returns an independent database (tests must not share
 * state). The underlying bun:sqlite handle is exposed for direct assertions
 * (e.g. counting rows) via the `raw` property.
 */
export function createTestD1(): D1Like & { raw: Database } {
  const db = new Database(":memory:");
  applyMigration(db);
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
