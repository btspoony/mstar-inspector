/**
 * Workspace ownership migrations: 0026 creates the tenant tables + the
 * 'default' workspace, 0027 backfills every existing App and dashboard user
 * into it. The backfill is the interesting half: it must cover soft-deleted
 * Apps, map users by role, and be safe to re-apply (each INSERT…SELECT is
 * guarded by NOT EXISTS).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMigratedTestD1 } from "./helpers";
import type { TestD1 } from "./helpers";

const MIGRATIONS_DIR = join(import.meta.dir, "../../migrations");
const BACKFILL = "0027_workspace_backfill.sql";

/** Apply the idempotent backfill on top of the already-migrated shape. */
function applyBackfill(db: TestD1): void {
  db.raw.exec(readFileSync(join(MIGRATIONS_DIR, BACKFILL), "utf8"));
}

function countRows(db: TestD1, table: string): number {
  return (db.raw.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n;
}

function insertUser(db: TestD1, id: string, login: string, role: "admin" | "member"): void {
  db.raw
    .prepare(
      `INSERT INTO users (id, github_login, role, created_at)
       VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')`,
    )
    .run(id, login, role);
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

describe("migrations/0027_workspace_backfill.sql", () => {
  test("maps every App, including soft-deleted rows, with no orphans", () => {
    const db = createMigratedTestD1();
    insertApp(db, "app-live", "live-app", 1001);
    insertApp(db, "app-gone", "gone-app", 1002, "2026-02-01T00:00:00.000Z");
    applyBackfill(db);

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

  test("maps users by role without reading an allowlist", () => {
    const db = createMigratedTestD1();
    insertUser(db, "user-admin", "octocat", "admin");
    insertUser(db, "user-member", "hubot", "member");
    applyBackfill(db);

    const members = db.raw
      .query("SELECT user_id, role, workspace_id FROM workspace_members ORDER BY user_id")
      .all() as Array<{ user_id: string; role: string; workspace_id: string }>;
    expect(members).toEqual([
      { user_id: "user-admin", role: "owner", workspace_id: "default" },
      { user_id: "user-member", role: "member", workspace_id: "default" },
    ]);
  });

  test("re-applying the backfill changes no row counts", () => {
    const db = createMigratedTestD1();
    insertUser(db, "user-admin", "octocat", "admin");
    insertUser(db, "user-member", "hubot", "member");
    insertApp(db, "app-live", "live-app", 1001);
    insertApp(db, "app-gone", "gone-app", 1002, "2026-02-01T00:00:00.000Z");
    applyBackfill(db);

    const before = {
      workspaces: countRows(db, "workspaces"),
      appWorkspaces: countRows(db, "app_workspaces"),
      workspaceMembers: countRows(db, "workspace_members"),
    };
    applyBackfill(db);
    const after = {
      workspaces: countRows(db, "workspaces"),
      appWorkspaces: countRows(db, "app_workspaces"),
      workspaceMembers: countRows(db, "workspace_members"),
    };

    expect(after).toEqual(before);
    expect(before).toEqual({ workspaces: 1, appWorkspaces: 2, workspaceMembers: 2 });
  });

  test("new rows added after the first apply are picked up by a re-apply", () => {
    const db = createMigratedTestD1();
    applyBackfill(db);
    insertApp(db, "app-late", "late-app", 1003);
    insertUser(db, "user-late", "late", "member");
    applyBackfill(db);

    expect(countRows(db, "app_workspaces")).toBe(1);
    expect(countRows(db, "workspace_members")).toBe(1);
  });
});
