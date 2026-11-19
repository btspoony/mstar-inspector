import { deepStrictEqual } from "node:assert";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { createReviewBotsStore } from "../src/dashboard/apps-store";
import { createMigratedTestD1, execMigrationScript } from "../tests/store/helpers";

// Run from the repository root: bun scripts/bench-delivery-health.ts [baseline-ref]
// Main immediately before the delivery-health rewrite; stable after this PR merges.
const baselineRef = process.argv[2] ?? "3c9e829e54401a7d45415417dd3ee8f0908aef69";
const baselineSha = execFileSync("git", ["rev-parse", "--verify", baselineRef], {
  encoding: "utf8",
}).trim();
const baseline = execFileSync("git", ["show", `${baselineSha}:src/dashboard/apps-store.ts`], {
  encoding: "utf8",
});
const ids = Array.from({ length: 10 }, (_, i) => `bench-app-${i}`);
const warmups = 10;
const runs = 41;
const migration = readFileSync("migrations/0080_delivery_health_indexes.sql", "utf8");

function baselineQueries(source: string): string[] {
  const start = source.indexOf("async function deliverySummaries(");
  const end = source.indexOf("const byApp:", start);
  const body = source.slice(start, end);
  const tier = source.match(/const DELIVERY_VERDICT_TIER_SQL = `([^`]+)`;/)?.[1];
  const templates = [...body.matchAll(/\.prepare\(\s*`([\s\S]*?)`/g)].map((match) => match[1]!);
  if (start < 0 || end < 0 || !tier || templates.length !== 2 || !body.includes("ROW_NUMBER()")) {
    throw new Error("Baseline must contain the original deliverySummaries window query. Run bun scripts/bench-delivery-health.ts <pre-fix-git-ref>.");
  }
  return templates.map((sql) => {
    const expanded = sql.replaceAll("${DELIVERY_VERDICT_TIER_SQL}", tier)
      .replaceAll("${placeholders}", ids.map(() => "?").join(", "));
    if (expanded.includes("${")) throw new Error("Unsupported baseline SQL interpolation");
    return expanded;
  });
}

const before = baselineQueries(baseline);
console.log(`baseline=${baselineSha}; bun:sqlite; apps=${ids.length}; warmups=${warmups}; median of ${runs} runs`);
console.log("Both health statements; 30 recent deliveries/app, growing older history; times in ms");
console.log("rows\tbefore ms\tafter ms\tspeedup");
for (const rows of [3000, 15000, 60000]) {
  const handle = createMigratedTestD1();
  const db = handle.raw;
  const foreignKeys = db.prepare<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()!.foreign_keys;
  function assertHealthIndexes(present: boolean) {
    const names = new Set(db.prepare<{ name: string }, []>("PRAGMA index_list('webhook_deliveries')").all()
      .map((index) => index.name));
    for (const index of ["idx_webhook_deliveries_bot_health", "idx_webhook_deliveries_bot_outcome_created"]) {
      deepStrictEqual(names.has(index), present, `${index} must be ${present ? "present" : "absent"}`);
    }
  }
  try {
    execMigrationScript(db, `PRAGMA foreign_keys = OFF;
      DROP INDEX idx_webhook_deliveries_bot_health;
      DROP INDEX idx_webhook_deliveries_bot_outcome_created;`);
    const insert = db.prepare(`INSERT INTO webhook_deliveries
      (id, bot_id, event_name, outcome, status_code, created_at)
      VALUES (?, ?, 'pull_request', ?, ?, ?)`);
    const now = Date.now();
    db.transaction(() => {
      for (let i = 0; i < rows; i++) {
        const outcome = ["ok", "paused", "rejected", "skipped", "ignored", "ignored", "ignored", "ignored", "ignored", "ignored"][Math.floor(i / 10) % 10]!;
        const createdAt = i < 300
          ? new Date(now - Math.floor(i / 10) * 1000).toISOString().replace("T", " ").slice(0, 19)
          : `2020-01-${String(1 + (Math.floor(i / 10) % 28)).padStart(2, "0")} 00:00:00`;
        insert.run(`row-${i}`, ids[i % 10]!, outcome, outcome === "rejected" ? 403 : null, createdAt);
      }
    })();

    function measure(sqls: string[], label: string) {
      const statements = sqls.map((sql) => db.prepare<Record<string, unknown>, string[]>(sql));
      if (rows === 60000) {
        for (const [i, sql] of sqls.entries()) {
          const plan = db.prepare<{ detail: string }, string[]>(`EXPLAIN QUERY PLAN ${sql}`).all(...ids);
          console.log(`${label} ${i === 0 ? "latest" : "count"} PLAN:\n${plan.map((row) => row.detail).join("\n")}`);
        }
      }
      const run = () => statements.map((statement) => statement.all(...ids));
      for (let i = 0; i < warmups; i++) run();
      const times = Array.from({ length: runs }, () => {
        const start = performance.now();
        run();
        return performance.now() - start;
      }).sort((a, b) => a - b);
      return {
        ms: times[Math.floor(runs / 2)]!,
        results: run().map((set) => set.sort((a, b) => String(a.bot_id).localeCompare(String(b.bot_id)))),
      };
    }

    db.exec(`PRAGMA foreign_keys = ${foreignKeys}`);
    assertHealthIndexes(false);
    const old = measure(before, "before");
    execMigrationScript(db, migration);
    assertHealthIndexes(true);
    // Capture the store's own statements rather than maintaining a second rewrite.
    const after: string[] = [];
    await createReviewBotsStore({
      ...handle,
      prepare(sql: string) {
        after.push(sql);
        return handle.prepare(sql);
      },
    }).deliverySummaries(ids);
    deepStrictEqual(after.length, 2);
    deepStrictEqual(after.some((sql, i) => sql !== before[i]), true, "Before and after SQL must differ");
    const improved = measure(after, "after");
    deepStrictEqual(improved.results, old.results);
    console.log(`${rows}\t${old.ms.toFixed(3)}\t${improved.ms.toFixed(3)}\t${(old.ms / improved.ms).toFixed(1)}x; results identical`);
  } finally {
    db.exec(`PRAGMA foreign_keys = ${foreignKeys}`);
    db.close();
  }
}
