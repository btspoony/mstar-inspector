import { describe, expect, test } from "bun:test";
import { createMigratedTestD1 } from "../store/helpers";
import { createReviewBotsStore, listBotScopes, setReviewBotScope } from "../../src/dashboard/apps-store";
import { createTargetsStore } from "../../src/dashboard/targets-store";
import { setOfficialWorkspace } from "../../src/dashboard/runtime-config-store";
import type { TestD1 } from "../store/helpers";

const WS = "default";

function seedApp(
  db: TestD1,
  id: string,
  options: { githubAppId: number; deleted?: boolean; name?: string },
): void {
  // Post-split pair: the App row (credentials/metadata) and the bot row
  // (review configuration). A soft-delete stamps BOTH — the invariant the
  // migration backfills and softDeleteApp keeps.
  const stamp = options.deleted ? "datetime('now')" : "NULL";
  db.raw
    .prepare(
      `INSERT INTO github_apps
         (id, github_app_id, name, private_key_enc, webhook_secret_enc, created_by,
          status, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, 'enc', 'enc', 'acme', 'active',
               ${stamp}, datetime('now'), datetime('now'))`,
    )
    .run(id, options.githubAppId, options.name ?? id);
  db.raw
    .prepare(
      `INSERT INTO review_bots
         (id, workspace_id, name, multiplier, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, 1, ${stamp}, datetime('now'), datetime('now'))`,
    )
    .run(id, WS, options.name ?? id);
}

describe("app creation (D13)", () => {
  test("creates the bot and its workspace mapping, and no review target", async () => {
    const db = createMigratedTestD1();
    const store = createReviewBotsStore(db);

    await store.createApp({
      id: "app-created",
      githubAppId: 5010,
      githubSlug: null,
      name: "app-created",
      privateKeyEnc: "enc",
      webhookSecretEnc: "enc",
      createdBy: "acme",
      workspaceId: WS,
      maxApps: null,
    });

    const app = await store.getAppById("app-created");
    expect(app?.workspace_id).toBe(WS);
    expect(app?.status).toBe("active");
    expect(await createTargetsStore(db).listLive(WS)).toEqual([]);
  });

  test("refuses an all-digits id — it could collide with a numeric GitHub App id at the route boundary (F1)", async () => {
    const db = createMigratedTestD1();
    await expect(
      createReviewBotsStore(db).createApp({
        id: "9201",
        githubAppId: 5012,
        githubSlug: null,
        name: "app-numeric",
        privateKeyEnc: "enc",
        webhookSecretEnc: "enc",
        createdBy: "acme",
        workspaceId: WS,
        maxApps: null,
      }),
    ).rejects.toThrow(/all-digits id/);
    // Nothing was written: the refusal happens before any row exists.
    expect(db.raw.query("SELECT COUNT(*) AS n FROM github_apps").get() as { n: number }).toEqual({ n: 0 });
    // A uuid-shaped id (what migrated rows carry) passes the rule.
    const created = await createReviewBotsStore(db).createApp({
      id: "5f9c1a2e-uuid-shape",
      githubAppId: 5013,
      githubSlug: null,
      name: "app-uuid",
      privateKeyEnc: "enc",
      webhookSecretEnc: "enc",
      createdBy: "acme",
      workspaceId: WS,
      maxApps: null,
    });
    expect(created.id).toBe("5f9c1a2e-uuid-shape");
  });

  test("refuses a workspace that is not live", async () => {
    const db = createMigratedTestD1();
    await expect(
      createReviewBotsStore(db).createApp({
        id: "app-dangling",
        githubAppId: 5011,
        githubSlug: null,
        name: "app-dangling",
        privateKeyEnc: "enc",
        webhookSecretEnc: "enc",
        createdBy: "acme",
        workspaceId: "ws-missing",
        maxApps: null,
      }),
    ).rejects.toThrow(/workspace is not live/);
  });
});

describe("app delete", () => {
  test("stamps the bot and every target it owns, and the first delete wins on both", async () => {
    const db = createMigratedTestD1();
    const store = createReviewBotsStore(db);
    await store.createApp({
      id: "app-delete",
      githubAppId: 5020,
      githubSlug: null,
      name: "app-delete",
      privateKeyEnc: "enc",
      webhookSecretEnc: "enc",
      createdBy: "acme",
      workspaceId: WS,
      maxApps: null,
    });
    const targets = createTargetsStore(db);
    const created = await targets.create({
      workspaceId: WS,
      botId: "app-delete",
      repoId: 900020,
      repoOwner: "acme",
      repoName: "repo",
      createdBy: "acme",
    });
    if (created.outcome !== "created") throw new Error("seed: target was refused as a duplicate");
    const target = created.target;

    expect(await store.softDeleteApp("app-delete")).toBe(true);
    expect((await store.getAppById("app-delete"))?.deleted_at).not.toBeNull();
    expect(await targets.getInWorkspace(WS, target.id)).toBeNull();

    expect(await store.softDeleteApp("app-delete")).toBe(false);
    const stamped = db.raw
      .query("SELECT deleted_at FROM review_targets WHERE id = ?")
      .get(target.id) as { deleted_at: string | null } | null;
    expect(stamped?.deleted_at).not.toBeNull();
  });
});

describe("GitHub App visibility (migration 0045)", () => {
  test("reads 'unknown' until probed and round-trips the stored value", async () => {
    const db = createMigratedTestD1();
    seedApp(db, "app-visibility", { githubAppId: 5201 });
    const store = createReviewBotsStore(db);

    expect(await store.getGithubVisibility("app-visibility")).toBe("unknown");

    expect(await store.saveGithubVisibility("app-visibility", "public")).toBe(true);
    expect(await store.getGithubVisibility("app-visibility")).toBe("public");

    expect(await store.saveGithubVisibility("app-visibility", "private")).toBe(true);
    expect(await store.getGithubVisibility("app-visibility")).toBe("private");

    expect(await store.getGithubVisibility("unknown-app")).toBeNull();
    expect(await store.saveGithubVisibility("unknown-app", "public")).toBe(false);
  });
});


const NOW = "2026-02-01T00:00:00.000Z";
const LATER = "2026-02-02T00:00:00.000Z";
const OFFICIAL_KEY = "platform.official_workspace_id";

function seedWorkspace(db: TestD1, id: string, deleted = false): void {
  db.raw
    .prepare(
      `INSERT INTO workspaces (id, slug, name, created_at, deleted_at)
       VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z', ${deleted ? "'2026-01-02T00:00:00.000Z'" : "NULL"})`,
    )
    .run(id, id, id);
}

function seedOfficialWorkspace(db: TestD1, workspaceId: string): void {
  db.raw
    .prepare(
      `INSERT INTO review_runtime_settings (key, value, updated_at, updated_by)
       VALUES (?, ?, ?, 'fixture')`,
    )
    .run(OFFICIAL_KEY, workspaceId, NOW);
}

let nextGithubAppId = 6100;

function seedScopedBot(
  db: TestD1,
  id: string,
  options: {
    workspaceId?: string;
    deleted?: boolean;
    scope?: string;
    sharedAt?: string | null;
    name?: string;
  } = {},
): void {
  nextGithubAppId += 1;
  seedApp(db, id, { githubAppId: nextGithubAppId, deleted: options.deleted, name: options.name });
  if (options.workspaceId !== undefined) {
    db.raw.prepare("INSERT OR REPLACE INTO app_workspaces (app_id, workspace_id) VALUES (?, ?)").run(id, options.workspaceId);
    if (options.workspaceId !== WS) {
      db.raw.prepare("UPDATE review_bots SET workspace_id = ? WHERE id = ?").run(options.workspaceId, id);
    }
  }
  if (options.scope !== undefined) {
    // Pre-split one scope row fed both columns; the migration backfilled them
    // equal, so a fixture that means "this bot is shared" stamps the pair.
    // The independent-switch behavior is covered in share-switches.test.ts.
    db.raw
      .prepare("UPDATE review_bots SET scope = ?, shared_at = ? WHERE id = ?")
      .run(options.scope, options.sharedAt ?? null, id);
    db.raw
      .prepare("UPDATE github_apps SET scope = ?, shared_at = ? WHERE id = ?")
      .run(options.scope, options.sharedAt ?? null, id);
  }
}

type ScopeAudit = { action: string; target_type: string; target_id: string; detail: unknown };

function scopeAudits(db: TestD1): ScopeAudit[] {
  return (
    db.raw
      .prepare(
        `SELECT action, target_type, target_id, detail_json
           FROM platform_audit_events ORDER BY rowid`,
      )
      .all() as Array<{ action: string; target_type: string; target_id: string; detail_json: string | null }>
  ).map((row) => ({
    action: row.action,
    target_type: row.target_type,
    target_id: row.target_id,
    detail: JSON.parse(row.detail_json ?? "null"),
  }));
}

function storedScope(db: TestD1, botId: string): { scope: string; shared_at: string | null } {
  return db.raw.query("SELECT scope, shared_at FROM review_bots WHERE id = ?").get(botId) as {
    scope: string;
    shared_at: string | null;
  };
}

describe("bot scope transitions (contract § 7.1)", () => {
  test("owned → shared inside the official workspace writes scope, shared_at and one audit row", async () => {
    const db = createMigratedTestD1();
    seedScopedBot(db, "bot-share", { workspaceId: WS });
    seedOfficialWorkspace(db, WS);

    const outcome = await setReviewBotScope(db, {
      botId: "bot-share",
      scope: "shared",
      actor: "operator",
      now: NOW,
      authority: { workspaceId: WS, role: "owner" },
    });

    expect(outcome).toEqual({ outcome: "ok", scope: "shared", sharedAt: NOW });
    expect(storedScope(db, "bot-share")).toEqual({ scope: "shared", shared_at: NOW });
    expect(scopeAudits(db)).toEqual([
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

  test("shared → owned needs confirm: true", async () => {
    const db = createMigratedTestD1();
    seedScopedBot(db, "bot-unshare", { workspaceId: WS, scope: "shared", sharedAt: NOW });

    for (const confirm of [undefined, false]) {
      const refused = await setReviewBotScope(db, {
        botId: "bot-unshare",
        scope: "owned",
        confirm,
        actor: "operator",
        now: LATER,
      authority: { workspaceId: WS, role: "owner" },
      });
      expect(refused).toEqual({ outcome: "confirm_required" });
    }
    expect(storedScope(db, "bot-unshare")).toEqual({ scope: "shared", shared_at: NOW });
    expect(scopeAudits(db)).toEqual([]);

    const accepted = await setReviewBotScope(db, {
      botId: "bot-unshare",
      scope: "owned",
      confirm: true,
      actor: "operator",
      now: LATER,
      authority: { workspaceId: WS, role: "owner" },
    });
    expect(accepted).toEqual({ outcome: "ok", scope: "owned", sharedAt: null });
    expect(storedScope(db, "bot-unshare")).toEqual({ scope: "owned", shared_at: null });
    expect(scopeAudits(db)).toEqual([
      {
        action: "runtime.bot_scope.set",
        target_type: "bot",
        target_id: "bot-unshare",
        detail: {
          before: { scope: "shared", shared_at: NOW },
          after: { scope: "owned", shared_at: null },
        },
      },
    ]);
  });

  test("a same-value transition is a no-op that appends no audit row", async () => {
    const db = createMigratedTestD1();
    seedScopedBot(db, "bot-owned", { workspaceId: WS });
    seedScopedBot(db, "bot-still-shared", { workspaceId: WS, scope: "shared", sharedAt: NOW });
    seedOfficialWorkspace(db, WS);

    expect(
      await setReviewBotScope(db, { botId: "bot-owned", scope: "owned", actor: "operator", now: LATER , authority: { workspaceId: WS, role: "owner" } }),
    ).toEqual({ outcome: "ok", scope: "owned", sharedAt: null });
    expect(
      await setReviewBotScope(db, { botId: "bot-still-shared", scope: "shared", actor: "operator", now: LATER , authority: { workspaceId: WS, role: "owner" } }),
    ).toEqual({ outcome: "ok", scope: "shared", sharedAt: NOW });

    expect(storedScope(db, "bot-owned")).toEqual({ scope: "owned", shared_at: null });
    expect(storedScope(db, "bot-still-shared")).toEqual({ scope: "shared", shared_at: NOW });
    expect(scopeAudits(db)).toEqual([]);
  });

  test("sharing is refused outside the official workspace, and with none designated", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "other");
    seedScopedBot(db, "bot-elsewhere", { workspaceId: "other" });
    seedScopedBot(db, "bot-home", { workspaceId: WS });

    expect(
      await setReviewBotScope(db, { botId: "bot-home", scope: "shared", actor: "operator", now: NOW , authority: { workspaceId: WS, role: "owner" } }),
    ).toEqual({ outcome: "outside_official_workspace" });

    seedOfficialWorkspace(db, WS);
    // F12: a FOREIGN bot is refused by ownership first, never by the official
    // rule — authorize as its own workspace to isolate the rule under test.
    expect(
      await setReviewBotScope(db, { botId: "bot-elsewhere", scope: "shared", actor: "operator", now: NOW , authority: { workspaceId: "other", role: "owner" } }),
    ).toEqual({ outcome: "outside_official_workspace" });

    expect(storedScope(db, "bot-home")).toEqual({ scope: "owned", shared_at: null });
    expect(storedScope(db, "bot-elsewhere")).toEqual({ scope: "owned", shared_at: null });
    expect(scopeAudits(db)).toEqual([]);
  });

  test("unsharing stays allowed after the official workspace moved away", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "other");
    seedScopedBot(db, "bot-stale-share", { workspaceId: WS, scope: "shared", sharedAt: NOW });
    seedOfficialWorkspace(db, "other");

    expect(
      await setReviewBotScope(db, {
        botId: "bot-stale-share",
        scope: "owned",
        confirm: true,
        actor: "operator",
        now: LATER,
      authority: { workspaceId: WS, role: "owner" },
      }),
    ).toEqual({ outcome: "ok", scope: "owned", sharedAt: null });
    expect(storedScope(db, "bot-stale-share")).toEqual({ scope: "owned", shared_at: null });
    expect(scopeAudits(db)).toHaveLength(1);
  });

  test("a re-share after a revoke stamps a new shared_at", async () => {
    const db = createMigratedTestD1();
    seedScopedBot(db, "bot-cycle", { workspaceId: WS });
    seedOfficialWorkspace(db, WS);

    await setReviewBotScope(db, { botId: "bot-cycle", scope: "shared", actor: "operator", now: NOW , authority: { workspaceId: WS, role: "owner" } });
    await setReviewBotScope(db, { botId: "bot-cycle", scope: "owned", confirm: true, actor: "operator", now: LATER , authority: { workspaceId: WS, role: "owner" } });
    const reShared = await setReviewBotScope(db, {
      botId: "bot-cycle",
      scope: "shared",
      actor: "operator",
      now: "2026-03-01T00:00:00.000Z",
      authority: { workspaceId: WS, role: "owner" },
    });

    expect(reShared).toEqual({ outcome: "ok", scope: "shared", sharedAt: "2026-03-01T00:00:00.000Z" });
    expect(storedScope(db, "bot-cycle")).toEqual({
      scope: "shared",
      shared_at: "2026-03-01T00:00:00.000Z",
    });
    expect(scopeAudits(db)).toHaveLength(3);
  });

  test("a missing or soft-deleted bot is bot_not_found and writes nothing", async () => {
    const db = createMigratedTestD1();
    seedScopedBot(db, "bot-gone", { workspaceId: WS, deleted: true });
    seedOfficialWorkspace(db, WS);

    expect(
      await setReviewBotScope(db, { botId: "bot-absent", scope: "shared", actor: "operator", now: NOW , authority: { workspaceId: WS, role: "owner" } }),
    ).toEqual({ outcome: "bot_not_found" });
    expect(
      await setReviewBotScope(db, { botId: "bot-gone", scope: "shared", actor: "operator", now: NOW , authority: { workspaceId: WS, role: "owner" } }),
    ).toEqual({ outcome: "bot_not_found" });
    expect(scopeAudits(db)).toEqual([]);
  });

  test("a bot deleted between the read and the write is bot_not_found, not a scope refusal", async () => {
    const db = createMigratedTestD1();
    seedScopedBot(db, "bot-raced", { workspaceId: WS });
    seedOfficialWorkspace(db, WS);

    let fired = false;
    const racingDb: TestD1 = {
      raw: db.raw,
      prepare: (query: string) => db.prepare(query),
      batch: async (statements) => {
        if (!fired) {
          fired = true;
          db.raw.prepare("UPDATE review_bots SET deleted_at = ? WHERE id = 'bot-raced'").run(NOW);
        }
        return db.batch(statements);
      },
    };

    expect(
      await setReviewBotScope(racingDb, {
        botId: "bot-raced",
        scope: "shared",
        actor: "operator",
        now: NOW,
        authority: { workspaceId: WS, role: "owner" },
      }),
    ).toEqual({ outcome: "bot_not_found" });
    expect(fired).toBe(true);
    expect(storedScope(db, "bot-raced")).toEqual({ scope: "owned", shared_at: null });
    expect(scopeAudits(db)).toEqual([]);
  });

  test("a designation cleared between the read and the write refuses the share", async () => {
    const db = createMigratedTestD1();
    seedScopedBot(db, "bot-stale-designation", { workspaceId: WS });
    seedOfficialWorkspace(db, WS);

    let fired = false;
    const racingDb: TestD1 = {
      raw: db.raw,
      prepare: (query: string) => db.prepare(query),
      batch: async (statements) => {
        if (!fired) {
          fired = true;
          db.raw.prepare("DELETE FROM review_runtime_settings WHERE key = ?").run(OFFICIAL_KEY);
        }
        return db.batch(statements);
      },
    };

    expect(
      await setReviewBotScope(racingDb, {
        botId: "bot-stale-designation",
        scope: "shared",
        actor: "operator",
        now: NOW,
      authority: { workspaceId: WS, role: "owner" },
      }),
    ).toEqual({ outcome: "outside_official_workspace" });
    expect(fired).toBe(true);
    expect(storedScope(db, "bot-stale-designation")).toEqual({ scope: "owned", shared_at: null });
    expect(scopeAudits(db)).toEqual([]);
  });

  test("two concurrent shares land once, keeping the first shared_at and one audit row", async () => {
    const db = createMigratedTestD1();
    seedScopedBot(db, "bot-double-share", { workspaceId: WS });
    seedOfficialWorkspace(db, WS);

    let fired = false;
    const racingDb: TestD1 = {
      raw: db.raw,
      prepare: (query: string) => db.prepare(query),
      batch: async (statements) => {
        if (!fired) {
          fired = true;
          expect(
            await setReviewBotScope(db, {
              botId: "bot-double-share",
              scope: "shared",
              actor: "operator",
              now: NOW,
      authority: { workspaceId: WS, role: "owner" },
            }),
          ).toEqual({ outcome: "ok", scope: "shared", sharedAt: NOW });
        }
        return db.batch(statements);
      },
    };

    expect(
      await setReviewBotScope(racingDb, {
        botId: "bot-double-share",
        scope: "shared",
        actor: "operator",
        now: LATER,
      authority: { workspaceId: WS, role: "owner" },
      }),
    ).toEqual({ outcome: "ok", scope: "shared", sharedAt: NOW });
    expect(fired).toBe(true);
    expect(storedScope(db, "bot-double-share")).toEqual({ scope: "shared", shared_at: NOW });
    expect(scopeAudits(db)).toEqual([
      {
        action: "runtime.bot_scope.set",
        target_type: "bot",
        target_id: "bot-double-share",
        detail: {
          before: { scope: "owned", shared_at: null },
          after: { scope: "shared", shared_at: NOW },
        },
      },
    ]);
  });

  test("two concurrent revokes land once", async () => {
    const db = createMigratedTestD1();
    seedScopedBot(db, "bot-double-revoke", { workspaceId: WS, scope: "shared", sharedAt: NOW });

    let fired = false;
    const racingDb: TestD1 = {
      raw: db.raw,
      prepare: (query: string) => db.prepare(query),
      batch: async (statements) => {
        if (!fired) {
          fired = true;
          expect(
            await setReviewBotScope(db, {
              botId: "bot-double-revoke",
              scope: "owned",
              confirm: true,
              actor: "operator",
              now: NOW,
      authority: { workspaceId: WS, role: "owner" },
            }),
          ).toEqual({ outcome: "ok", scope: "owned", sharedAt: null });
        }
        return db.batch(statements);
      },
    };

    expect(
      await setReviewBotScope(racingDb, {
        botId: "bot-double-revoke",
        scope: "owned",
        confirm: true,
        actor: "operator",
        now: LATER,
      authority: { workspaceId: WS, role: "owner" },
      }),
    ).toEqual({ outcome: "ok", scope: "owned", sharedAt: null });
    expect(fired).toBe(true);
    expect(storedScope(db, "bot-double-revoke")).toEqual({ scope: "owned", shared_at: null });
    expect(scopeAudits(db)).toEqual([
      {
        action: "runtime.bot_scope.set",
        target_type: "bot",
        target_id: "bot-double-revoke",
        detail: {
          before: { scope: "shared", shared_at: NOW },
          after: { scope: "owned", shared_at: null },
        },
      },
    ]);
  });

  test("an archive between the read and the batch refuses the share, and audits nothing", async () => {
    const db = createMigratedTestD1();
    seedScopedBot(db, "bot-archive-race", { workspaceId: WS });
    seedOfficialWorkspace(db, WS);

    let fired = false;
    const racingDb: TestD1 = {
      raw: db.raw,
      prepare: (query: string) => db.prepare(query),
      batch: async (statements) => {
        if (!fired) {
          fired = true;
          // The archive lands after this request read the bot as live and before
          // its share batch runs.
          db.raw.prepare("UPDATE review_bots SET archived_at = ? WHERE id = 'bot-archive-race'").run(NOW);
        }
        return db.batch(statements);
      },
    };

    expect(
      await setReviewBotScope(racingDb, {
        botId: "bot-archive-race",
        scope: "shared",
        actor: "operator",
        now: LATER,
        authority: { workspaceId: WS, role: "owner" },
      }),
    ).toEqual({ outcome: "archived" });
    expect(fired).toBe(true);
    expect(storedScope(db, "bot-archive-race")).toEqual({ scope: "owned", shared_at: null });
    expect(scopeAudits(db)).toEqual([]);
  });

  test("an archive between the read and the batch refuses the revoke, keeping the share", async () => {
    const db = createMigratedTestD1();
    seedScopedBot(db, "bot-archive-revoke", { workspaceId: WS, scope: "shared", sharedAt: NOW });

    let fired = false;
    const racingDb: TestD1 = {
      raw: db.raw,
      prepare: (query: string) => db.prepare(query),
      batch: async (statements) => {
        if (!fired) {
          fired = true;
          db.raw.prepare("UPDATE review_bots SET archived_at = ? WHERE id = 'bot-archive-revoke'").run(NOW);
        }
        return db.batch(statements);
      },
    };

    expect(
      await setReviewBotScope(racingDb, {
        botId: "bot-archive-revoke",
        scope: "owned",
        confirm: true,
        actor: "operator",
        now: LATER,
        authority: { workspaceId: WS, role: "owner" },
      }),
    ).toEqual({ outcome: "archived" });
    expect(storedScope(db, "bot-archive-revoke")).toEqual({ scope: "shared", shared_at: NOW });
    expect(scopeAudits(db)).toEqual([]);
  });

  test("an already-archived bot is refused before the batch, with zero writes", async () => {
    const db = createMigratedTestD1();
    seedScopedBot(db, "bot-archived-read", { workspaceId: WS });
    seedOfficialWorkspace(db, WS);
    db.raw.prepare("UPDATE review_bots SET archived_at = ? WHERE id = 'bot-archived-read'").run(NOW);

    let batched = false;
    const racingDb: TestD1 = {
      raw: db.raw,
      prepare: (query: string) => db.prepare(query),
      batch: async (statements) => {
        batched = true;
        return db.batch(statements);
      },
    };

    expect(
      await setReviewBotScope(racingDb, {
        botId: "bot-archived-read",
        scope: "shared",
        actor: "operator",
        now: LATER,
        authority: { workspaceId: WS, role: "owner" },
      }),
    ).toEqual({ outcome: "archived" });
    expect(batched).toBe(false);
    expect(scopeAudits(db)).toEqual([]);
  });

  test("a bot deleted inside the batch is bot_not_found, not archived or ok", async () => {
    const db = createMigratedTestD1();
    seedScopedBot(db, "bot-deleted-in-batch", { workspaceId: WS });
    seedOfficialWorkspace(db, WS);

    let fired = false;
    const racingDb: TestD1 = {
      raw: db.raw,
      prepare: (query: string) => db.prepare(query),
      batch: async (statements) => {
        if (!fired) {
          fired = true;
          db.raw.prepare("UPDATE review_bots SET deleted_at = ? WHERE id = 'bot-deleted-in-batch'").run(NOW);
        }
        return db.batch(statements);
      },
    };

    expect(
      await setReviewBotScope(racingDb, {
        botId: "bot-deleted-in-batch",
        scope: "shared",
        actor: "operator",
        now: LATER,
        authority: { workspaceId: WS, role: "owner" },
      }),
    ).toEqual({ outcome: "bot_not_found" });
    expect(fired).toBe(true);
    expect(scopeAudits(db)).toEqual([]);
  });

  test("a bot deleted for the batch and restored before the read is bot_not_found, not ok", async () => {
    const db = createMigratedTestD1();
    seedScopedBot(db, "bot-deleted-restored", { workspaceId: WS, scope: "shared", sharedAt: NOW });
    seedOfficialWorkspace(db, WS);

    let fired = false;
    const racingDb: TestD1 = {
      raw: db.raw,
      prepare: (query: string) => db.prepare(query),
      batch: async (statements) => {
        if (!fired) {
          fired = true;
          // Deleted for the batch, restored before the call's later read: a
          // post-batch read would call the refused write `ok`.
          db.raw.prepare("UPDATE review_bots SET deleted_at = ? WHERE id = 'bot-deleted-restored'").run(NOW);
        }
        const results = await db.batch(statements);
        db.raw.prepare("UPDATE review_bots SET deleted_at = NULL WHERE id = 'bot-deleted-restored'").run();
        return results;
      },
    };

    expect(
      await setReviewBotScope(racingDb, {
        botId: "bot-deleted-restored",
        scope: "owned",
        confirm: true,
        actor: "operator",
        now: LATER,
        authority: { workspaceId: WS, role: "owner" },
      }),
    ).toEqual({ outcome: "bot_not_found" });
    expect(storedScope(db, "bot-deleted-restored")).toEqual({ scope: "shared", shared_at: NOW });
    expect(scopeAudits(db)).toEqual([]);
  });

  test("a shared bot survives a designation clear: no revocation, no new share, still revocable", async () => {
    const db = createMigratedTestD1();
    seedScopedBot(db, "bot-orphan-share", { workspaceId: WS, scope: "shared", sharedAt: NOW });
    seedScopedBot(db, "bot-new", { workspaceId: WS });
    seedOfficialWorkspace(db, WS);

    expect(await setOfficialWorkspace(db, { workspaceId: null, actor: "operator", now: LATER })).toBeNull();
    expect(storedScope(db, "bot-orphan-share")).toEqual({ scope: "shared", shared_at: NOW });

    expect(
      await setReviewBotScope(db, { botId: "bot-new", scope: "shared", actor: "operator", now: LATER , authority: { workspaceId: WS, role: "owner" } }),
    ).toEqual({ outcome: "outside_official_workspace" });
    expect(storedScope(db, "bot-new")).toEqual({ scope: "owned", shared_at: null });

    expect(
      await setReviewBotScope(db, {
        botId: "bot-orphan-share",
        scope: "owned",
        confirm: true,
        actor: "operator",
        now: LATER,
      authority: { workspaceId: WS, role: "owner" },
      }),
    ).toEqual({ outcome: "ok", scope: "owned", sharedAt: null });
    expect(storedScope(db, "bot-orphan-share")).toEqual({ scope: "owned", shared_at: null });
  });

  test("the console list carries every live bot with its scope, ordered by name then id", async () => {
    const db = createMigratedTestD1();
    seedScopedBot(db, "bot-b", { workspaceId: WS, scope: "shared", sharedAt: NOW, name: "Alpha" });
    seedScopedBot(db, "bot-a", { workspaceId: WS, name: "Zulu" });
    seedScopedBot(db, "bot-dead", { workspaceId: WS, deleted: true, name: "Alpha" });

    const rows = await listBotScopes(db);
    expect(rows.map((row) => row.id)).toEqual(["bot-b", "bot-a"]);
    expect(rows[0]).toMatchObject({
      id: "bot-b",
      name: "Alpha",
      workspace_id: WS,
      scope: "shared",
      shared_at: NOW,
      deleted_at: null,
    });
    expect(rows[1]).toMatchObject({ id: "bot-a", name: "Zulu" });
  });
});


function seedTargetIn(db: TestD1, botId: string, workspaceId: string, deleted = false): void {
  db.raw
    .prepare(
      `INSERT INTO review_targets
         (id, workspace_id, app_id, name, created_by, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, 'fixture', datetime('now'), datetime('now'),
               ${deleted ? "datetime('now')" : "NULL"})`,
    )
    .run(crypto.randomUUID(), workspaceId, botId, botId);
}

describe("shared bots a workspace may create a target on", () => {
  test("each live shared bot carries the ADDRESSED workspace's live target count", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "ws-other");
    seedScopedBot(db, "bot-shared", { workspaceId: "ws-other", scope: "shared", sharedAt: NOW, name: "Alpha" });
    db.raw.prepare("UPDATE github_apps SET github_slug = 'alpha-app' WHERE id = 'bot-shared'").run();
    seedTargetIn(db, "bot-shared", WS);
    seedTargetIn(db, "bot-shared", WS, true);
    seedTargetIn(db, "bot-shared", "ws-other");
    seedTargetIn(db, "bot-shared", "ws-other");

    const store = createReviewBotsStore(db);
    // `listSharedBots` is the BOT face (the review-usage "designated bot"
    // read): bot rows, bot scopes, the caller's own target count.
    expect(await store.listSharedBots(WS)).toEqual([
      { id: "bot-shared", github_slug: "alpha-app", name: "Alpha", target_count: 1 },
    ]);
    expect(await store.listSharedBots("ws-other")).toEqual([
      { id: "bot-shared", github_slug: "alpha-app", name: "Alpha", target_count: 2 },
    ]);

    // F9: the CHOOSER is the App face — a shared GitHub App, selected by
    // `github_apps.scope`, with the App's own display chain (`github_name` is
    // absent here, so it falls back to the slug), description and owner.
    expect(await store.listSharedApps(WS)).toEqual([
      {
        id: "bot-shared",
        github_slug: "alpha-app",
        name: "alpha-app",
        github_description: null,
        owner_workspace_id: "ws-other",
        owner_workspace_name: "ws-other",
        capability: null,
        target_count: 1,
      },
    ]);
  });

  test("an owned, soft-deleted or absent bot is never offered", async () => {
    const db = createMigratedTestD1();
    seedScopedBot(db, "bot-owned", { workspaceId: WS, name: "Owned" });
    seedScopedBot(db, "bot-gone", { workspaceId: WS, deleted: true, scope: "shared", sharedAt: NOW, name: "Gone" });
    seedScopedBot(db, "bot-offered", { workspaceId: WS, scope: "shared", sharedAt: NOW, name: "Offered" });

    expect((await createReviewBotsStore(db).listSharedBots(WS)).map((row) => row.id)).toEqual(["bot-offered"]);
  });
});


function githubAppIdOf(db: TestD1, botId: string): number {
  const row = db.raw.query("SELECT github_app_id AS id FROM github_apps WHERE id = ?").get(botId) as {
    id: number;
  } | null;
  if (row === null) throw new Error(`no github_apps row ${botId}`);
  return row.id;
}

describe("the workspace-scoped App resolve", () => {
  test("resolves the workspace's own bot and any bot it holds a live target on", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "ws-other");
    seedScopedBot(db, "bot-own", { workspaceId: WS });
    seedScopedBot(db, "bot-foreign", { workspaceId: "ws-other" });
    seedScopedBot(db, "bot-shared", { workspaceId: "ws-other", scope: "shared", sharedAt: NOW });
    seedScopedBot(db, "bot-dead", { workspaceId: WS, deleted: true });

    const store = createReviewBotsStore(db);
    const own = await store.getScopedAppByGithubId(githubAppIdOf(db, "bot-own"), WS);
    expect(own?.id).toBe("bot-own");
    expect(own?.workspace_id).toBe(WS);
    expect(await store.getScopedAppByGithubId(githubAppIdOf(db, "bot-shared"), WS)).toBeNull();
    expect(await store.getScopedAppByGithubId(githubAppIdOf(db, "bot-foreign"), WS)).toBeNull();
    expect(await store.getScopedAppByGithubId(githubAppIdOf(db, "bot-dead"), WS)).toBeNull();

    seedTargetIn(db, "bot-foreign", WS);
    const revoked = await store.getScopedAppByGithubId(githubAppIdOf(db, "bot-foreign"), WS);
    expect(revoked?.id).toBe("bot-foreign");
    expect(revoked?.workspace_id).toBe("ws-other");

    seedTargetIn(db, "bot-shared", WS);
    const shared = await store.getScopedAppByGithubId(githubAppIdOf(db, "bot-shared"), WS);
    expect(shared?.id).toBe("bot-shared");
    expect(shared?.workspace_id).toBe("ws-other");
  });

  test("a shared bot whose only target here is deleted stays invisible", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "ws-other");
    seedScopedBot(db, "bot-shared", { workspaceId: "ws-other", scope: "shared", sharedAt: NOW });
    seedTargetIn(db, "bot-shared", WS, true);

    expect(await createReviewBotsStore(db).getScopedAppByGithubId(githubAppIdOf(db, "bot-shared"), WS)).toBeNull();
  });
});


function seedInstallation(db: TestD1, botId: string, installationId: number, removed = false): void {
  db.raw
    .prepare(
      `INSERT INTO github_app_installations (id, app_id, installation_id, account_login, seen_at, removed_at)
       VALUES (?, ?, ?, NULL, '2026-01-01T00:00:00.000Z', ${removed ? "datetime('now')" : "NULL"})`,
    )
    .run(crypto.randomUUID(), botId, installationId);
}

describe("pending installations of a bot", () => {
  test("lists the bot's live installations, newest seen first", async () => {
    const db = createMigratedTestD1();
    seedScopedBot(db, "bot-pending", { workspaceId: WS });
    seedInstallation(db, "bot-pending", 100);
    seedInstallation(db, "bot-pending", 200, true);

    const rows = await createReviewBotsStore(db).listPendingInstallations("bot-pending", WS, true);
    expect(rows.map((row) => row.installation_id)).toEqual([100]);
  });

  test("answers nothing for a bot the addressed workspace may not use", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "ws-other");
    seedScopedBot(db, "bot-foreign", { workspaceId: "ws-other" });
    seedInstallation(db, "bot-foreign", 501);
    seedScopedBot(db, "bot-shared", { workspaceId: "ws-other", scope: "shared", sharedAt: NOW });
    seedInstallation(db, "bot-shared", 502);

    const store = createReviewBotsStore(db);
    expect(await store.listPendingInstallations("bot-foreign", WS, true)).toEqual([]);
    expect(
      (await store.listPendingInstallations("bot-shared", WS, true)).map((row) => row.installation_id),
    ).toEqual([502]);
  });
});


describe("failure attribution follows the ledger head", () => {
  test("only the current head's failures count; history keeps the rest reachable", async () => {
    const db = createMigratedTestD1();
    seedApp(db, "bot-fail", { githubAppId: 9901 });
    db.raw
      .prepare(
        `INSERT INTO review_targets (id, workspace_id, app_id, name, created_by, created_at, updated_at)
         VALUES ('t-fail', ?, 'bot-fail', 'widgets', 'fixture', datetime('now'), datetime('now'))`,
      )
      .run(WS);
    db.raw
      .prepare(
        `INSERT INTO pull_requests
           (id, app_id, target_id, owner, repo, pr_number, title, state, head_sha, first_seen_at, last_seen_at)
         VALUES ('pr-7', 'bot-fail', 't-fail', 'acme', 'widgets', 7, 'PR', 'open', 'sha-now',
                 datetime('now'), datetime('now'))`,
      )
      .run();
    db.raw
      .prepare(
        `INSERT INTO review_failures (id, installation_id, owner, repo, pr_number, head_sha, stage, error, target_id)
         VALUES ('fa', 1, 'acme', 'widgets', 7, 'sha-now', 'runner', 'new head', 't-fail'),
                ('fb', 1, 'acme', 'widgets', 7, 'sha-old', 'runner', 'old head', 't-fail'),
                ('fc', 1, 'acme', 'widgets', 7, '', 'runner', 'headless', 't-fail')`,
      )
      .run();

    const scope = { kind: "workspace", workspaceId: WS } as const;
    const store = createReviewBotsStore(db);
    expect(await store.countPullRequestRecords(scope, "acme", "widgets", 7)).toEqual({
      findings: 0,
      reviews: 0,
      failures: 1,
      must_fix: 0,
    });
    expect(
      (await store.listPullRequestFailures(scope, "acme", "widgets", 7, { offset: 0, limit: 10 }))!
        .items.map((row) => row.error),
    ).toEqual(["new head"]);
    expect(
      (await store.listPullRequestFailures(scope, "acme", "widgets", 7, {
        offset: 0,
        limit: 10,
        history: true,
      }))!.total,
    ).toBe(3);
  });
});

describe("the two names a completed Check prints (migration 0126)", () => {
  test("the App name follows appDisplayName's resolution, and the Bot name comes from review_bots", async () => {
    const db = createMigratedTestD1();
    seedApp(db, "app-names", { githubAppId: 6010, name: "row-name" });
    db.raw.prepare(`UPDATE review_bots SET name = 'infra-review' WHERE id = ?`).run("app-names");
    db.raw.prepare(`UPDATE github_apps SET github_name = 'acme-bot' WHERE id = ?`).run("app-names");

    expect(await createReviewBotsStore(db).readExecutorNames("app-names", "app-names")).toEqual({
      appName: "acme-bot",
      botName: "infra-review",
    });

    // GitHub's own name wins; without it the slug, then the row's name.
    db.raw.prepare(`UPDATE github_apps SET github_name = NULL, github_slug = 'acme-slug' WHERE id = ?`).run("app-names");
    expect((await createReviewBotsStore(db).readExecutorNames("app-names", "app-names"))?.appName).toBe("acme-slug");
    db.raw.prepare(`UPDATE github_apps SET github_slug = NULL WHERE id = ?`).run("app-names");
    expect((await createReviewBotsStore(db).readExecutorNames("app-names", "app-names"))?.appName).toBe("row-name");
  });

  test("a deleted or unknown Bot leaves botName null, and a missing App leaves no row at all", async () => {
    const db = createMigratedTestD1();
    seedApp(db, "app-gone-bot", { githubAppId: 6011, deleted: true });

    expect(await createReviewBotsStore(db).readExecutorNames("app-gone-bot", "app-gone-bot")).toEqual({
      appName: "app-gone-bot",
      botName: null,
    });
    expect(await createReviewBotsStore(db).readExecutorNames("app-gone-bot", "no-such-bot")).toMatchObject({
      botName: null,
    });
    expect(await createReviewBotsStore(db).readExecutorNames("no-such-app", null)).toBeNull();
  });
});
