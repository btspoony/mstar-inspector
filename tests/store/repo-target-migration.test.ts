import { describe, expect, test } from "bun:test";
import { createTestD1, migrationNumber, migrationsAfter, seedBot, seedTarget, type TestD1 } from "./helpers";
import { applyMigrations } from "../helpers/migration-shapes";

const MIGRATION = "0067_repo_target_identity.sql";
const PREVIOUS = "0066_usage_events_month_rp_index.sql";

const BEFORE = migrationsAfter(2).filter((name) => migrationNumber(name) <= migrationNumber(PREVIOUS));

function columns(db: TestD1, table: string): Array<{ name: string; notnull: number; dflt_value: string | null }> {
  return db.raw.query(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
    notnull: number;
    dflt_value: string | null;
  }>;
}

function tableNames(db: TestD1): Set<string> {
  return new Set(
    (db.raw.query("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
}

function indexNames(db: TestD1): Set<string> {
  return new Set(
    (db.raw.query("SELECT name FROM sqlite_master WHERE type = 'index'").all() as Array<{ name: string }>).map(
      (row) => row.name,
    ),
  );
}

function dbAt0066(): TestD1 {
  const db = createTestD1();
  applyMigrations(db, BEFORE);
  db.raw
    .prepare("INSERT INTO users (id, github_login, role, created_at) VALUES ('user-1', 'acme', 'member', '2026-01-01')")
    .run();
  seedBot(db, "bot-1", 7001);
  db.raw.prepare("INSERT INTO bot_workspaces (bot_id, workspace_id) VALUES ('bot-1', 'default')").run();
  db.raw
    .prepare(
      `INSERT INTO review_targets
         (id, workspace_id, bot_id, name, installation_id, account_login, allowlist_enabled,
          created_by, created_at, updated_at)
       VALUES ('target-1', 'default', 'bot-1', 'acme/widgets', 42, 'acme', 1,
               'acme', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
    .run();
  db.raw
    .prepare("INSERT INTO target_owner_allowlist (target_id, owner_login, created_at) VALUES ('target-1', 'acme', '2026-01-01')")
    .run();
  db.raw
    .prepare(
      `INSERT INTO install_claims (id, user_id, workspace_id, target_id, created_at, expires_at)
       VALUES ('claim-1', 'user-1', 'default', 'target-1', '2026-01-01', '2026-01-01T00:05:00.000Z')`,
    )
    .run();
  return db;
}

describe("migration 0067: repository-keyed review targets", () => {
  test("the target carries the repository identity and no longer the installation binding", () => {
    const db = dbAt0066();
    applyMigrations(db, [MIGRATION]);

    const target = columns(db, "review_targets");
    const names = target.map((column) => column.name);
    expect(names).toEqual(expect.arrayContaining(["repo_id", "repo_owner", "repo_name", "follow_workspace_defaults"]));
    expect(names).not.toEqual(expect.arrayContaining(["installation_id", "account_login", "allowlist_enabled"]));

    const row = db.raw
      .query("SELECT repo_id, repo_owner, repo_name, follow_workspace_defaults FROM review_targets WHERE id = 'target-1'")
      .get() as Record<string, unknown>;
    expect(row).toEqual({
      repo_id: null,
      repo_owner: null,
      repo_name: null,
      follow_workspace_defaults: 0,
    });

    expect(tableNames(db).has("target_owner_allowlist")).toBe(false);
    const indexes = indexNames(db);
    expect(indexes.has("review_targets_bot_installation")).toBe(false);
    expect(indexes.has("idx_review_targets_workspace_id")).toBe(false);
    for (const name of [
      "review_targets_workspace_repo",
      "idx_review_targets_bot_repo",
      "idx_review_targets_bot_owner_name",
      "idx_review_targets_bot_workspace",
      "idx_review_targets_workspace",
      "idx_review_targets_bot_id",
    ]) {
      expect(indexes.has(name), name).toBe(true);
    }

    const nameIndex = db.raw
      .query("PRAGMA index_xinfo(idx_review_targets_bot_owner_name)")
      .all() as Array<{ name: string | null; coll: string | null }>;
    expect(nameIndex.filter((column) => column.name !== null).map((column) => [column.name, column.coll])).toEqual([
      ["bot_id", "BINARY"],
      ["repo_owner", "NOCASE"],
      ["repo_name", "NOCASE"],
    ]);
  });

  test("one repository belongs to one workspace; unclaimed and deleted rows stay outside the claim", () => {
    const db = dbAt0066();
    applyMigrations(db, [MIGRATION]);
    const insert = (id: string, repoId: number | null, deletedAt: string | null) =>
      db.raw
        .prepare(
          `INSERT INTO review_targets
             (id, workspace_id, bot_id, name, repo_id, created_by, created_at, updated_at, deleted_at)
           VALUES (?, 'default', 'bot-1', ?, ?, 'fixture', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?)`,
        )
        .run(id, `acme/repo-${id}`, repoId, deletedAt);

    insert("t-live", 501, null);
    expect(() => insert("t-duplicate", 501, null)).toThrow();
    insert("t-deleted", 501, "2026-02-01T00:00:00.000Z");
    insert("t-unclaimed", null, null);
    insert("t-unclaimed-2", null, null);

    expect((db.raw.query("SELECT count(*) AS n FROM review_targets").get() as { n: number }).n).toBe(5);
  });

  test("the workspace carries the defaults a target inherits, with the shipped values", () => {
    const db = dbAt0066();
    applyMigrations(db, [MIGRATION]);

    const defaults = db.raw
      .query(
        `SELECT default_review_trigger_mode, default_review_level, default_check_pass_verdicts,
                check_min_score
         FROM workspaces WHERE id = 'default'`,
      )
      .get() as Record<string, unknown>;
    expect(defaults).toEqual({
      default_review_trigger_mode: "every_push",
      default_review_level: null,
      default_check_pass_verdicts: '["ship it"]',
      check_min_score: null,
    });

    expect(() =>
      db.raw.prepare("UPDATE workspaces SET default_review_trigger_mode = 'on_push' WHERE id = 'default'").run(),
    ).toThrow();
    expect(() =>
      db.raw.prepare("UPDATE workspaces SET default_check_pass_verdicts = 'ship it' WHERE id = 'default'").run(),
    ).toThrow();
    expect(() =>
      db.raw.prepare("UPDATE review_targets SET follow_workspace_defaults = 2 WHERE id = 'target-1'").run(),
    ).toThrow();
  });

});

const MIGRATION_0068 = "0068_target_repo_global_unique.sql";

describe("migration 0068: one repository, one workspace per bot", () => {
  test("the workspace-scoped claim is replaced by the bot-scoped one", () => {
    const db = dbAt0066();
    applyMigrations(db, [MIGRATION, MIGRATION_0068]);

    const indexes = indexNames(db);
    expect(indexes.has("review_targets_workspace_repo")).toBe(false);
    expect(indexes.has("review_targets_bot_repo_unique")).toBe(true);
  });

  test("a live duplicate across two workspaces of the SAME bot is refused", () => {
    const db = dbAt0066();
    applyMigrations(db, [MIGRATION, MIGRATION_0068]);
    db.raw
      .prepare(
        `INSERT INTO workspaces (id, slug, name, created_by, created_at)
         VALUES ('other', 'other', 'other', 'acme', '2026-01-01')`,
      )
      .run();
    seedBot(db, "bot-2", 7002);
    seedBot(db, "bot-3", 7003);
    const insert = (id: string, workspaceId: string, botId: string, repoId: number | null, deletedAt: string | null = null) =>
      db.raw
        .prepare(
          `INSERT INTO review_targets
             (id, workspace_id, bot_id, name, repo_id, created_by, created_at, updated_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, 'fixture', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?)`,
        )
        .run(id, workspaceId, botId, `acme/repo-${id}`, repoId, deletedAt);

    insert("t-here", "default", "bot-1", 501);
    expect(() => insert("t-sibling", "other", "bot-1", 501)).toThrow();
    insert("t-other-bot", "other", "bot-2", 501);
    insert("t-released", "other", "bot-1", 501, "2026-02-01T00:00:00.000Z");
    insert("t-unclaimed", "other", "bot-1", null);
    insert("t-unclaimed-2", "default", "bot-3", null);

    expect((db.raw.query("SELECT count(*) AS n FROM review_targets").get() as { n: number }).n).toBe(6);
  });

  test("the cross-workspace claim is 0068's index itself, not the insert path", () => {
    const db = dbAt0066();
    applyMigrations(db, [MIGRATION, MIGRATION_0068]);
    db.raw
      .prepare(
        `INSERT INTO workspaces (id, slug, name, created_by, created_at)
         VALUES ('other', 'other', 'other', 'acme', '2026-01-01')`,
      )
      .run();
    seedBot(db, "bot-2", 7002);
    const insert = (id: string, workspaceId: string, botId: string, repoId: number | null, deletedAt: string | null = null) =>
      db.raw
        .prepare(
          `INSERT INTO review_targets
             (id, workspace_id, bot_id, name, repo_id, created_by, created_at, updated_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, 'fixture', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?)`,
        )
        .run(id, workspaceId, botId, `acme/repo-${id}`, repoId, deletedAt);

    insert("t-retired", "default", "bot-1", 501, "2026-02-01T00:00:00.000Z");
    insert("t-live", "other", "bot-1", 501);
    expect(() => insert("t-second", "default", "bot-1", 501)).toThrow(
      "UNIQUE constraint failed: review_targets.bot_id, review_targets.repo_id",
    );
    expect((db.raw.query("SELECT count(*) AS n FROM review_targets").get() as { n: number }).n).toBe(3);
    insert("t-unclaimed", "default", "bot-2", null);
    insert("t-unclaimed-2", "other", "bot-2", null);
    expect((db.raw.query("SELECT count(*) AS n FROM review_targets").get() as { n: number }).n).toBe(5);
    db.raw.run("DROP INDEX review_targets_bot_repo_unique");
    insert("t-second", "default", "bot-1", 501);
    expect((db.raw.query("SELECT count(*) AS n FROM review_targets").get() as { n: number }).n).toBe(6);
  });
});

const MIGRATION_0108 = "0108_workspace_admission_defaults.sql";
const BEFORE_0108 = migrationsAfter(2).filter(
  (name) => migrationNumber(name) < migrationNumber(MIGRATION_0108),
);

describe("migration 0108: the workspace carries the admission defaults", () => {
  test("adds two NOT NULL default-1 columns; every existing workspace keeps today's behaviour", () => {
    const db = createTestD1();
    applyMigrations(db, BEFORE_0108);
    db.raw
      .prepare(
        `INSERT INTO workspaces (id, slug, name, created_by, created_at)
         VALUES ('legacy', 'legacy', 'legacy', 'acme', '2026-01-01')`,
      )
      .run();

    applyMigrations(db, [MIGRATION_0108]);

    const byName = new Map(columns(db, "workspaces").map((column) => [column.name, column]));
    expect(byName.get("default_review_drafts")).toMatchObject({ notnull: 1, dflt_value: "1" });
    expect(byName.get("default_review_enabled")).toMatchObject({ notnull: 1, dflt_value: "1" });
    expect(
      db.raw
        .query("SELECT default_review_drafts, default_review_enabled FROM workspaces WHERE id = 'legacy'")
        .get(),
    ).toEqual({ default_review_drafts: 1, default_review_enabled: 1 });
    expect(() =>
      db.raw.prepare("UPDATE workspaces SET default_review_drafts = 2 WHERE id = 'legacy'").run(),
    ).toThrow();
    expect(() =>
      db.raw.prepare("UPDATE workspaces SET default_review_enabled = -1 WHERE id = 'legacy'").run(),
    ).toThrow();
  });

  test("the transition detaches only targets whose admission answer differs from the new defaults", () => {
    const db = createTestD1();
    applyMigrations(db, BEFORE_0108);
    seedBot(db, "bot-1", 7001);
    const affected = seedTarget(db, "bot-1", { id: "target-paused", name: "acme/paused", repoId: 501 });
    const unaffected = seedTarget(db, "bot-1", { id: "target-live", name: "acme/live", repoId: 502 });
    // A following target keeps its own answer for both admission facts today;
    // its policy columns are inert and may hold anything.
    db.raw
      .prepare(
        `UPDATE review_targets
            SET follow_workspace_defaults = 1, review_trigger_mode = 'manual',
                review_level = 'deep', check_min_score = 90,
                check_pass_verdicts = '["ship it","blocked"]', review_drafts = 0, review_enabled = 0
          WHERE id = ?`,
      )
      .run(affected);
    db.raw.prepare("UPDATE review_targets SET follow_workspace_defaults = 1 WHERE id = ?").run(unaffected);

    applyMigrations(db, [MIGRATION_0108]);

    const rows = db.raw
      .query(
        `SELECT id, follow_workspace_defaults, review_enabled, review_drafts,
                review_trigger_mode, review_level, check_min_score, check_pass_verdicts
           FROM review_targets WHERE id IN (?, ?)`,
      )
      .all(affected, unaffected) as Array<Record<string, unknown>>;
    const byId = new Map(rows.map((row) => [row.id as string, row]));
    expect(byId.get(affected)).toEqual({
      id: affected,
      follow_workspace_defaults: 0,
      review_enabled: 0,
      review_drafts: 0,
      review_trigger_mode: "every_push",
      review_level: null,
      check_min_score: 60,
      check_pass_verdicts: '["ship it"]',
    });
    expect(byId.get(unaffected)).toMatchObject({
      follow_workspace_defaults: 1,
      review_enabled: 1,
      review_drafts: 1,
    });
  });
});
