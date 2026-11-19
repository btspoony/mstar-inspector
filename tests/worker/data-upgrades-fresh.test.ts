/**
 * Every registered data upgrade on a fresh deployment.
 *
 * A team that deploys today has none of the historical shapes these items
 * exist for: no 0067 leftover target, no NULL-target ledger row, no row pinned
 * to another repository, no target awaiting its id. The console must still show
 * all four (so the operator can see the list is complete), each preflight must
 * read zero, and a click must leave the database untouched.
 *
 * This is the contract that keeps a "run" button from being a hazard on an
 * empty deployment: no maintenance window, no created target, no written row.
 */
import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import { DATA_UPGRADES } from "../../src/admin/data-upgrades";

/** Every table an upgrade can touch. */
const TOUCHED = ["review_targets", "pull_requests", "reviews", "review_findings", "review_failures"];

function snapshot(db: TestD1): Record<string, number> {
  const out: Record<string, number> = {};
  for (const table of TOUCHED) {
    const row = db.raw.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number };
    out[table] = row.n;
  }
  const live = db.raw
    .prepare("SELECT COUNT(*) AS n FROM review_targets WHERE deleted_at IS NULL")
    .get() as { n: number };
  out.live_targets = live.n;
  return out;
}

describe("data upgrades on a fresh deployment", () => {
  test("all four are registered in run order", () => {
    expect(DATA_UPGRADES.map((item) => `${item.order}:${item.id}`)).toEqual([
      "10:repo-backfill",
      "20:orphan-ledger-attribution",
      "21:ledger-target-alignment",
      "22:repo-id-claim",
    ]);
    expect(DATA_UPGRADES.filter((item) => item.requiresDowntime).map((item) => item.id)).toEqual([
      "repo-backfill",
    ]);
  });

  test("every preflight reads zero on an empty database", async () => {
    const db = createMigratedTestD1();
    for (const item of DATA_UPGRADES) {
      const counts = await item.preflight(db);
      expect(Object.values(counts).every((count) => count === 0), `${item.id}: ${JSON.stringify(counts)}`).toBe(true);
    }
  });

  test("a run over the empty worklist writes nothing and finishes", async () => {
    const db = createMigratedTestD1();
    const before = snapshot(db);
    for (const item of DATA_UPGRADES) {
      const batch = await item.runBatch(db, null, "operator", undefined);
      expect(batch.processed, item.id).toBe(0);
      expect(batch.done, item.id).toBe(true);
    }
    expect(snapshot(db)).toEqual(before);
  });

  test("the id claim is the only item that would bind, and it binds nothing here", async () => {
    const db = createMigratedTestD1();
    const claim = DATA_UPGRADES.find((item) => item.id === "repo-id-claim")!;
    let called = 0;
    const batch = await claim.runBatch(db, null, "operator", {
      repoLookup: async () => {
        called += 1;
        return { kind: "absent" };
      },
    });
    expect(batch.processed).toBe(0);
    expect(called).toBe(0);
  });
});
