/**
 * Container review-runner entry.
 *
 * Runs INSIDE the sandbox image and is invoked by the Worker consumer via
 * `exec` (the consumer wires the runtime in):
 *
 *   bun run /opt/runner/src/review/runner.ts --level <quick|default|deep> --input <json-file>
 *
 * Contract:
 *   - `--level` is the review tier (quick | default | deep); anything else is a
 *     usage error (the runtime itself rejects unknown levels as well);
 *   - `--input <json-file>` carries the review job as JSON:
 *       - `capabilityHosts` — REQUIRED array of the App's
 *         selected sandbox image's capability hosts (the consumer resolves
 *         them from the source-controlled registry and passes them verbatim;
 *         keyless — `apiKeyEnv`/`auth` are retained registry metadata, not
 *         active key-resolution inputs). The runner ALWAYS
 *         synthesizes a COMPLETE per-review models.yml
 *         (/tmp/omp-agent-<uuid>/models.yml) with the capability hosts as the
 *         base — the baked in-image models.yml was removed — and rides
 *         that directory as the runtime `agentDir` (required for every run);
 *       - `worktreePath` (string) — the in-container PR clone path; defaults
 *         to the process cwd;
 *       - `reconFacts` (string[]) — per-seat recon facts (owner/repo#pr, head
 *         sha, diff stats, file scope); defaults to [];
 *       - `modelOverrides` (Record<string, string>) — per-agent selector
 *         chains; shape-guarded here, the role vocabulary and
 *         selector grammar live dashboard-side; absent = the legacy runtime
 *         input shape;
 *       - `customProviders` — an OPTIONAL array of keyless
 *         declarations `{ provider_id, base_url, api, model_ids }`; merged
 *         INTO the capability-host base of the synthesized models.yml (no
 *         apiKey pin, `auth: oauth`); each provider's key pool rides the exec
 *         env as MSTAR_POOL_<UPPER_SNAKE(id)>_COUNT + _01.._NN and is written
 *         into the run's credential store; a
 *         declaration whose id collides with a capability host is skipped
 *         (capability/base wins, AL-23-1) with a structured stderr warn
 *         (id + count, no keys); absent/empty = the capability base alone.
 *   - stdout carries ONLY the mstar.review/v1 envelope JSON (validated by
 *     validateMstarReviewV1 inside the runtime); all diagnostics to stderr;
 *   - optional `--recheck-out <path>` (spec review-lifecycle
 *     §7.8): when the runtime result carries a recheck document, its JSON is
 *     written to <path> BEFORE the envelope reaches stdout (a write failure
 *     → exit 1, no stdout). No flag or no result writes nothing — absent
 *     flag/file leaves legacy behavior byte-identical;
 *   - exit codes: 0 success, 1 runtime/I-O failure, 2 usage error. There is
 *     no summary-degrade path: any seat/parse/validation failure exits 1 and
 *     the consumer must not post or persist.
 *
 * Container environment (zero secrets in the image — keys arrive only via
 * exec env injection):
 *   - HARNESS_PLUGIN_ROOT=/opt/mstar-harness      (image-preinstalled harness)
 *   - PI_CODING_AGENT_DIR=/opt/omp-agent           (empty agent dir; the models.yml
 *                                                   the session reads is the synthesized
 *                                                   per-review file under `agentDir`)
 *   - OMP_REVIEW_MODEL                             (comma-separated selector chain)
 *   - MSTAR_POOL_<UPPER_SNAKE(provider)>_COUNT + _01.._NN
 *                                                 (per-provider credential pool;
 *                                                  the runner writes these into
 *                                                  <agentDir>/agent.db as stored
 *                                                  `login` api_key rows before the
 *                                                  session starts — never logged)
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent";
import {
  isReviewLevel,
  REVIEW_LEVELS,
  type AgentRuntime,
  type AgentRuntimeRunInput,
  type CapabilityHost,
  type CustomProviderDeclaration,
} from "./runtime";
import { anchorRecheckDeadline } from "./recheck";
import { ompAgentRuntime, parseModelSelectors } from "./runtime-omp";
import { writePerReviewModelsYaml } from "./models-synthesis";
import type { RecheckInput } from "../contracts/recheck";

const USAGE =
  `usage: bun run runner.ts --level <${REVIEW_LEVELS.join(", ")}> --input <json-file> [--recheck-out <path>] ` +
  "(input JSON: { capabilityHosts: [{ id, catalogProviderId, apiKeyEnv, baseUrl, api, auth, models }], " +
  "worktreePath?: string, reconFacts?: string[], modelOverrides?: Record<string, string>, " +
  "customProviders?: [{ provider_id, base_url, api, model_ids }], recheck?: mstar.recheck-input/v1 document })";

/** Validated shape of the --input JSON file. */
type RunnerInputJson = {
  capabilityHosts: CapabilityHost[];
  worktreePath?: string;
  reconFacts?: string[];
  modelOverrides?: Record<string, string>;
  customProviders?: CustomProviderDeclaration[];
  /** Optional typed recheck input — passed through to the runtime. */
  recheck?: RecheckInput;
};

/** Parse CLI flags. Throws (usage) on missing/unknown flags or missing values. */
function parseArgs(argv: string[]): { level: string; inputPath: string; recheckOutPath?: string } {
  let level: string | undefined;
  let inputPath: string | undefined;
  let recheckOutPath: string | undefined;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--level" && value !== undefined && level === undefined) {
      level = value;
    } else if (flag === "--input" && value !== undefined && inputPath === undefined) {
      inputPath = value;
    } else if (flag === "--recheck-out" && value !== undefined && recheckOutPath === undefined) {
      recheckOutPath = value;
    } else {
      throw new Error(USAGE);
    }
  }
  if (level === undefined || inputPath === undefined) {
    throw new Error(USAGE);
  }
  return { level, inputPath, recheckOutPath };
}

/** Validate the untrusted --input JSON with small type guards (no schema dep here). */
function parseRunnerInput(parsed: unknown): RunnerInputJson {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("input JSON must be an object");
  }
  const record = parsed as Record<string, unknown>;
  const input = {} as RunnerInputJson;
  // The capability hosts are the base of the synthesized
  // models.yml — REQUIRED (there is no baked in-image base to fall back to).
  // Shape validation ONLY: the values are consumer-resolved registry data
  // (source-controlled, keyless); the generator emits them verbatim.
  if (!Array.isArray(record.capabilityHosts)) {
    throw new Error("input JSON field `capabilityHosts` must be an array of capability hosts");
  }
  // There is no baked in-image base: an empty array would synthesize a
  // header-only models.yml (qc2 S2 / qc3 S-2) — reject it as a shape violation.
  if (record.capabilityHosts.length === 0) {
    throw new Error("input JSON field `capabilityHosts` must be a non-empty array of capability hosts");
  }
  input.capabilityHosts = record.capabilityHosts.map((entry, index) => {
    if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`input JSON field \`capabilityHosts\`[${index}] must be an object`);
    }
    const host = entry as Record<string, unknown>;
    for (const key of ["id", "catalogProviderId", "apiKeyEnv", "baseUrl", "api", "auth"] as const) {
      if (typeof host[key] !== "string") {
        throw new Error(`input JSON field \`capabilityHosts\`[${index}].${key} must be a string`);
      }
    }
    if (!Array.isArray(host.models)) {
      throw new Error(`input JSON field \`capabilityHosts\`[${index}].models must be an array of models`);
    }
    const models = host.models.map((model, modelIndex) => {
      if (model === null || typeof model !== "object" || Array.isArray(model)) {
        throw new Error(`input JSON field \`capabilityHosts\`[${index}].models[${modelIndex}] must be an object`);
      }
      const m = model as Record<string, unknown>;
      if (typeof m.id !== "string" || typeof m.name !== "string") {
        throw new Error(
          `input JSON field \`capabilityHosts\`[${index}].models[${modelIndex}].id/.name must be strings`,
        );
      }
      if (typeof m.reasoning !== "boolean") {
        throw new Error(
          `input JSON field \`capabilityHosts\`[${index}].models[${modelIndex}].reasoning must be a boolean`,
        );
      }
      if (!Array.isArray(m.input) || m.input.some((modality: unknown) => typeof modality !== "string")) {
        throw new Error(
          `input JSON field \`capabilityHosts\`[${index}].models[${modelIndex}].input must be an array of strings`,
        );
      }
      if (
        typeof m.contextWindow !== "number" ||
        !Number.isFinite(m.contextWindow) ||
        typeof m.maxTokens !== "number" ||
        !Number.isFinite(m.maxTokens)
      ) {
        throw new Error(
          `input JSON field \`capabilityHosts\`[${index}].models[${modelIndex}].contextWindow/.maxTokens must be finite numbers`,
        );
      }
      return {
        id: m.id as string,
        name: m.name as string,
        reasoning: m.reasoning as boolean,
        input: [...(m.input as string[])],
        contextWindow: m.contextWindow as number,
        maxTokens: m.maxTokens as number,
      };
    });
    // The per-field guards above proved the six scalars are strings.
    return {
      id: host.id as string,
      catalogProviderId: host.catalogProviderId as string,
      apiKeyEnv: host.apiKeyEnv as string,
      baseUrl: host.baseUrl as string,
      api: host.api as string,
      auth: host.auth as string,
      models,
    };
  });
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
    // (spec Architect lock L3): shape validation ONLY here — the
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
    // (AL-23-1): shape validation ONLY here — the id
    // pattern/baseUrl/api-enum/model bounds live dashboard-side
    // (assertCustomProvider). The declarations carry NO keys: each key rides
    // the container exec env as MSTAR_POOL_<UPPER_SNAKE(id)>_COUNT + _01.._NN
    // and the runner loads it into the run's credential store (zero key
    // literals in any file).
    const list = record.customProviders;
    if (!Array.isArray(list)) {
      throw new Error(
        "input JSON field `customProviders` must be an array of declarations when present " +
          "(keys ride the exec env under MSTAR_POOL_<UPPER_SNAKE(id)>_*, never the input)",
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
  if (record.recheck !== undefined) {
    // Shape validation ONLY — the §7.3 wire SSOT is
    // validateRecheckDoc, which the runtime applies to the seat's OUTPUT
    // against this input. The consumer builds the document from
    // store-selected targets, so the runner guards the envelope shape only:
    // exact keys, the input schema tag, a nonempty headSha, array
    // targets/evidence and an object discussion.
    const doc = record.recheck;
    if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
      throw new Error("input JSON field `recheck` must be an object when present");
    }
    const recheck = doc as Record<string, unknown>;
    if (recheck.schema !== "mstar.recheck-input/v1") {
      throw new Error('input JSON field `recheck`.schema must be "mstar.recheck-input/v1"');
    }
    if (typeof recheck.headSha !== "string" || recheck.headSha.length === 0) {
      throw new Error("input JSON field `recheck`.headSha must be a nonempty string");
    }
    if (!Array.isArray(recheck.targets) || !Array.isArray(recheck.evidence)) {
      throw new Error("input JSON field `recheck`.targets/.evidence must be arrays");
    }
    if (recheck.discussion === null || typeof recheck.discussion !== "object" || Array.isArray(recheck.discussion)) {
      throw new Error("input JSON field `recheck`.discussion must be an object");
    }
    input.recheck = doc as RecheckInput;
  }
  return input;
}

/**
 * The provider pools one run must load, keyed by the models.yml provider id
 * the session will resolve credentials under. Two identity sources, in order:
 *
 *   1. DECLARED identity (what the synthesis itself puts in models.yml) —
 *      capability-host blocks pool under their catalog provider id (omp's
 *      `ark-plan` ↔ `MSTAR_POOL_ARK_*`), custom declarations under their own
 *      id. A custom id colliding with a capability host is skipped here too
 *      (capability/base wins, same rule as the synthesis).
 *   2. THE EXEC ENV ITSELF — a BUILT-IN catalog provider (`openai`,
 *      `azure-openai`, …) is neither a capability host nor a custom
 *      declaration, so its transported pool arrives with no declared
 *      identity and is discovered from the `_COUNT` names present. The
 *      consumer's prefix rule inverts exactly (upper-snake → lower, `_` → `-`):
 *      every provider id the allowlist or the store admits is `[a-z0-9-]`
 *      with no underscore, so an underscore in a prefix can only come from a
 *      hyphen. A prefix or provider id already claimed above is never loaded
 *      twice.
 *
 * The enumerated set therefore covers EXACTLY the names the consumer's
 * `buildRunnerEnv` emitted, which is also what the fail-closed validation
 * below ranges over.
 */
function poolProviders(
  json: RunnerInputJson,
  env: Record<string, string | undefined>,
): Array<{ providerId: string; prefix: string }> {
  const baseIds = new Set(json.capabilityHosts.map((host) => host.id));
  const byPrefix = new Map<string, string>();
  const byProviderId = new Set<string>();
  const add = (rawPrefix: string, providerId: string): void => {
    const prefix = poolPrefix(rawPrefix);
    if (byPrefix.has(prefix) || byProviderId.has(providerId)) return;
    byPrefix.set(prefix, providerId);
    byProviderId.add(providerId);
  };
  for (const host of json.capabilityHosts) add(host.catalogProviderId, host.id);
  for (const decl of json.customProviders ?? []) {
    if (baseIds.has(decl.provider_id)) continue;
    add(decl.provider_id, decl.provider_id);
  }
  for (const name of Object.keys(env)) {
    const prefix = /^MSTAR_POOL_(.+)_COUNT$/.exec(name)?.[1];
    if (prefix !== undefined) add(prefix, prefix.toLowerCase().replace(/_/g, "-"));
  }
  return [...byPrefix].map(([prefix, providerId]) => ({ providerId, prefix }));
}

/** Upper-snake pool env fragment for a provider id (the consumer's own rule). */
function poolPrefix(providerId: string): string {
  return providerId.toUpperCase().replace(/-/g, "_");
}

/** A pool prefix as a literal inside a RegExp (env-derived fragments). */
function escapeRegExp(literal: string): string {
  return literal.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Load the transported credential pool into the run's credential store:
 * `<agentDir>/agent.db` gains one `{type:"api_key", source:"login"}` row per
 * transported key, in env order. `source: "login"` ranks ABOVE the provider
 * env var in the SDK's credential cascade, which is what lets the runtime
 * rotate across the pool — the synthesized models.yml deliberately pins no
 * `apiKey` (a tier-2 config override would suppress this pool entirely).
 *
 * Fail-closed: a `_COUNT` that disagrees with the `_01.._NN` values actually
 * present, or a listed value that is empty, aborts the run before any session
 * exists — never a partial pool. Diagnostics carry provider id + counts only;
 * key VALUES are never logged or thrown.
 */
async function loadCredentialPool(
  agentDir: string,
  json: RunnerInputJson,
  env: Record<string, string | undefined>,
): Promise<void> {
  const pools: Array<{ providerId: string; keys: string[] }> = [];
  for (const { providerId, prefix } of poolProviders(json, env)) {
    const countRaw = env[`MSTAR_POOL_${prefix}_COUNT`];
    if (countRaw === undefined) continue; // no pool transported for this provider
    const count = Number(countRaw);
    if (!Number.isInteger(count) || count < 1) {
      throw new Error(
        `credential pool for provider ${providerId}: MSTAR_POOL_${prefix}_COUNT must be a positive integer, got ${JSON.stringify(countRaw)}`,
      );
    }
    const keys: string[] = [];
    for (let index = 1; index <= count; index++) {
      const slot = `MSTAR_POOL_${prefix}_${String(index).padStart(2, "0")}`;
      const value = env[slot];
      if (value === undefined || value === "") {
        throw new Error(
          `credential pool for provider ${providerId}: MSTAR_POOL_${prefix}_COUNT=${count} but ${slot} is ${value === undefined ? "missing" : "empty"}`,
        );
      }
      keys.push(value);
    }
    // COUNT must equal the number of value slots actually present: an extra
    // slot beyond COUNT (a stray key the pool would silently drop) fails here.
    const slotRe = new RegExp(`^MSTAR_POOL_${escapeRegExp(prefix)}_\\d{2,}$`);
    const present = Object.keys(env).filter((name) => slotRe.test(name) && env[name] !== undefined);
    if (present.length !== count) {
      throw new Error(
        `credential pool for provider ${providerId}: MSTAR_POOL_${prefix}_COUNT=${count} but ${present.length} value slot(s) present`,
      );
    }
    pools.push({ providerId, keys });
  }
  if (pools.length === 0) return; // no credentials transported (keyless run shape)

  const storage = await AuthStorage.create(join(agentDir, "agent.db"));
  try {
    for (const { providerId, keys } of pools) {
      await storage.set(
        providerId,
        keys.map((key) => ({ type: "api_key" as const, key, source: "login" as const })),
      );
      // Provider id + pool size only — never a key value.
      console.error(JSON.stringify({ event: "credential_pool", provider: providerId, pool_size: keys.length }));
    }
  } finally {
    storage.close();
  }
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
  let recheckOutPath: string | undefined;
  try {
    ({ level, inputPath, recheckOutPath } = parseArgs(argv));
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
  // spec §7.8: anchor the ABSOLUTE outer review deadline once
  // per process — the recheck seat's budget derives from it, so the seat can
  // never outlive (or restart past) the review's own wall-clock cap.
  anchorRecheckDeadline(Date.now(), level);

  let input: AgentRuntimeRunInput;
  try {
    const parsed: unknown = JSON.parse(readFileSync(inputPath, "utf8"));
    const json = parseRunnerInput(parsed);
    // (AL-23-1): EVERY run synthesizes the
    // COMPLETE per-review models.yml (/tmp/omp-agent-<uuid>/) — the App's
    // selected image's capability hosts are the base, the custom-provider
    // declarations merge into it — and the directory rides as `agentDir` (the
    // SDK reads <agentDir>/models.yml instead of the retired in-image file).
    const skippedCollisions: string[] = [];
    const agentDir = await writePerReviewModelsYaml(json.capabilityHosts, json.customProviders ?? [], (providerId) => {
      skippedCollisions.push(providerId);
    });
    // A custom id colliding with a capability host is skipped (capability/base
    // wins, AL-23-1) — never silent: one structured stderr warn per colliding
    // id (id + total count; zero key material).
    for (const providerId of skippedCollisions) {
      console.error(
        JSON.stringify({
          event: "custom_provider_collision",
          provider_id: providerId,
          count: skippedCollisions.length,
        }),
      );
    }
    // The transported credential pool lands in THIS run's credential store
    // (agent.db) before any session exists: the synthesized models.yml pins no
    // apiKey, so the stored `login` rows are what the runtime rotates across.
    // Fail-closed — a COUNT/slot disagreement aborts the run here (exit 1),
    // with its own diagnostic (not the input-read label).
    try {
      await loadCredentialPool(agentDir, json, Bun.env);
    } catch (error) {
      console.error(`review: credential pool rejected: ${(error as Error).message}`);
      return 1;
    }

    input = {
      level,
      worktreePath: json.worktreePath ?? process.cwd(),
      reconFacts: json.reconFacts ?? [],
      modelSelectors: parseModelSelectors(Bun.env.OMP_REVIEW_MODEL),
      // Optional per-role overrides: included ONLY when the map
      // is present, so legacy input builds a byte-identical runtime input.
      ...(json.modelOverrides !== undefined ? { modelOverrides: json.modelOverrides } : {}),
      // Optional typed recheck input: included ONLY when
      // present — same byte-identical legacy rule as modelOverrides.
      ...(json.recheck !== undefined ? { recheck: json.recheck } : {}),
      // The synthesized per-review models dir (present
      // on EVERY run — there is no baked models.yml to fall back to).
      agentDir,
    };
  } catch (error) {
    console.error(`review: cannot read runner input ${inputPath}: ${(error as Error).message}`);
    return 1;
  }

  try {
    const { envelope, recheck } = await runtime.runReview(input);
    // The optional --recheck-out file is written only when a
    // recheck result exists, and BEFORE the envelope reaches stdout — a
    // write failure is a genuine I-O failure (exit 1, no stdout), not a
    // silent lie about the file. No flag / no result writes nothing; stdout
    // stays envelope-only and exit codes are unchanged.
    if (recheckOutPath !== undefined && recheck !== null) {
      try {
        writeFileSync(recheckOutPath, JSON.stringify(recheck));
      } catch (error) {
        console.error(`review: cannot write recheck output ${recheckOutPath}: ${(error as Error).message}`);
        return 1;
      }
    }
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
