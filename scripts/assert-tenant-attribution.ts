#!/usr/bin/env bun
/**
 * assert-tenant-attribution.ts — zero-orphan deploy gate (migrations 0026/0027
 * data plane).
 *
 * Usage:
 *   bun scripts/assert-tenant-attribution.ts [--db <name>] [--env <environment>]
 *
 * Every App must own exactly one `app_workspaces` row: every execution-facing
 * App read INNER JOINs that table, so an unmapped App silently disappears from
 * the pipeline — the failure is invisible, which is why an orphan count aborts
 * the deploy instead of warning.
 *
 * The query runs through the same `wrangler d1 execute` path the deploy
 * uses, against the remote database, and against the environment's config
 * block (`--env production`). `0027_workspace_backfill.sql` is idempotent;
 * run it first, then this gate.
 *
 * Exit codes: 0 = zero orphans; 1 = orphans found, wrangler failed, or the
 * output could not be read (an unreadable answer is never a pass).
 */

/** The zero-orphan question. `n > 0` = Apps with no workspace mapping. */
export const ZERO_ORPHAN_SQL =
  "SELECT COUNT(*) AS n FROM github_apps g LEFT JOIN app_workspaces w ON w.app_id = g.id WHERE w.app_id IS NULL";

export type AttributionVerdict = {
  ok: boolean;
  /** Parsed orphan count; `null` when the wrangler output was unreadable. */
  count: number | null;
  message: string;
};

/**
 * Parse `wrangler d1 execute --json` stdout and decide.
 *
 * The CLI prints one entry per statement:
 *   [{ "results": [{ "n": 0 }], "success": true, "meta": { … } }]
 * Anything else — non-JSON, an empty array, no rows, a non-integer `n`,
 * `success: false` — is a failure: the count is unknown, so the gate must
 * not pass.
 */
export function attributionVerdict(stdout: string): AttributionVerdict {
  const fail = (reason: string): AttributionVerdict => ({
    ok: false,
    count: null,
    message: `tenant attribution: ${reason}`,
  });

  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return fail("wrangler d1 execute did not print JSON");
  }
  if (!Array.isArray(parsed) || parsed.length !== 1) {
    return fail("wrangler d1 execute did not return exactly one statement result");
  }
  const statement: unknown = parsed[0];
  if (typeof statement !== "object" || statement === null || Array.isArray(statement)) {
    return fail("wrangler d1 execute returned a malformed statement result");
  }
  const { success, results } = statement as Record<string, unknown>;
  // Strict `true`: a missing flag or the string `"false"` is neither a success
  // nor a readable answer, and this gate never passes on an unknown.
  if (success !== true) {
    return fail("wrangler d1 execute did not report success: true");
  }
  // Exactly one row: the query returns one COUNT(*), so extra rows mean the
  // wrong statement (or a batched reply) and the first row is not the answer.
  if (!Array.isArray(results) || results.length !== 1) {
    return fail("wrangler d1 execute did not return exactly one result row (expected one COUNT(*) AS n row)");
  }
  const row: unknown = results[0];
  if (typeof row !== "object" || row === null || Array.isArray(row)) {
    return fail("wrangler d1 execute returned a malformed result row");
  }
  const count = (row as Record<string, unknown>).n;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
    return fail("wrangler d1 execute returned no non-negative integer COUNT(*) AS n");
  }
  if (count === 0) {
    return { ok: true, count, message: "tenant attribution: 0 orphan Apps (every github_apps row has an app_workspaces row)" };
  }
  return {
    ok: false,
    count,
    message:
      `tenant attribution: ${count} App(s) have no app_workspaces row — every App read joins ` +
      `that table, so they are invisible to the pipeline. Run migrations/0027_workspace_backfill.sql, then re-run this gate.`,
  };
}

/**
 * Run the gate against one remote database. Exported so a caller can reuse
 * the exact wrangler invocation; the CLI below is the only production caller.
 */
export function runAttributionGate(db: string, envName?: string): AttributionVerdict {
  const args = ["bunx", "wrangler", "d1", "execute", db, "--remote"];
  if (envName !== undefined) args.push("--env", envName);
  args.push("--json", "--command", ZERO_ORPHAN_SQL);
  const proc = Bun.spawnSync(args, { stdout: "pipe", stderr: "pipe" });
  if (proc.exitCode !== 0) {
    const stderr = proc.stderr.toString().trim();
    return {
      ok: false,
      count: null,
      message: `tenant attribution: wrangler d1 execute failed (exit ${proc.exitCode})${stderr === "" ? "" : `: ${stderr}`}`,
    };
  }
  return attributionVerdict(proc.stdout.toString());
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
  const verdict = runAttributionGate(db, envName);
  if (!verdict.ok) {
    console.error(`::error::${verdict.message}`);
    process.exit(1);
  }
  console.log(verdict.message);
}
