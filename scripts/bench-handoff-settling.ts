import { createMigratedTestD1, execMigrationScript } from "../tests/store/helpers";
import { listIncompleteSettlements } from "../src/store/review-route-store";
import { HANDOFF_RECOVERY_AFTER_MS, ROUTE_RECOVERY_LIMIT } from "../src/pipeline/route-reconcile";

// note: Run from the repository root: bun scripts/bench-handoff-settling.ts
// Times the 15-minute route reconcile's incomplete-settlement selection with
// and without idx_review_attempt_handoffs_settling, over a growing delivery
// history. Almost every handoff is settled; a few are live (no settlement
// started yet) and a few started settling and never completed, which is the
// set both arms must return.
const warmups = 5;
const runs = 31;
const live = 30;
const stuck = 10;
const now = 1_800_000_000_000;
const payload = JSON.stringify({ pad: "x".repeat(1_500) });

function median(values: number[]): number {
  return values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
}

console.log(`bun:sqlite; ${stuck} stuck settlements, ${live} live handoffs, ~1.5 KB payloads; median of ${runs} runs; times in ms`);
console.log("handoffs\tbefore ms\tafter ms\tspeedup\trows");
for (const handoffs of [5_000, 20_000, 80_000]) {
  const handle = createMigratedTestD1();
  const db = handle.raw;
  const insert = db.prepare(`INSERT INTO review_attempt_handoffs
    (delivery_key, attempt_id, payload_json, state, settled_ms, settling_ms, created_ms, updated_ms)
    VALUES (?, ?, ?, 'created', ?, ?, ?, ?)`);
  const old = now - 2 * HANDOFF_RECOVERY_AFTER_MS;
  db.run("BEGIN");
  for (let i = 0; i < handoffs; i++) {
    const isStuck = i >= handoffs - stuck;
    const isLive = !isStuck && i >= handoffs - stuck - live;
    insert.run(`delivery-${i}`, `attempt-${i}`, payload, isStuck || isLive ? null : old + 1, isLive ? null : old, old, old);
  }
  db.run("COMMIT");

  const input = { settlingBeforeMs: now - HANDOFF_RECOVERY_AFTER_MS, limit: ROUTE_RECOVERY_LIMIT };
  async function measure(): Promise<{ ms: number; keys: string[] }> {
    let keys: string[] = [];
    for (let i = 0; i < warmups; i++) await listIncompleteSettlements(handle, input);
    const times: number[] = [];
    for (let i = 0; i < runs; i++) {
      const start = performance.now();
      keys = (await listIncompleteSettlements(handle, input)).map((row) => row.deliveryKey);
      times.push(performance.now() - start);
    }
    return { ms: median(times), keys: keys.sort() };
  }

  const after = await measure();
  execMigrationScript(db, "DROP INDEX idx_review_attempt_handoffs_settling;");
  const before = await measure();
  if (after.keys.length !== stuck || JSON.stringify(before.keys) !== JSON.stringify(after.keys)) throw new Error("settlement selection changed with the index");
  console.log(`${handoffs}\t${before.ms.toFixed(2)}\t${after.ms.toFixed(3)}\t${(before.ms / after.ms).toFixed(0)}x\t${after.keys.length}`);
}
