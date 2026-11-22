import { createMigratedTestD1, execMigrationScript } from "../tests/store/helpers";
import { RECONCILE_DEFAULTS } from "../src/contracts/reconcile-settings";
import { listCheckReconcileBatch } from "../src/store/review-checks";
import { clearConcludedCheckOwed } from "../src/pipeline/review-attempt";

// note: Run from the repository root: bun scripts/bench-check-owed.ts
// Times the per-minute Check reconcile's two owed-mark statements (the due
// batch selection and the concluded-mark clear) with and without
// idx_review_launches_check_owed, over a growing review_launches history.
// The open Checks are in backoff; the owed marks are due, so the owed branch
// selects the marked Checks and both arms must return the same attempt ids.
const warmups = 5;
const runs = 31;
const waiting = 50;
const marked = 10;
const now = 1_800_000_000_000;

function median(values: number[]): number {
  return values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
}

console.log(`bun:sqlite; ${waiting} nonterminal Checks in backoff, ${marked} owed marks due; median of ${runs} runs; times in ms`);
console.log("attempts\tbefore ms\tafter ms\tspeedup\tbatch rows");
for (const attempts of [5_000, 20_000, 80_000]) {
  const handle = createMigratedTestD1();
  const db = handle.raw;
  execMigrationScript(db, "PRAGMA foreign_keys = OFF;");
  const check = db.prepare(`INSERT INTO review_checks
    (id, bot_id, github_app_id, installation_id, owner, repo, pr_number, head_sha,
     triggered_by, action, attempt_key, generation, external_id, create_state,
     execution_deadline_ms, desired, observed, recovery_state, attempts, next_attempt_ms,
     terminal_ms, created_ms, updated_ms)
    VALUES (?, 'bot', 1, 1, 'acme', 'widgets', ?, 'sha', 'u', 'review', ?, 1, ?, 'not-sent',
            ?, 'in_progress', 'unknown', 'pending', 1, ?, ?, ?, ?)`);
  const launch = db.prepare(`INSERT INTO review_launches
    (attempt_id, attempt_key, attempt_generation, state, claimed_at_ms, check_key, check_generation, check_owed_ms)
    VALUES (?, ?, 1, 'provisioned', ?, ?, ?, ?)`);
  db.exec("BEGIN");
  for (let i = 0; i < attempts; i++) {
    const open = i >= attempts - waiting;
    const key = `key-${i}`;
    check.run(`check-${i}`, i, key, `ext-${i}`, now + 60_000, open ? now + 60_000 : null,
      open ? null : now - 1, now - 1000, now - 1000);
    const owed = i >= attempts - marked;
    launch.run(`attempt-${i}`, key, now - 1000, owed ? key : null, owed ? 1 : null, owed ? now - 1 : null);
  }
  db.exec("COMMIT");

  async function measure(): Promise<{ ms: number; ids: string[] }> {
    let ids: string[] = [];
    for (let i = 0; i < warmups; i++) await clearConcludedCheckOwed(handle);
    const times: number[] = [];
    for (let i = 0; i < runs; i++) {
      const start = performance.now();
      ids = (await listCheckReconcileBatch(handle, now, RECONCILE_DEFAULTS.checkMaxAttempts, RECONCILE_DEFAULTS.checkSelectLimit)).map((row) => row.id);
      await clearConcludedCheckOwed(handle);
      times.push(performance.now() - start);
    }
    return { ms: median(times), ids };
  }

  const after = await measure();
  execMigrationScript(db, "DROP INDEX idx_review_launches_check_owed;");
  const before = await measure();
  if (after.ids.length !== marked || JSON.stringify(before.ids) !== JSON.stringify(after.ids)) throw new Error("batch selection changed with the index");
  console.log(`${attempts}\t${before.ms.toFixed(2)}\t${after.ms.toFixed(3)}\t${(before.ms / after.ms).toFixed(0)}x\t${after.ids.length}`);
}
