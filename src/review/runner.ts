/**
 * Container review-runner entry (plan 06 Task 2).
 *
 * Runs INSIDE the sandbox image and is invoked by the Worker consumer via
 * `exec` (plan Clarify #5 / #6):
 *
 *   bun run /opt/runner/src/review/runner.ts --diff <unified-diff-file>
 *
 * Contract (locked to the M0 CLI semantics — this module deliberately reuses
 * `main` from ./run instead of re-implementing it):
 *   - cwd is the in-container PR clone dir (the consumer sets exec cwd);
 *   - the unified diff is read from the file passed via --diff;
 *   - stdout carries ONLY the ReviewOutput JSON (the `result` of reviewDiff —
 *     never the `{mode, result}` envelope; all diagnostics go to stderr);
 *   - exit codes along the M0 CLI: 0 success (structured or summary), 1
 *     session/I-O failure, 2 usage error.
 *
 * Container environment (zero secrets in the image — keys arrive only via
 * exec env injection):
 *   - HARNESS_PLUGIN_ROOT=/opt/mstar-harness      (image-preinstalled harness)
 *   - PI_CODING_AGENT_DIR=/opt/omp-agent           (image-provisioned models.yml)
 *   - ARK_API_KEY                                  (injected per exec by the consumer)
 *
 * The read-only tool whitelist (read/grep/glob) and `fetch.enabled=false`
 * isolation are inherited from src/review/session.ts (M0 semantics, unchanged).
 */
import { main } from "./run";

export { main };

if (import.meta.main) {
  process.exitCode = await main(Bun.argv.slice(2));
}
