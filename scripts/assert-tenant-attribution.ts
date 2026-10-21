#!/usr/bin/env bun
/**
 * assert-tenant-attribution.ts — zero-orphan deploy gate (migrations 0026/0027
 * data plane).
 *
 * Usage:
 *   bun scripts/assert-tenant-attribution.ts [--db <name>] [--env <environment>]
 *
 * Every App must own exactly one `app_workspaces` row. Under
 * `WORKSPACE_TENANT_MODE=strict` the App reads INNER JOIN that table, so an
 * unmapped App silently disappears from the pipeline — the failure is
 * invisible, which is why an orphan count aborts the deploy instead of
 * warning.
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
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout);
  } catch {
    return { ok: false, count: null, message: "tenant attribution: wrangler d1 execute did not print JSON" };
  }
  const statement = Array.isArray(parsed) ? (parsed[0] as Record<string, unknown> | undefined) : undefined;
  if (statement === undefined || statement.success === false) {
    return { ok: false, count: null, message: "tenant attribution: wrangler d1 execute reported no successful result" };
  }
  const rows = statement.results;
  const row = Array.isArray(rows) ? (rows[0] as Record<string, unknown> | undefined) : undefined;
  const count = row?.n;
  if (typeof count !== "number" || !Number.isInteger(count) || count < 0) {
    return { ok: false, count: null, message: "tenant attribution: wrangler d1 execute returned no integer COUNT(*) AS n row" };
  }
  if (count === 0) {
    return { ok: true, count, message: "tenant attribution: 0 orphan Apps (every github_apps row has an app_workspaces row)" };
  }
  return {
    ok: false,
    count,
    message:
      `tenant attribution: ${count} App(s) have no app_workspaces row — they are invisible to ` +
      `WORKSPACE_TENANT_MODE=strict. Run migrations/0027_workspace_backfill.sql, then re-run this gate.`,
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
