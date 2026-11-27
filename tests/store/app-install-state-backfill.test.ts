import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyMigration,
  createTestD1,
  migrationNumber,
  migrationsAfter,
  seedBot,
  seedTarget,
  splitSqlStatements,
  type TestD1,
} from "./helpers";

// migrations/0118_app_install_state_backfill.sql — the install state and its
// first chain row, materialised from the three relations that already mean
// "this workspace installs this App". Task 2's writers (createApp, bind)
// arrive later; until this file runs, `app_installations` is empty and the
// chain read answers nothing for every App that already has one.

const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");
const BACKFILL = "0118_app_install_state_backfill.sql";

const BEFORE = migrationsAfter(2).filter((name) => migrationNumber(name) < migrationNumber(BACKFILL));

/** The world 0118 applies over: every migration before it, on a fresh DB. */
function preBackfillDb(): TestD1 {
  const db = createTestD1();
  applyMigration(db.raw, BEFORE);
  return db;
}

function applyBackfill(db: TestD1): void {
  applyMigration(db.raw, [BACKFILL]);
}

const TS = "2026-01-01T00:00:00.000Z";

function seedWorkspace(db: TestD1, id: string, opts: { deleted?: boolean } = {}): void {
  db.raw
    .prepare("INSERT INTO workspaces (id, slug, name, created_at, deleted_at) VALUES (?, ?, ?, ?, ?)")
    .run(id, id, id, TS, opts.deleted ? "2026-02-01T00:00:00.000Z" : null);
}

/**
 * An App row with no ownership mapping and no bot (seedBot writes both): the
 * relations under test here are only the installation and the target.
 */
function seedBareApp(db: TestD1, id: string, githubAppId: number): void {
  db.raw
    .prepare(
      `INSERT INTO github_apps
         (id, github_app_id, name, private_key_enc, webhook_secret_enc, created_by, status, created_at, updated_at)
       VALUES (?, ?, ?, 'k', 'w', 'fixture', 'active', ?, ?)`,
    )
    .run(id, githubAppId, id, TS, TS);
}

function seedBotRow(db: TestD1, id: string, workspaceId: string): void {
  db.raw
    .prepare(
      `INSERT INTO review_bots (id, workspace_id, name, multiplier, created_at, updated_at)
       VALUES (?, ?, ?, 1, ?, ?)`,
    )
    .run(id, workspaceId, id, TS, TS);
}

function seedInstallation(
  db: TestD1,
  row: { id: string; appId: string; installationId: number; bound: string | null; removed?: boolean },
): void {
  db.raw
    .prepare(
      `INSERT INTO github_app_installations
         (id, app_id, installation_id, account_login, seen_at, removed_at, bound_workspace_id)
       VALUES (?, ?, ?, 'acme', ?, ?, ?)`,
    )
    .run(row.id, row.appId, row.installationId, TS, row.removed ? "2026-02-01T00:00:00.000Z" : null, row.bound);
}

function states(db: TestD1): Array<{ github_app_id: string; workspace_id: string }> {
  return db.raw
    .query("SELECT github_app_id, workspace_id FROM app_installations ORDER BY github_app_id, workspace_id")
    .all() as Array<{ github_app_id: string; workspace_id: string }>;
}

function chain(db: TestD1): Array<{ github_app_id: string; workspace_id: string; position: number; bot_id: string }> {
  return db.raw
    .query(
      `SELECT github_app_id, workspace_id, position, bot_id FROM app_install_bots
        ORDER BY github_app_id, workspace_id, position`,
    )
    .all() as Array<{ github_app_id: string; workspace_id: string; position: number; bot_id: string }>;
}

function stagedSourceIsDropped(db: TestD1): boolean {
  return (
    db.raw.query("SELECT name FROM sqlite_master WHERE name = 'install_state_sources_0118'").all().length === 0
  );
}

/**
 * One workspace per source, so each UNION arm is the only reason its row
 * exists: an owned App, a live bound installation of somebody else's App, and
 * a live target on somebody else's App. `ws-owner` owns the two Apps it shares,
 * so its own states come from the ownership arm.
 */
function seedThreeSources(): TestD1 {
  const db = preBackfillDb();
  for (const id of ["ws-own", "ws-bind", "ws-target", "ws-owner"]) seedWorkspace(db, id);
  seedBot(db, "app-owned", 7001, { workspaceId: "ws-own" });
  seedBot(db, "app-shared", 7002, { workspaceId: "ws-owner" });
  seedInstallation(db, { id: "inst-bind", appId: "app-shared", installationId: 101, bound: "ws-bind" });
  seedBot(db, "app-targeted", 7003, { workspaceId: "ws-owner" });
  seedTarget(db, "app-targeted", { workspaceId: "ws-target", repoId: 31, repoOwner: "acme", repoName: "widgets" });
  return db;
}

const THREE_SOURCES_STATES = [
  { github_app_id: "app-owned", workspace_id: "ws-own" },
  { github_app_id: "app-shared", workspace_id: "ws-bind" },
  { github_app_id: "app-shared", workspace_id: "ws-owner" },
  { github_app_id: "app-targeted", workspace_id: "ws-owner" },
  { github_app_id: "app-targeted", workspace_id: "ws-target" },
];

describe(`migrations/${BACKFILL}`, () => {
  test("each live relation — owned App, bound installation, live target — yields its install state, once", () => {
    const db = seedThreeSources();
    applyBackfill(db);

    expect(states(db)).toEqual(THREE_SOURCES_STATES);
    expect(db.raw.query("PRAGMA foreign_key_check").all()).toEqual([]);
    db.raw.close();
  });

  test("one chain row per state at position 1, naming the bot that inherited the App id", () => {
    const db = seedThreeSources();
    applyBackfill(db);

    // The split gave the App's bot the App's id, so the chain row's bot id IS
    // the App id — and that bot exists (the guard refused otherwise).
    expect(chain(db)).toEqual(
      THREE_SOURCES_STATES.map((state) => ({ ...state, position: 1, bot_id: state.github_app_id })),
    );
    db.raw.close();
  });

  test("a second run inside the same transaction is a fixed point", () => {
    const db = seedThreeSources();
    const statements = splitSqlStatements(readFileSync(join(MIGRATIONS_DIR, BACKFILL), "utf8"));
    const snapshot = () => ({ states: states(db), chain: chain(db) });
    const expected = {
      states: THREE_SOURCES_STATES,
      chain: THREE_SOURCES_STATES.map((state) => ({ ...state, position: 1, bot_id: state.github_app_id })),
    };

    db.raw.transaction(() => {
      for (let pass = 0; pass < 2; pass += 1) {
        for (const statement of statements) db.raw.run(statement);
        // Checked after EACH pass: a first pass that already violates the fixed
        // point must not hide behind the second.
        expect(snapshot(), `pass ${pass + 1}`).toEqual(expected);
        expect(stagedSourceIsDropped(db), `pass ${pass + 1} leaves no staging table`).toBe(true);
      }
    })();
    db.raw.close();
  });

  test("a deleted App yields no state from any source", () => {
    const db = preBackfillDb();
    seedWorkspace(db, "ws-live");
    seedBareApp(db, "app-deleted", 7101);
    db.raw.run("UPDATE github_apps SET deleted_at = '2026-02-01T00:00:00.000Z' WHERE id = 'app-deleted'");
    // No bot row either: a deleted App's relations are not live, so nothing
    // reaches the chain guard.
    seedInstallation(db, { id: "inst-1", appId: "app-deleted", installationId: 201, bound: "ws-live" });

    applyBackfill(db);

    expect(states(db)).toEqual([]);
    expect(chain(db)).toEqual([]);
    db.raw.close();
  });

  test("a deleted workspace yields no state from any source", () => {
    const db = preBackfillDb();
    seedWorkspace(db, "ws-gone", { deleted: true });
    seedBareApp(db, "app-orphaned", 7201);
    seedInstallation(db, { id: "inst-1", appId: "app-orphaned", installationId: 202, bound: "ws-gone" });
    seedTarget(db, "app-orphaned", { workspaceId: "ws-gone", repoId: 41, repoOwner: "acme", repoName: "gone" });
    seedBotRow(db, "app-orphaned", "ws-gone");

    applyBackfill(db);

    expect(states(db)).toEqual([]);
    expect(chain(db)).toEqual([]);
    db.raw.close();
  });

  test("a removed installation and a retired target yield no state", () => {
    const db = preBackfillDb();
    seedWorkspace(db, "ws-live");
    seedBareApp(db, "app-1", 7301);
    seedBotRow(db, "app-1", "ws-live");
    seedInstallation(db, { id: "inst-1", appId: "app-1", installationId: 203, bound: "ws-live", removed: true });
    seedTarget(db, "app-1", { workspaceId: "ws-live", repoId: 42, repoOwner: "acme", repoName: "old" });
    db.raw.run("UPDATE review_targets SET deleted_at = '2026-02-01T00:00:00.000Z' WHERE app_id = 'app-1'");

    applyBackfill(db);

    expect(states(db)).toEqual([]);
    expect(chain(db)).toEqual([]);
    db.raw.close();
  });

  test("a live install relation that cannot name a bot aborts and writes nothing", () => {
    const db = preBackfillDb();
    seedWorkspace(db, "ws-live");
    // A well-formed pair the file would otherwise migrate, so the assertions
    // below prove the guard runs BEFORE either insert rather than unwinding a
    // half-written result.
    seedBot(db, "app-good", 7400, { workspaceId: "ws-live" });
    // An App with a live ownership row and no bot row: the split's own guard
    // makes that impossible through the writers, and it is exactly the state
    // this file must refuse rather than leave an install state without chain.
    seedBareApp(db, "app-botless", 7401);
    db.raw.run("INSERT INTO app_workspaces (app_id, workspace_id) VALUES ('app-botless', 'ws-live')");

    expect(() => applyBackfill(db)).toThrow(/guard_install_state_without_bot/);

    // Nothing of the aborted file survived — not even the pair that was fine.
    expect(states(db)).toEqual([]);
    expect(chain(db)).toEqual([]);
    expect(stagedSourceIsDropped(db)).toBe(true);
    db.raw.close();
  });
});
