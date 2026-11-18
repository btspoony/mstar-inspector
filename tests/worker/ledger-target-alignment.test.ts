/**
 * The ledger target alignment item (spec operator-data-upgrade § Ledger target
 * alignment item).
 *
 * The fixture is the shape staging carries: ledger rows that HAVE a target, and
 * that target names a different repository than the row does. The repository
 * detail page reads by target, so those rows are invisible on their own page.
 *
 * What is pinned:
 *
 *   - a mismatched row moves onto the live target naming its repository;
 *   - a repository with no target gets exactly one, in the bot's workspace, with
 *     `repo_id` NULL unless GitHub can bind it;
 *   - a row already on its own target is not written;
 *   - running twice changes nothing the second time, and makes no GitHub call;
 *   - two live targets naming the repository leave the group untouched and
 *     count as ambiguous;
 *   - a live installation binds `repo_id`; a removed one leaves it NULL and
 *     counts the group unbound; a GitHub failure leaves it unbound without
 *     failing the batch;
 *   - verify reads zero mismatches after the run, and the item's own verify
 *     reports zero on the planted fixture.
 */
import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, seedBot, seedTarget, type TestD1 } from "../store/helpers";
import { ledgerTargetAlignment } from "../../src/admin/data-upgrades/ledger-target-alignment";
import {
  DATA_UPGRADES,
  resetDataUpgrade,
  stepDataUpgrade,
  verifyDataUpgrade,
  type RepoLookup,
  type UpgradeBatch,
  type UpgradeCursor,
} from "../../src/admin/data-upgrades";

const BOT = "bot-1";
const OPERATOR = "Support-Bot";
const RUN_START = "2026-11-18T00:00:00.000Z";

function seedBotWorkspace(db: TestD1, botId: string, workspaceId = "default"): void {
  db.raw
    .prepare("INSERT INTO bot_workspaces (bot_id, workspace_id) VALUES (?, ?)")
    .run(botId, workspaceId);
}

function seedInstallation(
  db: TestD1,
  botId: string,
  installationId: number,
  accountLogin: string,
  removedAt: string | null = null,
): void {
  db.raw
    .prepare(
      `INSERT INTO bot_installations (id, bot_id, installation_id, account_login, seen_at, removed_at)
       VALUES (?, ?, ?, ?, '2026-08-01T00:00:00.000Z', ?)`,
    )
    .run(`inst-${botId}-${installationId}`, botId, installationId, accountLogin, removedAt);
}

/** A PR row whose target is `targetId`. `owner`/`repo` are the row's OWN repository. */
function seedPr(
  db: TestD1,
  id: string,
  owner: string,
  repo: string,
  targetId: string,
  prNumber = 1,
  botId = BOT,
): void {
  db.raw
    .prepare(
      `INSERT INTO pull_requests
         (id, bot_id, owner, repo, pr_number, state, last_seen_at, target_id)
       VALUES (?, ?, ?, ?, ?, 'open', '2026-08-27T00:00:00.000Z', ?)`,
    )
    .run(id, botId, owner, repo, prNumber, targetId);
}

/** A review row whose target is `targetId`. */
function seedReview(db: TestD1, id: string, owner: string, repo: string, targetId: string): void {
  db.raw
    .prepare(
      `INSERT INTO reviews
         (id, installation_id, owner, repo, pr_number, head_sha, reviewed_at, verdict, bot_id, target_id)
       VALUES (?, 1, ?, ?, 1, ?, '2026-08-27T00:00:00.000Z', 'ship it', ?, ?)`,
    )
    .run(id, owner, repo, `sha-${id}`, BOT, targetId);
}

function targetOf(db: TestD1, table: string, id: string): string | null {
  const row = db.raw.prepare(`SELECT target_id FROM ${table} WHERE id = ?`).get(id) as {
    target_id: string | null;
  };
  return row.target_id;
}

function targetRow(
  db: TestD1,
  id: string,
): { id: string; bot_id: string; repo_owner: string | null; repo_name: string | null; repo_id: number | null } {
  return db.raw
    .prepare("SELECT id, bot_id, repo_owner, repo_name, repo_id FROM review_targets WHERE id = ?")
    .get(id) as never;
}

/** Step until the item reports done; returns every batch. */
async function drain(db: TestD1, lookup?: RepoLookup): Promise<UpgradeBatch[]> {
  const batches: UpgradeBatch[] = [];
  for (let cursor: UpgradeCursor | null = null; ; ) {
    const batch = await ledgerTargetAlignment.runBatch(db, cursor, OPERATOR, { repoLookup: lookup });
    batches.push(batch);
    if (batch.done) return batches;
    cursor = batch.cursor;
  }
}

/**
 * One bot in one workspace. The harness target (the row's own repository is the
 * inspector) is the misattribution staging carries; `target-inspector` is the
 * live target the inspector rows belong on.
 */
function fixture(): TestD1 {
  const db = createMigratedTestD1();
  seedBot(db, BOT, 7001);
  seedBotWorkspace(db, BOT);
  seedInstallation(db, BOT, 170871484, "btspoony");
  seedTarget(db, BOT, { id: "target-harness", repoOwner: "btspoony", repoName: "mstar-harness" });
  seedTarget(db, BOT, { id: "target-inspector", repoOwner: "btspoony", repoName: "mstar-inspector" });
  return db;
}

describe("ledger-target-alignment item", () => {
  test("it is registered after orphan attribution, without downtime", () => {
    expect(DATA_UPGRADES.map((item) => item.id)).toContain("ledger-target-alignment");
    expect(ledgerTargetAlignment.requiresDowntime).toBe(false);
    expect(ledgerTargetAlignment.order).toBeGreaterThan(
      DATA_UPGRADES.find((item) => item.id === "orphan-ledger-attribution")!.order,
    );
    // The card states what it never touches.
    expect(ledgerTargetAlignment.impact).toContain("Never deletes a ledger row");
  });

  test("a mismatched row moves onto its own repository's target", async () => {
    const db = fixture();
    seedPr(db, "pr-inspector", "btspoony", "mstar-inspector", "target-harness");
    seedReview(db, "rv-inspector", "btspoony", "mstar-inspector", "target-harness");

    expect(await ledgerTargetAlignment.preflight(db)).toMatchObject({
      misaligned_rows: 2,
      groups: 1,
      groups_with_target: 1,
      groups_needing_target: 0,
    });

    const batch = await ledgerTargetAlignment.runBatch(db, null, OPERATOR);
    expect(batch).toMatchObject({ processed: 2, done: true });
    expect(batch.log).toMatchObject({ groups: 1, aligned: 1, created: 0 });
    expect(targetOf(db, "pull_requests", "pr-inspector")).toBe("target-inspector");
    expect(targetOf(db, "reviews", "rv-inspector")).toBe("target-inspector");
    // The harness target keeps its own rows: nothing was deleted or emptied.
    expect(targetRow(db, "target-harness")).toMatchObject({ repo_name: "mstar-harness" });
  });

  test("a row already on its own target is not written", async () => {
    const db = fixture();
    seedPr(db, "pr-own", "btspoony", "mstar-inspector", "target-inspector");
    seedPr(db, "pr-other", "btspoony", "mstar-harness", "target-harness");

    expect(await ledgerTargetAlignment.preflight(db)).toMatchObject({ misaligned_rows: 0, groups: 0 });
    const batch = await ledgerTargetAlignment.runBatch(db, null, OPERATOR);
    expect(batch).toMatchObject({ processed: 0, done: true });
    expect(batch.log).toMatchObject({ groups: 0, aligned: 0 });
    expect(targetOf(db, "pull_requests", "pr-own")).toBe("target-inspector");
  });

  test("a repository with no target gets one, in the bot's workspace", async () => {
    const db = fixture();
    seedPr(db, "pr-nexus", "42ch-dev", "nexus", "target-harness", 7);

    const batch = await ledgerTargetAlignment.runBatch(db, null, OPERATOR);
    expect(batch).toMatchObject({ processed: 1, done: true });
    expect(batch.log).toMatchObject({ created: 1, aligned: 1 });

    const created = targetOf(db, "pull_requests", "pr-nexus")!;
    expect(created).not.toBe("target-harness");
    // No fabricated id: the first delivery claims it (0067).
    expect(targetRow(db, created)).toEqual({
      id: created,
      bot_id: BOT,
      repo_owner: "42ch-dev",
      repo_name: "nexus",
      repo_id: null,
    });
  });

  test("running twice changes nothing the second time", async () => {
    const db = fixture();
    seedPr(db, "pr-inspector", "btspoony", "mstar-inspector", "target-harness");
    seedPr(db, "pr-nexus", "42ch-dev", "nexus", "target-harness", 2);

    const first = await drain(db);
    expect(first.reduce((sum, batch) => sum + batch.processed, 0)).toBe(2);
    const aligned = db.raw
      .prepare("SELECT id, target_id FROM pull_requests ORDER BY id")
      .all() as Array<{ id: string; target_id: string }>;

    const second = await ledgerTargetAlignment.runBatch(db, null, OPERATOR);
    expect(second).toMatchObject({ processed: 0, done: true, cursor: null });
    expect(second.log).toMatchObject({ aligned: 0, created: 0 });
    expect(db.raw.prepare("SELECT id, target_id FROM pull_requests ORDER BY id").all()).toEqual(aligned);
    // One created target, not two.
    expect(
      db.raw.prepare("SELECT COUNT(*) AS n FROM review_targets WHERE repo_name = 'nexus'").get(),
    ).toEqual({ n: 1 });
  });

  test("two live targets naming the repository leave the group untouched and count as ambiguous", async () => {
    const db = fixture();
    // A second live row for the inspector repository: the store's own resolver
    // refuses the pair instead of picking one, and so does the item.
    db.raw
      .prepare(
        `INSERT INTO review_targets
           (id, workspace_id, bot_id, name, repo_id, repo_owner, repo_name,
            check_min_score, created_by, created_at, updated_at)
         VALUES ('target-inspector-2', 'default', ?, 'btspoony/mstar-inspector', NULL,
                 'btspoony', 'mstar-inspector', 80, 'fixture',
                 '2030-01-01T00:00:00.000Z', '2030-01-01T00:00:00.000Z')`,
      )
      .run(BOT);
    seedPr(db, "pr-inspector", "btspoony", "mstar-inspector", "target-harness");

    expect(await ledgerTargetAlignment.preflight(db)).toMatchObject({
      groups: 1,
      ambiguous_groups: 1,
    });
    const batch = await ledgerTargetAlignment.runBatch(db, null, OPERATOR);
    expect(batch).toMatchObject({ processed: 0, done: true });
    expect(batch.log).toMatchObject({ ambiguous: 1, aligned: 0 });
    expect(targetOf(db, "pull_requests", "pr-inspector")).toBe("target-harness");
    // The group is reported, never a failure: no later pass could repair it.
    expect(await ledgerTargetAlignment.verify(db, { runStartedAt: null })).toMatchObject({
      misaligned_ledger_rows: 0,
      ambiguous_groups: 1,
    });
  });

  test("a live installation binds repo_id; a removed one leaves the group unbound", async () => {
    const db = fixture();
    // `btspoony` has a live installation, `42ch-dev`'s is removed.
    seedInstallation(db, BOT, 177552922, "42ch-dev", "2026-09-01T00:00:00.000Z");
    seedPr(db, "pr-todo", "btspoony", "todo-bots", "target-harness", 3);
    seedPr(db, "pr-nexus", "42ch-dev", "nexus", "target-harness", 4);

    const calls: number[] = [];
    const lookup: RepoLookup = async (_bot, installationId, owner, repo) => {
      calls.push(installationId);
      if (installationId !== 170871484) return { kind: "failed" };
      return owner === "btspoony" && repo === "todo-bots"
        ? { kind: "found", repoId: 901 }
        : { kind: "absent" };
    };

    const batch = await ledgerTargetAlignment.runBatch(db, null, OPERATOR, { repoLookup: lookup });
    expect(batch.log).toMatchObject({ bound: 1, unbound: 1, binding_failed: 0, created: 2 });
    expect(calls).toEqual([170871484]);

    const todo = targetRow(db, targetOf(db, "pull_requests", "pr-todo")!);
    expect(todo).toMatchObject({ repo_owner: "btspoony", repo_name: "todo-bots", repo_id: 901 });
    const nexus = targetRow(db, targetOf(db, "pull_requests", "pr-nexus")!);
    expect(nexus).toMatchObject({ repo_owner: "42ch-dev", repo_name: "nexus", repo_id: null });

    // A second mismatched row for the now-bound repository adopts that target
    // and asks GitHub nothing: the claim is already there.
    seedPr(db, "pr-todo-2", "btspoony", "todo-bots", "target-harness", 8);
    const again: number[] = [];
    const second = await ledgerTargetAlignment.runBatch(db, null, OPERATOR, {
      repoLookup: async (...args) => {
        again.push(args[1]);
        return { kind: "failed" };
      },
    });
    expect(second).toMatchObject({ processed: 1, done: true });
    expect(second.log).toMatchObject({ groups: 1, bound: 0, binding_failed: 0 });
    expect(again).toEqual([]);
    expect(targetOf(db, "pull_requests", "pr-todo-2")).toBe(todo.id);
  });

  test("a GitHub failure leaves the target unbound without failing the batch", async () => {
    const db = fixture();
    seedPr(db, "pr-todo", "btspoony", "todo-bots", "target-harness", 5);

    const batch = await ledgerTargetAlignment.runBatch(db, null, OPERATOR, {
      repoLookup: async () => ({ kind: "failed" }),
    });
    expect(batch).toMatchObject({ processed: 1, done: true });
    expect(batch.log).toMatchObject({ created: 1, aligned: 1, binding_failed: 1, bound: 0 });
    const created = targetRow(db, targetOf(db, "pull_requests", "pr-todo")!);
    expect(created).toMatchObject({ repo_name: "todo-bots", repo_id: null });
    // The row moved: the failure is the binding's, not the alignment's.
    expect(await ledgerTargetAlignment.verify(db, { runStartedAt: null })).toMatchObject({
      misaligned_ledger_rows: 0,
    });
  });

  test("a PR the destination already holds is left alone and reported, never a failed batch", async () => {
    const db = fixture();
    // The inspector target already holds PR 42; the harness copy would violate
    // `(target_id, owner, repo, pr_number)`, so it is not moved and is reported.
    seedPr(db, "pr-dupe", "btspoony", "mstar-inspector", "target-harness", 42);
    db.raw
      .prepare(
        `INSERT INTO pull_requests
           (id, bot_id, owner, repo, pr_number, state, last_seen_at, target_id)
         VALUES ('pr-held', ?, 'btspoony', 'mstar-inspector', 42, 'open',
                 '2026-08-27T00:00:00.000Z', 'target-inspector')`,
      )
      .run(BOT);

    const batch = await ledgerTargetAlignment.runBatch(db, null, OPERATOR);
    expect(batch).toMatchObject({ processed: 0, done: true });
    expect(targetOf(db, "pull_requests", "pr-dupe")).toBe("target-harness");
    expect(targetOf(db, "pull_requests", "pr-held")).toBe("target-inspector");
    expect(await ledgerTargetAlignment.verify(db, { runStartedAt: null })).toMatchObject({
      misaligned_ledger_rows: 0,
      conflicting_ledger_rows: 1,
    });
  });

  test("the runner completes the item and verify reads zero mismatches", async () => {
    const db = fixture();
    seedPr(db, "pr-inspector", "btspoony", "mstar-inspector", "target-harness");
    seedPr(db, "pr-nexus", "42ch-dev", "nexus", "target-harness", 2);
    seedReview(db, "rv-nexus", "42ch-dev", "nexus", "target-harness");

    expect((await ledgerTargetAlignment.verify(db, { runStartedAt: null })).misaligned_ledger_rows).toBe(
      3,
    );

    for (let step = 0; step < 5; step += 1) {
      const outcome = await stepDataUpgrade(db, ledgerTargetAlignment, OPERATOR, RUN_START);
      expect(outcome.kind).toBe("ok");
    }
    const verified = await verifyDataUpgrade(
      db,
      ledgerTargetAlignment,
      OPERATOR,
      "2026-11-18T00:05:00.000Z",
    );
    expect(verified.kind).toBe("ok");
    if (verified.kind !== "ok") return;
    expect(verified.state.status).toBe("completed");
    expect(verified.checks).toEqual({
      misaligned_ledger_rows: 0,
      ambiguous_groups: 0,
      unattributable_groups: 0,
      conflicting_ledger_rows: 0,
    });
  });

  test("a batch stops at GROUPS_PER_BATCH groups and resumes from the cursor", async () => {
    const db = createMigratedTestD1();
    seedBot(db, BOT, 7001);
    seedBotWorkspace(db, BOT);
    seedTarget(db, BOT, { id: "target-harness", repoOwner: "btspoony", repoName: "mstar-harness" });
    for (let index = 0; index < 21; index += 1) {
      seedPr(db, `pr-${index}`, "acme", `repo-${String(index).padStart(2, "0")}`, "target-harness", index);
    }

    const first = await ledgerTargetAlignment.runBatch(db, null, OPERATOR);
    expect(first.processed).toBe(20);
    expect(first.done).toBe(false);
    expect(first.log).toMatchObject({ groups: 20 });

    const second = await ledgerTargetAlignment.runBatch(db, first.cursor, OPERATOR);
    expect(second).toMatchObject({ processed: 1, done: true });
    expect(second.log).toMatchObject({ groups: 1 });
    expect(await ledgerTargetAlignment.verify(db, { runStartedAt: null })).toMatchObject({
      misaligned_ledger_rows: 0,
    });
  });

  test("a group whose rows name different bots is left alone and counted", async () => {
    const db = fixture();
    seedBot(db, "bot-2", 7002);
    seedTarget(db, "bot-2", { id: "target-other", repoOwner: "acme", repoName: "elsewhere" });
    // One repository, two bots' rows, each on a target naming another
    // repository: no single tenant these rows belong to.
    seedPr(db, "pr-beta", "acme", "beta", "target-other", 6, "bot-2");
    seedReview(db, "rv-beta", "acme", "beta", "target-harness");

    expect(await ledgerTargetAlignment.preflight(db)).toMatchObject({
      groups: 1,
      unattributable_groups: 1,
    });
    const batch = await ledgerTargetAlignment.runBatch(db, null, OPERATOR);
    expect(batch).toMatchObject({ processed: 0, done: true });
    expect(batch.log).toMatchObject({ unattributable: 1, aligned: 0 });
    expect(targetOf(db, "pull_requests", "pr-beta")).toBe("target-other");
    expect(targetOf(db, "reviews", "rv-beta")).toBe("target-harness");
  });

  test("a completed item refuses a step and a reset re-walks the worklist", async () => {
    const db = fixture();
    seedPr(db, "pr-inspector", "btspoony", "mstar-inspector", "target-harness");
    expect((await stepDataUpgrade(db, ledgerTargetAlignment, OPERATOR, RUN_START)).kind).toBe("ok");
    const done = await verifyDataUpgrade(db, ledgerTargetAlignment, OPERATOR, RUN_START);
    expect(done.kind === "ok" && done.state.status).toBe("completed");

    expect((await stepDataUpgrade(db, ledgerTargetAlignment, OPERATOR, RUN_START)).kind).toBe(
      "refused",
    );
    expect((await resetDataUpgrade(db, ledgerTargetAlignment, OPERATOR, RUN_START)).kind).toBe("ok");

    // A row planted after the run is picked up by the next one: the worklist is
    // the mismatch itself, not a snapshot of it.
    seedPr(db, "pr-late", "btspoony", "mstar-inspector", "target-harness", 9);
    expect((await stepDataUpgrade(db, ledgerTargetAlignment, OPERATOR, RUN_START)).kind).toBe("ok");
    expect(targetOf(db, "pull_requests", "pr-late")).toBe("target-inspector");
  });
});
