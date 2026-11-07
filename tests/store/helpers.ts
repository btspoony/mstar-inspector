/**
 * Test D1 double — bun:sqlite in-memory
 * database executing the REAL migration SQL (DDL single sources, applied in
 * filename order exactly like `wrangler d1 migrations apply`), exposing only
 * the narrow D1 face the store depends on
 * (prepare/bind/first/all/run + batch).
 *
 * Two schema shapes:
 * - `createTestD1()` — the initial review-store shape (0001 + 0002),
 * i.e. production before the github_apps work. Kept for fixtures that exercise the
 *   append-only ALTER sequence itself (tests/worker/apps-store.test.ts
 *   seeds rows, THEN applies 0004/0005).
 * - `createMigratedTestD1()` — the full current shape: every `*.sql` in
 *   `migrations/` applied in filename order, i.e. what
 *   `wrangler d1 migrations apply` produces today. The store adapter's INSERT
 *   binds `reviews.app_id` (QC fix wave 1 F-001), so every test exercising the
 *   REAL store.put against production-shaped data runs on this one — and
 *   fixtures get the per-App config tables without re-applying migrations by
 *   hand.
 *
 * bun:sqlite and D1 are both SQLite, so UNIQUE/ON CONFLICT semantics match;
 * if a divergence ever shows up against real D1, the remote apply is
 * authoritative and this helper must be updated.
 */
import { Database, type Statement } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { D1BatchResult, D1Like, D1StatementLike } from "../../src/store/types";

const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");
/** Earliest review-store schema (production before the github_apps work). */
const BASE_MIGRATIONS = ["0001_reviews.sql", "0002_mstar_review_v1.sql"];
/** A migration filename's numeric prefix — the only part wrangler orders on. */
const MIGRATION_PREFIX = /^(\d+)_/;

/**
 * One migration's apply-order number. A `.sql` file without a numeric prefix
 * has NO defined position in wrangler's order, so it fails here BY NAME
 * instead of being dropped from every selector below — a silent drop would
 * apply a partial schema on a fresh database and hide the cause.
 */
export function migrationNumber(name: string): number {
  const match = MIGRATION_PREFIX.exec(name);
  if (match === null) {
    throw new Error(`migration ${name} has no numeric prefix — its apply order is undefined`);
  }
  return Number.parseInt(match[1]!, 10);
}

/**
 * The directory-derived migrations AFTER an anchor, in wrangler's apply order
 * (numeric prefix, so `1000_*` follows `999_*`). The anchor is either the
 * prefix number or a migration filename — a fixture declares the exact shape
 * it reconstructs, then appends this tail, so a new migration joins it with no
 * lockstep edit. A filename without a numeric prefix throws BY NAME
 * (`migrationNumber`): its apply order is undefined, and a silent drop would
 * apply a partial schema and hide the cause.
 *
 * The order is total: equal numeric prefixes — the four pre-existing duplicate
 * pairs (`0043`, `0047`, `0048`, `0049`) — break on the filename in byte order,
 * never on `readdir` order. With the repo's fixed-width 4-digit prefixes that
 * equals full-filename lexicographic order, the same order wrangler applies.
 */
export function migrationsAfter(anchor: number | string): string[] {
  const from = typeof anchor === "number" ? anchor : migrationNumber(anchor);
  return readdirSync(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => migrationNumber(a) - migrationNumber(b) || (a < b ? -1 : a > b ? 1 : 0))
    .filter((name) => migrationNumber(name) > from);
}

/** Full migration list, in wrangler's apply order (numeric, not lexical). */
const ALL_MIGRATIONS = migrationsAfter(0);

/**
 * Execute the migration DDL on a fresh in-memory database.
 *
 * Stays local instead of `applyMigrations` (`../helpers/migration-shapes`):
 * this is the raw `Database` layer that module itself imports `migrationsAfter`
 * / `TestD1` from, so the reverse import would be a cycle — and it runs before
 * the D1 wrapper (and its `PRAGMA foreign_keys`) exists.
 */
function applyMigration(db: Database, migrations: readonly string[]): void {
  // SQLite enforces foreign keys per-connection; D1 has them on by default.
  db.exec("PRAGMA foreign_keys = ON;");
  for (const name of migrations) {
    db.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
  }
}

/** Read one INTEGER scalar on the connection (SQLite change counters). */
function counter(db: Database, sql: string): number {
  const row = db.prepare(sql).values()[0];
  return Number(row?.[0] ?? 0);
}

/**
 * Wrap a bun:sqlite statement in the narrow D1 statement face. bun:sqlite
 * takes bound parameters directly on get/all/run (no separate bind step), so
 * the wrapper buffers values from `bind()` and forwards them on execution.
 */
function wrapStatement(db: Database, stmt: Statement): D1StatementLike {
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
      // D1 returns a statement's ROWS in its `D1Result` (`batch()` position for
      // position), so a SELECT placed in a batch is readable there. bun:sqlite
      // `run()` discards them, so a row-returning statement goes through
      // `all()` — the shape callers rely on when a batch classifies a refusal.
      // `changes()` reports the rows the statement modified (`1` when a guarded
      // `INSERT … SELECT … RETURNING` matched, `0` when it did not); it is stale
      // after a plain SELECT, so `total_changes()` tells a write from a read.
      if (stmt.columnNames.length > 0) {
        const before = counter(db, "SELECT total_changes() AS n");
        const results = stmt.all(...bound) as T[];
        const wrote = counter(db, "SELECT total_changes() AS n") !== before;
        return {
          results,
          meta: {
            changes: wrote ? counter(db, "SELECT changes() AS n") : 0,
            last_row_id: 0,
          },
        };
      }
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
      return wrapStatement(db, db.prepare(query));
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
 * The test D1 double handle: the narrow D1 face plus the raw bun:sqlite
 * handle for direct assertions. Named type so consumers do not reach
 * through `ReturnType<typeof createMigratedTestD1>`.
 */
export type TestD1 = D1Like & { raw: Database };

/**
 * Create a fresh in-memory D1-like database with the earliest
 * review-store schema (0001 + 0002) applied. Each call returns an
 * independent database (tests must not share state). The underlying
 * bun:sqlite handle is exposed for direct assertions (e.g. counting rows)
 * via the `raw` property.
 */
export function createTestD1(): TestD1 {
  const db = new Database(":memory:");
  applyMigration(db, BASE_MIGRATIONS);
  return wrapDb(db);
}

/**
 * Fully-migrated variant (the full migration list): the same double
 * with every `migrations/*.sql` applied in wrangler's numeric order — the
 * production shape, with no hand-picked subset.
 * Reviews carries the `app_id` column (FK to github_apps), so tests exercising
 * the REAL store.put — whose INSERT binds `app_id` — run against the
 * production-shaped schema, the per-App config tables
 * (app_provider_keys / app_model_config) exist without extra fixture work,
 * github_apps carries the ops columns (review_enabled /
 * last_webhook_at), and the per-role table (app_model_roles) exists
 * for the consumer modelOverrides tests. Each call returns an independent
 * database.
 */
export function createMigratedTestD1(): TestD1 {
  const db = new Database(":memory:");
  applyMigration(db, ALL_MIGRATIONS);
  return wrapDb(db);
}

/**
 * Attribute a raw-seeded App row to the `default` workspace. The one App read
 * face INNER JOINs `app_workspaces`, so a fixture that inserts `github_apps`
 * directly (not through `createApp`) must map it or the row is invisible.
 */
export async function mapAppToDefaultWorkspace(db: D1Like, appId: string): Promise<void> {
  await db
    .prepare("INSERT INTO app_workspaces (app_id, workspace_id) VALUES (?, 'default')")
    .bind(appId)
    .run();
}

/**
 * Join seeded users to the `default` workspace (0026 seeds it). Authority is
 * per workspace, so a suite driving a workspace route needs the membership row
 * — `users.role` grants nothing.
 */
export function seedDefaultMemberships(
  db: TestD1,
  roles: Record<string, "owner" | "admin" | "member">,
): void {
  for (const [login, role] of Object.entries(roles)) {
    db.raw
      .prepare(
        `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
         SELECT 'default', id, ?, '2026-01-01T00:00:00.000Z' FROM users WHERE github_login = ?`,
      )
      .run(role, login);
  }
}
