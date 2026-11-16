/**
 * Unit tests for the bot-side face in src/dashboard/apps-store.ts: creation,
 * the user-facing delete, the workspace-scoped resolve, the 已安装
 * installation read and the cached GitHub App visibility.
 *
 * Pinned here:
 *   - the create path writes the bot and its `bot_workspaces` mapping in one
 *     batch and NO review target: creation knows no repository (D13);
 *   - the user-facing delete stamps the bot AND every target it owns, once,
 *     refusing to re-stamp either;
 *   - the workspace-scoped resolve answers only the bot this workspace owns;
 *   - the 已安装 read lists the bot's live installations, narrowed to the bots
 *     the workspace may use;
 *   - visibility round-trips and reads `unknown` for a never-probed row.
 *
 * The workspace-owned review configuration itself (trigger mode, depth, gate,
 * business pause) lives on the target and is covered by
 * tests/dashboard/targets-store.test.ts.
 *
 * The fixture is the fully migrated schema (tests/store/helpers), so the
 * assertions run against the real DDL rather than a hand-built table.
 */
import { describe, expect, test } from "bun:test";
import { createMigratedTestD1 } from "../store/helpers";
import { createReviewBotsStore, listBotScopes, setBotScope } from "../../src/dashboard/apps-store";
import { createTargetsStore } from "../../src/dashboard/targets-store";
import { setOfficialWorkspace } from "../../src/dashboard/runtime-config-store";
import type { TestD1 } from "../store/helpers";

const WS = "default";

/** One review_bots row without the store's crypto path. */
function seedApp(
  db: TestD1,
  id: string,
  options: { githubAppId: number; deleted?: boolean; name?: string },
): void {
  db.raw
    .prepare(
      `INSERT INTO review_bots
         (id, github_app_id, name, private_key_enc, webhook_secret_enc, created_by,
          status, deleted_at, created_at, updated_at)
       VALUES (?, ?, ?, 'enc', 'enc', 'acme', 'active',
               ${options.deleted ? "datetime('now')" : "NULL"}, datetime('now'), datetime('now'))`,
    )
    .run(id, options.githubAppId, options.name ?? id);
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
    });

    const app = await store.getAppById("app-created");
    expect(app?.workspace_id).toBe(WS);
    expect(app?.status).toBe("active");
    // Creation knows no repository, so it creates no target: a target is born
    // when a repository is added.
    expect(await createTargetsStore(db).listLive(WS)).toEqual([]);
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
    });
    const targets = createTargetsStore(db);
    const { target } = await targets.create({
      workspaceId: WS,
      botId: "app-delete",
      repoId: 900020,
      repoOwner: "acme",
      repoName: "repo",
      createdBy: "acme",
    });

    expect(await store.softDeleteApp("app-delete")).toBe(true);
    expect((await store.getAppById("app-delete"))?.deleted_at).not.toBeNull();
    expect(await targets.getInWorkspace(WS, target.id)).toBeNull();

    // Idempotent: the first stamps are kept and the second call reports false.
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

// --- bot scope (migration 0058, contract § 7.1) ------------------------------

const NOW = "2026-02-01T00:00:00.000Z";
const LATER = "2026-02-02T00:00:00.000Z";
const OFFICIAL_KEY = "platform.official_workspace_id";

/** A second live workspace beside the seeded `default`. */
function seedWorkspace(db: TestD1, id: string, deleted = false): void {
  db.raw
    .prepare(
      `INSERT INTO workspaces (id, slug, name, created_at, deleted_at)
       VALUES (?, ?, ?, '2026-01-01T00:00:00.000Z', ${deleted ? "'2026-01-02T00:00:00.000Z'" : "NULL"})`,
    )
    .run(id, id, id);
}

/** The official-workspace row, written raw: audited writers are their own test. */
function seedOfficialWorkspace(db: TestD1, workspaceId: string): void {
  db.raw
    .prepare(
      `INSERT INTO review_runtime_settings (key, value, updated_at, updated_by)
       VALUES (?, ?, ?, 'fixture')`,
    )
    .run(OFFICIAL_KEY, workspaceId, NOW);
}

/** A fresh numeric App id per seeded bot: `github_app_id` is UNIQUE. */
let nextGithubAppId = 6100;

/** One bot plus its `bot_workspaces` mapping. */
function seedScopedBot(
  db: TestD1,
  id: string,
  options: {
    workspaceId?: string;
    deleted?: boolean;
    scope?: string;
    sharedAt?: string | null;
    /** Display name; defaults to the id. An ordering test must vary it. */
    name?: string;
  } = {},
): void {
  nextGithubAppId += 1;
  seedApp(db, id, { githubAppId: nextGithubAppId, deleted: options.deleted, name: options.name });
  if (options.workspaceId !== undefined) {
    db.raw.prepare("INSERT INTO bot_workspaces (bot_id, workspace_id) VALUES (?, ?)").run(id, options.workspaceId);
  }
  if (options.scope !== undefined) {
    db.raw
      .prepare("UPDATE review_bots SET scope = ?, shared_at = ? WHERE id = ?")
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

    const outcome = await setBotScope(db, {
      botId: "bot-share",
      scope: "shared",
      actor: "operator",
      now: NOW,
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
      const refused = await setBotScope(db, {
        botId: "bot-unshare",
        scope: "owned",
        confirm,
        actor: "operator",
        now: LATER,
      });
      expect(refused).toEqual({ outcome: "confirm_required" });
    }
    expect(storedScope(db, "bot-unshare")).toEqual({ scope: "shared", shared_at: NOW });
    expect(scopeAudits(db)).toEqual([]);

    const accepted = await setBotScope(db, {
      botId: "bot-unshare",
      scope: "owned",
      confirm: true,
      actor: "operator",
      now: LATER,
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
      await setBotScope(db, { botId: "bot-owned", scope: "owned", actor: "operator", now: LATER }),
    ).toEqual({ outcome: "ok", scope: "owned", sharedAt: null });
    expect(
      await setBotScope(db, { botId: "bot-still-shared", scope: "shared", actor: "operator", now: LATER }),
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

    // No official workspace at all.
    expect(
      await setBotScope(db, { botId: "bot-home", scope: "shared", actor: "operator", now: NOW }),
    ).toEqual({ outcome: "outside_official_workspace" });

    // The official workspace is someone else's.
    seedOfficialWorkspace(db, WS);
    expect(
      await setBotScope(db, { botId: "bot-elsewhere", scope: "shared", actor: "operator", now: NOW }),
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
      await setBotScope(db, {
        botId: "bot-stale-share",
        scope: "owned",
        confirm: true,
        actor: "operator",
        now: LATER,
      }),
    ).toEqual({ outcome: "ok", scope: "owned", sharedAt: null });
    expect(storedScope(db, "bot-stale-share")).toEqual({ scope: "owned", shared_at: null });
    expect(scopeAudits(db)).toHaveLength(1);
  });

  test("a re-share after a revoke stamps a new shared_at", async () => {
    const db = createMigratedTestD1();
    seedScopedBot(db, "bot-cycle", { workspaceId: WS });
    seedOfficialWorkspace(db, WS);

    await setBotScope(db, { botId: "bot-cycle", scope: "shared", actor: "operator", now: NOW });
    await setBotScope(db, { botId: "bot-cycle", scope: "owned", confirm: true, actor: "operator", now: LATER });
    const reShared = await setBotScope(db, {
      botId: "bot-cycle",
      scope: "shared",
      actor: "operator",
      now: "2026-03-01T00:00:00.000Z",
    });

    expect(reShared).toEqual({ outcome: "ok", scope: "shared", sharedAt: "2026-03-01T00:00:00.000Z" });
    expect(storedScope(db, "bot-cycle")).toEqual({
      scope: "shared",
      shared_at: "2026-03-01T00:00:00.000Z",
    });
    // The earlier instant survives only in the ledger.
    expect(scopeAudits(db)).toHaveLength(3);
  });

  test("a missing or soft-deleted bot is bot_not_found and writes nothing", async () => {
    const db = createMigratedTestD1();
    seedScopedBot(db, "bot-gone", { workspaceId: WS, deleted: true });
    seedOfficialWorkspace(db, WS);

    expect(
      await setBotScope(db, { botId: "bot-absent", scope: "shared", actor: "operator", now: NOW }),
    ).toEqual({ outcome: "bot_not_found" });
    expect(
      await setBotScope(db, { botId: "bot-gone", scope: "shared", actor: "operator", now: NOW }),
    ).toEqual({ outcome: "bot_not_found" });
    expect(scopeAudits(db)).toEqual([]);
  });

  test("a bot deleted between the read and the write is bot_not_found, not a scope refusal", async () => {
    const db = createMigratedTestD1();
    seedScopedBot(db, "bot-raced", { workspaceId: WS });
    seedOfficialWorkspace(db, WS);

    // A competing writer that commits the moment the transition submits its
    // batch — i.e. after the pre-read, before the batch's own statements run.
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
      await setBotScope(racingDb, { botId: "bot-raced", scope: "shared", actor: "operator", now: NOW }),
    ).toEqual({ outcome: "bot_not_found" });
    expect(fired).toBe(true);
    expect(storedScope(db, "bot-raced")).toEqual({ scope: "owned", shared_at: null });
    expect(scopeAudits(db)).toEqual([]);
  });

  test("a designation cleared between the read and the write refuses the share", async () => {
    const db = createMigratedTestD1();
    seedScopedBot(db, "bot-stale-designation", { workspaceId: WS });
    seedOfficialWorkspace(db, WS);

    // A competing operator clears the designation the moment this transition
    // submits its batch — i.e. after the pre-read, before the batch's own
    // statements run.
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
      await setBotScope(racingDb, {
        botId: "bot-stale-designation",
        scope: "shared",
        actor: "operator",
        now: NOW,
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

    // The first operator's share commits while this one is in flight: both read
    // `owned`, so both saw the same FROM state.
    let fired = false;
    const racingDb: TestD1 = {
      raw: db.raw,
      prepare: (query: string) => db.prepare(query),
      batch: async (statements) => {
        if (!fired) {
          fired = true;
          expect(
            await setBotScope(db, {
              botId: "bot-double-share",
              scope: "shared",
              actor: "operator",
              now: NOW,
            }),
          ).toEqual({ outcome: "ok", scope: "shared", sharedAt: NOW });
        }
        return db.batch(statements);
      },
    };

    // The loser reports the winner's state rather than rewriting shared_at.
    expect(
      await setBotScope(racingDb, {
        botId: "bot-double-share",
        scope: "shared",
        actor: "operator",
        now: LATER,
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
            await setBotScope(db, {
              botId: "bot-double-revoke",
              scope: "owned",
              confirm: true,
              actor: "operator",
              now: NOW,
            }),
          ).toEqual({ outcome: "ok", scope: "owned", sharedAt: null });
        }
        return db.batch(statements);
      },
    };

    expect(
      await setBotScope(racingDb, {
        botId: "bot-double-revoke",
        scope: "owned",
        confirm: true,
        actor: "operator",
        now: LATER,
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

  test("a shared bot survives a designation clear: no revocation, no new share, still revocable", async () => {
    const db = createMigratedTestD1();
    seedScopedBot(db, "bot-orphan-share", { workspaceId: WS, scope: "shared", sharedAt: NOW });
    seedScopedBot(db, "bot-new", { workspaceId: WS });
    seedOfficialWorkspace(db, WS);

    // Clearing the designation is legal platform state: the existing share is
    // not revoked and its instant is untouched.
    expect(await setOfficialWorkspace(db, { workspaceId: null, actor: "operator", now: LATER })).toBeNull();
    expect(storedScope(db, "bot-orphan-share")).toEqual({ scope: "shared", shared_at: NOW });

    // A new share has nowhere to be authorized from.
    expect(
      await setBotScope(db, { botId: "bot-new", scope: "shared", actor: "operator", now: LATER }),
    ).toEqual({ outcome: "outside_official_workspace" });
    expect(storedScope(db, "bot-new")).toEqual({ scope: "owned", shared_at: null });

    // The stale share stays revocable by the only role that can revoke it.
    expect(
      await setBotScope(db, {
        botId: "bot-orphan-share",
        scope: "owned",
        confirm: true,
        actor: "operator",
        now: LATER,
      }),
    ).toEqual({ outcome: "ok", scope: "owned", sharedAt: null });
    expect(storedScope(db, "bot-orphan-share")).toEqual({ scope: "owned", shared_at: null });
  });

  test("the console list carries every live bot with its scope, ordered by name then id", async () => {
    const db = createMigratedTestD1();
    // The names order OPPOSITE to the ids: an implementation that drops the
    // `name` sort key (or sorts by id alone) answers ["bot-a", "bot-b"] and
    // fails here. With `name === id` the two orders were indistinguishable.
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

// --- the creation chooser's shared-bot list --------------------------------

describe("shared bots a workspace may create a target on", () => {
  /** One target on `botId` in `workspaceId`, stamped when `deleted`. */
  function seedTargetIn(db: TestD1, botId: string, workspaceId: string, deleted = false): void {
    db.raw
      .prepare(
        `INSERT INTO review_targets
           (id, workspace_id, bot_id, name, created_by, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, 'fixture', datetime('now'), datetime('now'),
                 ${deleted ? "datetime('now')" : "NULL"})`,
      )
      .run(crypto.randomUUID(), workspaceId, botId, botId);
  }

  test("each live shared bot carries the ADDRESSED workspace's live target count", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "ws-other");
    seedScopedBot(db, "bot-shared", { workspaceId: "ws-other", scope: "shared", sharedAt: NOW, name: "Alpha" });
    db.raw.prepare("UPDATE review_bots SET github_slug = 'alpha-app' WHERE id = 'bot-shared'").run();
    // One live target here, one soft-deleted here, one live in the owner's own
    // workspace: only the first is the count this workspace reads.
    seedTargetIn(db, "bot-shared", WS);
    seedTargetIn(db, "bot-shared", WS, true);
    seedTargetIn(db, "bot-shared", "ws-other");
    seedTargetIn(db, "bot-shared", "ws-other");

    const store = createReviewBotsStore(db);
    expect(await store.listSharedBots(WS)).toEqual([
      { id: "bot-shared", github_slug: "alpha-app", name: "Alpha", target_count: 1 },
    ]);
    // The same bot reads the other workspace's own count, not WS's.
    expect(await store.listSharedBots("ws-other")).toEqual([
      { id: "bot-shared", github_slug: "alpha-app", name: "Alpha", target_count: 2 },
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

// --- the workspace-scoped App resolve -------------------------------------

function githubAppIdOf(db: TestD1, botId: string): number {
  const row = db.raw.query("SELECT github_app_id AS id FROM review_bots WHERE id = ?").get(botId) as {
    id: number;
  } | null;
  if (row === null) throw new Error(`no review_bots row ${botId}`);
  return row.id;
}

/**
 * The resolve the target pages use: the bot the addressed workspace OWNS.
 * Ownership is `bot_workspaces` alone, so another workspace's bot — shared or
 * not — stays invisible until that workspace owns it.
 */
describe("the workspace-scoped App resolve", () => {
  test("resolves the workspace's own bot and nothing it does not own", async () => {
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
    // Not owned here: neither another workspace's bot nor a soft-deleted one.
    expect(await store.getScopedAppByGithubId(githubAppIdOf(db, "bot-foreign"), WS)).toBeNull();
    expect(await store.getScopedAppByGithubId(githubAppIdOf(db, "bot-shared"), WS)).toBeNull();
    expect(await store.getScopedAppByGithubId(githubAppIdOf(db, "bot-dead"), WS)).toBeNull();
  });
});

// --- the target page's 已安装 installations --------------------------------

/** One `bot_installations` row; `removed` stamps the removal. */
function seedInstallation(db: TestD1, botId: string, installationId: number, removed = false): void {
  db.raw
    .prepare(
      `INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at, removed_at)
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

    const rows = await createReviewBotsStore(db).listPendingInstallations("bot-pending", WS);
    expect(rows.map((row) => row.installation_id)).toEqual([100]);
  });

  test("answers nothing for a bot the addressed workspace may not use", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, "ws-other");
    // Another workspace's owned bot: out of the caller's visible set.
    seedScopedBot(db, "bot-foreign", { workspaceId: "ws-other" });
    seedInstallation(db, "bot-foreign", 501);
    // A shared bot: usable from every workspace, so its rows read.
    seedScopedBot(db, "bot-shared", { workspaceId: "ws-other", scope: "shared", sharedAt: NOW });
    seedInstallation(db, "bot-shared", 502);

    const store = createReviewBotsStore(db);
    expect(await store.listPendingInstallations("bot-foreign", WS)).toEqual([]);
    expect(
      (await store.listPendingInstallations("bot-shared", WS)).map((row) => row.installation_id),
    ).toEqual([502]);
  });
});

