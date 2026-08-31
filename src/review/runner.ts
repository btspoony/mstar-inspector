/**
 * Container review-runner entry (plan 07 Task 2).
 *
 * Runs INSIDE the sandbox image and is invoked by the Worker consumer via
 * `exec` (the consumer wiring to the new runtime lands in plan 07 Task 5):
 *
 *   bun run /opt/runner/src/review/runner.ts --level <quick|default|deep> --input <json-file>
 *
 * Contract:
 *   - `--level` is the review tier (quick | default | deep); anything else is a
 *     usage error (the runtime itself rejects unknown levels as well);
 *   - `--input <json-file>` carries the review job as JSON with ALL-OPTIONAL
 *     fields (absent = the legacy default, byte-identical behavior):
 *       - `worktreePath` (string) — the in-container PR clone path; defaults
 *         to the process cwd;
 *       - `reconFacts` (string[]) — per-seat recon facts (owner/repo#pr, head
 *         sha, diff stats, file scope); defaults to [];
 *       - `modelOverrides` (Record<string, string>) — per-agent selector
 *         chains (plan 17 B6); shape-guarded here, the role vocabulary and
 *         selector grammar live dashboard-side; absent = the legacy runtime
 *         input shape;
 *       - `customProviders` (plan 23 Task 3) — an optional array of keyless
 *         declarations `{ provider_id, base_url, api, model_ids }`; when
 *         present and non-empty the runner synthesizes a COMPLETE per-review
 *         models.yml (/tmp/omp-agent-<uuid>/models.yml from the in-image
 *         base) with every custom key as a CUSTOM_<ID>_API_KEY env-name
 *         reference (the consumer injects the decrypted values into the exec
 *         env) and rides that directory as the runtime `agentDir`; a
 *         declaration whose id collides with a base provider is skipped
 *         (base wins, AL-23-1) with a structured stderr warn (id + count, no
 *         keys) — absent/empty = the legacy in-image models.yml,
 *         byte-identical behavior;
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
import { isReviewLevel, REVIEW_LEVELS, type AgentRuntime, type AgentRuntimeRunInput } from "./runtime";
import { ompAgentRuntime, parseModelSelectors } from "./runtime-omp";
import { writePerReviewModelsYaml } from "./models-synthesis";
import type { CustomProviderDeclaration } from "./runtime";

const USAGE =
  `usage: bun run runner.ts --level <${REVIEW_LEVELS.join(", ")}> --input <json-file> ` +
  "(input JSON: { worktreePath?: string, reconFacts?: string[], modelOverrides?: Record<string, string>, " +
  "customProviders?: [{ provider_id, base_url, api, model_ids }] })";

/** Validated shape of the --input JSON file. */
type RunnerInputJson = {
  worktreePath?: string;
  reconFacts?: string[];
  modelOverrides?: Record<string, string>;
  customProviders?: CustomProviderDeclaration[];
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
  if (record.modelOverrides !== undefined) {
    // Plan 17 B6 (spec Architect lock L3): shape validation ONLY here — the
    // role vocabulary lives dashboard-side and selector grammar in the
    // dashboard store's parseModelChain mirror; unknown agent names pass
    // through inertly (the SDK consumes only names it actually dispatches).
    const map = record.modelOverrides;
    if (map === null || typeof map !== "object" || Array.isArray(map)) {
      throw new Error("input JSON field `modelOverrides` must be an object of string selectors when present");
    }
    for (const [role, selector] of Object.entries(map)) {
      if (typeof selector !== "string") {
        throw new Error(
          `input JSON field \`modelOverrides\`[${JSON.stringify(role)}] must be a string when present`,
        );
      }
    }
    input.modelOverrides = map as Record<string, string>;
  }
  if (record.customProviders !== undefined) {
    // Plan 23 Task 3 (AL-23-1): shape validation ONLY here — the id
    // pattern/baseUrl/api-enum/model bounds live dashboard-side
    // (assertCustomProvider). The declarations carry NO keys: each key rides
    // the container exec env under CUSTOM_<id>_API_KEY (the synthesized
    // models.yml references that env name; zero key literals in any file).
    const list = record.customProviders;
    if (!Array.isArray(list)) {
      throw new Error(
        "input JSON field `customProviders` must be an array of declarations when present " +
          "(keys ride the exec env under CUSTOM_<id>_API_KEY, never the input)",
      );
    }
    input.customProviders = list.map((entry, index) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`input JSON field \`customProviders\`[${index}] must be an object`);
      }
      const decl = entry as Record<string, unknown>;
      if (typeof decl.provider_id !== "string") {
        throw new Error(`input JSON field \`customProviders\`[${index}].provider_id must be a string`);
      }
      if (typeof decl.base_url !== "string") {
        throw new Error(`input JSON field \`customProviders\`[${index}].base_url must be a string`);
      }
      if (typeof decl.api !== "string") {
        throw new Error(`input JSON field \`customProviders\`[${index}].api must be a string`);
      }
      if (!Array.isArray(decl.model_ids) || decl.model_ids.some((id: unknown) => typeof id !== "string")) {
        throw new Error(`input JSON field \`customProviders\`[${index}].model_ids must be an array of strings`);
      }
      return {
        provider_id: decl.provider_id,
        base_url: decl.base_url,
        api: decl.api,
        model_ids: [...decl.model_ids],
      };
    });
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
      `review: unknown level ${JSON.stringify(level)} (expected one of: ${REVIEW_LEVELS.join(", ")})`,
    );
    return 2;
  }

  let input: AgentRuntimeRunInput;
  try {
    const parsed: unknown = JSON.parse(readFileSync(inputPath, "utf8"));
    const json = parseRunnerInput(parsed);
    // Plan 23 Task 3 (AL-23-1): when the input declares custom providers,
    // synthesize the COMPLETE per-review models.yml (/tmp/omp-agent-<uuid>/
    // from the in-image base) and ride the directory as `agentDir` — the SDK
    // reads <agentDir>/models.yml instead of the in-image default. Absent or
    // empty declarations = no synthesis, no agentDir (legacy byte-identical).
    const skippedCollisions: string[] = [];
    const agentDir =
      json.customProviders !== undefined && json.customProviders.length > 0
        ? await writePerReviewModelsYaml(json.customProviders, undefined, (providerId) => {
            skippedCollisions.push(providerId);
          })
        : undefined;
    // A custom id colliding with a base declaration is skipped (base wins,
    // AL-23-1) — never silent: one structured stderr warn per colliding id
    // (id + total count; zero key material).
    for (const providerId of skippedCollisions) {
      console.error(
        JSON.stringify({
          event: "custom_provider_collision",
          provider_id: providerId,
          count: skippedCollisions.length,
        }),
      );
    }
    input = {
      level,
      worktreePath: json.worktreePath ?? process.cwd(),
      reconFacts: json.reconFacts ?? [],
      modelSelectors: parseModelSelectors(Bun.env.OMP_REVIEW_MODEL),
      // Optional per-role overrides (plan 17 B6): included ONLY when the map
      // is present, so legacy input builds a byte-identical runtime input.
      ...(json.modelOverrides !== undefined ? { modelOverrides: json.modelOverrides } : {}),
      // Optional per-review models dir (plan 23 Task 3): included ONLY when
      // declarations triggered a synthesis.
      ...(agentDir !== undefined ? { agentDir } : {}),
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
