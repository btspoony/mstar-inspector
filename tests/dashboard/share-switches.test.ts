import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, seedBot, mapAppToDefaultWorkspace } from "../store/helpers";
import { setAppScope, setReviewBotScope } from "../../src/dashboard/apps-store";
import type { TestD1 } from "../store/helpers";

/**
 * The two post-split share switches (Task 4): the App switch writes
 * `github_apps.scope` audited as `runtime.app_scope.set` on target `app`; the
 * bot switch writes `review_bots.scope` audited as `runtime.bot_scope.set` on
 * target `bot`. Each carries the official-workspace guard INSIDE its batch,
 * so a non-owner (a bot whose workspace is not the designated official
 * workspace) can never write either column — the targeted refusal proof.
 */

const WS = "default";
const NOW = "2026-02-01T00:00:00.000Z";
const LATER = "2026-02-02T00:00:00.000Z";
const OFFICIAL_KEY = "platform.official_workspace_id";

async function seedPair(db: TestD1, id: string, githubAppId: number): Promise<void> {
  seedBot(db, id, githubAppId);
  await mapAppToDefaultWorkspace(db, id);
}

function seedOfficialWorkspace(db: TestD1, workspaceId: string): void {
  db.raw
    .prepare(
      `INSERT INTO review_runtime_settings (key, value, updated_at, updated_by)
       VALUES (?, ?, ?, 'fixture')`,
    )
    .run(OFFICIAL_KEY, workspaceId, NOW);
}

function seedWorkspace(db: TestD1, id: string): void {
  db.raw
    .prepare(
      `INSERT INTO workspaces (id, slug, name, created_at)
       VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z')`,
    )
    .run(id, id, id);
}

function audits(db: TestD1) {
  return (
    db.raw
      .prepare(
        `SELECT action, target_type, target_id, detail_json FROM platform_audit_events ORDER BY rowid`,
      )
      .all() as Array<{ action: string; target_type: string; target_id: string; detail_json: string | null }>
  ).map((row) => ({
    action: row.action,
    target_type: row.target_type,
    target_id: row.target_id,
    detail: JSON.parse(row.detail_json ?? "null"),
  }));
}

function appScope(db: TestD1, id: string) {
  return db.raw.query("SELECT scope, shared_at FROM github_apps WHERE id = ?").get(id) as {
    scope: string;
    shared_at: string | null;
  };
}

function botScope(db: TestD1, id: string) {
  return db.raw.query("SELECT scope, shared_at FROM review_bots WHERE id = ?").get(id) as {
    scope: string;
    shared_at: string | null;
  };
}

describe("the App share switch (github_apps.scope)", () => {
  test("owned → shared inside the official workspace writes the App column and its audit action", async () => {
    const db = createMigratedTestD1();
    await seedPair(db, "app-share", 7101);
    seedOfficialWorkspace(db, WS);

    const outcome = await setAppScope(db, {
      appId: "app-share",
      scope: "shared",
      actor: "operator",
      now: NOW,
    });

    expect(outcome).toEqual({ outcome: "ok", scope: "shared", sharedAt: NOW });
    expect(appScope(db, "app-share")).toEqual({ scope: "shared", shared_at: NOW });
    // The App switch does NOT write the bot column — the two switches are independent.
    expect(botScope(db, "app-share")).toEqual({ scope: "owned", shared_at: null });
    expect(audits(db)).toEqual([
      {
        action: "runtime.app_scope.set",
        target_type: "app",
        target_id: "app-share",
        detail: {
          before: { scope: "owned", shared_at: null },
          after: { scope: "shared", shared_at: NOW },
        },
      },
    ]);
  });

  test("unsharing needs confirm: true and audits the owned transition", async () => {
    const db = createMigratedTestD1();
    await seedPair(db, "app-unshare", 7102);
    db.raw.prepare("UPDATE github_apps SET scope = 'shared', shared_at = ? WHERE id = ?").run(NOW, "app-unshare");

    const refused = await setAppScope(db, {
      appId: "app-unshare",
      scope: "owned",
      actor: "operator",
      now: LATER,
    });
    expect(refused).toEqual({ outcome: "confirm_required" });
    expect(appScope(db, "app-unshare")).toEqual({ scope: "shared", shared_at: NOW });
    expect(audits(db)).toEqual([]);

    const accepted = await setAppScope(db, {
      appId: "app-unshare",
      scope: "owned",
      confirm: true,
      actor: "operator",
      now: LATER,
    });
    expect(accepted).toEqual({ outcome: "ok", scope: "owned", sharedAt: null });
    expect(audits(db)[0]?.action).toBe("runtime.app_scope.set");
    expect(audits(db)[0]?.target_type).toBe("app");
  });
});

describe("the bot share switch (review_bots.scope)", () => {
  test("owned → shared inside the official workspace writes the bot column and its audit action", async () => {
    const db = createMigratedTestD1();
    await seedPair(db, "bot-share", 7103);
    seedOfficialWorkspace(db, WS);

    const outcome = await setReviewBotScope(db, {
      botId: "bot-share",
      scope: "shared",
      actor: "operator",
      now: NOW,
    });

    expect(outcome).toEqual({ outcome: "ok", scope: "shared", sharedAt: NOW });
    expect(botScope(db, "bot-share")).toEqual({ scope: "shared", shared_at: NOW });
    // The bot switch does NOT write the App column.
    expect(appScope(db, "bot-share")).toEqual({ scope: "owned", shared_at: null });
    expect(audits(db)).toEqual([
      {
        action: "runtime.bot_scope.set",
        target_type: "bot",
        target_id: "bot-share",
        detail: {
          before: { scope: "owned", shared_at: null },
          after: { scope: "shared", shared_at: NOW },
        },
      },
    ]);
  });

  test("unsharing needs confirm: true", async () => {
    const db = createMigratedTestD1();
    await seedPair(db, "bot-unshare", 7104);
    db.raw.prepare("UPDATE review_bots SET scope = 'shared', shared_at = ? WHERE id = ?").run(NOW, "bot-unshare");

    const refused = await setReviewBotScope(db, {
      botId: "bot-unshare",
      scope: "owned",
      actor: "operator",
      now: LATER,
    });
    expect(refused).toEqual({ outcome: "confirm_required" });
    expect(botScope(db, "bot-unshare")).toEqual({ scope: "shared", shared_at: NOW });

    const accepted = await setReviewBotScope(db, {
      botId: "bot-unshare",
      scope: "owned",
      confirm: true,
      actor: "operator",
      now: LATER,
    });
    expect(accepted).toEqual({ outcome: "ok", scope: "owned", sharedAt: null });
    expect(audits(db)[0]?.action).toBe("runtime.bot_scope.set");
    expect(audits(db)[0]?.target_type).toBe("bot");
  });
});

describe("the non-owner refusal (neither switch writes outside the official workspace)", () => {
  test("the App switch refuses with the guard in the batch", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "other");
    // The pair lives in `default` but the official workspace is `other`:
    // the guard inside the batch refuses before a byte is written.
    await seedPair(db, "app-guarded", 7105);
    seedOfficialWorkspace(db, "other");

    const outcome = await setAppScope(db, {
      appId: "app-guarded",
      scope: "shared",
      actor: "operator",
      now: NOW,
    });
    expect(outcome).toEqual({ outcome: "outside_official_workspace" });
    expect(appScope(db, "app-guarded")).toEqual({ scope: "owned", shared_at: null });
    expect(audits(db)).toEqual([]);
  });

  test("the bot switch refuses with the guard in the batch", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "other");
    await seedPair(db, "bot-guarded", 7106);
    seedOfficialWorkspace(db, "other");

    const outcome = await setReviewBotScope(db, {
      botId: "bot-guarded",
      scope: "shared",
      actor: "operator",
      now: NOW,
    });
    expect(outcome).toEqual({ outcome: "outside_official_workspace" });
    expect(botScope(db, "bot-guarded")).toEqual({ scope: "owned", shared_at: null });
    expect(audits(db)).toEqual([]);

    // …and with NO official workspace designated at all.
    const db2 = createMigratedTestD1();
    await seedPair(db2, "bot-nowhere", 7107);
    const outcome2 = await setReviewBotScope(db2, {
      botId: "bot-nowhere",
      scope: "shared",
      actor: "operator",
      now: NOW,
    });
    expect(outcome2).toEqual({ outcome: "outside_official_workspace" });
    expect(botScope(db2, "bot-nowhere")).toEqual({ scope: "owned", shared_at: null });
    expect(audits(db2)).toEqual([]);
  });
});
