/**
 * Workspace ownership migrations: 0026 creates the tenant tables + the
 * 'default' workspace, 0027 attributes every existing App to it, and 0030
 * backfills the pre-open-sign-in users' memberships exactly once.
 *
 * 0027 is REPLAYED by both deploy workflows, so the interesting half is what
 * it must NOT do: a routine deploy must neither grant a fresh login a
 * membership nor resurrect a removed member. 0030 is the one-time half and is
 * scoped to the users that existed before open sign-in (cutover).
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { createMigratedTestD1, createTestD1 } from "./helpers";
import type { TestD1 } from "./helpers";
import { deleteWorkspaceMember, signInDashboardUser } from "../../src/dashboard/users";

const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");
const APP_REPAIR = "0027_workspace_backfill.sql";
const MEMBERSHIP_CUTOVER = "0030_workspace_membership_cutover.sql";
/** The open-sign-in instant 0030 scopes on (see the migration header). */
const CUTOVER = "2026-10-22T11:13:45.000Z";

/** Apply a migration file as `wrangler d1 execute --file` would (verbatim). */
function runFile(db: TestD1, name: string): void {
  db.raw.exec(readFileSync(join(MIGRATIONS_DIR, name), "utf8"));
}

/**
 * A database migrated exactly as production stood BEFORE 0030 applied: every
 * earlier file in filename order, 0030 not yet. Lets a test insert the
 * pre-cutover users and then let the migration do its one backfill.
 */
function dbBeforeCutover(): TestD1 {
  const db = createTestD1(); // already carries 0001 + 0002
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
): void {
  db.raw
    .prepare(
      `INSERT INTO github_apps (id, slug, github_app_id, name, private_key_enc, webhook_secret_enc,
         created_by, status, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, ?, 'enc', 'enc', 'mallory', 'active', ?, '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
    .run(id, slug, githubAppId, slug, deletedAt);
}

/** The `default` workspace's membership logins, sorted. */
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

describe("migrations/0027_workspace_backfill.sql (replayed every deploy)", () => {
  test("maps every App, including soft-deleted rows, with no orphans", () => {
    const db = createMigratedTestD1();
    insertApp(db, "app-live", "live-app", 1001);
    insertApp(db, "app-gone", "gone-app", 1002, "2026-02-01T00:00:00.000Z");
    runFile(db, APP_REPAIR);

    expect(countRows(db, "github_apps")).toBe(2);
    expect(countRows(db, "app_workspaces")).toBe(countRows(db, "github_apps"));
    expect(countRows(db, "app_workspaces")).toBe(2);

    const orphan = db.raw
      .query(
        `SELECT count(*) AS n FROM github_apps g
         LEFT JOIN app_workspaces w ON w.app_id = g.id
         WHERE w.app_id IS NULL`,
      )
      .get() as { n: number };
    expect(orphan.n).toBe(0);

    const owners = db.raw
      .query("SELECT app_id, workspace_id FROM app_workspaces ORDER BY app_id")
      .all() as Array<{ app_id: string; workspace_id: string }>;
    expect(owners).toEqual([
      { app_id: "app-gone", workspace_id: "default" },
      { app_id: "app-live", workspace_id: "default" },
    ]);
  });

  test("new Apps added after the first apply are picked up by a re-apply", () => {
    const db = createMigratedTestD1();
    runFile(db, APP_REPAIR);
    insertApp(db, "app-late", "late-app", 1003);
    runFile(db, APP_REPAIR);

    expect(countRows(db, "app_workspaces")).toBe(1);
    expect(countRows(db, "workspace_members")).toBe(0);
  });

  // The regression this split exists for: the file the workflows replay must
  // not touch `workspace_members` at all.
  test("a routine replay grants no membership: a fresh login and a removed member stay out", async () => {
    const db = createMigratedTestD1();
    insertApp(db, "app-live", "live-app", 1001);

    // (a) A login that signed in with no invite: a `users` row, no membership.
    const fresh = await signInDashboardUser(db, "fresh-login");
    if (fresh.outcome !== "allow") throw new Error("fixture sign-in was denied");
    // (b) A member removed from the workspace: the membership row is gone, the
    // users row survives (removal from a workspace is not a login ban) — which
    // is exactly the state the old replay resurrected.
    const member = await signInDashboardUser(db, "removed-member");
    if (member.outcome !== "allow") throw new Error("fixture sign-in was denied");
    db.raw
      .prepare(
        "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ('default', ?, 'member', ?)",
      )
      .run(member.user.id, new Date().toISOString());
    expect(await deleteWorkspaceMember(db, "default", member.user.id)).toBe(true);
    expect(defaultMembers(db)).toEqual([]);

    // The deploy's repair step, verbatim from disk — twice (a run can retry).
    runFile(db, APP_REPAIR);
    runFile(db, APP_REPAIR);

    expect(defaultMembers(db)).toEqual([]);
    expect(countRows(db, "users")).toBe(2);
    // The App half still did its job in the same run.
    expect(countRows(db, "app_workspaces")).toBe(1);
  });
});

describe("migrations/0030_workspace_membership_cutover.sql (applied once)", () => {
  test("backfills only pre-cutover users, honouring removal records and existing roles", () => {
    const db = dbBeforeCutover();
    insertUser(db, "user-admin", "octocat", "admin");
    insertUser(db, "user-member", "hubot", "member");
    // Signed in under open sign-in: joins nobody.
    insertUser(db, "user-late", "late", "member", CUTOVER);
    // Removed by an operator before the cutover: stays out.
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

    // Exactly once: a second apply inserts nothing (the deploy never does
    // this — the ledger does — but the guard is what makes that safe).
    runFile(db, MEMBERSHIP_CUTOVER);
    expect(defaultMembers(db)).toEqual(["hubot", "octocat"]);
  });

  // The stamp is the discriminator the deploy runbook keys on: 0030's own rows
  // must NOT reuse 0027's legacy stamp, or "written by the one-time migration"
  // and "written by a replayed 0027" become indistinguishable afterwards.
  test("inserted rows carry the cutover stamp, never 0027's legacy stamp", () => {
    const db = dbBeforeCutover();
    insertUser(db, "user-admin", "octocat", "admin");
    insertUser(db, "user-member", "hubot", "member");

    runFile(db, MEMBERSHIP_CUTOVER);

    const stamps = db.raw
      .query("SELECT DISTINCT created_at AS stamp FROM workspace_members ORDER BY stamp")
      .all() as Array<{ stamp: string }>;
    expect(stamps).toEqual([{ stamp: CUTOVER }]);
    // And the legacy value is exactly what the repair predicate excludes.
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
    // The row was written while the retired allowlist admitted logins: its
    // `created_at` predates the cutover, which is what makes 0030 want it.
    insertUser(db, "user-members-page-removed", "members-page-removed", "member");
    db.raw
      .prepare(
        "INSERT INTO workspace_members (workspace_id, user_id, role, created_at) VALUES ('default', ?, 'admin', ?)",
      )
      .run("user-members-page-removed", "2026-01-01T00:00:00.000Z");
    // Removed the way this branch's members page removes somebody.
    expect(await deleteWorkspaceMember(db, "default", "user-members-page-removed")).toBe(true);
    expect(defaultMembers(db)).toEqual([]);
    // The membership-only removal leaves no tombstone — that is the blind spot.
    expect(countRows(db, "removed_logins")).toBe(0);

    runFile(db, MEMBERSHIP_CUTOVER);

    expect(defaultMembers(db)).toEqual(["members-page-removed"]);
    const role = db.raw
      .query("SELECT role FROM workspace_members WHERE workspace_id = 'default' AND user_id = ?")
      .get("user-members-page-removed") as { role: string };
    // The legacy `users.role` mapping decides the re-granted role — the
    // pre-removal `admin` membership is gone, only the users row speaks.
    expect(role.role).toBe("member");

    // One-shot: a second apply cannot add anything, and a deploy never replays
    // this file through the ledger.
    runFile(db, MEMBERSHIP_CUTOVER);
    expect(defaultMembers(db)).toEqual(["members-page-removed"]);
  });
});
