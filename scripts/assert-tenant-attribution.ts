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
 *   1. Zero orphans. Every App must own exactly one `app_workspaces` row:
 *      every execution-facing App read INNER JOINs that table, so an unmapped
 *      App silently disappears from the pipeline — the failure is invisible,
 *      which is why an orphan count aborts the deploy instead of warning.
 *      `scripts/workspace-backfill.sql` is idempotent; replay it first.
 *   2. No target-less App. Every live App must own a live `review_targets`
 *      row: the review configuration and the installation binding live on
 *      that row, so an App without one answers no delivery at all.
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
  "SELECT COUNT(*) AS n FROM github_apps g LEFT JOIN app_workspaces w ON w.app_id = g.id WHERE w.app_id IS NULL";

/**
 * The target-less question. `n > 0` = live GitHub Apps without a live review
 * target: the `LEFT JOIN` keeps an App whose only target is soft-deleted,
 * which is the state that answers no delivery.
 */
export const TARGETLESS_BOT_SQL =
  "SELECT COUNT(*) AS n FROM github_apps g LEFT JOIN review_targets t ON t.app_id = g.id AND t.deleted_at IS NULL WHERE g.deleted_at IS NULL AND t.id IS NULL";

export type AttributionVerdict = {
  ok: boolean;
  count: number | null;
  message: string;
};

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
  if (success !== true) {
    return { reason: "wrangler d1 execute did not report success: true" };
  }
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
    return { ok: true, count: 0, message: "tenant attribution: 0 orphan Apps (every github_apps row has an app_workspaces row)" };
  }
  return {
    ok: false,
    count: read.count,
    message:
      `tenant attribution: ${read.count} App(s) have no app_workspaces row — every App read joins ` +
      `that table, so they are invisible to the pipeline. Replay scripts/workspace-backfill.sql, then re-run this gate.`,
  };
}
/** The target-less verdict: `n > 0` names the live GitHub Apps that cannot review. */
export function targetlessVerdict(stdout: string): AttributionVerdict {
  const read = readCount(stdout);
  if ("reason" in read) return { ok: false, count: null, message: `tenant attribution: ${read.reason}` };
  if (read.count === 0) {
    return {
      ok: true,
      count: 0,
      message: "tenant attribution: 0 target-less Apps (every live github_apps row has a live review_targets row)",
    };
  }
  return {
    ok: false,
    count: read.count,
    message:
      `tenant attribution: ${read.count} live GitHub App(s) have no live review target — a delivery resolves ` +
      `its repository through that row, so these Apps answer no delivery at all. 0057_review_targets.sql cannot ` +
      `be replayed whole on a half-applied database: inspect its partial application and restore the missing ` +
      `target rows, then re-run this gate.`,
  };
}

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
