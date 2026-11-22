#!/usr/bin/env bun
/**
 * why: assert-tenant-attribution.ts — deploy gate for the two attribution rows a
 * bot cannot work without (the 0026/0027 and 0057 data planes).
 *
 * Usage:
 *   bun scripts/assert-tenant-attribution.ts [--db <name>] [--env <environment>]
 *
 * Two questions, each its own `COUNT(*)`:
 *
 *   1. Zero orphans. Every App must own exactly one `bot_workspaces` row:
 *      every execution-facing App read INNER JOINs that table, so an unmapped
 *      App silently disappears from the pipeline — the failure is invisible,
 *      which is why an orphan count aborts the deploy instead of warning.
 *      `scripts/workspace-backfill.sql` is idempotent; replay it first.
 *   2. No target-less bot. Every live bot must own a live `review_targets`
 *      row: the review configuration and the installation binding live on
 *      that row, so a bot without one answers no delivery at all.
 *
 * Both queries run through the same `wrangler d1 execute` path the deploy
 * uses, against the remote database, and against the environment's config
 * block (`--env production`).
 *
 * Exit codes: 0 = both counts are zero; 1 = a count above zero, wrangler
 * failed, or the output could not be read (an unreadable answer is never a
 * pass).
 */

/** The zero-orphan question. `n > 0` = Apps with no workspace mapping. */
export const ZERO_ORPHAN_SQL =
  "SELECT COUNT(*) AS n FROM review_bots g LEFT JOIN bot_workspaces w ON w.bot_id = g.id WHERE w.bot_id IS NULL";

/**
 * The target-less question. `n > 0` = live bots with no live target: the
 * `LEFT JOIN` keeps a bot whose only target is soft-deleted, which is the
 * state that answers no delivery.
 */
export const TARGETLESS_BOT_SQL =
  "SELECT COUNT(*) AS n FROM review_bots g LEFT JOIN review_targets t ON t.bot_id = g.id AND t.deleted_at IS NULL WHERE g.deleted_at IS NULL AND t.id IS NULL";

export type AttributionVerdict = {
  ok: boolean;
  /** note: Parsed count; `null` when the wrangler output was unreadable. */
  count: number | null;
  message: string;
};

/**
 * note: Parse `wrangler d1 execute --json` stdout down to the one `COUNT(*) AS n`
 * row, or the reason it cannot be read.
 *
 * The CLI prints one entry per statement:
 *   [{ "results": [{ "n": 0 }], "success": true, "meta": { … } }]
 * Anything else — non-JSON, an empty array, no rows, a non-integer `n`,
 * `success: false` — is a failure: the count is unknown, so the gate must
 * not pass.
 */
function readCount(stdout: string): { count: number } | { reason: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { reason: "wrangler d1 execute did not print JSON" };
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    return { reason: "wrangler d1 execute did not return exactly one statement result" };
  }
  const statement: unknown = parsed[0];
  if (typeof statement !== "object" || statement === null || Array.isArray(statement)) {
    return { reason: "wrangler d1 execute returned a malformed statement result" };
  }
  const { success, results } = statement as Record<string, unknown>;
  // why: Strict `true`: a missing flag or the string `"false"` is neither a success
  // nor a readable answer, and this gate never passes on an unknown.
  if (success !== true) {
    return { reason: "wrangler d1 execute did not report success: true" };
  }
  // why: Exactly one row: the query returns one COUNT(*), so extra rows mean the
  // wrong statement (or a batched reply) and the first row is not the answer.
  if (!Array.isArray(results) || results.length !== 1) {
    return { reason: "wrangler d1 execute did not return exactly one result row (expected one COUNT(*) AS n row)" };
  }
  const row: unknown = results[0];
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    return { reason: "wrangler d1 execute returned a malformed result row" };
  }
  const count = (row as Record<string, unknown>).n;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
    return { reason: "wrangler d1 execute returned no non-negative integer COUNT(*) AS n" };
  }
  return { count };
}

/** The zero-orphan verdict: `n > 0` names the unmapped Apps and the replay. */
export function attributionVerdict(stdout: string): AttributionVerdict {
  const read = readCount(stdout);
  if ("reason" in read) return { ok: false, count: null, message: `tenant attribution: ${read.reason}` };
  if (read.count === 0) {
    return { ok: true, count: 0, message: "tenant attribution: 0 orphan Apps (every review_bots row has a bot_workspaces row)" };
  }
  return {
    ok: false,
    count: read.count,
    message:
      `tenant attribution: ${read.count} App(s) have no bot_workspaces row — every App read joins ` +
      `that table, so they are invisible to the pipeline. Replay scripts/workspace-backfill.sql, then re-run this gate.`,
  };
}

/** The target-less verdict: `n > 0` names the bots that cannot review. */
export function targetlessVerdict(stdout: string): AttributionVerdict {
  const read = readCount(stdout);
  if ("reason" in read) return { ok: false, count: null, message: `tenant attribution: ${read.reason}` };
  if (read.count === 0) {
    return {
      ok: true,
      count: 0,
      message: "tenant attribution: 0 target-less bots (every live review_bots row has a live review_targets row)",
    };
  }
  return {
    ok: false,
    count: read.count,
    message:
      `tenant attribution: ${read.count} bot(s) have no live review target — review configuration and the ` +
      `installation binding live on that row, so they cannot review. 0057_review_targets.sql cannot be replayed ` +
      `whole on a half-applied database: inspect its partial application and restore the missing target rows, ` +
      `then re-run this gate.`,
  };
}

/** note: One `wrangler d1 execute --command` call: the stdout, or why there is none. */
function queryCount(
  db: string,
  envName: string | undefined,
  sql: string,
): { stdout: string } | { failure: string } {
  const args = ["bunx", "wrangler", "d1", "execute", db, "--remote"];
  if (envName !== undefined) args.push("--env", envName);
  args.push("--json", "--command", sql);
  const proc = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    const stderr = proc.stderr.toString().trim();
    return { failure: `wrangler d1 execute failed (exit ${proc.exitCode})${stderr === "" ? "" : `: ${stderr}`}` };
  }
  return { stdout: proc.stdout.toString() };
}

/**
 * Run the zero-orphan question against one remote database. Exported so a
 * caller can reuse the exact wrangler invocation.
 */
export function runAttributionGate(db: string, envName?: string): AttributionVerdict {
  const out = queryCount(db, envName, ZERO_ORPHAN_SQL);
  return "failure" in out
    ? { ok: false, count: null, message: `tenant attribution: ${out.failure}` }
    : attributionVerdict(out.stdout);
}

/** Run the target-less question against the same database. */
export function runTargetlessGate(db: string, envName?: string): AttributionVerdict {
  const out = queryCount(db, envName, TARGETLESS_BOT_SQL);
  return "failure" in out
    ? { ok: false, count: null, message: `tenant attribution: ${out.failure}` }
    : targetlessVerdict(out.stdout);
}

if (import.meta.main) {
  const argv = process.argv.slice(2);
  let db = "mstar-inspector-db";
  let envName: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (arg === "--db") db = argv[++i] ?? "";
    else if (arg === "--env") envName = argv[++i];
    else {
      console.error(`assert-tenant-attribution: unknown argument ${arg}`);
      process.exit(1);
    }
  }
  if (db === "") {
    console.error("assert-tenant-attribution: --db needs a database name");
    process.exit(1);
  }
  // why: Both questions run before the verdict: one deploy attempt reports every
  // broken row, and a failure in the first answer must not hide the second.
  let failed = false;
  for (const verdict of [runAttributionGate(db, envName), runTargetlessGate(db, envName)]) {
    if (verdict.ok) console.log(verdict.message);
    else {
      console.error(`::error::${verdict.message}`);
      failed = true;
    }
  }
  if (failed) process.exit(1);
}
