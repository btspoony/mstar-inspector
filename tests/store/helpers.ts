import { Database, type Statement } from "bun:sqlite";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { D1BatchResult, D1Like, D1StatementLike } from "../../src/store/types";
import { DEFAULT_CHECK_MIN_SCORE } from "../../src/contracts/review-gate";

const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");
const BASE_MIGRATIONS = ["0001_reviews.sql", "0002_mstar_review_v1.sql"];
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
 *
 * `readDir` is the directory seam: a case that needs a synthetic listing
 * injects one instead of mocking `node:fs`, whose registry entry is
 * process-wide.
 */
export function migrationsAfter(
  anchor: number | string,
  readDir: (dir: string) => string[] = readdirSync,
): string[] {
  const from = typeof anchor === "number" ? anchor : migrationNumber(anchor);
  return readDir(MIGRATIONS_DIR)
    .filter((name) => name.endsWith(".sql"))
    .sort((a, b) => migrationNumber(a) - migrationNumber(b) || (a < b ? -1 : a > b ? 1 : 0))
    .filter((name) => migrationNumber(name) > from);
}

const ALL_MIGRATIONS = migrationsAfter(0);

export function applyMigration(db: Database, migrations: readonly string[]): void {
  db.run("PRAGMA foreign_keys = ON;");
  // Each file applies inside one transaction, the way D1 runs it: SQLite only
  // carries child foreign keys onto a renamed parent while enforcement is on,
  // and PRAGMA foreign_keys = OFF is inert inside a transaction — an
  // autocommit apply would build a schema whose FK targets no production
  // database ever has.
  for (const name of migrations) {
    const script = readFileSync(join(MIGRATIONS_DIR, name), "utf8");
    db.transaction(() => {
      for (const statement of splitSqlStatements(script)) db.run(statement);
    })();
  }
}

/**
 * Split a migration script into its statements, tracking `--` / `/* *\/`
 * comments and single-, double- and back-quoted literals so a `;` inside any of
 * them does not split. Comment-only and whitespace-only fragments are dropped
 * (they carry no statement).
 */
export function splitSqlStatements(script: string): string[] {
  const statements: string[] = [];
  let current = "";
  let hasCode = false;
  let quote: string | null = null;
  for (let index = 0; index < script.length; index += 1) {
    const char = script[index]!;
    const next = script[index + 1];
    if (quote !== null) {
      current += char;
      if (char === quote) {
        if (script[index + 1] === quote) {
          current += quote;
          index += 1;
        } else {
          quote = null;
        }
      }
      continue;
    }
    if (char === "-" && next === "-") {
      const end = script.indexOf("\n", index);
      const stop = end === -1 ? script.length : end;
      current += script.slice(index, stop);
      index = stop - 1;
      continue;
    }
    if (char === "/" && next === "*") {
      const end = script.indexOf("*/", index + 2);
      const stop = end === -1 ? script.length : end + 2;
      current += script.slice(index, stop);
      index = stop - 1;
      continue;
    }
    if (char === "'" || char === '"' || char === "`") {
      quote = char;
      hasCode = true;
      current += char;
      continue;
    }
    if (char === ";") {
      if (hasCode) statements.push(current.trim());
      current = "";
      hasCode = false;
      continue;
    }
    if (!/\s/.test(char)) hasCode = true;
    current += char;
  }
  if (hasCode) statements.push(current.trim());
  return statements;
}

/**
 * Apply one migration script the way D1 does: statement by statement, the
 * first failure aborting the migration.
 *
 * `Database.exec` runs the whole string as one script, and on bun 1.4.0 —
 * the version CI pins — a statement that fails inside a multi-statement string
 * is silently SKIPPED while the rest of the script still runs (1.4.4 throws).
 * A guard that exists to fail a migration would then pass on CI and fail
 * everywhere else, and a fixture would silently come up half-migrated.
 */
export function execMigrationScript(db: Database, script: string): void {
  for (const statement of splitSqlStatements(script)) db.run(statement);
}

function counter(db: Database, sql: string): number {
  const row = db.prepare(sql).values()[0];
  return Number(row?.[0] ?? 0);
}

function wrapStatement(
  db: Database,
  stmt: Statement,
  recordBindCount: (count: number) => void,
): D1StatementLike {
  let bound: unknown[] = [];
  // D1 rejects a bind whose value count differs from the statement's parameter
  // count ("D1_ERROR: Wrong number of parameter bindings"); bun:sqlite silently
  // tolerates surplus values. Enforcing it here makes a `.bind()` with no
  // matching placeholder fail in every test that runs it, instead of passing
  // locally and 500ing in production.
  const assertBinding = (): void => {
    if (bound.length !== stmt.paramsCount) {
      throw new Error(
        `bound ${bound.length} values to a statement with ${stmt.paramsCount} parameters: ${String(stmt)}`,
      );
    }
  };
  return {
    bind(...values: unknown[]): D1StatementLike {
      bound = values;
      recordBindCount(values.length);
      return this;
    },
    async first<T = Record<string, unknown>>(): Promise<T | null> {
      assertBinding();
      const row = stmt.get(...bound) as T | undefined;
      return row ?? null;
    },
    async all<T = Record<string, unknown>>(): Promise<{ results: T[] }> {
      assertBinding();
      return { results: stmt.all(...bound) as T[] };
    },
    async run<T = Record<string, unknown>>(): Promise<{
      results: T[];
      meta: { changes: number; last_row_id: number };
    }> {
      assertBinding();
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

function wrapDb(db: Database): TestD1 {
  const boundValueCounts: number[] = [];
  const handle: TestD1 = {
    raw: db,
    boundValueCounts,
    prepare(query: string): D1StatementLike {
      return wrapStatement(db, db.prepare(query), (count) => {
        boundValueCounts.push(count);
      });
    },
    async batch(statements: D1StatementLike[]): Promise<D1BatchResult[]> {
      db.run("BEGIN");
      try {
        const results: D1BatchResult[] = [];
        for (const stmt of statements) {
          results.push(await stmt.run());
        }
        db.run("COMMIT");
        return results;
      } catch (error) {
        db.run("ROLLBACK");
        throw error;
      }
    },
  };
  return handle;
}

/**
 * The test D1 double handle: the narrow D1 face plus the raw bun:sqlite
 * handle for direct assertions. Named type so consumers do not reach
 * through `ReturnType<typeof createMigratedTestD1>`.
 *
 * `boundValueCounts` records every `bind()`'s value count in call order — the
 * observable stand-in for D1's 100-bound-parameter ceiling, which bun:sqlite
 * does not enforce.
 */
export type TestD1 = D1Like & { raw: Database; readonly boundValueCounts?: readonly number[] };

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
 * Reviews carries the `bot_id` column (FK to review_bots), so tests exercising
 * the REAL store.put — whose INSERT binds `bot_id` — run against the
 * production-shaped schema, the per-App config tables
 * (bot_provider_keys / bot_model_config) exist without extra fixture work,
 * review_bots carries the ops columns (review_enabled /
 * last_webhook_at), and the per-role table (bot_model_roles) exists
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
 * directly (not through `createApp`) must map it or the row is invisible; the
 * bot row the split schema requires comes with the mapping.
 */
export async function mapAppToDefaultWorkspace(db: D1Like, appId: string): Promise<void> {
  // Idempotent: seedBot already creates the pair, and older callers invoke
  // both — a second mapping must not fail.
  await db
    .prepare("INSERT OR IGNORE INTO app_workspaces (app_id, workspace_id) VALUES (?, 'default')")
    .bind(appId)
    .run();
  await db
    .prepare(
      `INSERT OR IGNORE INTO review_bots (id, workspace_id, name, multiplier, created_at, updated_at)
       VALUES (?, 'default', ?, 1, datetime('now'), datetime('now'))`,
    )
    .bind(appId, appId)
    .run();
}

/**
 * Insert one live `github_apps` row. Targets, workspace mappings and review
 * trees reference it, so a fixture that seeds any of those needs the App row
 * first; `githubAppId` is UNIQUE. The bot half of the pair comes from
 * `mapAppToDefaultWorkspace` — the same two writers as production.
 */
/**
 * Fixture seam for the split writer invariant: a reviews row carries both
 * attribution columns, equal (bot_id = app_id), written by the artifact store.
 * Fixtures inserting reviews rows call this after their seeds. It must be a
 * TYPE-SCRIPT GATED helper, not inline SQL: fixture functions building
 * pre-split / intermediate migration shapes have no bot_id column at all, and
 * a bare UPDATE would fail at parse time before any guard predicate could run.
 */
export function syncReviewBotColumn(db: TestD1): void {
  const cols = new Set(
    (db.raw.query("PRAGMA table_info(reviews)").all() as Array<{ name: string }>).map((c) => c.name),
  );
  if (cols.has("bot_id") && cols.has("app_id")) {
    db.raw.run("UPDATE reviews SET bot_id = app_id WHERE bot_id IS NULL");
  }
}

/**
 * Fixture seam for the split pair invariant: every App row exists with a
 * workspace binding and a bot row at the same id. Era-gated — fixtures
 * building pre-0026 or intermediate migration shapes have no ownership or bot
 * table at all, and a bare INSERT would fail before any guard could run.
 */
export function syncSplitPair(db: TestD1): void {
  const names = new Set(
    (db.raw.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
      (r) => r.name,
    ),
  );
  if (!names.has("github_apps")) return;
  if (names.has("app_workspaces")) {
    db.raw.run(
      "INSERT OR IGNORE INTO app_workspaces (app_id, workspace_id) SELECT id, 'default' FROM github_apps WHERE id NOT IN (SELECT app_id FROM app_workspaces)",
    );
  }
  if (names.has("review_bots")) {
    db.raw.run(`INSERT OR IGNORE INTO review_bots (id, workspace_id, name, multiplier, created_at, updated_at)
  SELECT id, COALESCE((SELECT workspace_id FROM app_workspaces WHERE app_id = github_apps.id), 'default'), name, 1, datetime('now'), datetime('now')
  FROM github_apps WHERE id NOT IN (SELECT id FROM review_bots)`);
    db.raw.run(
      "UPDATE review_bots SET workspace_id = (SELECT workspace_id FROM app_workspaces WHERE app_id = review_bots.id) WHERE EXISTS (SELECT 1 FROM app_workspaces WHERE app_id = review_bots.id)",
    );
  }
  if (names.has("app_install_bots")) {
    // The owner's chain, which `createApp` writes at creation and a raw fixture
    // INSERT bypasses. The relay walks THIS table, so without it every fixture
    // App would have an empty chain and every delivery would refuse
    // `no-review-bot`. One row at position 1 naming the App's own bot — the same
    // shape `createApp` writes.
    // `app_install_bots` carries a composite FK to `app_installations`, so the
    // state row comes first — exactly the order `createApp` and `bindInstallation`
    // write in production.
    db.raw.run(`INSERT OR IGNORE INTO app_installations (github_app_id, workspace_id, created_at)
  SELECT aw.app_id, aw.workspace_id, datetime('now')
    FROM app_workspaces aw
   WHERE EXISTS (SELECT 1 FROM review_bots b WHERE b.id = aw.app_id)`);
    db.raw.run(`INSERT OR IGNORE INTO app_install_bots (github_app_id, workspace_id, position, bot_id)
  SELECT aw.app_id, aw.workspace_id, 1, aw.app_id
    FROM app_workspaces aw
   WHERE EXISTS (SELECT 1 FROM review_bots b WHERE b.id = aw.app_id)`);
  }
}

export function seedBot(db: TestD1, id: string, githubAppId: number, opts: { workspaceId?: string } = {}): void {
  const workspaceId = opts.workspaceId ?? "default";
  // Era-aware: the credential parent is github_apps pre-0056 and post-0115,
  // review_bots in between (0066-era migration worlds live in the bot era).
  // Migration-era fixture worlds must build the schema shape they test — a
  // post-split INSERT would fail before any assertion runs.
  const names = new Set(
    (db.raw.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
      (r) => r.name,
    ),
  );
  const postSplit = names.has("github_apps") && names.has("review_bots");
  const parent = postSplit || names.has("github_apps") ? "github_apps" : "review_bots";
  db.raw
    .prepare(
      `INSERT INTO ${parent}
         (id, github_app_id, name, private_key_enc, webhook_secret_enc,
          created_by, status, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, 'k', 'w', 'fixture', 'active', NULL, datetime('now'), datetime('now'))`,
    )
    .run(id, githubAppId, id);
  if (postSplit) {
    // The split pair: the bot row and the workspace mapping the same-id
    // invariant of this release requires beside the App row. INSERT OR IGNORE
    // so callers that add their own mapping/companions never collide.
    db.raw
      .prepare("INSERT OR IGNORE INTO app_workspaces (app_id, workspace_id) VALUES (?, ?)")
      .run(id, workspaceId);
    db.raw
      .prepare(
        `INSERT OR IGNORE INTO review_bots (id, workspace_id, name, multiplier, created_at, updated_at)
         VALUES (?, ?, ?, 1, datetime('now'), datetime('now'))`,
      )
      .run(id, workspaceId, id);
  } else if (names.has("bot_workspaces")) {
    db.raw
      .prepare("INSERT OR IGNORE INTO bot_workspaces (bot_id, workspace_id) VALUES (?, ?)")
      .run(id, workspaceId);
  } else if (names.has("app_workspaces")) {
    db.raw
      .prepare("INSERT OR IGNORE INTO app_workspaces (app_id, workspace_id) VALUES (?, ?)")
      .run(id, workspaceId);
  }
}

/**
 * Insert one live `review_targets` row for a raw-seeded bot and return its id.
 * Review and pull-request rows carry `target_id`, and the tenant reads bind it
 * together with `review_targets.workspace_id`, so a fixture that seeds those
 * rows itself needs the target that owns them. Defaults mirror the create
 * path (the DDL defaults, no installation binding).
 *
 * A target IS a repository (migration 0067), so the row is repository-keyed:
 * the owner/name/`repo_id` defaults are derived from the ids this helper is
 * given, and a caller that asserts on a specific repository passes them.
 */
export function seedTarget(
  db: TestD1,
  botId: string,
  opts: {
    id?: string;
    workspaceId?: string;
    name?: string;
    repoId?: number;
    repoOwner?: string;
    repoName?: string;
    createdAt?: string;
  } = {},
): string {
  const id = opts.id ?? crypto.randomUUID();
  const now = opts.createdAt ?? "2026-01-01T00:00:00.000Z";
  let hash = 0x811c9dc5;
  for (const char of id) hash = Math.imul(hash ^ char.codePointAt(0)!, 0x01000193) >>> 0;
  // Era-aware attribution: review_targets carries app_id pre-0056 and
  // post-0115, bot_id in between — the same migration-era rule as seedBot.
  const columns = (db.raw.query("PRAGMA table_info(review_targets)").all() as Array<{ name: string }>).map(
    (r) => r.name,
  );
  const attribution = columns.includes("app_id") ? "app_id" : "bot_id";
  db.raw
    .prepare(
      `INSERT INTO review_targets
         (id, workspace_id, ${attribution}, name, repo_id, repo_owner, repo_name,
          check_min_score, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'fixture', ?, ?)`,
    )
    .run(
      id,
      opts.workspaceId ?? "default",
      botId,
      opts.name ?? botId,
      opts.repoId ?? (hash % 2_000_000_000) + 1,
      opts.repoOwner ?? "acme",
      opts.repoName ?? (opts.name ?? botId),
      DEFAULT_CHECK_MIN_SCORE,
      now,
      now,
    );
  return id;
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
