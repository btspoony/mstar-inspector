import { describe, expect, test } from "bun:test";
import { createMigratedTestD1, type TestD1 } from "../store/helpers";
import { DATA_UPGRADES } from "../../src/admin/data-upgrades";
import { getMaintenanceMode } from "../../src/dashboard/runtime-config-store";

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
  test("all five are registered in run order", () => {
    expect(DATA_UPGRADES.map((item) => `${item.order}:${item.id}`)).toEqual([
      "10:repo-backfill",
      "20:orphan-ledger-attribution",
      "21:ledger-target-alignment",
      "22:repo-id-claim",
      "30:usage-bot-attribution",
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

  test("an empty run claims no state row and touches no other table", async () => {
    const db = createMigratedTestD1();
    const before = snapshot(db);
    for (const item of DATA_UPGRADES) {
      const batch = await item.runBatch(db, null, "operator", undefined);
      expect(batch.processed, item.id).toBe(0);
      expect(batch.done, item.id).toBe(true);
    }
    const states = db.raw.prepare("SELECT COUNT(*) AS n FROM operator_data_upgrades").get() as { n: number };
    expect(states.n).toBe(0);
    expect((await getMaintenanceMode(db)).enabled).toBe(false);
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
