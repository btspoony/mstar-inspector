import { createMigratedTestD1, execMigrationScript } from "../tests/store/helpers";
import { RECONCILE_DEFAULTS } from "../src/contracts/reconcile-settings";
import { listLineBatchRecovery } from "../src/store/finding-lifecycle";

// note: Run from the repository root: bun scripts/bench-line-batch-recovery.ts
// Times the 15-minute lifecycle reconcile's line-batch selection: before is the
// previous statement (EXISTS probe per applied publication) without
// idx_thread_uncaptured, after is the current statement with it; both arms time
// the raw statement, and listLineBatchRecovery (untimed) must return the same ids. Each
// publication is applied and owns three threads; only the newest few still
// hold an uncaptured thread, which is the set both arms must return. The
// "+publication index" rows add a full-history (publication_id, review_id)
// index (not in this branch's migrations; #359 proposes it) to show it does not
// displace the partial one.
const warmups = 5;
const runs = 31;
const pending = 10;
const now = 1_800_000_000_000;
const payload = JSON.stringify({ pad: "x".repeat(1_500) });
const limit = RECONCILE_DEFAULTS.lifecycleSelectLimit;
const BEFORE = `SELECT * FROM review_publications p
  WHERE p.phase = 'applied'
    AND p.line_unresolvable_ms IS NULL
    AND (p.lease_until_ms IS NULL OR p.lease_until_ms <= ?)
    AND EXISTS (SELECT 1 FROM review_threads t WHERE t.publication_id = p.id AND t.review_id IS NULL)
  ORDER BY COALESCE(p.applied_ms, p.updated_ms), p.id
  LIMIT ?`;
const AFTER = BEFORE.replace(
  "AND EXISTS (SELECT 1 FROM review_threads t WHERE t.publication_id = p.id AND t.review_id IS NULL)",
  "AND p.id IN (SELECT t.publication_id FROM review_threads t WHERE t.review_id IS NULL)",
);

function median(values: number[]): number {
  return values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
}

async function time(fn: () => Promise<string[]>): Promise<{ ms: number; ids: string[] }> {
  for (let i = 0; i < warmups; i++) await fn();
  const times: number[] = [];
  let ids: string[] = [];
  for (let i = 0; i < runs; i++) {
    const start = performance.now();
    ids = await fn();
    times.push(performance.now() - start);
  }
  return { ms: median(times), ids };
}

console.log(`bun:sqlite; 3 threads per applied publication, ${pending} with an uncaptured thread, ~1.5 KB payloads; median of ${runs} runs; times in ms`);
console.log("publications\tbefore ms\tafter ms\tspeedup\trows");
for (const withPublicationIndex of [false, true]) {
  for (const publications of [5_000, 20_000, 80_000]) {
    const handle = createMigratedTestD1();
    const db = handle.raw;
    execMigrationScript(db, "PRAGMA foreign_keys = OFF;");
    if (withPublicationIndex) db.exec("CREATE INDEX IF NOT EXISTS idx_thread_publication ON review_threads (publication_id, review_id)");
    const publication = db.prepare(`INSERT INTO review_publications
      (id, bot_id, installation_id, owner, repo, pr_number, head_sha, kind, phase, payload_json, recovery_state, created_ms, updated_ms, applied_ms)
      VALUES (?, 'bot', 1, 'acme', 'widgets', ?, ?, 'review', 'applied', ?, 'done', ?, ?, ?)`);
    const thread = db.prepare(`INSERT INTO review_threads
      (id, finding_row_id, publication_id, bot_id, installation_id, owner, repo, pr_number, original_sha, round, intent_json, resolution_state, created_ms, updated_ms, review_id)
      VALUES (?, ?, ?, 'bot', 1, 'acme', 'widgets', ?, 'sha', 1, '{}', 'resolved', ?, ?, ?)`);
    db.exec("BEGIN");
    for (let i = 0; i < publications; i++) {
      const at = now - (publications - i) * 1_000;
      publication.run(`pub-${i}`, i, `sha-${i}`, payload, at, at, at);
      const open = i >= publications - pending;
      for (let k = 0; k < 3; k++) thread.run(`thread-${i}-${k}`, `finding-${i}-${k}`, `pub-${i}`, i, at, at, open && k === 0 ? null : `review-${i}`);
    }
    db.exec("COMMIT");

    const production = (await listLineBatchRecovery(handle, now, limit)).map((row) => row.id);
    const after = await time(async () => (await handle.prepare(AFTER).bind(now, limit).all<{ id: string }>()).results.map((row) => row.id));
    execMigrationScript(db, "DROP INDEX idx_thread_uncaptured;");
    const before = await time(async () => (await handle.prepare(BEFORE).bind(now, limit).all<{ id: string }>()).results.map((row) => row.id));
    if (after.ids.length !== pending || JSON.stringify(before.ids) !== JSON.stringify(after.ids) || JSON.stringify(production) !== JSON.stringify(after.ids)) throw new Error("line-batch selection changed");
    const label = `${publications}${withPublicationIndex ? " +publication index" : ""}`;
    console.log(`${label}\t${before.ms.toFixed(2)}\t${after.ms.toFixed(3)}\t${(before.ms / after.ms).toFixed(0)}x\t${after.ids.length}`);
  }
}
