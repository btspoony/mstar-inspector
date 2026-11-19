/**
 * The repository id claim item.
 *
 * A target can name a repository and still have no `repo_id`: the shape
 * `repo-backfill` leaves when it merges the 0067 leftover target, and the one
 * the dashboard reads as 待安装. This item is the explicit repair — it never
 * creates or re-points anything, only asks GitHub for the id.
 *
 * What is pinned:
 *
 *   - preflight counts only live, named targets without an id;
 *   - a live installation binds the id the lookup answers with;
 *   - no live installation leaves the id NULL and counts unbound, without
 *     failing;
 *   - a second run visits nothing;
 *   - an id already set is never visited.
 */
import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, seedBot, seedTarget, type TestD1 } from "../store/helpers";
import { repoIdClaim } from "../../src/admin/data-upgrades/repo-id-claim";
import { DATA_UPGRADES, type RepoLookup } from "../../src/admin/data-upgrades";

const BOT = "bot-1";
const OPERATOR = "Support-Bot";

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

const lookupFound = (repoId: number): RepoLookup => async () => ({ kind: "found", repoId });
const lookupAbsent: RepoLookup = async () => ({ kind: "absent" });

/**
 * A target in the shape this item exists for: it names a repository and carries
 * no `repo_id`. `seedTarget` always writes a hashed id, so this fixture writes
 * the NULL itself rather than widening that helper for one item.
 */
function seedUnclaimedTarget(db: TestD1, botId: string, owner: string, repo: string): void {
  db.raw
    .prepare(
      `INSERT INTO review_targets
         (id, workspace_id, bot_id, name, repo_id, repo_owner, repo_name,
          check_min_score, created_by, created_at, updated_at)
       VALUES (?, 'default', ?, ?, NULL, ?, ?, 0, 'fixture', datetime('now'), datetime('now'))`,
    )
    .run(crypto.randomUUID(), botId, `${owner}/${repo}`, owner, repo);
}

function repoIdOf(db: TestD1, owner: string, repo: string): number | null {
  const row = db.raw
    .prepare(
      "SELECT repo_id FROM review_targets WHERE repo_owner = ? AND repo_name = ? AND deleted_at IS NULL",
    )
    .get(owner, repo) as { repo_id: number | null } | undefined;
  return row?.repo_id ?? null;
}

describe("repo-id-claim", () => {
  test("is registered after the items that create targets", () => {
    expect(DATA_UPGRADES.map((item) => item.id)).toEqual([
      "repo-backfill",
      "orphan-ledger-attribution",
      "ledger-target-alignment",
      "repo-id-claim",
    ]);
    expect(repoIdClaim.requiresDowntime).toBe(false);
  });

  test("binds the id a live installation answers with, then visits nothing", async () => {
    const db = createMigratedTestD1();
    seedBot(db, BOT, 42);
    seedBotWorkspace(db, BOT);
    seedInstallation(db, BOT, 1234, "acme");
    seedUnclaimedTarget(db, BOT, "acme", "widget");

    expect((await repoIdClaim.preflight(db)).unclaimed_targets).toBe(1);

    const first = await repoIdClaim.runBatch(db, null, OPERATOR, { repoLookup: lookupFound(777) });
    expect(first.processed).toBe(1);
    expect(first.done).toBe(true);
    expect(repoIdOf(db, "acme", "widget")).toBe(777);

    expect((await repoIdClaim.preflight(db)).unclaimed_targets).toBe(0);
    const second = await repoIdClaim.runBatch(db, null, OPERATOR, { repoLookup: lookupFound(777) });
    expect(second.processed).toBe(0);
  });

  test("a removed installation leaves the id unclaimed without failing", async () => {
    const db = createMigratedTestD1();
    seedBot(db, BOT, 42);
    seedBotWorkspace(db, BOT);
    seedInstallation(db, BOT, 1234, "acme", "2026-09-01T00:00:00.000Z");
    seedUnclaimedTarget(db, BOT, "acme", "widget");

    const batch = await repoIdClaim.runBatch(db, null, OPERATOR, { repoLookup: lookupFound(777) });
    expect(batch.processed).toBe(0);
    expect(repoIdOf(db, "acme", "widget")).toBeNull();
  });

  test("a repository the installation does not grant stays unclaimed", async () => {
    const db = createMigratedTestD1();
    seedBot(db, BOT, 42);
    seedBotWorkspace(db, BOT);
    seedInstallation(db, BOT, 1234, "acme");
    seedUnclaimedTarget(db, BOT, "acme", "widget");

    const batch = await repoIdClaim.runBatch(db, null, OPERATOR, { repoLookup: lookupAbsent });
    expect(batch.processed).toBe(0);
    expect(repoIdOf(db, "acme", "widget")).toBeNull();
  });

  test("a target that already carries an id is never visited", async () => {
    const db = createMigratedTestD1();
    seedBot(db, BOT, 42);
    seedBotWorkspace(db, BOT);
    seedTarget(db, BOT, { repoOwner: "acme", repoName: "widget", repoId: 42 });

    expect((await repoIdClaim.preflight(db)).unclaimed_targets).toBe(0);
    let called = 0;
    const lookup: RepoLookup = async () => {
      called += 1;
      return { kind: "found", repoId: 999 };
    };
    const batch = await repoIdClaim.runBatch(db, null, OPERATOR, { repoLookup: lookup });
    expect(batch.processed).toBe(0);
    expect(called).toBe(0);
    expect(repoIdOf(db, "acme", "widget")).toBe(42);
  });
});
