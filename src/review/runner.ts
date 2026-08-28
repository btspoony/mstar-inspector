/**
 * Container review-runner entry (plan 07 Task 2).
 *
 * Runs INSIDE the sandbox image and is invoked by the Worker consumer via
 * `exec` (the consumer wiring to the new runtime lands in plan 07 Task 5):
 *
 *   bun run /opt/runner/src/review/runner.ts --level <quick|default> --input <json-file>
 *
 * Contract:
 *   - `--level` is the review tier (quick | default); anything else is a
 *     usage error (the runtime itself rejects unknown levels as well);
 *   - `--input` points at a JSON file `{ worktreePath?: string,
 *     reconFacts?: string[] }`; `worktreePath` defaults to the process cwd
 *     (the consumer execs with cwd = the in-container PR clone dir);
 *   - stdout carries ONLY the mstar.review/v1 envelope JSON (validated by
 *     validateMstarReviewV1 inside the runtime); all diagnostics to stderr;
 *   - exit codes: 0 success, 1 runtime/I-O failure, 2 usage error. There is
 *     no summary-degrade path: any seat/parse/validation failure exits 1 and
 *     the consumer must not post or persist.
 *
 * Container environment (zero secrets in the image — keys arrive only via
 * exec env injection):
 *   - HARNESS_PLUGIN_ROOT=/opt/mstar-harness      (image-preinstalled harness)
 *   - PI_CODING_AGENT_DIR=/opt/omp-agent           (image-provisioned models.yml)
 *   - OMP_REVIEW_MODEL                             (comma-separated selector chain)
 *   - ARK_API_KEY                                  (injected per exec by the consumer)
 */
import { readFileSync } from "node:fs";
import { isReviewLevel, REVIEW_SEATS, type AgentRuntime, type AgentRuntimeRunInput } from "./runtime";
import { ompAgentRuntime, parseModelSelectors } from "./runtime-omp";

const USAGE =
  "usage: bun run runner.ts --level <quick|default> --input <json-file> " +
  "(input JSON: { worktreePath?: string, reconFacts?: string[] })";

/** Validated shape of the --input JSON file. */
type RunnerInputJson = {
  worktreePath?: string;
  reconFacts?: string[];
};

/** Parse CLI flags. Throws (usage) on missing/unknown flags or missing values. */
function parseArgs(argv: string[]): { level: string; inputPath: string } {
  let level: string | undefined;
  let inputPath: string | undefined;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--level" && value !== undefined && level === undefined) {
      level = value;
    } else if (flag === "--input" && value !== undefined && inputPath === undefined) {
      inputPath = value;
    } else {
      throw new Error(USAGE);
    }
  }
  if (level === undefined || inputPath === undefined) {
    throw new Error(USAGE);
  }
  return { level, inputPath };
}

/** Validate the untrusted --input JSON with small type guards (no schema dep here). */
function parseRunnerInput(parsed: unknown): RunnerInputJson {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("input JSON must be an object");
  }
  const record = parsed as Record<string, unknown>;
  const input: RunnerInputJson = {};
  if (record.worktreePath !== undefined) {
    if (typeof record.worktreePath !== "string") {
      throw new Error("input JSON field `worktreePath` must be a string when present");
    }
    input.worktreePath = record.worktreePath;
  }
  if (record.reconFacts !== undefined) {
    if (!Array.isArray(record.reconFacts) || record.reconFacts.some((fact) => typeof fact !== "string")) {
      throw new Error("input JSON field `reconFacts` must be an array of strings when present");
    }
    input.reconFacts = record.reconFacts;
  }
  return input;
}

/**
 * Run the CLI. Returns the process exit code; prints the mstar.review/v1
 * envelope JSON to stdout and diagnostics to stderr. Exported for
 * deterministic tests, which inject a fake `runtime` (mock.module on this
 * shared specifier is process-global and leaks across bun test files).
 */
export async function main(argv: string[], runtime: AgentRuntime = ompAgentRuntime): Promise<number> {
  let level: string;
  let inputPath: string;
  try {
    ({ level, inputPath } = parseArgs(argv));
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }
  // Level validity is knowable before any I/O — treat it as a usage error.
  if (!isReviewLevel(level)) {
    console.error(
      `review: unknown level ${JSON.stringify(level)} (expected one of: ${Object.keys(REVIEW_SEATS).join(", ")})`,
    );
    return 2;
  }

  let input: AgentRuntimeRunInput;
  try {
    const parsed: unknown = JSON.parse(readFileSync(inputPath, "utf8"));
    const json = parseRunnerInput(parsed);
    input = {
      level,
      worktreePath: json.worktreePath ?? process.cwd(),
      reconFacts: json.reconFacts ?? [],
      modelSelectors: parseModelSelectors(Bun.env.OMP_REVIEW_MODEL),
    };
  } catch (error) {
    console.error(`review: cannot read runner input ${inputPath}: ${(error as Error).message}`);
    return 1;
  }

  try {
    const envelope = await runtime.runReview(input);
    // stdout carries ONLY the envelope JSON (plan Module contracts).
    console.log(JSON.stringify(envelope));
    return 0;
  } catch (error) {
    console.error(`review: runtime failed: ${(error as Error).message}`);
    return 1;
  }
}

// Auto-run only when executed directly.
if (import.meta.main) {
  process.exitCode = await main(Bun.argv.slice(2));
}
