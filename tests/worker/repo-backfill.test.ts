/**
 * The repository backfill item (spec operator-data-upgrade § Repository
 * backfill item, D15/D22).
 *
 * The fixture is the shape 0067 left: ONE bot, two repositories' ledger rows
 * and reviews all hanging off ONE live target that names no repository. The
 * item must split it into one live target per repository, carry every ledger
 * row onto the new target, retire the old row, and be idempotent — a replay
 * over the migrated database processes nothing.
 *
 * What is pinned:
 *
 *   - preflight counts the split without writing anything;
 *   - one step creates one target per repository and repoints every ledger
 *     table, and the old row is soft-deleted;
 *   - a SECOND step over the finished work processes `0` and creates nothing;
 *   - verify reads all zero checks after the run — and does NOT read zero
 *     before it (the same checks, so the fixture proves the checks bite);
 *   - the D22 merge: two old rows naming the same repository collapse onto
 *     one target, keeping the later `last_seen_at` row's configuration.
 */
import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, seedBot, type TestD1 } from "../store/helpers";
import { repoBackfill } from "../../src/admin/data-upgrades/repo-backfill";
import { DATA_UPGRADES, resetDataUpgrade, stepDataUpgrade, verifyDataUpgrade, type UpgradeCursor } from "../../src/admin/data-upgrades";

const BOT = "bot-1";
const OPERATOR = "Support-Bot";
const RUN_1_START = "2026-06-01T00:00:00.000Z";

/** One old-shape target: no `repo_id`, no owner, no name — the 0067 leftover. */
function seedLeftoverTarget(
  db: TestD1,
  id: string,
  opts: {
    minScore?: number;
    workspaceId?: string;
    botId?: string;
    /** A target that already names a repository (the live replacement). */
    owner?: string;
    repo?: string;
    /** `deleted_at` in SQLite's `datetime('now')` shape, as production writes it. */
    deletedAt?: string;
  } = {},
): void {
  db.raw
    .prepare(
      `INSERT INTO review_targets
         (id, workspace_id, bot_id, name, repo_id, repo_owner, repo_name,
          follow_workspace_defaults, check_min_score, review_level, created_by, created_at, updated_at,
          deleted_at)
       VALUES (?, ?, ?, ?, NULL, ?, ?, 0, ?, 'deep', 'fixture',
               '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z', ?)`,
    )
    .run(
      id,
      opts.workspaceId ?? "default",
      opts.botId ?? BOT,
      id,
      opts.owner ?? null,
      opts.repo ?? null,
      opts.minScore ?? 80,
      opts.deletedAt ?? null,
    );
}

function seedPr(
  db: TestD1,
  id: string,
  targetId: string,
  owner: string,
  repo: string,
  prNumber: number,
  lastSeenAt: string,
  botId: string = BOT,
): void {
  db.raw
    .prepare(
      `INSERT INTO pull_requests
         (id, bot_id, owner, repo, pr_number, state, last_seen_at, target_id)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
    )
    .run(id, botId, owner, repo, prNumber, lastSeenAt, targetId);
}

function seedReview(
  db: TestD1,
  id: string,
  targetId: string,
  owner: string,
  repo: string,
  prNumber: number,
  reviewedAt: string,
  botId: string = BOT,
): void {
  db.raw
    .prepare(
      `INSERT INTO reviews
         (id, installation_id, owner, repo, pr_number, head_sha, reviewed_at, verdict, bot_id, target_id)
       VALUES (?, 1, ?, ?, ?, ?, ?, 'ship it', ?, ?)`,
    )
    .run(id, owner, repo, prNumber, `sha-${id}`, reviewedAt, botId, targetId);
}

function seedFailure(db: TestD1, id: string, targetId: string, owner: string, repo: string): void {
  db.raw
    .prepare(
      `INSERT INTO review_failures
         (id, installation_id, owner, repo, pr_number, head_sha, stage, error, created_at, target_id)
       VALUES (?, 1, ?, ?, 1, 'sha', 'pipeline', 'boom', '2026-01-01T00:00:00.000Z', ?)`,
    )
    .run(id, owner, repo, targetId);
}

/** One publication + one finding row, the minimum a `review_findings` row needs. */
function seedFinding(db: TestD1, id: string, targetId: string, owner: string, repo: string): void {
  db.raw
    .prepare(
      `INSERT INTO review_publications
         (id, bot_id, installation_id, owner, repo, pr_number, head_sha, kind, phase,
          payload_json, created_ms, updated_ms)
       VALUES (?, ?, 1, ?, ?, 1, 'sha', 'review', 'applied', '{}', 1, 1)`,
    )
    .run(`pub-${id}`, BOT, owner, repo);
  db.raw
    .prepare(
      `INSERT INTO review_findings
         (id, bot_id, installation_id, owner, repo, pr_number, finding_id, original_json,
          first_publication_id, last_publication_id, first_seen_sha, last_seen_sha,
          first_seen_round, last_seen_round, state, created_ms, updated_ms, target_id)
       VALUES (?, ?, 1, ?, ?, 1, ?, '{}', ?, ?, 'sha', 'sha', 1, 1, 'open', 1, 1, ?)`,
    )
    .run(id, BOT, owner, repo, `f-${id}`, `pub-${id}`, `pub-${id}`, targetId);
}

/**
 * The fixture: one bot, one leftover target carrying TWO repositories'
 * PRs/reviews/findings/failures.
 */
function fixture(): TestD1 {
  const db = createMigratedTestD1();
  seedBot(db, BOT, 7001);
  seedLeftoverTarget(db, "target-old", { minScore: 71 });
  for (const [repo, prSuffix] of [
    ["alpha", 1],
    ["beta", 2],
  ] as const) {
    seedPr(db, `pr-${repo}`, "target-old", "acme", repo, prSuffix, "2026-02-01T00:00:00.000Z");
    seedReview(db, `rv-${repo}`, "target-old", "acme", repo, prSuffix, "2026-02-01T00:00:00.000Z");
    seedFinding(db, `fd-${repo}`, "target-old", "acme", repo);
    seedFailure(db, `fl-${repo}`, "target-old", "acme", repo);
  }
  return db;
}

function liveTargets(db: TestD1): Array<{ id: string; repo_owner: string | null; repo_name: string | null; check_min_score: number; follow_workspace_defaults: number }> {
  return db.raw
    .query(
      `SELECT id, repo_owner, repo_name, check_min_score, follow_workspace_defaults
         FROM review_targets WHERE deleted_at IS NULL ORDER BY repo_name`,
    )
    .all() as never;
}

describe("repo-backfill item", () => {
  test("it is the registered item", () => {
    expect(DATA_UPGRADES.map((item) => item.id)).toContain("repo-backfill");
    expect(repoBackfill.requiresDowntime).toBe(true);
  });

  test("preflight counts the split without writing", async () => {
    const db = fixture();
    const before = liveTargets(db);
    const counts = await repoBackfill.preflight(db);
    expect(counts).toEqual({
      unidentified_targets: 1,
      ledger_pairs: 2,
      conflicting_groups: 0,
      leftover_without_ledger: 0,
    });
    // Read-only: not one row moved.
    expect(liveTargets(db)).toEqual(before);
  });

  test("one step splits the target into one per repository and repoints the ledger", async () => {
    const db = fixture();
    const batch = await repoBackfill.runBatch(db, null);
    expect(batch.processed).toBe(1);
    expect(batch.done).toBe(true);

    const live = liveTargets(db);
    expect(live.map((row) => row.repo_name)).toEqual(["alpha", "beta"]);
    // The winner's configuration is copied and the row does NOT inherit.
    for (const row of live) {
      expect(row.check_min_score).toBe(71);
      expect(row.follow_workspace_defaults).toBe(0);
      expect(row.repo_owner).toBe("acme");
    }

    // Every ledger row of both repositories followed its repository's target.
    for (const repo of ["alpha", "beta"]) {
      const target = live.find((row) => row.repo_name === repo)!;
      for (const [table, id] of [
        ["pull_requests", `pr-${repo}`],
        ["reviews", `rv-${repo}`],
        ["review_findings", `fd-${repo}`],
        ["review_failures", `fl-${repo}`],
      ] as const) {
        const row = db.raw.prepare(`SELECT target_id FROM ${table} WHERE id = ?`).get(id) as {
          target_id: string;
        };
        expect(row.target_id, `${table}:${id}`).toBe(target.id);
      }
    }

    // The old row is retired, not deleted.
    const old = db.raw.prepare("SELECT deleted_at FROM review_targets WHERE id = 'target-old'").get() as {
      deleted_at: string | null;
    };
    expect(old.deleted_at).not.toBeNull();
  });

  test("a second step processes nothing", async () => {
    const db = fixture();
    await repoBackfill.runBatch(db, null);
    const afterFirst = liveTargets(db);

    const replay = await repoBackfill.runBatch(db, null);
    expect(replay.processed).toBe(0);
    expect(replay.done).toBe(true);
    expect(replay.cursor).toBeNull();
    // No row was created and no configuration changed.
    expect(liveTargets(db)).toEqual(afterFirst);
  });

  test("verify reports the split as outstanding before the run and clean after it", async () => {
    const db = fixture();
    const outstanding = await repoBackfill.verify(db, { runStartedAt: null });
    expect(Object.values(outstanding).some((value) => value !== 0)).toBe(true);

    await repoBackfill.runBatch(db, null);
    expect(await repoBackfill.verify(db, { runStartedAt: null })).toEqual({
      unidentified_targets_with_ledger: 0,
      unrepointed_ledger_rows: 0,
      historical_rows: 0,
      duplicate_repository_groups: 0,
      ledger_rows_without_pr: 0,
    });
  });

  test("D22 merges two old rows naming one repository onto the newer row's config", async () => {
    const db = createMigratedTestD1();
    seedBot(db, BOT, 7001);
    seedLeftoverTarget(db, "target-older", { minScore: 60 });
    seedLeftoverTarget(db, "target-newer", { minScore: 95 });
    // Same repository, split across two old rows: one PR each, different stamps.
    seedPr(db, "pr-a", "target-older", "acme", "alpha", 1, "2026-01-01T00:00:00.000Z");
    seedPr(db, "pr-b", "target-newer", "acme", "alpha", 2, "2026-03-01T00:00:00.000Z");

    expect(await repoBackfill.preflight(db)).toMatchObject({ conflicting_groups: 1 });

    const batch = await repoBackfill.runBatch(db, null);
    expect(batch.log).toMatchObject({ created: 1, discarded: 1 });

    const live = liveTargets(db);
    expect(live).toHaveLength(1);
    // The winner is the row with the LATER last_seen_at, not the lower id.
    expect(live[0]!.check_min_score).toBe(95);
    const prs = db.raw
      .query("SELECT id, target_id FROM pull_requests ORDER BY id")
      .all() as Array<{ id: string; target_id: string }>;
    expect(prs.map((row) => row.target_id)).toEqual([live[0]!.id, live[0]!.id]);
    expect(batch.processed).toBe(2);
    expect((await repoBackfill.verify(db, { runStartedAt: null })).duplicate_repository_groups).toBe(0);
  });

  test("a PR held by two old rows of one repository keeps the later last_seen_at", async () => {
    const db = createMigratedTestD1();
    seedBot(db, BOT, 7001);
    seedLeftoverTarget(db, "target-a");
    seedLeftoverTarget(db, "target-b");
    seedPr(db, "pr-stale", "target-a", "acme", "alpha", 7, "2026-01-01T00:00:00.000Z");
    seedPr(db, "pr-fresh", "target-b", "acme", "alpha", 7, "2026-05-01T00:00:00.000Z");

    await repoBackfill.runBatch(db, null);
    const rows = db.raw.query("SELECT id FROM pull_requests").all() as Array<{ id: string }>;
    expect(rows.map((row) => row.id)).toEqual(["pr-fresh"]);
    expect((await repoBackfill.verify(db, { runStartedAt: null })).unrepointed_ledger_rows).toBe(0);
  });

  test("a PR the adopted destination already holds does not collide with the repoint", async () => {
    const db = createMigratedTestD1();
    seedBot(db, BOT, 7001);
    // The repository's live home, and a leftover row that also holds its PRs.
    seedLeftoverTarget(db, "target-home", { owner: "acme", repo: "alpha" });
    seedLeftoverTarget(db, "target-old");
    // #7: the destination's own row is later, so it stays and the member's goes.
    seedPr(db, "pr-home-7", "target-home", "acme", "alpha", 7, "2026-05-01T00:00:00.000Z");
    seedPr(db, "pr-old-7", "target-old", "acme", "alpha", 7, "2026-01-01T00:00:00.000Z");
    // #8: the member's row is later, so it repoints and the destination's goes.
    seedPr(db, "pr-home-8", "target-home", "acme", "alpha", 8, "2026-01-01T00:00:00.000Z");
    seedPr(db, "pr-old-8", "target-old", "acme", "alpha", 8, "2026-05-01T00:00:00.000Z");

    const batch = await repoBackfill.runBatch(db, null);
    expect(batch.done).toBe(true);
    expect(batch.log).toMatchObject({ adopted: 1, created: 0 });

    const rows = db.raw
      .query("SELECT id, target_id FROM pull_requests WHERE pr_number IN (7, 8) ORDER BY pr_number")
      .all() as Array<{ id: string; target_id: string }>;
    expect(rows).toEqual([
      { id: "pr-home-7", target_id: "target-home" },
      { id: "pr-old-8", target_id: "target-home" },
    ]);
    expect((await repoBackfill.verify(db, { runStartedAt: null })).unrepointed_ledger_rows).toBe(0);

    // A replay is a no-op: the collision is settled, not retried.
    const replay = await repoBackfill.runBatch(db, null);
    expect(replay.processed).toBe(0);
    expect(replay.done).toBe(true);
  });

  test("a leftover row with no ledger rows keeps its configuration", async () => {
    const db = createMigratedTestD1();
    seedBot(db, BOT, 7001);
    seedLeftoverTarget(db, "target-old");
    seedPr(db, "pr-1", "target-old", "acme", "alpha", 1, "2026-01-01T00:00:00.000Z");
    // 待安装: an unclaimed row with no history at all.
    seedLeftoverTarget(db, "target-empty", { minScore: 55 });
    // A row that already names its repository and merely has no ledger rows yet
    // is not backfill work — the batch's own write skips it, so the count must.
    seedLeftoverTarget(db, "target-claimed", { owner: "acme", repo: "gamma" });

    const counts = await repoBackfill.preflight(db);
    expect(counts).toMatchObject({ unidentified_targets: 2, leftover_without_ledger: 1 });

    await repoBackfill.runBatch(db, null);
    const empty = db.raw
      .query(
        "SELECT check_min_score, follow_workspace_defaults FROM review_targets WHERE id = 'target-empty'",
      )
      .get() as { check_min_score: number; follow_workspace_defaults: number };
    expect(empty).toEqual({ check_min_score: 55, follow_workspace_defaults: 0 });
  });

  /** Step until the item reports done; returns every batch's log. */
  async function drain(db: TestD1): Promise<Array<{ created: number; consumed: number; done: boolean }>> {
    const batches: Array<{ created: number; consumed: number; done: boolean }> = [];
    for (let cursor: UpgradeCursor | null = null; ; ) {
      const batch = await repoBackfill.runBatch(db, cursor);
      const log = batch.log ?? {};
      batches.push({
        created: typeof log.created === "number" ? log.created : 0,
        consumed: typeof log.consumed === "number" ? log.consumed : 0,
        done: batch.done,
      });
      if (batch.done) return batches;
      cursor = batch.cursor;
    }
  }

  test("only the batch's own rows retire: a member naming another repository stays live", async () => {
    const db = createMigratedTestD1();
    seedBot(db, BOT, 7001);
    // ONE old row naming 21 repositories: more groups than a step carries, so
    // its last repository can only migrate in a LATER batch.
    seedLeftoverTarget(db, "target-many");
    for (let index = 0; index < 21; index += 1) {
      seedPr(db, `pr-${index}`, "target-many", "acme", `repo-${index}`, 1, "2026-02-01T00:00:00.000Z");
    }

    const first = await repoBackfill.runBatch(db, null);
    expect(first.done).toBe(false);
    expect(first.log).toMatchObject({ created: 20, consumed: 0 });
    // The row is NOT retired: it still holds `repo-20`'s ledger row.
    const stillLive = db.raw
      .prepare("SELECT deleted_at FROM review_targets WHERE id = 'target-many'")
      .get() as { deleted_at: string | null };
    expect(stillLive.deleted_at).toBeNull();

    const batches = await drain(db);
    expect(batches.at(-1)!.done).toBe(true);
    expect(liveTargets(db)).toHaveLength(21);
    expect(await repoBackfill.verify(db, { runStartedAt: null })).toEqual({
      unidentified_targets_with_ledger: 0,
      unrepointed_ledger_rows: 0,
      historical_rows: 0,
      duplicate_repository_groups: 0,
      ledger_rows_without_pr: 0,
    });
  });

  test("two bots of one workspace keep separate targets for the same repository", async () => {
    const db = createMigratedTestD1();
    seedBot(db, BOT, 7001);
    seedBot(db, "bot-2", 7002);
    seedLeftoverTarget(db, "target-bot-1", { minScore: 60 });
    seedLeftoverTarget(db, "target-bot-2", { minScore: 90, botId: "bot-2" });
    seedPr(db, "pr-bot-1", "target-bot-1", "acme", "alpha", 1, "2026-01-01T00:00:00.000Z");
    seedPr(db, "pr-bot-2", "target-bot-2", "acme", "alpha", 1, "2026-02-01T00:00:00.000Z", "bot-2");

    const batch = await repoBackfill.runBatch(db, null);
    expect(batch.log).toMatchObject({ created: 2, discarded: 0 });

    const live = db.raw
      .query(
        "SELECT id, bot_id, check_min_score FROM review_targets WHERE deleted_at IS NULL ORDER BY bot_id",
      )
      .all() as Array<{ id: string; bot_id: string; check_min_score: number }>;
    expect(live).toHaveLength(2);
    expect(live.map((row) => [row.bot_id, row.check_min_score])).toEqual([
      [BOT, 60],
      ["bot-2", 90],
    ]);
    // Each bot's ledger row stayed on its own bot's target.
    for (const [id, botId] of [["pr-bot-1", BOT], ["pr-bot-2", "bot-2"]] as const) {
      const pr = db.raw.prepare("SELECT target_id FROM pull_requests WHERE id = ?").get(id) as {
        target_id: string;
      };
      expect(pr.target_id, id).toBe(live.find((row) => row.bot_id === botId)!.id);
    }
    expect((await repoBackfill.verify(db, { runStartedAt: null })).duplicate_repository_groups).toBe(0);
  });

  test("one bot's two workspaces collapse into ONE repository target", async () => {
    const db = createMigratedTestD1();
    seedBot(db, BOT, 7001);
    db.raw
      .prepare(
        `INSERT INTO workspaces (id, slug, name, created_by, created_at, deleted_at)
         VALUES ('second', 'second', 'Second', NULL, '2026-01-01T00:00:00.000Z', NULL)`,
      )
      .run();
    seedLeftoverTarget(db, "target-default", { minScore: 60 });
    seedLeftoverTarget(db, "target-second", { minScore: 90, workspaceId: "second" });
    seedPr(db, "pr-default", "target-default", "acme", "alpha", 1, "2026-01-01T00:00:00.000Z");
    seedPr(db, "pr-second", "target-second", "acme", "alpha", 2, "2026-03-01T00:00:00.000Z");

    // Both rows claim one repository: 0068's claim is bot-scoped, so is this.
    expect(await repoBackfill.preflight(db)).toMatchObject({ conflicting_groups: 1 });
    const batch = await repoBackfill.runBatch(db, null);
    expect(batch.log).toMatchObject({ created: 1, discarded: 1 });

    const live = db.raw
      .query("SELECT workspace_id, check_min_score FROM review_targets WHERE deleted_at IS NULL")
      .all() as Array<{ workspace_id: string; check_min_score: number }>;
    // ONE target, born in the D22 winner's workspace — not one per workspace.
    expect(live).toEqual([{ workspace_id: "second", check_min_score: 90 }]);
    const prs = db.raw.query("SELECT target_id FROM pull_requests").all() as Array<{
      target_id: string;
    }>;
    expect(prs).toHaveLength(2);
    expect(new Set(prs.map((row) => row.target_id)).size).toBe(1);
    expect((await repoBackfill.verify(db, { runStartedAt: null })).duplicate_repository_groups).toBe(0);
  });

  test("a run that drains mid-row leaves no live all-NULL target", async () => {
    const db = createMigratedTestD1();
    seedBot(db, BOT, 7001);
    // The first row spends the whole group budget on its 20 repositories.
    seedLeftoverTarget(db, "target-a");
    for (let index = 0; index < 20; index += 1) {
      seedPr(db, `pr-a-${index}`, "target-a", "acme", `repo-${index}`, 1, "2026-02-01T00:00:00.000Z");
    }
    // The second row is cut off mid-way: it shares `repo-0` (already planned)
    // and adds `repo-99`, the 21st group.
    seedLeftoverTarget(db, "target-b");
    seedPr(db, "pr-b-shared", "target-b", "acme", "repo-0", 1, "2026-02-01T00:00:00.000Z");
    seedPr(db, "pr-b-own", "target-b", "acme", "repo-99", 1, "2026-02-01T00:00:00.000Z");
    // The third row sits past the cutoff and holds ONLY the shared repository:
    // the first row's group moves its ledger row away, and the worklist — which
    // finds a row by a `pull_requests` row — would never visit it again.
    seedLeftoverTarget(db, "target-c");
    seedPr(db, "pr-c-shared", "target-c", "acme", "repo-0", 1, "2026-02-01T00:00:00.000Z");

    const batches = await drain(db);
    expect(batches.at(-1)!.done).toBe(true);
    expect(liveTargets(db)).toHaveLength(21);
    expect(liveTargets(db).filter((row) => row.repo_owner === null)).toEqual([]);
    expect(await repoBackfill.verify(db, { runStartedAt: null })).toEqual({
      unidentified_targets_with_ledger: 0,
      unrepointed_ledger_rows: 0,
      historical_rows: 0,
      duplicate_repository_groups: 0,
      ledger_rows_without_pr: 0,
    });
  });

  test("a case-variant owner name joins the same group instead of creating a second target", async () => {
    const db = createMigratedTestD1();
    seedBot(db, BOT, 7001);
    seedLeftoverTarget(db, "target-lower");
    seedLeftoverTarget(db, "target-upper");
    seedPr(db, "pr-lower", "target-lower", "acme", "alpha", 1, "2026-01-01T00:00:00.000Z");
    seedPr(db, "pr-upper", "target-upper", "Acme", "alpha", 2, "2026-02-01T00:00:00.000Z");

    const batch = await repoBackfill.runBatch(db, null);
    expect(batch.log).toMatchObject({ created: 1, discarded: 1 });

    const live = liveTargets(db);
    expect(live).toHaveLength(1);
    const prs = db.raw.query("SELECT target_id FROM pull_requests ORDER BY id").all() as Array<{
      target_id: string;
    }>;
    expect(prs.map((row) => row.target_id)).toEqual([live[0]!.id, live[0]!.id]);
    expect((await repoBackfill.verify(db, { runStartedAt: null })).duplicate_repository_groups).toBe(0);
  });

  test("a target naming many repositories migrates without overrunning the bind list", async () => {
    const db = createMigratedTestD1();
    seedBot(db, BOT, 7001);
    seedLeftoverTarget(db, "target-wide");
    for (let index = 0; index < 60; index += 1) {
      seedPr(db, `pr-${index}`, "target-wide", "acme", `repo-${index}`, 1, "2026-02-01T00:00:00.000Z");
      seedReview(db, `rv-${index}`, "target-wide", "acme", `repo-${index}`, 1, "2026-02-01T00:00:00.000Z");
    }

    expect((await repoBackfill.preflight(db)).ledger_pairs).toBe(60);
    const batches = await drain(db);
    expect(batches.every((batch) => batch.created <= 20)).toBe(true);
    expect(liveTargets(db)).toHaveLength(60);
    expect(await repoBackfill.verify(db, { runStartedAt: null })).toEqual({
      unidentified_targets_with_ledger: 0,
      unrepointed_ledger_rows: 0,
      historical_rows: 0,
      duplicate_repository_groups: 0,
      ledger_rows_without_pr: 0,
    });
  });
});

/** One ledger row's home table, seeded with no `pull_requests` row at all. */
const NON_PR_LEDGER: ReadonlyArray<readonly [string, (db: TestD1, id: string, targetId: string) => void]> = [
  [
    "reviews",
    (db, id, targetId) => seedReview(db, id, targetId, "acme", "alpha", 1, "2026-02-01T00:00:00.000Z"),
  ],
  ["review_findings", (db, id, targetId) => seedFinding(db, id, targetId, "acme", "alpha")],
  ["review_failures", (db, id, targetId) => seedFailure(db, id, targetId, "acme", "alpha")],
];

/**
 * A swept `pull_requests` row does not sweep the reviews, findings or failures
 * written for it: each of the other three tables alone must still reach the
 * worklist, preflight, group and verify.
 */
describe("repo-backfill over non-PR ledger rows", () => {
  for (const [table, seed] of NON_PR_LEDGER) {
    test(`a target whose only ledger row is in ${table} still reaches the worklist`, async () => {
      const db = createMigratedTestD1();
      seedBot(db, BOT, 7001);
      seedLeftoverTarget(db, "target-old", { minScore: 64 });
      seed(db, `row-${table}`, "target-old");

      // Preflight, worklist and the pre-run verify all see the same leftovers.
      expect(await repoBackfill.preflight(db)).toEqual({
        unidentified_targets: 1,
        ledger_pairs: 1,
        conflicting_groups: 0,
        leftover_without_ledger: 0,
      });
      const before = await repoBackfill.verify(db, { runStartedAt: null });
      expect(before.unidentified_targets_with_ledger).toBe(1);
      expect(before.ledger_rows_without_pr).toBe(1);

      const batch = await repoBackfill.runBatch(db, null);
      expect(batch.processed).toBe(1);
      expect(batch.done).toBe(true);

      const live = liveTargets(db);
      expect(live).toHaveLength(1);
      expect(live[0]).toMatchObject({ repo_owner: "acme", repo_name: "alpha", check_min_score: 64 });
      const row = db.raw
        .prepare(`SELECT target_id FROM ${table} WHERE id = ?`)
        .get(`row-${table}`) as { target_id: string };
      expect(row.target_id).toBe(live[0]!.id);

      // Passing: the row now sits on a target that names its repository. It has
      // no PR of its own, which is exactly what the advisory counts.
      expect(await repoBackfill.verify(db, { runStartedAt: null })).toEqual({
        unidentified_targets_with_ledger: 0,
        unrepointed_ledger_rows: 0,
        historical_rows: 0,
        duplicate_repository_groups: 0,
        ledger_rows_without_pr: 1,
      });
      expect(repoBackfill.advisoryChecks).toEqual(["historical_rows", "ledger_rows_without_pr"]);
      // Clean replay: nothing is left in the worklist.
      expect(await repoBackfill.runBatch(db, null)).toMatchObject({ processed: 0, done: true });
    });
  }

  test("three non-PR rows with no PR row anywhere yield advisory 3 and the item passes", async () => {
    const db = createMigratedTestD1();
    seedBot(db, BOT, 7001);
    // Already migrated: the target names its repository and holds one row in
    // each non-PR table. Nothing points at a retired target, so there is no
    // repair for the item to offer — the count is evidence, not a failure.
    seedLeftoverTarget(db, "target-live", { owner: "acme", repo: "alpha" });
    seedReview(db, "rv", "target-live", "acme", "alpha", 1, "2026-02-01T00:00:00.000Z");
    seedFinding(db, "fd", "target-live", "acme", "alpha");
    seedFailure(db, "fl", "target-live", "acme", "alpha");

    expect(await repoBackfill.runBatch(db, null)).toMatchObject({ processed: 0, done: true });
    expect(await repoBackfill.verify(db, { runStartedAt: null })).toEqual({
      unidentified_targets_with_ledger: 0,
      unrepointed_ledger_rows: 0,
      historical_rows: 0,
      duplicate_repository_groups: 0,
      ledger_rows_without_pr: 3,
    });

    // Through the runner: reported, and the item still completes.
    expect((await stepDataUpgrade(db, repoBackfill, OPERATOR, RUN_1_START)).kind).toBe("ok");
    const verified = await verifyDataUpgrade(db, repoBackfill, OPERATOR, "2026-06-01T00:10:00.000Z");
    expect(verified.kind === "ok" && verified.state.status).toBe("completed");
    expect(verified.kind === "ok" && verified.checks.ledger_rows_without_pr).toBe(3);
  });

  test("a case-variant group with no PR rows still collapses onto one target", async () => {
    const db = createMigratedTestD1();
    seedBot(db, BOT, 7001);
    seedLeftoverTarget(db, "target-lower");
    seedLeftoverTarget(db, "target-upper");
    seedReview(db, "rv-lower", "target-lower", "acme", "alpha", 1, "2026-01-01T00:00:00.000Z");
    seedFailure(db, "fl-upper", "target-upper", "Acme", "ALPHA");

    expect(await repoBackfill.preflight(db)).toMatchObject({ ledger_pairs: 2, conflicting_groups: 1 });
    const batch = await repoBackfill.runBatch(db, null);
    expect(batch.log).toMatchObject({ created: 1, discarded: 1 });

    const live = liveTargets(db);
    expect(live).toHaveLength(1);
    for (const [table, id] of [
      ["reviews", "rv-lower"],
      ["review_failures", "fl-upper"],
    ] as const) {
      const row = db.raw.prepare(`SELECT target_id FROM ${table} WHERE id = ?`).get(id) as {
        target_id: string;
      };
      expect(row.target_id, id).toBe(live[0]!.id);
    }
    expect(await repoBackfill.verify(db, { runStartedAt: null })).toEqual({
      unidentified_targets_with_ledger: 0,
      unrepointed_ledger_rows: 0,
      historical_rows: 0,
      duplicate_repository_groups: 0,
      ledger_rows_without_pr: 2,
    });
  });

  test("one bot's two workspaces collapse with no PR rows", async () => {
    const db = createMigratedTestD1();
    seedBot(db, BOT, 7001);
    db.raw
      .prepare(
        `INSERT INTO workspaces (id, slug, name, created_by, created_at, deleted_at)
         VALUES ('second', 'second', 'Second', NULL, '2026-01-01T00:00:00.000Z', NULL)`,
      )
      .run();
    seedLeftoverTarget(db, "target-default", { minScore: 60 });
    seedLeftoverTarget(db, "target-second", { minScore: 90, workspaceId: "second" });
    seedReview(db, "rv-default", "target-default", "acme", "alpha", 1, "2026-01-01T00:00:00.000Z");
    // Newer review stamp: the second workspace's row wins D22.
    seedReview(db, "rv-second", "target-second", "acme", "alpha", 2, "2026-03-01T00:00:00.000Z");

    const batch = await repoBackfill.runBatch(db, null);
    expect(batch.log).toMatchObject({ created: 1, discarded: 1 });
    const live = db.raw
      .query("SELECT workspace_id, check_min_score FROM review_targets WHERE deleted_at IS NULL")
      .all() as Array<{ workspace_id: string; check_min_score: number }>;
    expect(live).toEqual([{ workspace_id: "second", check_min_score: 90 }]);
    expect(await repoBackfill.verify(db, { runStartedAt: null })).toEqual({
      unidentified_targets_with_ledger: 0,
      unrepointed_ledger_rows: 0,
      historical_rows: 0,
      duplicate_repository_groups: 0,
      ledger_rows_without_pr: 2,
    });
  });

  test("all three non-PR tables on one leftover target drain together", async () => {
    const db = createMigratedTestD1();
    seedBot(db, BOT, 7001);
    seedLeftoverTarget(db, "target-old");
    seedReview(db, "rv", "target-old", "acme", "alpha", 1, "2026-02-01T00:00:00.000Z");
    seedFinding(db, "fd", "target-old", "acme", "alpha");
    seedFailure(db, "fl", "target-old", "acme", "alpha");

    expect(await repoBackfill.preflight(db)).toEqual({
      unidentified_targets: 1,
      ledger_pairs: 1,
      conflicting_groups: 0,
      leftover_without_ledger: 0,
    });
    const batch = await repoBackfill.runBatch(db, null);
    expect(batch.log).toMatchObject({ created: 1, repointed: 0, consumed: 1 });
    expect(batch.done).toBe(true);

    const live = liveTargets(db);
    expect(live).toHaveLength(1);
    for (const [table, id] of [
      ["reviews", "rv"],
      ["review_findings", "fd"],
      ["review_failures", "fl"],
    ] as const) {
      const row = db.raw.prepare(`SELECT target_id FROM ${table} WHERE id = ?`).get(id) as {
        target_id: string;
      };
      expect(row.target_id, table).toBe(live[0]!.id);
    }
    // The retired source keeps no ledger rows, so nothing is stranded.
    expect(await repoBackfill.verify(db, { runStartedAt: null })).toEqual({
      unidentified_targets_with_ledger: 0,
      unrepointed_ledger_rows: 0,
      historical_rows: 0,
      duplicate_repository_groups: 0,
      ledger_rows_without_pr: 3,
    });
    expect(await repoBackfill.runBatch(db, null)).toMatchObject({ processed: 0, done: true });
  });

  test("a named destination with no PR row adopts a non-PR ledger row", async () => {
    const db = createMigratedTestD1();
    seedBot(db, BOT, 7001);
    // The repository's live home names it but holds no PR: naming is coverage.
    seedLeftoverTarget(db, "target-home", { owner: "acme", repo: "alpha" });
    seedLeftoverTarget(db, "target-old");
    seedReview(db, "rv", "target-old", "acme", "alpha", 5, "2026-02-01T00:00:00.000Z");

    const batch = await repoBackfill.runBatch(db, null);
    // A migrated group counts even though `repointed` (PR rows) is zero.
    expect(batch.log).toMatchObject({ created: 0, adopted: 1, repointed: 0, consumed: 1 });
    const row = db.raw.prepare("SELECT target_id FROM reviews WHERE id = 'rv'").get() as {
      target_id: string;
    };
    expect(row.target_id).toBe("target-home");
    expect(liveTargets(db).map((target) => target.id)).toEqual(["target-home"]);
    expect((await repoBackfill.runBatch(db, null)).processed).toBe(0);
  });
});

/**
 * A live target already covering `acme/alpha` (its PR proves the coverage) plus
 * a soft-deleted target of the same bot and workspace still holding a ledger row
 * for that repository — the shape verify has to date.
 */
function withRetiredTarget(deletedAt: string): TestD1 {
  const db = createMigratedTestD1();
  seedBot(db, BOT, 7001);
  seedLeftoverTarget(db, "target-live", { owner: "acme", repo: "alpha" });
  seedPr(db, "pr-live", "target-live", "acme", "alpha", 1, "2026-02-01T00:00:00.000Z");
  seedLeftoverTarget(db, "target-retired", { deletedAt });
  seedPr(db, "pr-retired", "target-retired", "acme", "alpha", 9, "2026-01-01T00:00:00.000Z");
  return db;
}

describe("repo-backfill verify: this run's retirements vs history", () => {
  test("a row on a target deleted BEFORE the run is history and does not fail the item", async () => {
    // `deleted_at` in SQLite's `datetime('now')` shape, a month before the run.
    const db = withRetiredTarget("2026-05-01 00:00:00");

    const checks = await repoBackfill.verify(db, { runStartedAt: "2026-06-01T00:00:00.000Z" });
    expect(checks).toEqual({
      unidentified_targets_with_ledger: 0,
      unrepointed_ledger_rows: 0,
      historical_rows: 1,
      duplicate_repository_groups: 0,
      ledger_rows_without_pr: 0,
    });
    // Advisory only: the run completes.
    expect(repoBackfill.advisoryChecks).toContain("historical_rows");
  });

  test("a row on a target deleted DURING the run blocks the item", async () => {
    // Retired a day into the run: the worklist could have stranded this row.
    const db = withRetiredTarget("2026-06-02 00:00:00");

    const checks = await repoBackfill.verify(db, { runStartedAt: "2026-06-01T00:00:00.000Z" });
    expect(checks).toMatchObject({ unrepointed_ledger_rows: 1, historical_rows: 0 });
  });

  test("with no recorded run start every deleted target is history", async () => {
    // A freshly deleted target with no run start is still not this run's doing:
    // the item never stepped, so it cannot have stranded anything.
    const db = withRetiredTarget("2026-06-02 00:00:00");

    const checks = await repoBackfill.verify(db, { runStartedAt: null });
    expect(checks).toMatchObject({ unrepointed_ledger_rows: 0, historical_rows: 1 });
  });

  /**
   * The live destination need not hold a PR: naming the repository is what
   * covers it. A retired target's reviews then count just like its PRs would.
   */
  test("a retired target's non-PR row blocks when the live destination has no PR", async () => {
    const db = createMigratedTestD1();
    seedBot(db, BOT, 7001);
    seedLeftoverTarget(db, "target-live", { owner: "acme", repo: "alpha" });
    seedLeftoverTarget(db, "target-retired", { deletedAt: "2026-06-02 00:00:00" });
    seedReview(db, "rv-retired", "target-retired", "acme", "alpha", 3, "2026-02-01T00:00:00.000Z");

    const checks = await repoBackfill.verify(db, { runStartedAt: "2026-06-01T00:00:00.000Z" });
    expect(checks).toMatchObject({ unrepointed_ledger_rows: 1, historical_rows: 0 });
  });

  test("a retired target's non-PR row on no live destination is not covered", async () => {
    const db = createMigratedTestD1();
    seedBot(db, BOT, 7001);
    // A live target naming ANOTHER repository covers nothing here.
    seedLeftoverTarget(db, "target-other", { owner: "acme", repo: "beta" });
    seedLeftoverTarget(db, "target-retired", { deletedAt: "2026-06-02 00:00:00" });
    seedFailure(db, "fl-retired", "target-retired", "acme", "alpha");

    const checks = await repoBackfill.verify(db, { runStartedAt: "2026-06-01T00:00:00.000Z" });
    // No live cover, so no unrepointed residual — but the row still has no PR.
    expect(checks).toMatchObject({
      unrepointed_ledger_rows: 0,
      historical_rows: 0,
      ledger_rows_without_pr: 1,
    });
  });

  /**
   * The advisory is exact and independent of the blocking split: three non-PR
   * rows on a retired target are three rows, and do not suppress the blocking
   * unrepointed count when a live destination covers them.
   */
  test("the advisory counts rows and leaves the blocking count alone", async () => {
    const db = createMigratedTestD1();
    seedBot(db, BOT, 7001);
    seedLeftoverTarget(db, "target-live", { owner: "acme", repo: "alpha" });
    seedLeftoverTarget(db, "target-retired", { deletedAt: "2026-06-02 00:00:00" });
    seedReview(db, "rv-retired", "target-retired", "acme", "alpha", 3, "2026-02-01T00:00:00.000Z");
    seedFinding(db, "fd-retired", "target-retired", "acme", "alpha");
    seedFailure(db, "fl-retired", "target-retired", "acme", "alpha");

    const checks = await repoBackfill.verify(db, { runStartedAt: "2026-06-01T00:00:00.000Z" });
    expect(checks).toMatchObject({ unrepointed_ledger_rows: 3, ledger_rows_without_pr: 3 });
  });

  /**
   * Acceptance shape: a leftover target whose `pull_requests` rows are gone but
   * whose reviews remain. Verify reports it in the advisory AND still fails the
   * item on the blocking unidentified count — the advisory never suppresses it.
   */
  test("a PR-less leftover blocks the item while the advisory reports the same shape", async () => {
    const db = createMigratedTestD1();
    seedBot(db, BOT, 7001);
    // The run stamps its boundary on an empty ledger, then the leftover lands —
    // a review written against an old target after the batch scanned it.
    expect((await stepDataUpgrade(db, repoBackfill, OPERATOR, RUN_1_START)).kind).toBe("ok");
    seedLeftoverTarget(db, "target-old");
    seedReview(db, "rv", "target-old", "acme", "alpha", 1, "2026-02-01T00:00:00.000Z");

    const failed = await verifyDataUpgrade(db, repoBackfill, OPERATOR, "2026-06-01T00:10:00.000Z");
    expect(failed.kind === "ok" && failed.state.status).toBe("failed");
    expect(failed.kind === "ok" && failed.state.lastError).toContain("unidentified_targets_with_ledger=1");
    expect(failed.kind === "ok" && failed.checks).toMatchObject({
      unidentified_targets_with_ledger: 1,
      ledger_rows_without_pr: 1,
    });

    // The worklist drains it; then it passes, with the advisory still standing
    // for the row that has no PR of its own.
    expect((await resetDataUpgrade(db, repoBackfill, OPERATOR, "2026-06-01T00:20:00.000Z")).kind).toBe("ok");
    expect((await stepDataUpgrade(db, repoBackfill, OPERATOR, "2026-06-01T00:30:00.000Z")).kind).toBe("ok");
    const passed = await verifyDataUpgrade(db, repoBackfill, OPERATOR, "2026-06-01T00:40:00.000Z");
    expect(passed.kind === "ok" && passed.state.status).toBe("completed");
    expect(passed.kind === "ok" && passed.checks).toMatchObject({
      unidentified_targets_with_ledger: 0,
      ledger_rows_without_pr: 1,
    });
  });

  test("a row retired during run 1 still blocks after a reset and re-run", async () => {
    // Retired BETWEEN run 1's start and the resumed attempt: only the kept
    // run-start boundary makes it this item's retirement rather than history.
    const db = withRetiredTarget("2026-06-01 00:05:00");

    // Run 1: its first step stamps the boundary, and the row is this run's.
    expect((await stepDataUpgrade(db, repoBackfill, OPERATOR, RUN_1_START)).kind).toBe("ok");
    const first = await verifyDataUpgrade(db, repoBackfill, OPERATOR, "2026-06-01T00:10:00.000Z");
    expect(first.kind === "ok" && first.checks).toMatchObject({
      unrepointed_ledger_rows: 1,
      historical_rows: 0,
    });

    // Reset returns the item to `pending` but keeps the item's run-start
    // boundary, so the resumed attempt judges the same retirements.
    expect((await resetDataUpgrade(db, repoBackfill, OPERATOR, "2026-06-01T00:20:00.000Z")).kind).toBe("ok");
    expect((await stepDataUpgrade(db, repoBackfill, OPERATOR, "2026-06-01T00:30:00.000Z")).kind).toBe("ok");
    const second = await verifyDataUpgrade(db, repoBackfill, OPERATOR, "2026-06-01T00:40:00.000Z");
    expect(second.kind === "ok" && second.checks).toMatchObject({
      unrepointed_ledger_rows: 1,
      historical_rows: 0,
    });
  });
});
