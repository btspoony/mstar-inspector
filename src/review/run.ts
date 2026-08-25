/**
 * CLI entry: `bun run review --diff <file>` (plan 02 Task 3).
 *
 * stdout contract: prints ONLY the ReviewOutput JSON (the `result` of
 * reviewDiff — never the `{mode, result}` envelope). All diagnostics go to
 * stderr. Exit codes: 0 on success (structured or summary), 1 on session or
 * I/O failure, 2 on usage errors.
 */

import { readFileSync } from "node:fs";
import { reviewDiff } from "./review";

const USAGE = "usage: bun run review --diff <file>";

function parseArgs(argv: string[]): { diffPath: string } {
  const diffIndex = argv.indexOf("--diff");
  if (diffIndex === -1) {
    throw new Error(USAGE);
  }
  const diffPath = argv[diffIndex + 1];
  if (!diffPath) {
    throw new Error(USAGE);
  }
  return { diffPath };
}

/**
 * Run the CLI. Returns the process exit code; prints the ReviewOutput JSON to
 * stdout and diagnostics to stderr. Exported for deterministic e2e tests.
 */
export async function main(argv: string[]): Promise<number> {
  let diffPath: string;
  try {
    ({ diffPath } = parseArgs(argv));
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }

  let diffText: string;
  try {
    diffText = readFileSync(diffPath, "utf8");
  } catch (error) {
    console.error(`review: cannot read diff file ${diffPath}: ${(error as Error).message}`);
    return 1;
  }

  const { mode, result } = await reviewDiff(diffText);
  console.error(`review mode: ${mode}`);
  // stdout carries ONLY the ReviewOutput JSON (plan Module contracts).
  console.log(JSON.stringify(result));
  return 0;
}

// Auto-run only when executed directly (bun run review --diff <file>).
if (import.meta.main) {
  process.exitCode = await main(Bun.argv.slice(2));
}
