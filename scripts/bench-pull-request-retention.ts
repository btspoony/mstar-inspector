import { createMigratedTestD1, execMigrationScript, type TestD1 } from "../tests/store/helpers";
import { createReviewBotsStore } from "../src/dashboard/apps-store";

// note: Run from the repository root: bun scripts/bench-pull-request-retention.ts
// Times the 15-minute sweep's terminal pull_requests retention delete
// (sweepTerminalPullRequests, the store's own statement) with and without
// idx_pull_requests_terminal_seen over a growing ledger. 15% of rows are open,
// the rest closed/merged within the window; `expired` terminal rows past the
// window are spread through the ledger. Each run deletes inside a transaction
// that is rolled back untimed, so every run sees the same rows; both arms must
// delete the same number of rows, and the same ids whenever all due rows fit
// under the per-run cap.
const warmups = 5;
const runs = 41;
const DAY_MS = 86_400_000;

// The absent-row defaults of the pull-request retention sweep settings.
const RETENTION = { days: 90, cap: 500 };

function sqliteTime(ms: number): string {
  return new Date(ms).toISOString().replace("T", " ").slice(0, 19);
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.ceil(p * sorted.length) - 1)]!;
}

function seed(handle: TestD1, rows: number, expired: number): Set<string> {
  const db = handle.raw;
  execMigrationScript(db, "PRAGMA foreign_keys = OFF;");
  const insert = db.prepare(`INSERT INTO pull_requests
    (id, bot_id, owner, repo, pr_number, title, state, head_sha, first_seen_at, last_seen_at, target_id)
    VALUES (?, 'bot', 'acme', ?, ?, ?, ?, ?, ?, ?, 'target')`);
  const now = Date.now();
  const stride = Math.floor(rows / expired);
  const due = new Set<string>();
  db.exec("BEGIN");
  for (let i = 0; i < rows; i++) {
    const isDue = i % stride === 0 && i / stride < expired;
    if (isDue) due.add(`pr-${i}`);
    const state = isDue ? (i % 2 ? "closed" : "merged") : i % 7 === 0 ? "open" : i % 2 ? "closed" : "merged";
    const ageDays = isDue ? RETENTION.days + 1 + (i % 30) : (i % (RETENTION.days - 1));
    const seen = sqliteTime(now - ageDays * DAY_MS - (i % 86_400) * 1000);
    insert.run(`pr-${i}`, `repo-${i % 40}`, i, `Fix the widget rendering path number ${i}`, state, `sha-${i}`, seen, seen);
  }
  db.exec("COMMIT");
  return due;
}

async function measure(handle: TestD1): Promise<{ p50: number; p95: number; calls: number; deleted: string[] }> {
  let calls = 0;
  const counted: TestD1 = { ...handle, prepare: (sql: string) => (calls++, handle.prepare(sql)) };
  const store = createReviewBotsStore(counted);
  const ids = () => new Set((handle.raw.query("SELECT id FROM pull_requests").all() as Array<{ id: string }>).map((r) => r.id));
  const all = ids();
  let deleted: string[] = [];
  const times: number[] = [];
  for (let i = 0; i < warmups + runs; i++) {
    handle.raw.exec("BEGIN");
    calls = 0;
    const start = performance.now();
    await store.sweepTerminalPullRequests(RETENTION);
    const ms = performance.now() - start;
    if (i === 0) {
      const left = ids();
      deleted = [...all].filter((id) => !left.has(id)).sort();
    }
    handle.raw.exec("ROLLBACK");
    if (i >= warmups) times.push(ms);
  }
  times.sort((a, b) => a - b);
  return { p50: percentile(times, 0.5), p95: percentile(times, 0.95), calls, deleted };
}

console.log(`bun:sqlite; 15% open, terminal rows within ${RETENTION.days} days plus the expired ones; cap ${RETENTION.cap}; ${runs} runs after ${warmups} warmups; times in ms`);
console.log("rows\texpired\tcalls before/after\tbefore p50\tbefore p95\tafter p50\tafter p95\tp50 speedup\tdeleted");
for (const expired of [10, 2_000]) {
  for (const rows of [5_000, 20_000, 80_000]) {
    const handle = createMigratedTestD1();
    const dueIds = seed(handle, rows, expired);
    const indexed = () => (handle.raw.query("SELECT name FROM sqlite_master WHERE name = 'idx_pull_requests_terminal_seen'").all()).length;
    if (indexed() !== 1) throw new Error("idx_pull_requests_terminal_seen missing before the after arm");
    const after = await measure(handle);
    execMigrationScript(handle.raw, "DROP INDEX idx_pull_requests_terminal_seen;");
    if (indexed() !== 0) throw new Error("idx_pull_requests_terminal_seen still present before the before arm");
    const before = await measure(handle);
    const due = Math.min(expired, RETENTION.cap);
    if (before.deleted.length !== due || after.deleted.length !== due) throw new Error("deleted count differs from the due rows");
    if (![...before.deleted, ...after.deleted].every((id) => dueIds.has(id))) throw new Error("a deleted row was not due");
    const same = JSON.stringify(before.deleted) === JSON.stringify(after.deleted);
    if (expired <= RETENTION.cap && !same) throw new Error("deleted ids differ with the index");
    console.log(`${rows}\t${expired}\t${before.calls}/${after.calls}\t${before.p50.toFixed(3)}\t${before.p95.toFixed(3)}\t${after.p50.toFixed(3)}\t${after.p95.toFixed(3)}\t${(before.p50 / after.p50).toFixed(1)}x\t${after.deleted.length}${same ? " (same ids)" : " (same count)"}`);
  }
}
