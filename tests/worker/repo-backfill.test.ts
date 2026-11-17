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
import { DATA_UPGRADES } from "../../src/admin/data-upgrades";

const BOT = "bot-1";

/** One old-shape target: no `repo_id`, no owner, no name — the 0067 leftover. */
function seedLeftoverTarget(db: TestD1, id: string, opts: { minScore?: number; workspaceId?: string } = {}): void {
  db.raw
    .prepare(
      `INSERT INTO review_targets
         (id, workspace_id, bot_id, name, repo_id, repo_owner, repo_name,
          follow_workspace_defaults, check_min_score, review_level, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, NULL, NULL, NULL, 0, ?, 'deep', 'fixture',
               '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')`,
    )
    .run(id, opts.workspaceId ?? "default", BOT, id, opts.minScore ?? 80);
}

function seedPr(
  db: TestD1,
  id: string,
  targetId: string,
  owner: string,
  repo: string,
  prNumber: number,
  lastSeenAt: string,
): void {
  db.raw
    .prepare(
      `INSERT INTO pull_requests
         (id, bot_id, owner, repo, pr_number, state, last_seen_at, target_id)
       VALUES (?, ?, ?, ?, ?, 'open', ?, ?)`,
    )
    .run(id, BOT, owner, repo, prNumber, lastSeenAt, targetId);
}

function seedReview(
  db: TestD1,
  id: string,
  targetId: string,
  owner: string,
  repo: string,
  prNumber: number,
  reviewedAt: string,
): void {
  db.raw
    .prepare(
      `INSERT INTO reviews
         (id, installation_id, owner, repo, pr_number, head_sha, reviewed_at, verdict, bot_id, target_id)
       VALUES (?, 1, ?, ?, ?, ?, ?, 'ship it', ?, ?)`,
    )
    .run(id, owner, repo, prNumber, `sha-${id}`, reviewedAt, BOT, targetId);
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
      empty_targets: 0,
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
    const outstanding = await repoBackfill.verify(db);
    expect(Object.values(outstanding).some((value) => value !== 0)).toBe(true);

    await repoBackfill.runBatch(db, null);
    expect(await repoBackfill.verify(db)).toEqual({
      unidentified_targets_with_ledger: 0,
      unrepointed_ledger_rows: 0,
      duplicate_repository_groups: 0,
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
    expect((await repoBackfill.verify(db)).duplicate_repository_groups).toBe(0);
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
    expect((await repoBackfill.verify(db)).unrepointed_ledger_rows).toBe(0);
  });

  test("a leftover row with no ledger rows keeps its configuration", async () => {
    const db = createMigratedTestD1();
    seedBot(db, BOT, 7001);
    seedLeftoverTarget(db, "target-old");
    seedPr(db, "pr-1", "target-old", "acme", "alpha", 1, "2026-01-01T00:00:00.000Z");
    // 待安装: an unclaimed row with no history at all.
    seedLeftoverTarget(db, "target-empty", { minScore: 55 });

    const counts = await repoBackfill.preflight(db);
    expect(counts).toMatchObject({ unidentified_targets: 2, empty_targets: 1 });

    await repoBackfill.runBatch(db, null);
    const empty = db.raw
      .query(
        "SELECT check_min_score, follow_workspace_defaults FROM review_targets WHERE id = 'target-empty'",
      )
      .get() as { check_min_score: number; follow_workspace_defaults: number };
    expect(empty).toEqual({ check_min_score: 55, follow_workspace_defaults: 0 });
  });
});
