/**
 * Unit tests for `src/dashboard/targets-store.ts` — the workspace-owned review
 * configuration face.
 *
 * Pinned here:
 *   - a backfill-shaped insert leaves exactly ONE target per bot, carrying the
 *     configuration the old bot row held;
 *   - the partial UNIQUE index refuses a second non-NULL
 *     `(bot_id, installation_id)` claim while NULL bindings stay legal;
 *   - EVERY tenant read binds `workspace_id`: another workspace's target reads
 *     absent/empty and every write against it is a no-op with zero rows;
 *   - the policy setters write the target, and the bot row has no policy
 *     columns left to write;
 *   - the pause writes `review_targets.review_enabled` and leaves
 *     `review_bots.review_enabled` alone;
 *   - `resolve` is the webhook's two steps: the bound installation first, else
 *     the bot's single live target, else null — and it never writes
 *     `installation_id`;
 *   - the create path (manifest commit) writes one bot and one target in one
 *     batch, unbound and with the contract's defaults;
 *   - the owner allowlist is REPLACED as a set in one batch;
 *   - the user-facing delete stamps the bot and its target.
 *
 * The fixture is the fully migrated schema (tests/store/helpers), so the
 * assertions run against the real DDL rather than a hand-built table.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createMigratedTestD1 } from "../store/helpers";
import type { TestD1 } from "../store/helpers";
import { createReviewBotsStore } from "../../src/dashboard/apps-store";
import {
  ALLOWLIST_MAX_OWNERS,
  createTargetsStore,
  parseTargetReviewLevel,
  REVIEW_TRIGGER_MODES,
} from "../../src/dashboard/targets-store";
import { REVIEW_LEVELS } from "../../packages/shared/src/runtime";

const WS = "default";
const OTHER_WS = "ws-other";

function seedWorkspace(db: TestD1, id: string): void {
  db.raw
    .prepare(
      `INSERT INTO workspaces (id, slug, name, created_by, created_at)
       VALUES (?, ?, ?, 'acme', datetime('now'))`,
    )
    .run(id, id, id);
}

type BotSeed = {
  githubAppId: number;
  workspaceId?: string;
  installationId?: number | null;
  reviewEnabled?: number;
  deleted?: boolean;
};

/**
 * One bot plus the target the backfill writes for it: the five moved columns
 * copied from the old row, the installation bound only when the caller names
 * one, and `deleted_at` copied from the bot.
 */
function seedBackfilledBot(
  db: TestD1,
  botId: string,
  seed: BotSeed,
): { botId: string; targetId: string } {
  const workspaceId = seed.workspaceId ?? WS;
  db.raw
    .prepare(
      `INSERT INTO review_bots
         (id, github_app_id, name, private_key_enc, webhook_secret_enc, created_by,
          status, deleted_at, review_enabled, created_at, updated_at)
       VALUES (?, ?, ?, 'enc', 'enc', 'acme', 'active', ?, ?, datetime('now'), datetime('now'))`,
    )
    .run(botId, seed.githubAppId, botId, seed.deleted ? "2026-01-01 00:00:00" : null, seed.reviewEnabled ?? 1);
  db.raw
    .prepare(`INSERT INTO bot_workspaces (bot_id, workspace_id) VALUES (?, ?)`)
    .run(botId, workspaceId);
  const targetId = `${botId}-target`;
  db.raw
    .prepare(
      `INSERT INTO review_targets
         (id, workspace_id, bot_id, name, installation_id, account_login,
          review_enabled, review_trigger_mode, review_level,
          check_min_score, check_pass_verdicts, allowlist_enabled,
          created_by, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, 'every_push', 'deep', 70, '["ship it","blocked"]', 1,
               'acme', datetime('now'), datetime('now'), ?)`,
    )
    .run(
      targetId,
      workspaceId,
      botId,
      botId,
      seed.installationId ?? null,
      seed.installationId === undefined || seed.installationId === null ? null : "acme",
      seed.reviewEnabled ?? 1,
      seed.deleted ? "2026-01-01 00:00:00" : null,
    );
  return { botId, targetId };
}

/** The bot row's column names — the moved policy columns must not be there. */
function reviewBotColumns(db: TestD1): string[] {
  return (db.raw.query("PRAGMA table_info(review_bots)").all() as Array<{ name: string }>).map(
    (column) => column.name,
  );
}

/** One target row straight from the table, for the write assertions. */
type TargetRowSnapshot = {
  review_enabled: number;
  review_trigger_mode: string;
  review_level: string | null;
  check_min_score: number;
  check_pass_verdicts: string;
  allowlist_enabled: number;
  installation_id: number | null;
  deleted_at: string | null;
};

function targetRow(db: TestD1, targetId: string): TargetRowSnapshot {
  // bun:sqlite hands back a loose record; the SELECT list above fixes the shape.
  const row = db.raw
    .query(
      `SELECT review_enabled, review_trigger_mode, review_level, check_min_score,
              check_pass_verdicts, allowlist_enabled, installation_id, deleted_at
         FROM review_targets WHERE id = ?`,
    )
    .get(targetId) as TargetRowSnapshot | null;
  if (row === null) throw new Error(`review target ${targetId} is missing`);
  return row;
}

describe("backfill shape (one target per bot)", () => {
  test("a backfilled bot has exactly one target carrying the old configuration", async () => {
    const db = createMigratedTestD1();
    const { botId } = seedBackfilledBot(db, "bot-a", { githubAppId: 6001 });
    const store = createTargetsStore(db);

    const targets = await store.list(WS);
    expect(targets).toHaveLength(1);
    const [target] = targets;
    expect(target!.bot_id).toBe(botId);
    expect(target!.workspace_id).toBe(WS);
    expect(target!.installation_id).toBeNull();
    expect(target!.review_trigger_mode).toBe("every_push");
    expect(target!.review_level).toBe("deep");
    expect(target!.check_min_score).toBe(70);
    expect(target!.check_pass_verdicts).toBe('["ship it","blocked"]');
    expect(target!.allowlist_enabled).toBe(1);
  });

  test("a second non-NULL claim of (bot_id, installation_id) is rejected; NULL bindings stay legal", async () => {
    const db = createMigratedTestD1();
    const { botId, targetId } = seedBackfilledBot(db, "bot-bind", { githubAppId: 6002 });
    // The backfill leaves every created target unbound, so a second unbound
    // target is outside the partial index...
    db.raw
      .prepare(
        `INSERT INTO review_targets (id, workspace_id, bot_id, name, created_by, created_at, updated_at)
         VALUES ('bot-bind-target-2', ?, ?, 'second', 'acme', datetime('now'), datetime('now'))`,
      )
      .run(WS, botId);
    db.raw
      .prepare(`UPDATE review_targets SET installation_id = 41 WHERE id = ?`)
      .run(targetId);

    // ...but one installation cannot be claimed by two targets.
    expect(() =>
      db.raw
        .prepare(`UPDATE review_targets SET installation_id = 41 WHERE id = 'bot-bind-target-2'`)
        .run(),
    ).toThrow();
  });
});

describe("tenant reads bind workspace_id", () => {
  test("another workspace's target reads absent everywhere and every write is a no-op", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, OTHER_WS);
    const { targetId } = seedBackfilledBot(db, "bot-tenant", {
      githubAppId: 6101,
      installationId: 51,
    });
    const store = createTargetsStore(db);

    expect(await store.getById(OTHER_WS, targetId)).toBeNull();
    expect(await store.list(OTHER_WS)).toEqual([]);
    expect(await store.getCheckGate(OTHER_WS, targetId)).toBeNull();
    expect(await store.getAllowlist(OTHER_WS, targetId)).toBeNull();
    expect(await store.setReviewEnabled(OTHER_WS, targetId, false)).toBe(false);
    expect(await store.setReviewTriggerMode(OTHER_WS, targetId, "manual")).toBe(false);
    expect(await store.setReviewLevel(OTHER_WS, targetId, "quick")).toBe(false);
    expect(await store.saveCheckGate(OTHER_WS, targetId, { minScore: 10, passVerdicts: [] })).toBe(false);
    expect(await store.saveAllowlist(OTHER_WS, targetId, { enabled: true, owners: ["acme"] })).toBe(false);
    expect(await store.delete(OTHER_WS, targetId)).toBe(false);

    // Nothing moved: the owning workspace still sees the backfilled values.
    const row = targetRow(db, targetId);
    expect(row.review_enabled).toBe(1);
    expect(row.review_trigger_mode).toBe("every_push");
    expect(row.review_level).toBe("deep");
    expect(row.check_min_score).toBe(70);
    expect(row.allowlist_enabled).toBe(1);
    expect(row.deleted_at).toBeNull();
    expect((await store.getById(WS, targetId))?.id).toBe(targetId);
  });

  test("the tenant resolution answers only a target in the named workspace", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, OTHER_WS);
    const { botId, targetId } = seedBackfilledBot(db, "bot-tenant-resolve", { githubAppId: 6103 });
    const store = createTargetsStore(db);

    expect((await store.resolveInWorkspace(WS, botId))?.id).toBe(targetId);
    expect(await store.resolveInWorkspace(OTHER_WS, botId)).toBeNull();
    expect(await store.resolveInWorkspace(WS, "no-such-bot")).toBeNull();
    // A soft-deleted target is no target for a tenant read either.
    await store.delete(WS, targetId);
    expect(await store.resolveInWorkspace(WS, botId)).toBeNull();
  });

  test("a target that belongs to another workspace is invisible to the resolve of its bot's workspace assumption", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, OTHER_WS);
    // The bot is owned by `default` while the target claims `ws-other`: a later
    // shared-bot shape must still keep each workspace's reads separate.
    const { botId, targetId } = seedBackfilledBot(db, "bot-split", {
      githubAppId: 6102,
      workspaceId: OTHER_WS,
    });
    const store = createTargetsStore(db);

    expect(await store.list(WS)).toEqual([]);
    expect((await store.list(OTHER_WS)).map((target) => target.id)).toEqual([targetId]);
    // `resolve` is the execution read: it names the bot, not a workspace.
    expect((await store.resolve(botId, null))?.id).toBe(targetId);
  });
});

describe("policy setters write the target", () => {
  test("the setters round-trip on the target row and the bot has no policy columns left", async () => {
    const db = createMigratedTestD1();
    const { targetId } = seedBackfilledBot(db, "bot-policy", { githubAppId: 6201 });
    const store = createTargetsStore(db);

    expect(await store.setReviewTriggerMode(WS, targetId, "manual")).toBe(true);
    expect((await store.getById(WS, targetId))?.review_trigger_mode).toBe("manual");
    expect(await store.setReviewLevel(WS, targetId, "quick")).toBe(true);
    expect((await store.getById(WS, targetId))?.review_level).toBe("quick");
    expect(await store.saveCheckGate(WS, targetId, { minScore: 55, passVerdicts: ["ship it"] })).toBe(true);
    expect(await store.getCheckGate(WS, targetId)).toEqual({ minScore: 55, passVerdicts: ["ship it"] });

    // The pivot itself: the bot row carries none of the five moved columns, so
    // no writer can keep writing them.
    const columns = reviewBotColumns(db);
    for (const column of [
      "review_trigger_mode",
      "review_level",
      "check_min_score",
      "check_pass_verdicts",
      "allowlist_enabled",
    ]) {
      expect(columns).not.toContain(column);
    }
  });

  test("every vocabulary mode round-trips on the target and bumps updated_at", async () => {
    const db = createMigratedTestD1();
    const { targetId } = seedBackfilledBot(db, "bot-modes", { githubAppId: 6204 });
    const store = createTargetsStore(db);

    for (const mode of REVIEW_TRIGGER_MODES) {
      db.raw
        .prepare(`UPDATE review_targets SET updated_at = '2026-01-01 00:00:00' WHERE id = ?`)
        .run(targetId);
      expect(await store.setReviewTriggerMode(WS, targetId, mode)).toBe(true);
      const row = await store.getById(WS, targetId);
      expect(row?.review_trigger_mode).toBe(mode);
      expect(row?.updated_at).not.toBe("2026-01-01 00:00:00"); // an operator mutation
    }
    // An unknown target id changed nothing (the bot store's setAppStatus rule).
    expect(await store.setReviewTriggerMode(WS, "no-such-target", "manual")).toBe(false);
  });

  test("the DDL CHECK is the last-line backstop: a raw off-vocabulary mode is unrepresentable", () => {
    const db = createMigratedTestD1();
    const { targetId } = seedBackfilledBot(db, "bot-modes-check", { githubAppId: 6205 });
    expect(() =>
      db.raw
        .prepare(`UPDATE review_targets SET review_trigger_mode = 'whenever' WHERE id = ?`)
        .run(targetId),
    ).toThrow(/CHECK constraint failed/);
  });

  test("off-vocabulary values throw BEFORE any write", async () => {
    const db = createMigratedTestD1();
    const { targetId } = seedBackfilledBot(db, "bot-invalid", { githubAppId: 6202 });
    const store = createTargetsStore(db);

    await expect(store.setReviewTriggerMode(WS, targetId, "sometimes" as never)).rejects.toThrow(
      /trigger mode/,
    );
    await expect(store.setReviewLevel(WS, targetId, "turbo" as never)).rejects.toThrow(/review level/);
    await expect(
      store.saveCheckGate(WS, targetId, { minScore: 101, passVerdicts: ["ship it"] }),
    ).rejects.toThrow(/outside 0..100/);
    await expect(
      store.saveCheckGate(WS, targetId, { minScore: 80, passVerdicts: ["lgtm" as never] }),
    ).rejects.toThrow(/PR_VERDICTS/);

    const row = targetRow(db, targetId);
    expect(row.review_trigger_mode).toBe("every_push");
    expect(row.review_level).toBe("deep");
    expect(row.check_min_score).toBe(70);
  });

  test("the on-vocabulary VALUES parse back, and an off-vocabulary stored value reads as absent", () => {
    for (const level of REVIEW_LEVELS) expect(parseTargetReviewLevel(level)).toBe(level);
    for (const value of [null, undefined, "turbo", "", "DEEP", 3, ["deep"]]) {
      expect(parseTargetReviewLevel(value)).toBeNull();
    }
  });

  test("the pause writes the target flag and leaves the bot's operational flag alone", async () => {
    const db = createMigratedTestD1();
    const { botId, targetId } = seedBackfilledBot(db, "bot-pause", { githubAppId: 6203 });
    const store = createTargetsStore(db);

    expect(await store.setReviewEnabled(WS, targetId, false)).toBe(true);
    expect(targetRow(db, targetId).review_enabled).toBe(0);
    // bun:sqlite hands back a loose record; the SELECT list fixes the shape.
    const bot = db.raw
      .query(`SELECT review_enabled FROM review_bots WHERE id = ?`)
      .get(botId) as { review_enabled: number } | null;
    expect(bot?.review_enabled).toBe(1);

    expect(await store.setReviewEnabled(WS, targetId, true)).toBe(true);
    expect(targetRow(db, targetId).review_enabled).toBe(1);
  });
});

describe("resolve (webhook steps)", () => {
  test("the bound installation wins over a second live target", async () => {
    const db = createMigratedTestD1();
    const { botId, targetId } = seedBackfilledBot(db, "bot-resolve-bound", {
      githubAppId: 6301,
      installationId: 61,
    });
    db.raw
      .prepare(
        `INSERT INTO review_targets (id, workspace_id, bot_id, name, created_by, created_at, updated_at)
         VALUES ('bot-resolve-bound-second', ?, ?, 'second', 'acme', datetime('now'), datetime('now'))`,
      )
      .run(WS, botId);
    const store = createTargetsStore(db);

    expect((await store.resolve(botId, 61))?.id).toBe(targetId);
    // A delivery from an installation no target bound falls through to the
    // single-target step, which now has TWO candidates — undecidable, so null.
    expect(await store.resolve(botId, 99)).toBeNull();
  });

  test("one unbound target answers every installation and the no-installation read", async () => {
    const db = createMigratedTestD1();
    const { botId, targetId } = seedBackfilledBot(db, "bot-resolve-single", { githubAppId: 6302 });
    const store = createTargetsStore(db);

    expect((await store.resolve(botId, 71))?.id).toBe(targetId);
    expect((await store.resolve(botId, null))?.id).toBe(targetId);
  });

  test("two unbound targets are ambiguous, a soft-deleted one is not a candidate, and no target is null", async () => {
    const db = createMigratedTestD1();
    const { botId } = seedBackfilledBot(db, "bot-resolve-none", { githubAppId: 6303 });
    const store = createTargetsStore(db);
    expect(await store.resolve("bot-with-no-target", 81)).toBeNull();

    db.raw
      .prepare(
        `INSERT INTO review_targets (id, workspace_id, bot_id, name, created_by, created_at, updated_at)
         VALUES ('bot-resolve-none-second', ?, ?, 'second', 'acme', datetime('now'), datetime('now'))`,
      )
      .run(WS, botId);
    expect(await store.resolve(botId, 81)).toBeNull();
    expect(await store.resolve(botId, null)).toBeNull();

    // Soft delete takes a target out of resolution entirely.
    db.raw
      .prepare(`UPDATE review_targets SET deleted_at = datetime('now') WHERE id = 'bot-resolve-none-second'`)
      .run();
    expect((await store.resolve(botId, 81))?.bot_id).toBe(botId);

    const seeded = seedBackfilledBot(db, "bot-resolve-deleted-only", {
      githubAppId: 6304,
      deleted: true,
    });
    expect(await store.resolve(seeded.botId, 82)).toBeNull();
  });

  test("resolution never writes installation_id onto the target", async () => {
    const db = createMigratedTestD1();
    const { botId, targetId } = seedBackfilledBot(db, "bot-resolve-write-free", { githubAppId: 6305 });
    const store = createTargetsStore(db);

    await store.resolve(botId, 91);
    await store.resolve(botId, null);
    expect(targetRow(db, targetId).installation_id).toBeNull();
  });

  test("a removed installation resolves nothing and does not fall back to the single target", async () => {
    const db = createMigratedTestD1();
    const { botId, targetId } = seedBackfilledBot(db, "bot-resolve-removed", {
      githubAppId: 6306,
      installationId: 61,
    });
    const store = createTargetsStore(db);
    // GitHub uninstalled it: the row is stamped, never deleted, and the target
    // keeps its binding (§ 9.5).
    db.raw
      .prepare(
        `INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at, removed_at)
         VALUES ('install-removed', ?, 61, 'acme', datetime('now'), datetime('now'))`,
      )
      .run(botId);

    // The binding survives; resolution does not — and it must NOT fall through
    // to the single-target step, which would silently re-attribute a deletion.
    expect(await store.resolve(botId, 61)).toBeNull();
    expect(targetRow(db, targetId).installation_id).toBe(61);

    // A different installation of an OWNED bot still reaches the single target:
    // the removed guard is about the delivery's own binding.
    expect((await store.resolve(botId, 62))?.id).toBe(targetId);
  });

  test("a shared bot loses the single-target fallback; an owned bot keeps it", async () => {
    const db = createMigratedTestD1();
    const owned = seedBackfilledBot(db, "bot-resolve-owned-fallback", { githubAppId: 6307 });
    const shared = seedBackfilledBot(db, "bot-resolve-shared", { githubAppId: 6308 });
    db.raw.prepare("UPDATE review_bots SET scope = 'shared' WHERE id = ?").run(shared.botId);
    const store = createTargetsStore(db);

    // Unchanged path: one live target answers an unbound delivery.
    expect((await store.resolve(owned.botId, 71))?.id).toBe(owned.targetId);
    expect((await store.resolve(owned.botId, null))?.id).toBe(owned.targetId);

    // A shared bot reviews nothing until a claim binds an installation.
    expect(await store.resolve(shared.botId, 71)).toBeNull();
    expect(await store.resolve(shared.botId, null)).toBeNull();

    // ...and once bound, the binding is what resolves.
    db.raw.prepare("UPDATE review_targets SET installation_id = 72 WHERE id = ?").run(shared.targetId);
    expect((await store.resolve(shared.botId, 72))?.id).toBe(shared.targetId);
  });
});

describe("create path (manifest commit)", () => {
  test("createApp writes one bot, its workspace mapping and one unbound target in one batch", async () => {
    const db = createMigratedTestD1();
    db.raw.prepare("UPDATE workspaces SET check_min_score = 45 WHERE id = 'default'").run();
    const botId = "bot-created";
    await createReviewBotsStore(db).createApp({
      id: botId,
      githubAppId: 6401,
      githubSlug: null,
      name: "created-bot",
      privateKeyEnc: "enc",
      webhookSecretEnc: "enc",
      createdBy: "acme",
      workspaceId: WS,
      defaultCheckMinScore: 45,
    });

    const targets = await createTargetsStore(db).list(WS);
    expect(targets).toHaveLength(1);
    const [target] = targets;
    expect(target!.bot_id).toBe(botId);
    expect(target!.installation_id).toBeNull();
    expect(target!.review_enabled).toBe(1);
    expect(target!.review_trigger_mode).toBe("every_push");
    expect(target!.review_level).toBeNull();
    expect(target!.check_min_score).toBe(45);
    expect(target!.check_pass_verdicts).toBe('["ship it"]');
    expect(target!.allowlist_enabled).toBe(0);
  });

  test("create seeds the DDL defaults and the product floor when the caller names none", async () => {
    const db = createMigratedTestD1();
    const { botId } = seedBackfilledBot(db, "bot-create-store", { githubAppId: 6402 });
    const store = createTargetsStore(db);

    const row = await store.create({
      workspaceId: WS,
      botId,
      name: "store-created",
      createdBy: "acme",
    });
    expect(row.installation_id).toBeNull();
    expect(row.review_enabled).toBe(1);
    expect(row.review_trigger_mode).toBe("every_push");
    expect(row.review_level).toBeNull();
    expect(row.check_min_score).toBe(60);
    expect(row.allowlist_enabled).toBe(0);
    expect((await store.getById(WS, row.id))?.name).toBe("store-created");
  });
});

describe("create on a shared bot", () => {
  /**
   * The shared-bot capability lives on the plan (migration 0061): `pro` and
   * `unlimited` include it, the seeded `free` row does not. A workspace with
   * no subscription resolves `free`, so these creation cases seed `pro`.
   */
  function seedProPlan(db: TestD1): void {
    db.raw
      .prepare(
        `INSERT INTO workspace_subscriptions (workspace_id, plan_id, status, created_at, updated_at)
         VALUES (?, 'pro', 'active', datetime('now'), datetime('now'))`,
      )
      .run(WS);
  }

  /** One live bot shared platform-wide, with no target anywhere yet. */
  function seedSharedBot(db: TestD1, botId: string, githubAppId: number, deleted = false): void {
    db.raw
      .prepare(
        `INSERT INTO review_bots
           (id, github_app_id, name, private_key_enc, webhook_secret_enc, created_by,
            status, scope, shared_at, deleted_at, created_at, updated_at)
         VALUES (?, ?, ?, 'enc', 'enc', 'acme', 'active', 'shared', datetime('now'),
                 ${deleted ? "datetime('now')" : "NULL"}, datetime('now'), datetime('now'))`,
      )
      .run(botId, githubAppId, botId);
    db.raw
      .prepare("INSERT INTO bot_workspaces (bot_id, workspace_id) VALUES (?, ?)")
      .run(botId, OTHER_WS);
  }

  test("writes ONE unbound target, seeded from the workspace floor and the bot's own name", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, OTHER_WS);
    seedProPlan(db);
    db.raw.prepare("UPDATE workspaces SET check_min_score = 45 WHERE id = ?").run(WS);
    seedSharedBot(db, "bot-shared", 6403);

    const result = await createTargetsStore(db).createOnSharedBot({
      workspaceId: WS,
      botId: "bot-shared",
      createdBy: "acme",
      mode: "saas",
      checkMinScore: 45,
    });
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("unreachable");
    expect(result.target).toMatchObject({
      workspace_id: WS,
      bot_id: "bot-shared",
      name: "bot-shared",
      installation_id: null,
      account_login: null,
      review_enabled: 1,
      review_trigger_mode: "every_push",
      review_level: null,
      check_min_score: 45,
      check_pass_verdicts: '["ship it"]',
      allowlist_enabled: 0,
      deleted_at: null,
    });
    // The bot is untouched: still one row, still shared, no installation bound.
    expect(db.raw.query("SELECT COUNT(*) AS n FROM review_bots").get()).toEqual({ n: 1 });
    expect(db.raw.query("SELECT scope FROM review_bots WHERE id = 'bot-shared'").get()).toEqual({
      scope: "shared",
    });
    expect(db.raw.query("SELECT COUNT(*) AS n FROM bot_installations").get()).toEqual({ n: 0 });
  });

  test("a second call for the same workspace and bot writes nothing", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, OTHER_WS);
    seedProPlan(db);
    seedSharedBot(db, "bot-shared", 6404);
    const store = createTargetsStore(db);

    const first = await store.createOnSharedBot({
      workspaceId: WS,
      botId: "bot-shared",
      createdBy: "acme",
      mode: "saas",
    });
    expect(first.outcome).toBe("created");
    expect(
      await store.createOnSharedBot({ workspaceId: WS, botId: "bot-shared", createdBy: "acme", mode: "saas" }),
    ).toEqual({
      outcome: "target_exists",
    });
    expect(await store.list(WS)).toHaveLength(1);
  });

  test("an owned, soft-deleted or unknown bot is one refusal and zero writes", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, OTHER_WS);
    seedProPlan(db);
    seedSharedBot(db, "bot-gone", 6405, true);
    seedBackfilledBot(db, "bot-owned", { githubAppId: 6406, workspaceId: OTHER_WS });
    const store = createTargetsStore(db);
    const before = db.raw.query("SELECT COUNT(*) AS n FROM review_targets").get();

    for (const botId of ["bot-owned", "bot-gone", "bot-absent"]) {
      expect(
        await store.createOnSharedBot({ workspaceId: WS, botId, createdBy: "acme", mode: "saas" }),
        botId,
      ).toEqual({
        outcome: "bot_not_shared",
      });
    }
    expect(db.raw.query("SELECT COUNT(*) AS n FROM review_targets").get()).toEqual(before);
    expect(await store.list(WS)).toHaveLength(0);
  });

  test("a plan without the capability is refused before anything is written", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, OTHER_WS);
    seedSharedBot(db, "bot-shared", 6407);
    const store = createTargetsStore(db);
    // No subscription row → the seeded `free` plan, which excludes the shared
    // bot. The refusal names the plan this reader can change.
    expect(
      await store.createOnSharedBot({ workspaceId: WS, botId: "bot-shared", createdBy: "acme", mode: "saas" }),
    ).toEqual({ outcome: "plan_refused", planId: "free" });
    // Zero writes: no target, and no audit row about one.
    expect(db.raw.query("SELECT COUNT(*) AS n FROM review_targets").get()).toEqual({ n: 0 });
    expect(db.raw.query("SELECT COUNT(*) AS n FROM audit_events").get()).toEqual({ n: 0 });

    // The capability is the plan's and the plan is read per attempt: the same
    // store creates once the workspace moves to a plan that includes the bot.
    seedProPlan(db);
    expect(
      (await store.createOnSharedBot({ workspaceId: WS, botId: "bot-shared", createdBy: "acme", mode: "saas" }))
        .outcome,
    ).toBe("created");
    db.raw.close();
  });

  test("self-hosted answers without reading the catalogue", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, OTHER_WS);
    seedSharedBot(db, "bot-shared", 6408);
    // A catalogue read would throw here (`free` is missing); the mode resolves
    // the unlimited constant before any read, so the create still succeeds.
    db.raw.prepare("DELETE FROM plans WHERE id = 'free'").run();
    expect(
      (await createTargetsStore(db).createOnSharedBot({
        workspaceId: WS,
        botId: "bot-shared",
        createdBy: "acme",
        mode: "self-hosted",
      })).outcome,
    ).toBe("created");
    db.raw.close();
  });
});

describe("owner allowlist", () => {
  test("each save REPLACES the owner set, and the read is alphabetical", async () => {
    const db = createMigratedTestD1();
    const { targetId } = seedBackfilledBot(db, "bot-allow", { githubAppId: 6501 });
    const store = createTargetsStore(db);

    expect(await store.saveAllowlist(WS, targetId, { enabled: true, owners: ["beta", "acme"] })).toBe(true);
    expect(await store.getAllowlist(WS, targetId)).toEqual({ enabled: true, owners: ["acme", "beta"] });

    // A removal rides the same submission that keeps `beta`.
    expect(await store.saveAllowlist(WS, targetId, { enabled: false, owners: ["beta"] })).toBe(true);
    expect(await store.getAllowlist(WS, targetId)).toEqual({ enabled: false, owners: ["beta"] });

    // Case variants are ONE owner (the first spelling wins); empty is legal.
    expect(
      await store.saveAllowlist(WS, targetId, { enabled: true, owners: ["Acme", "acme", "beta"] }),
    ).toBe(true);
    expect(await store.getAllowlist(WS, targetId)).toEqual({ enabled: true, owners: ["Acme", "beta"] });
    expect(await store.saveAllowlist(WS, targetId, { enabled: true, owners: [] })).toBe(true);
    expect(await store.getAllowlist(WS, targetId)).toEqual({ enabled: true, owners: [] });
  });

  test("an unknown or soft-deleted target refuses with zero owner rows", async () => {
    const db = createMigratedTestD1();
    const { targetId } = seedBackfilledBot(db, "bot-allow-deleted", { githubAppId: 6502 });
    const store = createTargetsStore(db);

    expect(await store.saveAllowlist(WS, "no-such-target", { enabled: true, owners: ["acme"] })).toBe(false);
    db.raw.prepare(`UPDATE review_targets SET deleted_at = datetime('now') WHERE id = ?`).run(targetId);
    expect(await store.saveAllowlist(WS, targetId, { enabled: true, owners: ["acme"] })).toBe(false);
    expect(await store.getAllowlist(WS, targetId)).toBeNull();
  });

  test("a collapsed set past ALLOWLIST_MAX_OWNERS throws before any read", async () => {
    const db = createMigratedTestD1();
    const { targetId } = seedBackfilledBot(db, "bot-allow-cap", { githubAppId: 6503 });
    const store = createTargetsStore(db);
    const oversized = Array.from({ length: ALLOWLIST_MAX_OWNERS + 1 }, (_, index) => `owner-${index}`);

    await expect(
      store.saveAllowlist(WS, targetId, { enabled: true, owners: oversized }),
    ).rejects.toThrow(/ALLOWLIST_MAX_OWNERS/);
    expect(await store.getAllowlist(WS, targetId)).toEqual({ enabled: true, owners: [] });
  });
});

describe("gate read", () => {
  test("unreadable stored verdicts read as null, and a save repairs them", async () => {
    const db = createMigratedTestD1();
    const { targetId } = seedBackfilledBot(db, "bot-gate", { githubAppId: 6601 });
    const store = createTargetsStore(db);
    // The DDL CHECK only proves `json_valid`, so a readable JSON array of
    // off-vocabulary verdicts can still land in the column.
    db.raw.prepare(`UPDATE review_targets SET check_pass_verdicts = '["lgtm"]' WHERE id = ?`).run(targetId);
    expect(await store.getCheckGate(WS, targetId)).toBeNull();

    expect(await store.saveCheckGate(WS, targetId, { minScore: 80, passVerdicts: ["ship it"] })).toBe(true);
    expect(await store.getCheckGate(WS, targetId)).toEqual({ minScore: 80, passVerdicts: ["ship it"] });
  });
});

describe("delete", () => {
  test("the target delete is a soft delete that stamps deleted_at once", async () => {
    const db = createMigratedTestD1();
    const { botId, targetId } = seedBackfilledBot(db, "bot-delete", { githubAppId: 6701 });
    const store = createTargetsStore(db);

    expect(await store.delete(WS, targetId)).toBe(true);
    expect(targetRow(db, targetId).deleted_at).not.toBeNull();
    expect(await store.getById(WS, targetId)).toBeNull();
    expect(await store.resolve(botId, null)).toBeNull();
    expect(await store.delete(WS, targetId)).toBe(false);
  });
});

/**
 * Park: the audited repair for an owner overlap. It writes the business pause
 * and the retired account claim plus ONE `target.park` audit row in one batch,
 * deletes nothing, and refuses — with zero writes — a target that is not live
 * in the addressed workspace, a bot's only live target, or a claim no other
 * live target in the workspace duplicates.
 */
describe("park an overlapping target", () => {
  const NOW = "2026-06-01T00:00:00.000Z";
  /** The read-only audit the operator runs; parking must empty its row. */
  const OVERLAP_SQL = readFileSync(join(import.meta.dir, "../../scripts/audit-owner-overlap.sql"), "utf8");

  type TargetShape = {
    review_enabled: number;
    account_login: string | null;
    installation_id: number | null;
    deleted_at: string | null;
  };

  function targetOf(db: TestD1, targetId: string): TargetShape {
    const row = db.raw
      .query(
        `SELECT review_enabled, account_login, installation_id, deleted_at
           FROM review_targets WHERE id = ?`,
      )
      .get(targetId) as TargetShape | null;
    if (row === null) throw new Error(`target ${targetId} is missing`);
    return row;
  }

  function counts(db: TestD1): { targets: number; bots: number; audits: number } {
    const one = (sql: string) => (db.raw.query(sql).get() as { n: number }).n;
    return {
      targets: one("SELECT COUNT(*) AS n FROM review_targets"),
      bots: one("SELECT COUNT(*) AS n FROM review_bots"),
      audits: one("SELECT COUNT(*) AS n FROM audit_events"),
    };
  }

  /** A second live target on the same bot, carrying the account claim. */
  function seedSiblingTarget(
    db: TestD1,
    input: { id: string; botId: string; workspaceId?: string; accountLogin: string | null; deleted?: boolean },
  ): void {
    db.raw
      .prepare(
        `INSERT INTO review_targets
           (id, workspace_id, bot_id, name, installation_id, account_login,
            review_enabled, review_trigger_mode, review_level,
            check_min_score, check_pass_verdicts, allowlist_enabled,
            created_by, created_at, updated_at, deleted_at)
         VALUES (?, ?, ?, ?, NULL, ?, 1, 'every_push', NULL, 70, '["ship it"]', 0,
                 'acme', datetime('now'), datetime('now'), ?)`,
      )
      .run(
        input.id,
        input.workspaceId ?? WS,
        input.botId,
        input.id,
        input.accountLogin,
        input.deleted ? "2026-01-01 00:00:00" : null,
      );
  }

  test("a park pauses the target, retires its claim and audits it in one batch", async () => {
    const db = createMigratedTestD1();
    // The overlap the audit reports: ONE owner, TWO different bots, each with
    // its own target in this workspace.
    const { targetId } = seedBackfilledBot(db, "bot-park", {
      githubAppId: 6101,
      installationId: 501,
    });
    const rival = seedBackfilledBot(db, "bot-rival", { githubAppId: 6106, installationId: 506 });
    expect(targetOf(db, targetId).account_login).toBe("acme");
    expect(targetOf(db, rival.targetId).account_login).toBe("acme");
    expect(OVERLAP_SQL).toContain("HAVING COUNT(*) > 1");
    expect((db.raw.query(OVERLAP_SQL).all() as Array<{ account_login: string }>).map((row) => row.account_login)).toEqual([
      "acme",
    ]);
    const before = counts(db);
    const store = createTargetsStore(db);
    expect(await store.hasOwnerOverlap(WS, targetId)).toBe(true);

    expect(await store.park(WS, targetId, "octocat", NOW)).toEqual({ outcome: "parked" });

    const parked = targetOf(db, targetId);
    expect(parked.review_enabled).toBe(0);
    expect(parked.account_login).toBeNull();
    // Parking is not a delete and not an unbind: the target, its bot and its
    // installation binding all stay.
    expect(parked.deleted_at).toBeNull();
    expect(parked.installation_id).toBe(501);
    expect(counts(db).targets).toBe(before.targets);
    expect(counts(db).bots).toBe(before.bots);

    // Exactly one audit row, naming the target it parked.
    expect(counts(db).audits).toBe(before.audits + 1);
    const audits = db.raw
      .query("SELECT workspace_id, actor_login, action, target_id, created_at FROM audit_events ORDER BY rowid")
      .all() as Array<{
      workspace_id: string;
      actor_login: string;
      action: string;
      target_id: string | null;
      created_at: string;
    }>;
    expect(audits).toEqual([
      { workspace_id: WS, actor_login: "octocat", action: "target.park", target_id: targetId, created_at: NOW },
    ]);
    // The rival target — the claim the park left in place — is untouched.
    expect(targetOf(db, rival.targetId)).toMatchObject({
      review_enabled: 1,
      account_login: "acme",
    });
    // The audit query's healthy state for this workspace/owner.
    expect(db.raw.query(OVERLAP_SQL).all()).toEqual([]);
    // Parking the second claimant is now refused: `acme` would be left with no
    // live target at all.
    expect(await store.park(WS, rival.targetId, "octocat", NOW)).toEqual({
      outcome: "refused",
      reason: "only-live-target",
    });
    expect(targetOf(db, rival.targetId)).toMatchObject({ review_enabled: 1, account_login: "acme" });
    expect(counts(db).audits).toBe(before.audits + 1);
  });

  test("a target that is the owner's only live claim is refused with zero writes", async () => {
    const db = createMigratedTestD1();
    const { targetId } = seedBackfilledBot(db, "bot-solo", { githubAppId: 6102, installationId: 502 });
    // A second bot exists in the workspace, but its target claims a DIFFERENT
    // owner: parking this one would retire the login instead of settling a
    // duplicate, so it is refused.
    const other = seedBackfilledBot(db, "bot-neighbour", { githubAppId: 6103, installationId: 503 });
    db.raw.prepare(`UPDATE review_targets SET account_login = 'someone-else' WHERE id = ?`).run(other.targetId);
    const before = counts(db);
    const store = createTargetsStore(db);

    expect(await store.park(WS, targetId, "octocat", NOW)).toEqual({
      outcome: "refused",
      reason: "only-live-target",
    });
    expect(await store.hasOwnerOverlap(WS, targetId)).toBe(false);
    expect(targetOf(db, targetId)).toMatchObject({ review_enabled: 1, account_login: "acme" });
    expect(counts(db)).toEqual(before);
  });

  test("a target outside the caller's workspace is refused with zero writes", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, OTHER_WS);
    const foreign = seedBackfilledBot(db, "bot-foreign", {
      githubAppId: 6104,
      workspaceId: OTHER_WS,
      installationId: 504,
    });
    seedSiblingTarget(db, { id: "foreign-sibling", botId: "bot-foreign", workspaceId: OTHER_WS, accountLogin: "acme" });
    const before = counts(db);
    const store = createTargetsStore(db);

    expect(await store.park(WS, foreign.targetId, "octocat", NOW)).toEqual({
      outcome: "refused",
      reason: "unknown-target",
    });
    expect(await store.hasOwnerOverlap(WS, foreign.targetId)).toBe(false);
    expect(targetOf(db, foreign.targetId)).toMatchObject({ review_enabled: 1, account_login: "acme" });
    expect(counts(db)).toEqual(before);
  });

  test("a target whose claim nobody duplicates is refused with zero writes", async () => {
    const db = createMigratedTestD1();
    // No installation → no account claim; a second live target makes the bot
    // multi-target, so only the overlap guard can refuse this one.
    const { botId, targetId } = seedBackfilledBot(db, "bot-no-claim", { githubAppId: 6105 });
    seedSiblingTarget(db, { id: "no-claim-sibling", botId, accountLogin: "someone-else" });
    const before = counts(db);
    const store = createTargetsStore(db);

    expect(await store.park(WS, targetId, "octocat", NOW)).toEqual({
      outcome: "refused",
      reason: "no-overlap",
    });
    expect(await store.hasOwnerOverlap(WS, targetId)).toBe(false);
    expect(targetOf(db, targetId).review_enabled).toBe(1);
    expect(counts(db)).toEqual(before);
  });
});
