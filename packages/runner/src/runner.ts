/**
 * Container review-runner entry.
 *
 * Runs INSIDE the sandbox image and is invoked by the Worker consumer via
 * `exec` (the consumer wires the runtime in):
 *
 *   bun run /opt/runner/packages/runner/src/runner.ts --level <quick|default|deep> --input <json-file>
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
 *         apiKey pin, `auth: oauth`); each provider's key pool rides the STDIN
 *         credential payload under its own provider id and is loaded into the
 *         run's in-memory credential store; a
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
 * Container environment (zero secrets in the image — the process environment
 * carries NO credential):
 *   - HARNESS_PLUGIN_ROOT=/opt/mstar-harness      (image-preinstalled harness)
 *   - PI_CODING_AGENT_DIR=/opt/omp-agent           (empty agent dir; the models.yml
 *                                                   the session reads is the synthesized
 *                                                   per-review file under `agentDir`)
 *   - OMP_REVIEW_MODEL                             (comma-separated selector chain)
 *
 * Credential transport: the consumer streams a versioned JSON payload
 * (`{"version":1,"pools":{"<providerId>":["k1",…]}}` — packages/shared/src/credential-payload.ts)
 * into this process's STDIN and closes the stream. The runner validates it
 * BEFORE any credential is written, resolves each pool key to the models.yml
 * provider id it serves, and loads those keys into an IN-MEMORY credential
 * store as stored `login` api_key rows before the session starts; that exact
 * instance rides `AgentRuntimeRunInput.authStorage` and is what every
 * `createAgentSession` call receives. No credential database is ever written,
 * so the session's own read/grep/glob (which the pinned SDK admits) have no
 * file to find. Diagnostics carry the provider id and the pool size only —
 * never a key value, never the payload.
 * An absent payload (empty stdin) is the keyless run shape — and so is an
 * interactive terminal: the documented local
 * `bun run packages/runner/src/runner.ts --level <tier> --input <json-file>` has no pipe,
 * so its TTY would never send EOF; the read is skipped there instead of
 * blocking.
 * The credential directory is per-run and holds only the non-secret synthesized
 * models.yml, so it is removed once the runtime has settled, on both the
 * success and the failure path (best-effort; a removal failure never replaces
 * the run's own outcome).
 */
import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { AuthStorage } from "@oh-my-pi/pi-coding-agent";
import {
  isReviewLevel,
  REVIEW_LEVELS,
  type AgentRuntime,
  type AgentRuntimeRunInput,
  type CapabilityHost,
  type CustomProviderDeclaration,
} from "../../shared/src/runtime";
import { anchorRecheckDeadline } from "./recheck";
import { ompAgentRuntime, parseModelSelectors } from "./runtime-omp";
import { writePerReviewModelsYaml } from "./models-synthesis";
import { decodeCredentialPayload } from "../../shared/src/credential-payload";
import type { RecheckInput } from "../../shared/src/recheck-wire";

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
    // the STDIN credential payload under its provider id (packages/shared/src/credential-payload)
    // and the runner loads it into the run's in-memory credential store (zero
    // key literals in any file).
    const list = record.customProviders;
    if (!Array.isArray(list)) {
      throw new Error(
        "input JSON field `customProviders` must be an array of declarations when present " +
          "(keys ride the stdin credential payload, never the input)",
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
 * the session resolves credentials under. Two identity sources, in order:
 *
 *   1. DECLARED identity (what the synthesis itself puts in models.yml) —
 *      capability-host blocks pool under their catalog provider id (omp's
 *      `ark-plan` ↔ the payload's `ark` entry: the consumer's key space is the
 *      App-config provider id), custom declarations under their own id. A
 *      custom id colliding with a capability host is skipped here too
 *      (capability/base wins, same rule as the synthesis).
 *   2. THE PAYLOAD'S OWN ENTRIES — a BUILT-IN catalog provider (`openai`,
 *      `azure-openai`, …) is neither a capability host nor a custom
 *      declaration, so its transported pool carries no declared identity and
 *      resolves under its own provider id. A pool key or provider id already
 *      claimed above is never loaded twice.
 *
 * The enumerated set therefore covers EXACTLY the payload the consumer built. A
 * declared provider with no payload entry simply has no transported credentials
 * and is skipped by the caller, so a keyless chain still runs.
 */
function poolProviders(
  json: RunnerInputJson,
  poolKeys: readonly string[],
): Array<{ providerId: string; poolKey: string }> {
  const baseIds = new Set(json.capabilityHosts.map((host) => host.id));
  const claimedKeys = new Set<string>();
  const claimedProviderIds = new Set<string>();
  const providers: Array<{ providerId: string; poolKey: string }> = [];
  const add = (poolKey: string, providerId: string): void => {
    if (claimedKeys.has(poolKey) || claimedProviderIds.has(providerId)) return;
    claimedKeys.add(poolKey);
    claimedProviderIds.add(providerId);
    providers.push({ providerId, poolKey });
  };
  for (const host of json.capabilityHosts) add(host.catalogProviderId, host.id);
  for (const decl of json.customProviders ?? []) {
    if (baseIds.has(decl.provider_id)) continue;
    add(decl.provider_id, decl.provider_id);
  }
  for (const poolKey of poolKeys) add(poolKey, poolKey);
  return providers;
}

/**
 * The run's credential store — IN MEMORY, and the ONLY place it is constructed.
 *
 * Exported so every runtime entry point shares this one definition: the
 * container runner (below) and `scripts/live-smoke-evidence.ts`. A caller that
 * builds its own store can drift back to a file path, which is how the
 * exposure returned once already. The signature takes NO path for that reason
 * — there is no argument through which a caller could make it disk-backed.
 * `:memory:` is SQLite's in-memory database: no `<agentDir>/agent.db`, no
 * `-wal`/`-shm`, so the review agent's own read/grep/glob have nothing to find.
 */
export function createInMemoryAuthStorage(): Promise<AuthStorage> {
  return AuthStorage.create(":memory:");
}

/**
 * Load the transported credential pool into the run's credential store.
 *
 * The store is IN MEMORY (`createInMemoryAuthStorage`): `<agentDir>` keeps
 * only the synthesized models.yml, so there is no credential database for the
 * session's own read/grep/glob tools to find — the review agent cannot read
 * the App's key pool out of its own run directory. The returned instance is
 * the one every `createAgentSession` call must receive; without it the SDK
 * recreates `<agentDir>/agent.db` and the exposure returns.
 *
 * One `{type:"api_key", source:"login"}` row per transported key, in payload
 * order (the entry is an array for a provider). `source: "login"` ranks ABOVE
 * the provider env var in the SDK's credential cascade, which is what lets the
 * runtime rotate across the pool — the synthesized models.yml deliberately pins
 * no `apiKey` (a tier-2 config override would suppress this pool entirely).
 *
 * Fail-closed, and BEFORE anything is written: the stdin payload is validated
 * (packages/shared/src/credential-payload) as the first statement, so an unreadable payload, a
 * missing/empty pool array or a non-string/empty entry aborts the run before
 * any credential exists and before the runtime starts — never a partial pool.
 * Diagnostics carry provider id + pool size only; key VALUES are never logged
 * or thrown.
 */
async function loadCredentialPool(json: RunnerInputJson, payload: string): Promise<AuthStorage> {
  const pools = decodeCredentialPayload(payload);
  const loaded: Array<{ providerId: string; keys: string[] }> = [];
  for (const { providerId, poolKey } of poolProviders(json, Object.keys(pools))) {
    const keys = pools[poolKey];
    if (keys === undefined) continue; // no pool transported for this provider
    loaded.push({ providerId, keys });
  }
  // A keyless run still gets an instance: the session must never fall back to
  // discoverAuthStorage(agentDir), which would create the database on disk.
  const storage = await createInMemoryAuthStorage();
  if (loaded.length === 0) return storage;

  try {
    for (const { providerId, keys } of loaded) {
      await storage.credentials.set(
        providerId,
        keys.map((key) => ({ type: "api_key" as const, key, source: "login" as const })),
      );
      // Provider id + pool size only — never a key value.
      console.error(JSON.stringify({ event: "credential_pool", provider: providerId, pool_size: keys.length }));
    }
  } catch (error) {
    // A failed write must not leave the half-loaded store open; the caller
    // aborts the run on this throw, so nothing else holds it.
    storage.close();
    throw error;
  }
  return storage;
}

/**
 * The credential payload source: this process's STDIN — the exec pipe the
 * consumer writes the payload into and then closes (that close is the EOF this
 * read waits for). `Bun.stdin.text()` reads to EOF; an empty result is the
 * keyless run shape. With no pipe (an interactive TTY) there is no EOF to
 * wait for, so the read is skipped and the run is keyless — the interactive
 * case never blocks.
 */
const readCredentialStdin = (): Promise<string> =>
  process.stdin.isTTY ? Promise.resolve("") : Bun.stdin.text();

/**
 * Run the CLI. Returns the process exit code; prints the mstar.review/v1
 * envelope JSON to stdout and diagnostics to stderr. Exported for
 * deterministic tests, which inject a fake `runtime` AND a fake credential
 * source (mock.module on this shared specifier is process-global and leaks
 * across bun test files).
 */
export async function main(
  argv: string[],
  runtime: AgentRuntime = ompAgentRuntime,
  readStdin: () => Promise<string> = readCredentialStdin,
): Promise<number> {
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

  // The per-run directory carries only the synthesized models.yml — the
  // credential rows live in an in-memory store (below), so no key material is
  // ever written to disk. The directory still exists only for this run, so it
  // is removed once the runtime has settled, on every path (success,
  // credential rejection, runtime failure). Best-effort: a removal failure is
  // reported and never replaces the run's own outcome.
  let agentDir: string | undefined;
  const removeAgentDir = (): void => {
    if (agentDir === undefined) return;
    try {
      rmSync(agentDir, { recursive: true, force: true });
    } catch (error) {
      console.error(`review: cannot remove credential directory ${agentDir}: ${(error as Error).message}`);
    }
  };
  // Closed once the runtime has settled — the store must outlive every session
  // the runtime creates (all three call sites receive this exact instance).
  let authStorage: AuthStorage | undefined;

  try {
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
      const dir = await writePerReviewModelsYaml(json.capabilityHosts, json.customProviders ?? [], (providerId) => {
        skippedCollisions.push(providerId);
      });
      agentDir = dir;
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
      // The transported credential pool arrives on STDIN and lands in an
      // IN-MEMORY store before any session exists: the synthesized models.yml
      // pins no apiKey, so the stored `login` rows are what the runtime rotates
      // across, and no file exists for the session's own tools to read.
      // Fail-closed — a payload that does not decode aborts the run here
      // (exit 1), with its own diagnostic (not the input-read label).
      try {
        authStorage = await loadCredentialPool(json, await readStdin());
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
        // on EVERY run — there is no baked models.yml to fall back to), and the
        // in-memory credential store the sessions must use.
        agentDir: dir,
        authStorage,
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
  } finally {
    // The store is released only after the runtime has settled — every
    // session it created held this instance for the whole run.
    authStorage?.close();
    removeAgentDir();
  }
}

// Auto-run only when executed directly.
if (import.meta.main) {
  process.exitCode = await main(Bun.argv.slice(2));
}
