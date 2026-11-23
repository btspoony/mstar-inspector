import { createMigratedTestD1, execMigrationScript } from "../tests/store/helpers";
import { readLineBatchState } from "../src/store/finding-lifecycle";
import { BIND_UNBOUND_THREADS_MAX_ENTRIES } from "../src/pipeline/review-attempt-execution";

// note: Run from the repository root: bun scripts/bench-thread-lookups.ts
// Times one review round's review_threads reads for a PR with 25 live findings
// (recheck association, thread binding, discussion capture, the per-intent
// supersede write, and the line-batch state read) with and without the
// finding/publication indexes, over a growing thread history. The finding
// statements are the store's own SQL text; the supersede write omits its
// publication-lease guard, which reads review_publications by primary key.
const warmups = 5;
const runs = 31;
const findings = 25;
const marks = (n: number) => Array.from({ length: n }, () => "?").join(",");
const statements = [
  `SELECT id, finding_row_id FROM review_threads
   WHERE finding_row_id IN (${marks(findings)}) AND superseded_by_publication_id IS NULL`,
  `SELECT id, intent_json FROM review_threads
   WHERE finding_row_id IN (${marks(findings)}) AND thread_id IS NULL
     AND superseded_by_publication_id IS NULL
   ORDER BY updated_ms, id
   LIMIT ?`,
  `SELECT id, thread_id FROM review_threads
   WHERE finding_row_id IN (${marks(findings)}) AND thread_id IS NOT NULL
     AND superseded_by_publication_id IS NULL`,
];
const supersede = `UPDATE review_threads
   SET superseded_by_publication_id = ?, updated_ms = ?
   WHERE finding_row_id = ? AND publication_id <> ? AND superseded_by_publication_id IS NULL`;

function median(values: number[]): number {
  return values.sort((a, b) => a - b)[Math.floor(values.length / 2)]!;
}

console.log(`bun:sqlite; one review round over ${findings} live findings; median of ${runs} runs; times in ms`);
console.log("threads\tbefore ms\tafter ms\tspeedup\tresults compared");
for (const threads of [5_000, 20_000, 80_000]) {
  const handle = createMigratedTestD1();
  const db = handle.raw;
  execMigrationScript(db, "PRAGMA foreign_keys = OFF;");
  const insert = db.prepare(`INSERT INTO review_threads
    (id, finding_row_id, publication_id, bot_id, installation_id, owner, repo, pr_number, original_sha,
     round, intent_json, review_id, thread_id, resolution_state, superseded_by_publication_id, created_ms, updated_ms)
    VALUES (?, ?, ?, 'bot', 1, 'acme', 'widgets', ?, 'sha', 1, '{}', ?, ?, 'pending', ?, 1, ?)`);
  db.run("BEGIN");
  for (let i = 0; i < threads; i++) {
    // note: Two threads per finding; every other finding's older thread was superseded by a re-post.
    const finding = Math.floor(i / 2);
    const superseded = i % 4 === 0 ? `pub-${Math.floor(i / 8)}-next` : null;
    insert.run(`thread-${i}`, `finding-${finding}`, `pub-${Math.floor(i / 8)}`, Math.floor(i / 50),
      i % 3 === 0 ? null : i, i % 3 === 0 ? null : `T_${i}`, superseded, i);
  }
  db.run("COMMIT");
  const ids = Array.from({ length: findings }, (_, k) => `finding-${Math.floor(threads / 2) - 1 - k}`);
  const publication = `pub-${Math.floor((threads - 1) / 8)}`;

  async function measure(): Promise<{ ms: number; seen: unknown[] }> {
    let seen: unknown[] = [];
    const once = async (normalize = false) => {
      seen = [];
      for (const sql of statements) {
        const stmt = handle.prepare(sql);
        const bound = sql.includes("LIMIT ?") ? stmt.bind(...ids, BIND_UNBOUND_THREADS_MAX_ENTRIES) : stmt.bind(...ids);
        const results = (await bound.all<{ id: string }>()).results;
        // note: Only the binding read orders its rows; the untimed final pass sorts the others to compare them as sets.
        if (normalize && !sql.includes("ORDER BY")) results.sort((a, b) => a.id.localeCompare(b.id));
        seen.push(...results);
      }
      db.run("SAVEPOINT round");
      for (const id of ids) seen.push((await handle.prepare(supersede).bind("pub-new", 2, id, "pub-new").run()).meta.changes);
      db.run("ROLLBACK TO round; RELEASE round");
      const state = await readLineBatchState(handle, publication);
      seen.push(state);
    };
    for (let i = 0; i < warmups; i++) await once();
    const times: number[] = [];
    for (let i = 0; i < runs; i++) {
      const start = performance.now();
      await once();
      times.push(performance.now() - start);
    }
    await once(true);
    return { ms: median(times), seen };
  }

  db.prepare(`INSERT INTO review_publications
    (id, bot_id, installation_id, owner, repo, pr_number, head_sha, kind, phase, payload_json, created_ms, updated_ms)
    VALUES (?, 'bot', 1, 'acme', 'widgets', 1, 'sha', 'review', 'applied', '{}', 1, 1)`).run(publication);
  const after = await measure();
  execMigrationScript(db, "DROP INDEX idx_thread_live_finding; DROP INDEX idx_thread_publication;");
  const before = await measure();
  if (JSON.stringify(before.seen) !== JSON.stringify(after.seen)) throw new Error("results changed with the indexes");
  console.log(`${threads}\t${before.ms.toFixed(2)}\t${after.ms.toFixed(3)}\t${(before.ms / after.ms).toFixed(0)}x\t${after.seen.length}`);
}
