import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createMigratedTestD1, createTestD1, execMigrationScript, migrationsAfter } from "./helpers";
import type { TestD1 } from "./helpers";
import { deleteWorkspaceMember, signInDashboardUser } from "../../src/dashboard/users";

const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");
const SCRIPTS_DIR = join(import.meta.dir, "../../scripts");
const APP_REPAIR = "workspace-backfill.sql";
const HISTORICAL_APP_REPAIR = "0027_workspace_backfill.sql";
const MEMBERSHIP_CUTOVER = "0030_workspace_membership_cutover.sql";
const CUTOVER = "2026-10-22T11:13:45.000Z";

function runFile(db: TestD1, name: string, dir = MIGRATIONS_DIR): void {
  execMigrationScript(db.raw, readFileSync(join(dir, name), "utf8"));
}

function dbBeforeCutover(): TestD1 {
  const db = createTestD1();
  const before = readdirSync(MIGRATIONS_DIR)
    .filter((name) => {
      const prefix = name.slice(0, 4);
      return name.endsWith(".sql") && prefix > "0002" && name < MEMBERSHIP_CUTOVER;
    })
    .sort();
  for (const name of before) runFile(db, name);
  return db;
}

function countRows(db: TestD1, table: string): number {
  return (db.raw.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function insertUser(
  db: TestD1,
  id: string,
  login: string,
  role: "admin" | "member",
  createdAt = "2026-01-01T00:00:00.000Z",
): void {
  db.raw
    .prepare("INSERT INTO users (id, github_login, role, created_at) VALUES (?, ?, ?, ?)")
    .run(id, login, role, createdAt);
}

function insertApp(
  db: TestD1,
  id: string,
  slug: string,
  githubAppId: number,
  deletedAt: string | null = null,
  parent = "review_bots",
): void {
  db.raw
    .prepare(
      `INSERT INTO ${parent} (id, github_app_id, name, private_key_enc, webhook_secret_enc,
         created_by, status, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, 'enc', 'enc', 'mallory', 'active', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
    .run(id, githubAppId, slug, deletedAt);
}

function defaultMembers(db: TestD1): string[] {
  return (
    db.raw
      .query(
        `SELECT u.github_login AS login FROM workspace_members wm
           JOIN users u ON u.id = wm.user_id
          WHERE wm.workspace_id = 'default' ORDER BY u.github_login`,
      )
      .all() as Array<{ login: string }>
  ).map((row) => row.login);
}

describe("migrations/0026_workspaces.sql", () => {
  test("seeds exactly one workspace and it is the default", () => {
    const db = createMigratedTestD1();
    expect(countRows(db, "workspaces")).toBe(1);
    const row = db.raw.query("SELECT id, slug, name, created_by FROM workspaces").get() as {
      id: string;
      slug: string;
      name: string;
      created_by: string | null;
    };
    expect(row).toEqual({ id: "default", slug: "default", name: "Default", created_by: null });
  });

  test("membership role domain rejects a value outside owner/admin/member", () => {
    const db = createMigratedTestD1();
    insertUser(db, "user-1", "octocat", "admin");
    expect(() =>
      db.raw
        .prepare(
          `INSERT INTO workspace_members (workspace_id, user_id, role, created_at)
           VALUES ('default', 'user-1', 'superuser', '2026-01-01T00:00:00.000Z')`,
        )
        .run(),
    ).toThrow();
  });
});

describe("scripts/workspace-backfill.sql (replayed every deploy)", () => {
  test("maps every App, including soft-deleted rows, with no orphans", () => {
    const db = createMigratedTestD1();
    insertApp(db, "app-live", "live-app", 1001);
    insertApp(db, "app-gone", "gone-app", 1002, "2026-02-01T00:00:00.000Z");
    runFile(db, APP_REPAIR, SCRIPTS_DIR);

    expect(countRows(db, "review_bots")).toBe(2);
    expect(countRows(db, "bot_workspaces")).toBe(countRows(db, "review_bots"));
    expect(countRows(db, "bot_workspaces")).toBe(2);

    const orphan = db.raw
      .query(
        `SELECT count(*) AS n FROM review_bots g
         LEFT JOIN bot_workspaces w ON w.bot_id = g.id
         WHERE w.bot_id IS NULL`,
      )
      .get() as { n: number };
    expect(orphan.n).toBe(0);

    const owners = db.raw
      .query("SELECT bot_id, workspace_id FROM bot_workspaces ORDER BY bot_id")
      .all() as Array<{ bot_id: string; workspace_id: string }>;
    expect(owners).toEqual([
      { bot_id: "app-gone", workspace_id: "default" },
      { bot_id: "app-live", workspace_id: "default" },
    ]);
  });

  test("the historical 0027 still applies where it runs: before the rename", () => {
    const db = createTestD1();
    for (const name of migrationsAfter(2).filter((entry) => entry < "0056_review_bots_rename.sql")) {
      runFile(db, name);
    }
    insertApp(db, "app-live", "live-app", 1001, null, "github_apps");
    runFile(db, HISTORICAL_APP_REPAIR);

    expect(countRows(db, "github_apps")).toBe(1);
    expect(countRows(db, "app_workspaces")).toBe(1);
  });

  test("new Apps added after the first apply are picked up by a re-apply", () => {
    const db = createMigratedTestD1();
    runFile(db, APP_REPAIR, SCRIPTS_DIR);
    insertApp(db, "app-late", "late-app", 1003);
    runFile(db, APP_REPAIR, SCRIPTS_DIR);

    expect(countRows(db, "bot_workspaces")).toBe(1);
    expect(countRows(db, "workspace_members")).toBe(0);
  });

  test("a routine replay grants no membership: a fresh login and a removed member stay out", async () => {
    const db = createMigratedTestD1();
    insertApp(db, "app-live", "live-app", 1001);

    const fresh = await signInDashboardUser(db, "fresh-login");
    if (fresh.outcome !== "allow") throw new Error("fixture sign-in was denied");
    const member = await signInDashboardUser(db, "removed-member");
    if (member.outcome !== "allow") throw new Error("fixture sign-in was denied");
    db.raw
      .prepare(
        "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ('default', ?, 'member', ?)",
      )
      .run(member.user.id, new Date().toISOString());
    expect(await deleteWorkspaceMember(db, "default", member.user.id)).toBe(true);
    expect(defaultMembers(db)).toEqual([]);

    runFile(db, APP_REPAIR, SCRIPTS_DIR);
    runFile(db, APP_REPAIR, SCRIPTS_DIR);

    expect(defaultMembers(db)).toEqual([]);
    expect(countRows(db, "users")).toBe(2);
    expect(countRows(db, "bot_workspaces")).toBe(1);
  });
});

describe("migrations/0030_workspace_membership_cutover.sql (applied once)", () => {
  test("backfills only pre-cutover users, honouring removal records and existing roles", () => {
    const db = dbBeforeCutover();
    insertUser(db, "user-admin", "octocat", "admin");
    insertUser(db, "user-member", "hubot", "member");
    insertUser(db, "user-late", "late", "member", CUTOVER);
    insertUser(db, "user-removed", "mallory", "member");
    db.raw
      .prepare("INSERT INTO removed_logins (github_login, removed_at) VALUES (?, ?)")
      .run("Mallory", "2026-10-22T10:00:00.000Z");

    runFile(db, MEMBERSHIP_CUTOVER);

    expect(defaultMembers(db)).toEqual(["hubot", "octocat"]);
    const roles = db.raw
      .query(
        `SELECT u.github_login AS login, wm.role AS role FROM workspace_members wm
           JOIN users u ON u.id = wm.user_id WHERE wm.workspace_id = 'default' ORDER BY login`,
      )
      .all() as Array<{ login: string; role: string }>;
    expect(roles).toEqual([
      { login: "hubot", role: "member" },
      { login: "octocat", role: "owner" },
    ]);

    runFile(db, MEMBERSHIP_CUTOVER);
    expect(defaultMembers(db)).toEqual(["hubot", "octocat"]);
  });

  test("inserted rows carry the cutover stamp, never 0027's legacy stamp", () => {
    const db = dbBeforeCutover();
    insertUser(db, "user-admin", "octocat", "admin");
    insertUser(db, "user-member", "hubot", "member");

    runFile(db, MEMBERSHIP_CUTOVER);

    const stamps = db.raw
      .query("SELECT DISTINCT created_at AS stamp FROM workspace_members ORDER BY stamp")
      .all() as Array<{ stamp: string }>;
    expect(stamps).toEqual([{ stamp: CUTOVER }]);
    expect(stamps.map((row) => row.stamp)).not.toContain("2026-10-21T00:00:00.000Z");
  });

  test("an existing membership keeps its role — an invited owner is not demoted", () => {
    const db = dbBeforeCutover();
    insertUser(db, "user-legacy", "hubot", "member");
    db.raw
      .prepare("INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ('default', 'user-legacy', 'owner', ?)")
      .run("2026-10-22T09:00:00.000Z");

    runFile(db, MEMBERSHIP_CUTOVER);

    const role = db.raw
      .query("SELECT role FROM workspace_members WHERE workspace_id = 'default' AND user_id = 'user-legacy'")
      .get() as { role: string };
    expect(role.role).toBe("owner");
    expect(countRows(db, "workspace_members")).toBe(1);
  });

  // KNOWN ONE-TIME RE-GRANT, pinned as current behaviour rather than "fixed":
  // a database that ran this branch BEFORE 0030 existed can hold a pre-cutover
  // user who was removed through the members page — that path deletes the
  // membership row and writes no `removed_logins` tombstone, so the `NOT
  // EXISTS` guard cannot tell them from a login that was never a member. The
  // first apply re-adds them to `default`. The production upgrade path is
  // unaffected (base `removeUser` writes the tombstone in the same batch), and
  // the effect is one-shot because the ledger applies this file once.
  // Operator guidance: docs/deploy.md § "The FIRST application has the same
  // blind spot".
  test("KNOWN: a pre-cutover user removed on the members page before the first apply is re-granted once", async () => {
    const db = dbBeforeCutover();
    insertUser(db, "user-members-page-removed", "members-page-removed", "member");
    db.raw
      .prepare(
        "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ('default', ?, 'admin', ?)",
      )
      .run("user-members-page-removed", "2026-01-01T00:00:00.000Z");
    expect(await deleteWorkspaceMember(db, "default", "user-members-page-removed")).toBe(true);
    expect(defaultMembers(db)).toEqual([]);
    expect(countRows(db, "removed_logins")).toBe(0);

    runFile(db, MEMBERSHIP_CUTOVER);

    expect(defaultMembers(db)).toEqual(["members-page-removed"]);
    const role = db.raw
      .query("SELECT role FROM workspace_members WHERE workspace_id = 'default' AND user_id = ?")
      .get("user-members-page-removed") as { role: string };
    expect(role.role).toBe("member");

    runFile(db, MEMBERSHIP_CUTOVER);
    expect(defaultMembers(db)).toEqual(["members-page-removed"]);
  });
});
