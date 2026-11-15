/**
 * `scripts/audit-owner-overlap.sql` — the read-only overlap listing.
 *
 * The shipped file is executed, not restated: one `account_login` on two live
 * targets in one workspace is the only state that can make it return a row,
 * and the row must name the targets and bots the operator has to choose
 * between.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMigratedTestD1, seedBot, seedTarget, type TestD1 } from "../store/helpers";

const AUDIT_SQL = readFileSync(join(import.meta.dir, "../../scripts/audit-owner-overlap.sql"), "utf8");

/** One row per (workspace, account_login) that appears on more than one live target. */
type OverlapRow = {
  workspace_id: string;
  account_login: string;
  target_ids: string;
  bot_ids: string;
};

/** Execute the audit exactly as an operator runs it. */
function overlaps(db: TestD1): OverlapRow[] {
  return db.raw.prepare(AUDIT_SQL).all() as OverlapRow[];
}

/** `review_bots.github_app_id` is UNIQUE; the fixture only needs it distinct. */
let nextGithubAppId = 1;

/** One target on `login`, in `workspaceId`, with its bot row. */
function seedOwned(db: TestD1, targetId: string, login: string, opts: { workspaceId?: string; deleted?: boolean } = {}): void {
  const botId = `bot-${targetId}`;
  seedBot(db, botId, nextGithubAppId++);
  seedTarget(db, botId, { id: targetId, workspaceId: opts.workspaceId });
  db.raw.prepare("UPDATE review_targets SET account_login = ? WHERE id = ?").run(login, targetId);
  if (opts.deleted === true) {
    db.raw.prepare("UPDATE review_targets SET deleted_at = datetime('now') WHERE id = ?").run(targetId);
  }
}

describe("audit-owner-overlap.sql", () => {
  test("two live targets on one login in one workspace is exactly one row", () => {
    const db = createMigratedTestD1();
    try {
      seedOwned(db, "target-a", "octocat");
      seedOwned(db, "target-b", "octocat");
      expect(overlaps(db)).toEqual([
        {
          workspace_id: "default",
          account_login: "octocat",
          target_ids: "target-a,target-b",
          bot_ids: "bot-target-a,bot-target-b",
        },
      ]);
    } finally {
      db.raw.close();
    }
  });

  test("the same login in two workspaces is one row per workspace", () => {
    const db = createMigratedTestD1();
    try {
      db.raw
        .prepare("INSERT INTO workspaces (id, slug, name, created_at) VALUES ('second', 'second', 'Second', datetime('now'))")
        .run();
      seedOwned(db, "target-a", "octocat");
      seedOwned(db, "target-b", "octocat");
      seedOwned(db, "target-c", "octocat", { workspaceId: "second" });
      seedOwned(db, "target-d", "octocat", { workspaceId: "second" });
      expect(overlaps(db).map((row) => [row.workspace_id, row.target_ids])).toEqual([
        ["default", "target-a,target-b"],
        ["second", "target-c,target-d"],
      ]);
    } finally {
      db.raw.close();
    }
  });

  test("a healthy fixture returns nothing", () => {
    const db = createMigratedTestD1();
    try {
      seedOwned(db, "target-a", "octocat");
      seedOwned(db, "target-b", "hubot");
      // An unclaimed target carries no login: it cannot overlap.
      seedBot(db, "bot-target-c", nextGithubAppId++);
      seedTarget(db, "bot-target-c", { id: "target-c" });
      expect(overlaps(db)).toEqual([]);
    } finally {
      db.raw.close();
    }
  });

  test("a soft-deleted target is excluded from the overlap and from the counts", () => {
    const db = createMigratedTestD1();
    try {
      seedOwned(db, "target-a", "octocat");
      seedOwned(db, "target-b", "octocat", { deleted: true });
      expect(overlaps(db)).toEqual([]);

      seedOwned(db, "target-c", "octocat");
      expect(overlaps(db)).toEqual([
        {
          workspace_id: "default",
          account_login: "octocat",
          target_ids: "target-a,target-c",
          bot_ids: "bot-target-a,bot-target-c",
        },
      ]);
    } finally {
      db.raw.close();
    }
  });
});
