import { describe, expect, test } from "bun:test";
import { createMigratedTestD1 } from "../store/helpers";
import type { TestD1 } from "../store/helpers";
import {
  checkGateOf,
  createTargetsStore,
  effectiveTargetSettings,
  getWorkspaceReviewDefaults,
  parseTargetReviewLevel,
  readEffectiveTargetSettings,
  setInheritance,
  setWorkspaceReviewDefaults,
} from "../../src/dashboard/targets-store";
import { UnknownWorkspaceError } from "../../src/dashboard/runtime-config-store";
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

function seedBot(db: TestD1, botId: string, workspaceId = WS): void {
  db.raw
    .prepare(
      `INSERT INTO review_bots
         (id, github_app_id, name, private_key_enc, webhook_secret_enc, created_by,
          status, created_at, updated_at)
       VALUES (?, ?, ?, 'enc', 'enc', 'acme', 'active', datetime('now'), datetime('now'))`,
    )
    .run(botId, botId.replace(/\D/g, "") || 1, botId);
  db.raw.prepare("INSERT INTO bot_workspaces (bot_id, workspace_id) VALUES (?, ?)").run(botId, workspaceId);
}

function seedTarget(
  db: TestD1,
  input: {
    id: string;
    botId: string;
    workspaceId?: string;
    repoId?: number | null;
    repoOwner?: string | null;
    repoName?: string | null;
    follow?: 0 | 1;
    reviewEnabled?: number;
    triggerMode?: string;
    level?: string | null;
    minScore?: number;
    verdicts?: string;
    deleted?: boolean;
  },
): string {
  db.raw
    .prepare(
      `INSERT INTO review_targets
         (id, workspace_id, bot_id, name, repo_id, repo_owner, repo_name,
          follow_workspace_defaults, review_enabled, review_trigger_mode, review_level,
          check_min_score, check_pass_verdicts, created_by, created_at, updated_at, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'acme',
               datetime('now'), datetime('now'), ?)`,
    )
    .run(
      input.id,
      input.workspaceId ?? WS,
      input.botId,
      input.repoName ?? input.id,
      input.repoId ?? null,
      input.repoOwner ?? null,
      input.repoName ?? null,
      input.follow ?? 0,
      input.reviewEnabled ?? 1,
      input.triggerMode ?? "every_push",
      input.level ?? null,
      input.minScore ?? 70,
      input.verdicts ?? '["ship it"]',
      input.deleted ? "2026-01-01 00:00:00" : null,
    );
  return input.id;
}

type TargetRowSnapshot = {
  repo_id: number | null;
  repo_owner: string | null;
  repo_name: string | null;
  follow_workspace_defaults: number;
  review_enabled: number;
  review_trigger_mode: string;
  review_level: string | null;
  check_min_score: number;
  check_pass_verdicts: string;
  deleted_at: string | null;
};

function targetRow(db: TestD1, targetId: string): TargetRowSnapshot {
  const row = db.raw
    .query(
      `SELECT repo_id, repo_owner, repo_name, follow_workspace_defaults, review_enabled,
              review_trigger_mode, review_level, check_min_score, check_pass_verdicts, deleted_at
         FROM review_targets WHERE id = ?`,
    )
    .get(targetId) as TargetRowSnapshot | null;
  if (row === null) throw new Error(`review target ${targetId} is missing`);
  return row;
}

function targetCount(db: TestD1): number {
  return (db.raw.query("SELECT COUNT(*) AS n FROM review_targets").get() as { n: number }).n;
}

describe("tenant reads bind workspace_id", () => {
  test("another workspace's target reads absent", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, OTHER_WS);
    seedBot(db, "bot-tenant");
    const targetId = seedTarget(db, { id: "t-tenant", botId: "bot-tenant", repoId: 9001, repoOwner: "acme", repoName: "widgets" });
    const store = createTargetsStore(db);

    expect(await store.getInWorkspace(OTHER_WS, targetId)).toBeNull();
    expect(await store.listLive(OTHER_WS)).toEqual([]);
    expect((await store.getInWorkspace(WS, targetId))?.repo_id).toBe(9001);
    expect((await store.listLive(WS)).map((target) => target.id)).toEqual([targetId]);
  });

  test("a soft-deleted target is no target for a tenant read", async () => {
    const db = createMigratedTestD1();
    seedBot(db, "bot-deleted");
    const targetId = seedTarget(db, { id: "t-del", botId: "bot-deleted", repoId: 9002, repoOwner: "acme", repoName: "gone", deleted: true });
    const store = createTargetsStore(db);

    expect(await store.getInWorkspace(WS, targetId)).toBeNull();
    expect(await store.listLive(WS)).toEqual([]);
    expect(await store.getForExecution(targetId)).toBeNull();
  });

  test("writes against a foreign workspace target change nothing", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, OTHER_WS);
    seedBot(db, "bot-foreign", OTHER_WS);
    const targetId = seedTarget(db, {
      id: "t-foreign",
      botId: "bot-foreign",
      workspaceId: OTHER_WS,
      repoId: 9003,
      repoOwner: "acme",
      repoName: "remote",
    });
    const store = createTargetsStore(db);

    expect(await store.setReviewEnabled(WS, targetId, false)).toBe(false);
    expect(await store.delete(WS, targetId)).toBe(false);
    expect(await store.setReviewConfig(WS, targetId, { triggerMode: "manual" })).toBe(false);
    await setInheritance(db, WS, targetId, 1);
    expect(await store.getInWorkspace(WS, targetId)).toBeNull();

    const row = targetRow(db, targetId);
    expect(row.review_enabled).toBe(1);
    expect(row.review_trigger_mode).toBe("every_push");
    expect(row.deleted_at).toBeNull();
  });
});

describe("listLiveByBot", () => {
  test("a bot holding two live targets in one workspace answers both in creation order", async () => {
    const db = createMigratedTestD1();
    seedBot(db, "bot-two");
    const older = seedTarget(db, { id: "t-older", botId: "bot-two", repoId: 9600, repoOwner: "acme", repoName: "widgets" });
    const newer = seedTarget(db, { id: "t-newer", botId: "bot-two", repoId: 9601, repoOwner: "acme", repoName: "gadgets" });
    db.raw.prepare("UPDATE review_targets SET created_at = '2026-01-01 00:00:00' WHERE id = ?").run(older);
    db.raw.prepare("UPDATE review_targets SET created_at = '2026-01-02 00:00:00' WHERE id = ?").run(newer);
    const store = createTargetsStore(db);

    expect((await store.listLiveByBot("bot-two")).map((target) => target.id)).toEqual([older, newer]);
  });
});

describe("create (one repository, one workspace)", () => {
  test("a created target binds the repository, inherits the workspace and carries the caches", async () => {
    const db = createMigratedTestD1();
    seedBot(db, "bot-create");
    const store = createTargetsStore(db);

    const result = await store.create({
      workspaceId: WS,
      botId: "bot-create",
      repoId: 9100,
      repoOwner: "acme",
      repoName: "widgets",
      createdBy: "octocat",
    });
    expect(result.outcome).toBe("created");
    if (result.outcome !== "created") throw new Error("unreachable");
    expect(result.target).toMatchObject({
      workspace_id: WS,
      bot_id: "bot-create",
      repo_id: 9100,
      repo_owner: "acme",
      repo_name: "widgets",
      follow_workspace_defaults: 1,
      review_enabled: 1,
      deleted_at: null,
    });
  });

  test("the same repository twice in one workspace is one refusal and one row", async () => {
    const db = createMigratedTestD1();
    seedBot(db, "bot-dup");
    const store = createTargetsStore(db);
    const input = {
      workspaceId: WS,
      botId: "bot-dup",
      repoId: 9200,
      repoOwner: "acme",
      repoName: "widgets",
      createdBy: "octocat",
    };

    expect((await store.create(input)).outcome).toBe("created");
    expect(await store.create(input)).toEqual({ outcome: "duplicate" });
    expect(targetCount(db)).toBe(1);
  });

  test("a migrated unclaimed row of the same repository is a duplicate", async () => {
    const db = createMigratedTestD1();
    seedBot(db, "bot-legacy");
    seedTarget(db, { id: "legacy-1", botId: "bot-legacy", repoOwner: "acme", repoName: "widgets" });
    const store = createTargetsStore(db);

    expect(
      await store.create({
        workspaceId: WS,
        botId: "bot-legacy",
        repoId: 9300,
        repoOwner: "acme",
        repoName: "widgets",
        createdBy: "octocat",
      }),
    ).toEqual({ outcome: "duplicate" });
    expect(targetCount(db)).toBe(1);
  });

  test("a sibling workspace's row on the SAME bot is the same claim; a soft-deleted row releases it", async () => {
    const db = createMigratedTestD1();
    seedWorkspace(db, OTHER_WS);
    seedBot(db, "bot-scope");
    seedTarget(db, {
      id: "elsewhere",
      botId: "bot-scope",
      workspaceId: OTHER_WS,
      repoId: 9400,
      repoOwner: "acme",
      repoName: "widgets",
    });
    seedTarget(db, {
      id: "removed",
      botId: "bot-scope",
      repoId: 9401,
      repoOwner: "acme",
      repoName: "old",
      deleted: true,
    });
    const store = createTargetsStore(db);

    expect(
      await store.create({
        workspaceId: WS,
        botId: "bot-scope",
        repoId: 9400,
        repoOwner: "acme",
        repoName: "widgets",
        createdBy: "octocat",
      }),
    ).toEqual({ outcome: "duplicate" });
    expect(
      (await store.create({
        workspaceId: WS,
        botId: "bot-scope",
        repoId: 9401,
        repoOwner: "acme",
        repoName: "old",
        createdBy: "octocat",
      })).outcome,
    ).toBe("created");
  });

  test("the same repository under ANOTHER bot is a separate claim", async () => {
    const db = createMigratedTestD1();
    seedBot(db, "bot-1");
    seedBot(db, "bot-2");
    const store = createTargetsStore(db);
    const input = { workspaceId: WS, repoId: 9410, repoOwner: "acme", repoName: "widgets", createdBy: "octocat" };

    expect((await store.create({ ...input, botId: "bot-1" })).outcome).toBe("created");
    expect((await store.create({ ...input, botId: "bot-2" })).outcome).toBe("created");
    expect(targetCount(db)).toBe(2);
  });

  test("an identity the resolver could never find is refused before any write", async () => {
    const db = createMigratedTestD1();
    seedBot(db, "bot-bad");
    const store = createTargetsStore(db);

    await expect(
      store.create({
        workspaceId: WS,
        botId: "bot-bad",
        repoId: 0,
        repoOwner: "acme",
        repoName: "widgets",
        createdBy: "octocat",
      }),
    ).rejects.toThrow(/repo id/);
    await expect(
      store.create({
        workspaceId: WS,
        botId: "bot-bad",
        repoId: 9500,
        repoOwner: " ",
        repoName: "widgets",
        createdBy: "octocat",
      }),
    ).rejects.toThrow(/owner and name/);
    expect(targetCount(db)).toBe(0);
  });
});

describe("resolveByRepo (webhook resolution)", () => {
  test("a delivery resolves by repository id and answers null for an unknown one", async () => {
    const db = createMigratedTestD1();
    seedBot(db, "bot-resolve");
    const targetId = seedTarget(db, { id: "t-resolve", botId: "bot-resolve", repoId: 9600, repoOwner: "acme", repoName: "widgets" });
    const store = createTargetsStore(db);

    expect((await store.resolveByRepo("bot-resolve", { id: 9600, owner: "acme", name: "widgets" }))?.id).toBe(targetId);
    expect(await store.resolveByRepo("bot-resolve", { id: 9999, owner: "acme", name: "widgets" })).toBeNull();
    expect(await store.resolveByRepo("bot-absent", { id: 9600, owner: "acme", name: "widgets" })).toBeNull();
  });

  test("a rename refreshes the caches and keeps the identity", async () => {
    const db = createMigratedTestD1();
    seedBot(db, "bot-rename");
    const targetId = seedTarget(db, { id: "t-rename", botId: "bot-rename", repoId: 9700, repoOwner: "acme", repoName: "widgets" });
    const store = createTargetsStore(db);

    const resolved = await store.resolveByRepo("bot-rename", { id: 9700, owner: "acme", name: "gadgets" });
    expect(resolved?.id).toBe(targetId);
    expect(targetRow(db, targetId)).toMatchObject({ repo_id: 9700, repo_owner: "acme", repo_name: "gadgets" });
  });

  test("a first delivery onto a legacy row claims repo_id and the names", async () => {
    const db = createMigratedTestD1();
    seedBot(db, "bot-claim");
    const targetId = seedTarget(db, { id: "t-claim", botId: "bot-claim", repoOwner: "acme", repoName: "widgets" });
    const store = createTargetsStore(db);

    const resolved = await store.resolveByRepo("bot-claim", { id: 9800, owner: "acme", name: "widgets" });
    expect(resolved?.id).toBe(targetId);
    expect(resolved?.repo_id).toBe(9800);
    expect(targetRow(db, targetId)).toMatchObject({ repo_id: 9800, repo_owner: "acme", repo_name: "widgets" });

    expect((await store.resolveByRepo("bot-claim", { id: 9800, owner: "acme", name: "widgets" }))?.id).toBe(targetId);
  });

  test("a delivery without an id resolves the legacy row and claims nothing", async () => {
    const db = createMigratedTestD1();
    seedBot(db, "bot-noid");
    const targetId = seedTarget(db, { id: "t-noid", botId: "bot-noid", repoOwner: "acme", repoName: "widgets" });
    const store = createTargetsStore(db);

    expect((await store.resolveByRepo("bot-noid", { id: null, owner: "acme", name: "widgets" }))?.id).toBe(targetId);
    expect(targetRow(db, targetId).repo_id).toBeNull();
  });

  test("the bot's ONE all-NULL row is claimed on its first delivery (the migrated shape)", async () => {
    const db = createMigratedTestD1();
    seedBot(db, "bot-first");
    const targetId = seedTarget(db, { id: "t-first", botId: "bot-first" });
    const store = createTargetsStore(db);

    const resolved = await store.resolveByRepo("bot-first", { id: 9810, owner: "acme", name: "widgets" });
    expect(resolved?.id).toBe(targetId);
    expect(targetRow(db, targetId)).toMatchObject({
      repo_id: 9810,
      repo_owner: "acme",
      repo_name: "widgets",
    });
    expect((await store.resolveByRepo("bot-first", { id: 9810, owner: "acme", name: "widgets" }))?.id).toBe(targetId);
  });

  test("two all-NULL rows name no repository, so neither is claimed", async () => {
    const db = createMigratedTestD1();
    seedBot(db, "bot-two-null");
    seedTarget(db, { id: "t-null-a", botId: "bot-two-null" });
    seedTarget(db, { id: "t-null-b", botId: "bot-two-null" });
    const store = createTargetsStore(db);

    expect(await store.resolveByRepo("bot-two-null", { id: 9820, owner: "acme", name: "widgets" })).toBeNull();
    expect(targetRow(db, "t-null-a").repo_id).toBeNull();
    expect(targetRow(db, "t-null-b").repo_id).toBeNull();
  });

  test("owner/name compare case-insensitively, like the index", async () => {
    const db = createMigratedTestD1();
    seedBot(db, "bot-case");
    const targetId = seedTarget(db, { id: "t-case", botId: "bot-case", repoOwner: "Acme", repoName: "Widgets" });
    const store = createTargetsStore(db);

    const resolved = await store.resolveByRepo("bot-case", { id: 9830, owner: "acme", name: "widgets" });
    expect(resolved?.id).toBe(targetId);
    expect(targetRow(db, targetId)).toMatchObject({ repo_id: 9830, repo_owner: "acme", repo_name: "widgets" });

    seedBot(db, "bot-case-2");
    seedTarget(db, { id: "t-case-unclaimed", botId: "bot-case-2", repoOwner: "Acme", repoName: "Widgets" });
    expect(
      (
        await store.create({
          workspaceId: WS,
          botId: "bot-case-2",
          repoId: 9831,
          repoOwner: "ACME",
          repoName: "WIDGETS",
          createdBy: "octocat",
        })
      ).outcome,
    ).toBe("duplicate");
  });

  test("an id already held by a live row wins over a legacy name match", async () => {
    const db = createMigratedTestD1();
    seedBot(db, "bot-clash");
    seedTarget(db, { id: "t-claimed", botId: "bot-clash", repoId: 9900, repoOwner: "acme", repoName: "widgets" });
    seedTarget(db, { id: "t-legacy", botId: "bot-clash", repoOwner: "acme", repoName: "widgets-legacy" });
    const store = createTargetsStore(db);

    expect((await store.resolveByRepo("bot-clash", { id: 9900, owner: "acme", name: "widgets" }))?.id).toBe(
      "t-claimed",
    );
    expect(targetRow(db, "t-legacy").repo_id).toBeNull();
  });

  test("a soft-deleted target resolves to nothing; two unclaimed names are ambiguous", async () => {
    const db = createMigratedTestD1();
    seedBot(db, "bot-amb");
    seedTarget(db, { id: "t-gone", botId: "bot-amb", repoId: 9950, repoOwner: "acme", repoName: "gone", deleted: true });
    const store = createTargetsStore(db);
    expect(await store.resolveByRepo("bot-amb", { id: 9950, owner: "acme", name: "gone" })).toBeNull();

    seedTarget(db, { id: "t-dup-a", botId: "bot-amb", repoOwner: "acme", repoName: "two" });
    seedTarget(db, { id: "t-dup-b", botId: "bot-amb", repoOwner: "acme", repoName: "two" });
    expect(await store.resolveByRepo("bot-amb", { id: null, owner: "acme", name: "two" })).toBeNull();
    expect(targetRow(db, "t-dup-a").repo_id).toBeNull();
    expect(targetRow(db, "t-dup-b").repo_id).toBeNull();
  });
});

describe("effective settings and inheritance", () => {
  test("the workspace defaults answer while inheriting, the row's own columns otherwise", async () => {
    const db = createMigratedTestD1();
    db.raw
      .prepare(
        `UPDATE workspaces SET check_min_score = 45, default_review_trigger_mode = 'open',
                default_review_level = 'quick', default_check_pass_verdicts = '["ship it","blocked"]'
          WHERE id = ?`,
      )
      .run(WS);
    seedBot(db, "bot-inherit");
    seedTarget(db, {
      id: "t-follow",
      botId: "bot-inherit",
      repoId: 10001,
      repoOwner: "acme",
      repoName: "a",
      follow: 1,
      triggerMode: "manual",
      level: "deep",
      minScore: 90,
      verdicts: '["ship it"]',
    });
    seedTarget(db, {
      id: "t-own",
      botId: "bot-inherit",
      repoId: 10002,
      repoOwner: "acme",
      repoName: "b",
      follow: 0,
      triggerMode: "manual",
      level: "deep",
      minScore: 90,
    });
    const store = createTargetsStore(db);
    const defaults = await getWorkspaceReviewDefaults(db, WS);
    expect(defaults).toEqual({
      triggerMode: "open",
      level: "quick",
      checkMinScore: 45,
      checkPassVerdicts: ["ship it", "blocked"],
      checkPassVerdictsReadable: true,
    });

    const following = (await store.getInWorkspace(WS, "t-follow"))!;
    expect(effectiveTargetSettings(following, defaults)).toEqual({
      triggerMode: "open",
      level: "quick",
      checkMinScore: 45,
      checkPassVerdicts: ["ship it", "blocked"],
      checkPassVerdictsReadable: true,
      reviewDrafts: true,
    });
    const own = (await store.getInWorkspace(WS, "t-own"))!;
    expect(effectiveTargetSettings(own, defaults)).toEqual({
      triggerMode: "manual",
      level: "deep",
      checkMinScore: 90,
      checkPassVerdicts: ["ship it"],
      checkPassVerdictsReadable: true,
      reviewDrafts: true,
    });
  });

  test("inheriting never copies the defaults into the row, and toggling off snapshots them", async () => {
    const db = createMigratedTestD1();
    db.raw
      .prepare(
        `UPDATE workspaces SET check_min_score = 45, default_review_trigger_mode = 'open',
                default_review_level = 'quick'
          WHERE id = ?`,
      )
      .run(WS);
    seedBot(db, "bot-toggle");
    const targetId = seedTarget(db, {
      id: "t-toggle",
      botId: "bot-toggle",
      repoId: 10100,
      repoOwner: "acme",
      repoName: "widgets",
      follow: 1,
      triggerMode: "every_push",
      level: "deep",
      minScore: 90,
    });
    const store = createTargetsStore(db);

    db.raw.prepare("UPDATE workspaces SET default_review_trigger_mode = 'manual' WHERE id = ?").run(WS);
    expect((await getWorkspaceReviewDefaults(db, WS)).triggerMode).toBe("manual");
    expect(targetRow(db, targetId).review_trigger_mode).toBe("every_push");

    await setInheritance(db, WS, targetId, 0);
    expect(targetRow(db, targetId)).toMatchObject({
      follow_workspace_defaults: 0,
      review_trigger_mode: "manual",
      review_level: "quick",
      check_min_score: 45,
      check_pass_verdicts: '["ship it"]',
    });

    await setInheritance(db, WS, targetId, 1);
    expect(targetRow(db, targetId)).toMatchObject({
      follow_workspace_defaults: 1,
      review_trigger_mode: "manual",
      check_min_score: 45,
    });
  });

  test("an unreadable stored verdict array fails closed instead of admitting nobody's gate", async () => {
    const db = createMigratedTestD1();
    seedBot(db, "bot-gate");
    seedTarget(db, {
      id: "t-gate",
      botId: "bot-gate",
      repoId: 10200,
      repoOwner: "acme",
      repoName: "widgets",
      verdicts: '["lgtm"]',
    });
    const store = createTargetsStore(db);

    const target = (await store.getInWorkspace(WS, "t-gate"))!;
    expect(effectiveTargetSettings(target, await getWorkspaceReviewDefaults(db, WS)).checkPassVerdicts).toEqual([]);
    expect(await store.setReviewConfig(WS, "t-gate", { checkPassVerdicts: ["ship it"] })).toBe(true);
    expect(targetRow(db, "t-gate").check_pass_verdicts).toBe('["ship it"]');
  });

  test("the on-vocabulary levels parse back and an off-vocabulary stored value reads as absent", () => {
    for (const level of REVIEW_LEVELS) expect(parseTargetReviewLevel(level)).toBe(level);
    for (const value of [null, undefined, "turbo", "", "DEEP", 3, ["deep"]]) {
      expect(parseTargetReviewLevel(value)).toBeNull();
    }
  });
});

describe("setReviewConfig", () => {
  test("writes only the columns the caller names", async () => {
    const db = createMigratedTestD1();
    seedBot(db, "bot-config");
    const targetId = seedTarget(db, {
      id: "t-config",
      botId: "bot-config",
      repoId: 10300,
      repoOwner: "acme",
      repoName: "widgets",
      triggerMode: "every_push",
      level: "deep",
      minScore: 70,
    });
    const store = createTargetsStore(db);

    expect(await store.setReviewConfig(WS, targetId, { triggerMode: "manual" })).toBe(true);
    expect(targetRow(db, targetId)).toMatchObject({
      review_trigger_mode: "manual",
      review_level: "deep",
      check_min_score: 70,
    });

    expect(
      await store.setReviewConfig(WS, targetId, { checkMinScore: 55, checkPassVerdicts: ["ship it", "blocked"] }),
    ).toBe(true);
    expect(targetRow(db, targetId)).toMatchObject({
      review_trigger_mode: "manual",
      check_min_score: 55,
      check_pass_verdicts: '["ship it","blocked"]',
    });

    expect(await store.setReviewConfig(WS, targetId, { level: null })).toBe(true);
    expect(targetRow(db, targetId).review_level).toBeNull();
  });

  test("off-vocabulary values throw before any write", async () => {
    const db = createMigratedTestD1();
    seedBot(db, "bot-invalid");
    const targetId = seedTarget(db, { id: "t-invalid", botId: "bot-invalid", repoId: 10400, repoOwner: "acme", repoName: "widgets" });
    const store = createTargetsStore(db);

    await expect(
      store.setReviewConfig(WS, targetId, { triggerMode: "sometimes" as never }),
    ).rejects.toThrow(/trigger mode/);
    await expect(store.setReviewConfig(WS, targetId, { level: "turbo" as never })).rejects.toThrow(/review level/);
    await expect(store.setReviewConfig(WS, targetId, { checkMinScore: 101 })).rejects.toThrow(/outside 0..100/);
    await expect(
      store.setReviewConfig(WS, targetId, { checkPassVerdicts: ["lgtm" as never] }),
    ).rejects.toThrow(/PR_VERDICTS/);

    expect(targetRow(db, targetId)).toMatchObject({
      review_trigger_mode: "every_push",
      review_level: null,
      check_min_score: 70,
    });
  });

  test("an explicit save flips the row off inheritance in the same statement", async () => {
    const db = createMigratedTestD1();
    db.raw
      .prepare(
        `UPDATE workspaces SET check_min_score = 45 WHERE id = ?`,
      )
      .run(WS);
    seedBot(db, "bot-explicit");
    const targetId = seedTarget(db, {
      id: "t-explicit",
      botId: "bot-explicit",
      repoId: 10700,
      repoOwner: "acme",
      repoName: "widgets",
      follow: 1,
      minScore: 90,
    });
    const store = createTargetsStore(db);

    expect(checkGateOf(await readEffectiveTargetSettings(db, (await store.getInWorkspace(WS, targetId))!))).toEqual({
      minScore: 45,
      passVerdicts: ["ship it"],
    });

    expect(await store.setReviewConfig(WS, targetId, { checkMinScore: 90, follow: 0 })).toBe(true);
    expect(targetRow(db, targetId)).toMatchObject({ follow_workspace_defaults: 0, check_min_score: 90 });
    expect(checkGateOf(await readEffectiveTargetSettings(db, (await store.getInWorkspace(WS, targetId))!))).toEqual({
      minScore: 90,
      passVerdicts: ["ship it"],
    });
  });

  test("the pause writes the target flag", async () => {
    const db = createMigratedTestD1();
    seedBot(db, "bot-pause");
    const targetId = seedTarget(db, { id: "t-pause", botId: "bot-pause", repoId: 10500, repoOwner: "acme", repoName: "widgets" });
    const store = createTargetsStore(db);

    expect(await store.setReviewEnabled(WS, targetId, false)).toBe(true);
    expect(targetRow(db, targetId).review_enabled).toBe(0);
    expect(await store.setReviewEnabled(WS, targetId, true)).toBe(true);
    expect(targetRow(db, targetId).review_enabled).toBe(1);
  });

  test("delete is a soft delete that stamps deleted_at once", async () => {
    const db = createMigratedTestD1();
    seedBot(db, "bot-delete");
    const targetId = seedTarget(db, { id: "t-remove", botId: "bot-delete", repoId: 10600, repoOwner: "acme", repoName: "widgets" });
    const store = createTargetsStore(db);

    expect(await store.delete(WS, targetId)).toBe(true);
    expect(targetRow(db, targetId).deleted_at).not.toBeNull();
    expect(await store.getInWorkspace(WS, targetId)).toBeNull();
    expect(await store.delete(WS, targetId)).toBe(false);
  });
});

describe("setWorkspaceReviewDefaults (defaults + floor, one writer)", () => {
  const ACTION = "workspace.check_min_score.set";

  const floorAudits = (db: TestD1): Array<{ before: unknown; after: unknown }> =>
    (
      db.raw
        .prepare("SELECT detail_json FROM platform_audit_events WHERE action = ?1 ORDER BY rowid")
        .all(ACTION) as Array<{ detail_json: string }>
    ).map((row) => JSON.parse(row.detail_json) as { before: unknown; after: unknown });

  const workspaceRow = (db: TestD1) =>
    db.raw
      .prepare(
        `SELECT default_review_trigger_mode, default_review_level,
                default_check_pass_verdicts, check_min_score
           FROM workspaces WHERE id = ?`,
      )
      .get(WS) as Record<string, unknown>;

  test("writes the three defaults and the floor in one call, and ledgers the floor", async () => {
    const db = createMigratedTestD1();

    expect(
      await setWorkspaceReviewDefaults(
        db,
        WS,
        {
          triggerMode: "open",
          level: "deep",
          checkPassVerdicts: ["ship it", "blocked"],
          checkMinScore: 45,
        },
        "operator",
      ),
    ).toBe(true);
    expect(workspaceRow(db)).toEqual({
      default_review_trigger_mode: "open",
      default_review_level: "deep",
      default_check_pass_verdicts: '["ship it","blocked"]',
      check_min_score: 45,
    });
    expect(floorAudits(db)).toEqual([{ before: null, after: 45 }]);
  });

  test("each later floor save ledgers the value it replaced", async () => {
    const db = createMigratedTestD1();

    for (const value of [45, 0, 100]) {
      await setWorkspaceReviewDefaults(db, WS, { checkMinScore: value }, "operator");
    }

    expect(workspaceRow(db).check_min_score).toBe(100);
    expect(floorAudits(db)).toEqual([
      { before: null, after: 45 },
      { before: 45, after: 0 },
      { before: 0, after: 100 },
    ]);
  });

  test("an off-vocabulary value is refused before any write", async () => {
    const db = createMigratedTestD1();

    for (const bad of [-1, 101, 60.5, Number.NaN]) {
      await expect(
        setWorkspaceReviewDefaults(db, WS, { checkMinScore: bad }, "operator"),
      ).rejects.toThrow(/min score/);
    }
    await expect(
      setWorkspaceReviewDefaults(db, WS, { triggerMode: "sometimes" as never }, "operator"),
    ).rejects.toThrow(/trigger mode/);
    await expect(
      setWorkspaceReviewDefaults(db, WS, { checkPassVerdicts: ["lgtm" as never] }, "operator"),
    ).rejects.toThrow(/PR_VERDICTS/);

    expect(workspaceRow(db)).toEqual({
      default_review_trigger_mode: "every_push",
      default_review_level: null,
      default_check_pass_verdicts: '["ship it"]',
      check_min_score: null,
    });
    expect(floorAudits(db)).toEqual([]);
  });

  test("a patch that names nothing writes nothing", async () => {
    const db = createMigratedTestD1();

    expect(await setWorkspaceReviewDefaults(db, WS, {}, "operator")).toBe(false);
    expect(floorAudits(db)).toEqual([]);
  });

  test("an unknown workspace is refused as such", async () => {
    const db = createMigratedTestD1();

    await expect(
      setWorkspaceReviewDefaults(db, "ws_missing", { checkMinScore: 50 }, "operator"),
    ).rejects.toBeInstanceOf(UnknownWorkspaceError);
  });

  test("an untrusted stored floor is ledgered as absent, not as the default", async () => {
    const db = createMigratedTestD1();
    db.raw.exec("PRAGMA ignore_check_constraints = ON");
    db.raw.prepare("UPDATE workspaces SET check_min_score = 150 WHERE id = ?").run(WS);
    db.raw.exec("PRAGMA ignore_check_constraints = OFF");

    await setWorkspaceReviewDefaults(db, WS, { checkMinScore: 75 }, "operator");

    expect(floorAudits(db)).toEqual([{ before: null, after: 75 }]);
  });
});
