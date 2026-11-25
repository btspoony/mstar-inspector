/**
 * note: Container review-runner entry.
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
 *       - `capabilityHosts` — REQUIRED array, EMPTY on every production
 *         run: the image declares no provider and no model. The runner ALWAYS
 *         synthesizes a COMPLETE per-review models.yml
 *         (/tmp/omp-agent-<uuid>/models.yml) — the App's own declarations plus
 *         this (empty) base — and rides that directory as the runtime
 *         `agentDir` (required for every run). A non-empty entry is still
 *         accepted for a runtime that ships its own base providers;
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
 *         declaration whose id collides with a base provider is skipped
 *         (base wins, AL-23-1) with a structured stderr warn
 *         (id + count, no keys); absent/empty = the (empty) base alone.
 *       - `tokenUsageNonce` (string) — the consumer-issued run nonce the
 *         token-usage side document is stamped with; the consumer drops a
 *         document whose nonce is absent, malformed or foreign, so a stale
 *         document a failed clear left behind can never be read as this
 *         run's usage;
 *   - stdout carries ONLY one JSON document: the mstar.review/v1 envelope
 *     (validated by validateMstarReviewV1 inside the runtime), OR — when the
 *     runner's own deadline evidence stops the review — the
 *     mstar.review-budget-exhausted/v1 signal ({ schema, seatsDispatched,
 *     seatsStopped }) the runtime throws as `RunnerBudgetExhausted`. The
 *     signal is produced by runner code only: no model payload can supply
 *     it. All diagnostics to stderr;
 *   - optional `--recheck-out <path>` (spec review-lifecycle
 *     §7.8): when the runtime result carries a recheck document, its JSON is
 *     written to <path> BEFORE the envelope reaches stdout (a write failure
 *     → exit 1, no stdout). The round's STATUS is written to
 *     RECHECK_STATUS_PATH when a flag was given and the document write (if
 *     any) succeeded — including when the document is null (budget skip, seat
 *     failure, invalid document) — so a round that produced no document is
 *     still attributable; that write is best-effort and never fails the run.
 *     No flag writes nothing — absent flag/file leaves legacy behavior
 *     byte-identical. MSTAR_RECHECK_STATUS_PATH redirects the status target
 *     for tests only: no test may write the path a real runner uses;
 *   - optional `--report-out <path>`: the OPTIONAL report side document —
 *     written only when the runtime produced a report, BEFORE the envelope
 *     reaches stdout. Unlike the recheck document it feeds narrative only, so
 *     a write failure is a structured `report_write_failed` warn and the
 *     validated envelope still publishes (exit 0); the sections render `none`.
 *     The side-channel targets this run uses (each `--*-out` path, plus the
 *     status path when a recheck flag was given) are REMOVED before the runtime
 *     starts: the paths are fixed, so a retry or a re-delivered job would
 *     otherwise see an earlier attempt's document where a skipped/failed seat
 *     wrote nothing. A removal failure exits 1 as well;
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
import { join } from "node:path";
import { AuthStorage, ModelRegistry } from "@oh-my-pi/pi-coding-agent";
import {
  isReviewLevel,
  REVIEW_LEVELS,
  type AgentRuntime,
  type AgentRuntimeRunInput,
  type CapabilityHost,
  type CustomProviderDeclaration,
  type CustomProviderModelMeta,
  type CustomProviderModelsMeta,
} from "../../shared/src/runtime";
import { anchorRecheckDeadline } from "./recheck";
import { ompAgentRuntime, parseModelSelectors } from "./runtime-omp";
import {
  attributeChain,
  attributionEntries,
  formatFailureAttribution,
  walkSeatGates,
} from "./seat-failover-probe";
import { writePerReviewModelsYaml } from "./models-synthesis";
import {
  ReviewNoOutputFailure,
  isReviewBudgetExhaustedSignal,
  RunnerBudgetExhausted,
} from "../../shared/src/budget-exhausted-wire";
import { decodeCredentialPayload } from "../../shared/src/credential-payload";
import { APPLIED_MODEL_PATH, type AppliedModelDoc } from "../../shared/src/runtime";
import { RECHECK_STATUS_PATH, type RecheckInput, type RecheckStatus } from "../../shared/src/recheck-wire";
import { isReviewCoverage } from "../../shared/src/coverage-wire";
import { type PrContext } from "../../shared/src/report-wire";
import { TOKEN_USAGE_PATH, type TokenUsageDoc } from "../../shared/src/token-usage-wire";

const USAGE =
  `usage: bun run runner.ts --level <${REVIEW_LEVELS.join(", ")}> --input <json-file> ` +
  "[--recheck-out <path>] [--report-out <path>] " +
  "(input JSON: { capabilityHosts: [{ id, catalogProviderId, apiKeyEnv, baseUrl, api, auth, models }], " +
  "worktreePath?: string, reconFacts?: string[], modelOverrides?: Record<string, string>, " +
  "recheckAssignmentMaxBytes?: integer > 0, outerDeadlineEpochMs?: integer epoch ms, " +
  "tokenUsageNonce?: string, " +
  "prContext?: { prBody: string, issues: [{ number, title, body }] } })";

function parseCustomProviderEntry(entry: unknown, index: number): CustomProviderDeclaration {
  const at = `input JSON field \`customProviders\`[${index}]`;
  if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
    throw new Error(`${at} must be an object`);
  }
  const decl = entry as Record<string, unknown>;
  if (typeof decl.provider_id !== "string") {
    throw new Error(`${at}.provider_id must be a string`);
  }
  if (typeof decl.base_url !== "string") {
    throw new Error(`${at}.base_url must be a string`);
  }
  if (typeof decl.api !== "string") {
    throw new Error(`${at}.api must be a string`);
  }
  if (!Array.isArray(decl.model_ids) || decl.model_ids.some((id: unknown) => typeof id !== "string")) {
    throw new Error(`${at}.model_ids must be an array of strings`);
  }
  const declaration: CustomProviderDeclaration = {
    provider_id: decl.provider_id,
    base_url: decl.base_url,
    api: decl.api,
    model_ids: [...decl.model_ids],
  };
  if (decl.models_meta !== undefined) {
    declaration.models_meta = parseCustomProviderModelsMeta(
      decl.models_meta,
      declaration.model_ids,
      `${at}.models_meta`,
    );
  }
  return declaration;
}

function parseCustomProviderModelsMeta(
  raw: unknown,
  modelIds: readonly string[],
  at: string,
): CustomProviderModelsMeta {
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${at} must be an object keyed by model id when present`);
  }
  const meta: CustomProviderModelsMeta = {};
  for (const [modelId, value] of Object.entries(raw as Record<string, unknown>)) {
    const atModel = `${at}[${JSON.stringify(modelId)}]`;
    if (!modelIds.includes(modelId)) {
      throw new Error(`${atModel} names a model that is not in model_ids`);
    }
    if (value === null || typeof value !== "object" || Array.isArray(value)) {
      throw new Error(`${atModel} must be an object`);
    }
    const entry: CustomProviderModelMeta = {};
    for (const [field, fieldValue] of Object.entries(value as Record<string, unknown>)) {
      if (field === "contextWindow" || field === "maxTokens") {
        if (typeof fieldValue !== "number" || !Number.isInteger(fieldValue) || fieldValue <= 0) {
          throw new Error(`${atModel}.${field} must be a positive integer when present`);
        }
        entry[field] = fieldValue;
      } else if (field === "name") {
        if (typeof fieldValue !== "string") {
          throw new Error(`${atModel}.name must be a string when present`);
        }
        entry.name = fieldValue;
      } else if (field === "reasoning") {
        if (typeof fieldValue !== "boolean") {
          throw new Error(`${atModel}.reasoning must be a boolean when present`);
        }
        entry.reasoning = fieldValue;
      } else if (field === "input") {
        if (!Array.isArray(fieldValue) || fieldValue.some((modality) => typeof modality !== "string")) {
          throw new Error(`${atModel}.input must be an array of strings when present`);
        }
        entry.input = [...fieldValue];
      } else {
        throw new Error(`${atModel}.${field} is not a known model-metadata field`);
      }
    }
    meta[modelId] = entry;
  }
  return meta;
}

/** Validated shape of the --input JSON file. */
export type RunnerInputJson = {
  capabilityHosts: CapabilityHost[];
  worktreePath?: string;
  reconFacts?: string[];
  modelOverrides?: Record<string, string>;
  customProviders?: CustomProviderDeclaration[];
  recheck?: RecheckInput;
  recheckAssignmentMaxBytes?: number;
  outerDeadlineEpochMs?: number;
  seats?: number;
  prContext?: PrContext;
  tokenUsageNonce?: string;
};

function parseArgs(argv: string[]): {
  level: string;
  inputPath: string;
  recheckOutPath?: string;
  reportOutPath?: string;
} {
  let level: string | undefined;
  let inputPath: string | undefined;
  let recheckOutPath: string | undefined;
  let reportOutPath: string | undefined;
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (flag === "--level" && value !== undefined && level === undefined) {
      level = value;
    } else if (flag === "--input" && value !== undefined && inputPath === undefined) {
      inputPath = value;
    } else if (flag === "--recheck-out" && value !== undefined && recheckOutPath === undefined) {
      recheckOutPath = value;
    } else if (flag === "--report-out" && value !== undefined && reportOutPath === undefined) {
      reportOutPath = value;
    } else {
      throw new Error(USAGE);
    }
  }
  if (level === undefined || inputPath === undefined) {
    throw new Error(USAGE);
  }
  return { level, inputPath, recheckOutPath, reportOutPath };
}

/** Validate the untrusted --input JSON with small type guards (no schema dep here). */
export function parseRunnerInput(parsed: unknown): RunnerInputJson {
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("input JSON must be an object");
  }
  const record = parsed as Record<string, unknown>;
  const input = {} as RunnerInputJson;
  if (!Array.isArray(record.capabilityHosts)) {
    throw new Error("input JSON field `capabilityHosts` must be an array of capability hosts");
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
    // invariant: (AL-23-1): shape validation ONLY here — the id
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
    input.customProviders = list.map((entry, index) => parseCustomProviderEntry(entry, index));
  }
  if (record.recheck !== undefined) {
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
  if (record.recheckAssignmentMaxBytes !== undefined) {
    const maxBytes = record.recheckAssignmentMaxBytes;
    if (typeof maxBytes !== "number" || !Number.isInteger(maxBytes) || maxBytes <= 0) {
      throw new Error("input JSON field `recheckAssignmentMaxBytes` must be a positive integer when present");
    }
    input.recheckAssignmentMaxBytes = maxBytes;
  }
  if (record.outerDeadlineEpochMs !== undefined) {
    const outerDeadlineEpochMs = record.outerDeadlineEpochMs;
    if (
      typeof outerDeadlineEpochMs !== "number" ||
      !Number.isInteger(outerDeadlineEpochMs) ||
      outerDeadlineEpochMs <= 0 ||
      outerDeadlineEpochMs > Number.MAX_SAFE_INTEGER
    ) {
      throw new Error(
        "input JSON field `outerDeadlineEpochMs` must be a positive integer epoch in ms when present",
      );
    }
    input.outerDeadlineEpochMs = outerDeadlineEpochMs;
  }
  if (record.seats !== undefined) {
    const seats = record.seats;
    if (typeof seats !== "number" || !Number.isInteger(seats) || seats < 1) {
      throw new Error("input JSON field `seats` must be a positive integer when present");
    }
    input.seats = seats;
  }
  if (record.prContext !== undefined) {
    const context = record.prContext;
    if (context === null || typeof context !== "object" || Array.isArray(context)) {
      throw new Error("input JSON field `prContext` must be an object when present");
    }
    const prContext = context as Record<string, unknown>;
    if (typeof prContext.prBody !== "string") {
      throw new Error("input JSON field `prContext`.prBody must be a string");
    }
    if (!Array.isArray(prContext.issues)) {
      throw new Error("input JSON field `prContext`.issues must be an array");
    }
    const issues = prContext.issues.map((entry, index) => {
      if (entry === null || typeof entry !== "object" || Array.isArray(entry)) {
        throw new Error(`input JSON field \`prContext\`.issues[${index}] must be an object`);
      }
      const issue = entry as Record<string, unknown>;
      if (typeof issue.number !== "number" || !Number.isInteger(issue.number) || issue.number <= 0) {
        throw new Error(`input JSON field \`prContext\`.issues[${index}].number must be a positive integer`);
      }
      if (typeof issue.title !== "string" || typeof issue.body !== "string") {
        throw new Error(`input JSON field \`prContext\`.issues[${index}].title/.body must be strings`);
      }
      return { number: issue.number, title: issue.title, body: issue.body };
    });
    input.prContext = { prBody: prContext.prBody, issues };
  }
  if (record.tokenUsageNonce !== undefined) {
    const nonce = record.tokenUsageNonce;
    if (typeof nonce !== "string" || nonce.trim() === "") {
      throw new Error("input JSON field `tokenUsageNonce` must be a non-blank string when present");
    }
    input.tokenUsageNonce = nonce;
  }
  return input;
}

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
 * safety: Load the transported credential pool into the run's credential store.
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
    if (keys === undefined) continue;
    loaded.push({ providerId, keys });
  }
  const storage = await createInMemoryAuthStorage();
  if (loaded.length === 0) return storage;

  try {
    for (const { providerId, keys } of loaded) {
      await storage.credentials.set(
        providerId,
        keys.map((key) => ({ type: "api_key" as const, key, source: "login" as const })),
      );
      console.error(JSON.stringify({ event: "credential_pool", provider: providerId, pool_size: keys.length }));
    }
  } catch (error) {
    storage.close();
    throw error;
  }
  return storage;
}

/**
 * The credential payload source: this process's STDIN — the exec pipe the
 * consumer writes the payload into.
 *
 * The payload is a self-describing JSON document, so its END IS KNOWABLE
 * WITHOUT EOF: the read stops as soon as the accumulated text parses. That
 * matters because relying on EOF makes the run hostage to the pipe close: when
 * a write-side close does not surface as EOF, the read never returns, the
 * process emits nothing on either stream, and the only visible symptom is the
 * outer exec bound killing a silent run.
 *
 * EOF remains a legitimate end (an empty stream is the keyless run shape), and
 * so does a TTY — there is no pipe to read, so the run is keyless. The wait is
 * additionally BOUNDED: a pipe that delivers neither a complete document nor
 * EOF is a broken transport, and the rejection names it instead of hiding
 * behind a timeout.
 */
export const CREDENTIAL_STDIN_TIMEOUT_MS = 30_000;

async function* defaultStdinChunks(): AsyncGenerator<Uint8Array> {
  if (process.stdin.isTTY) return;
  for await (const chunk of Bun.stdin.stream()) yield chunk;
}

function isCompletePayload(text: string): boolean {
  if (!text.trimEnd().endsWith("}")) return false;
  try {
    JSON.parse(text);
    return true;
  } catch {
    return false;
  }
}

export async function readCredentialStdin(
  chunks: AsyncIterable<Uint8Array> = defaultStdinChunks(),
  timeoutMs: number = CREDENTIAL_STDIN_TIMEOUT_MS,
): Promise<string> {
  const collect = (async (): Promise<string> => {
    const decoder = new TextDecoder();
    let acc = "";
    for await (const chunk of chunks) {
      acc += decoder.decode(chunk, { stream: true });
      if (isCompletePayload(acc)) return acc;
    }
    return acc;
  })();
  const { promise: bound, reject } = Promise.withResolvers<never>();
  const timer = setTimeout(
    () =>
      reject(
        new Error(`credential stdin delivered neither a complete payload nor EOF within ${timeoutMs}ms`),
      ),
    timeoutMs,
  );
  try {
    return await Promise.race([collect, bound]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Write the recheck round's status document to `path` (production:
 * RECHECK_STATUS_PATH; `MSTAR_RECHECK_STATUS_PATH` redirects it for tests, so
 * no suite writes the file a real runner owns). The target is a parameter
 * only so a test can write into its own temp dir instead of the one path a
 * real runner uses. Best-effort by contract: the status is attribution
 * evidence, so a failure to write it must never turn a completed review into
 * a failed run — it is logged and swallowed. Exported so the write path is
 * testable without a container.
 */
export function writeRecheckStatus(
  status: RecheckStatus,
  path: string = process.env.MSTAR_RECHECK_STATUS_PATH?.trim() || RECHECK_STATUS_PATH,
): void {
  try {
    writeFileSync(path, JSON.stringify(status));
  } catch (error) {
    console.error(`review: cannot write recheck status ${path}: ${(error as Error).message}`);
  }
}

/**
 * The failed round's per-selector disposition, produced by the seat-failover
 * probe's OWN gate walker (one rule, one place). No live context exists at
 * this point, so the context gate is reported as not evaluated rather than
 * guessed. A throw here is swallowed into a BOUNDED line — every failure
 * path shares the formatter's budget, including this one: attribution is
 * diagnosis, never a second failure.
 */
export function chainAttributionBlock(
  cause: string,
  chain: readonly string[],
  agentDir: string,
  authStorage: AuthStorage,
): string {
  try {
    const registry = new ModelRegistry(authStorage, join(agentDir, "models.yml"));
    return formatFailureAttribution(
      cause,
      attributionEntries(attributeChain(walkSeatGates({ registry, chain }))),
    );
  } catch (error) {
    return formatFailureAttribution(cause, [`chain attribution unavailable: ${(error as Error).message}`]);
  }
}
/**
 * Remove the token-usage document without letting a removal fault become a
 * second failure — the startup clear and the empty-fold clear share it. If
 * unlink fails, the stale content is truncated to zero bytes as a fallback
 * where the file stays writable, so the reader sees absence or "not a
 * document", never this run reading a previous run's usage. Both legs are
 * logged, never thrown: usage is analysis data, not a gate.
 */
function clearTokenUsageDoc(path: string): boolean {
  try {
    rmSync(path, { force: true });
    return true;
  } catch (error) {
    console.error(
      JSON.stringify({
        event: "token_usage_clear_failed",
        path,
        reason: (error as Error).message,
      }),
    );
  }
  try {
    writeFileSync(path, "");
  } catch {
    // Removal and truncation both failed; the clear already logged its fault.
  }
  return false;
}

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
  statusPath: string = process.env.MSTAR_RECHECK_STATUS_PATH?.trim() || RECHECK_STATUS_PATH,
  appliedModelPath: string = APPLIED_MODEL_PATH,
  tokenUsagePath: string = TOKEN_USAGE_PATH,
): Promise<number> {
  let level: string;
  let inputPath: string;
  let recheckOutPath: string | undefined;
  let reportOutPath: string | undefined;
  try {
    ({ level, inputPath, recheckOutPath, reportOutPath } = parseArgs(argv));
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }
  if (!isReviewLevel(level)) {
    console.error(
      `review: unknown level ${JSON.stringify(level)} (expected one of: ${REVIEW_LEVELS.join(", ")})`,
    );
    return 2;
  }
  const stale: string[] = [];
  if (recheckOutPath !== undefined) stale.push(recheckOutPath, statusPath);
  if (reportOutPath !== undefined) stale.push(reportOutPath);
  stale.push(appliedModelPath);
  for (const path of stale) {
    try {
      rmSync(path, { force: true });
    } catch (error) {
      console.error(`review: cannot remove stale side-channel file ${path}: ${(error as Error).message}`);
      return 1;
    }
  }
  // why: Unlike the paths above, the token-usage document is analysis-only —
  // its startup clear degrades to a logged fault and the run still reaches
  // runReview. Rule: an unremovable stale document is a capture fault for
  // this run — the write below is suppressed so this run's own write path
  // cannot replace the survivor; the consumer's nonce check then provably
  // rejects whatever old document is still readable there.
  const tokenUsageClearFailed = !clearTokenUsageDoc(tokenUsagePath);
  let tokenUsageNonce: string | undefined;
  let agentDir: string | undefined;
  const removeAgentDir = (): void => {
    if (agentDir === undefined) return;
    try {
      rmSync(agentDir, { recursive: true, force: true });
    } catch (error) {
      console.error(`review: cannot remove credential directory ${agentDir}: ${(error as Error).message}`);
    }
  };
  let authStorage: AuthStorage | undefined;

  try {
    const chain = parseModelSelectors(Bun.env.OMP_REVIEW_MODEL);
    let input: AgentRuntimeRunInput;
    try {
      const parsed: unknown = JSON.parse(readFileSync(inputPath, "utf8"));
      const json = parseRunnerInput(parsed);
      tokenUsageNonce = json.tokenUsageNonce;
      anchorRecheckDeadline(Date.now(), level, json.outerDeadlineEpochMs);
      const skippedCollisions: string[] = [];
      const dir = await writePerReviewModelsYaml(json.capabilityHosts, json.customProviders ?? [], (providerId) => {
        skippedCollisions.push(providerId);
      });
      agentDir = dir;
      for (const providerId of skippedCollisions) {
        console.error(
          JSON.stringify({
            event: "custom_provider_collision",
            provider_id: providerId,
            count: skippedCollisions.length,
          }),
        );
      }
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
        modelSelectors: chain,
        ...(json.modelOverrides !== undefined ? { modelOverrides: json.modelOverrides } : {}),
        ...(json.recheck !== undefined ? { recheck: json.recheck } : {}),
        ...(json.recheckAssignmentMaxBytes !== undefined
          ? { recheckAssignmentMaxBytes: json.recheckAssignmentMaxBytes }
          : {}),
        ...(json.outerDeadlineEpochMs !== undefined
          ? { outerDeadlineEpochMs: json.outerDeadlineEpochMs }
          : {}),
        ...(json.prContext !== undefined ? { prContext: json.prContext } : {}),
        ...(json.seats !== undefined ? { seats: json.seats } : {}),
        agentDir: dir,
        authStorage,
      };
    } catch (error) {
      console.error(`review: cannot read runner input ${inputPath}: ${(error as Error).message}`);
      return 1;
    }

    try {
      const { envelope, coverage, recheck, recheckStatus, report, appliedModel, tokenUsage } = await runtime.runReview(input);
      if (appliedModel === undefined) {
        try {
          rmSync(appliedModelPath, { force: true });
        } catch (error) {
          console.error(
            JSON.stringify({
              event: "applied_model_clear_failed",
              path: appliedModelPath,
              reason: (error as Error).message,
            }),
          );
        }
      } else {
        try {
          writeFileSync(appliedModelPath, JSON.stringify({ appliedModel } satisfies AppliedModelDoc));
        } catch (error) {
          console.error(
            JSON.stringify({
              event: "applied_model_write_failed",
              path: appliedModelPath,
              reason: (error as Error).message,
            }),
          );
        }
      }
      // why: Same side-document discipline as appliedModel — the document is
      // stamped with THIS run's consumer-issued nonce, so a stale document a
      // failed clear left readable is rejected consumer-side instead of being
      // read as this run's usage. A missing input nonce or a failed clear
      // suppresses the write (a nonce-less document is never consumable); a
      // capture or write fault is logged, never thrown: usage is analysis
      // data, not a gate.
      if (tokenUsageClearFailed || tokenUsageNonce === undefined || tokenUsage === undefined || tokenUsage.length === 0) {
        clearTokenUsageDoc(tokenUsagePath);
      } else {
        try {
          writeFileSync(
            tokenUsagePath,
            JSON.stringify({ version: 1, nonce: tokenUsageNonce, buckets: tokenUsage } satisfies TokenUsageDoc),
          );
        } catch (error) {
          console.error(
            JSON.stringify({
              event: "token_usage_write_failed",
              path: tokenUsagePath,
              reason: (error as Error).message,
            }),
          );
        }
      }
      if (recheckOutPath !== undefined && recheck !== null) {
        try {
          writeFileSync(recheckOutPath, JSON.stringify(recheck));
        } catch (error) {
          console.error(`review: cannot write recheck output ${recheckOutPath}: ${(error as Error).message}`);
          return 1;
        }
      }
      if (reportOutPath !== undefined && report !== null) {
        try {
          writeFileSync(reportOutPath, JSON.stringify(report));
        } catch (error) {
          console.error(
            JSON.stringify({
              event: "report_write_failed",
              path: reportOutPath,
              reason: (error as Error).message,
            }),
          );
        }
      }
      if (recheckOutPath !== undefined && recheckStatus !== undefined) {
        writeRecheckStatus(recheckStatus, statusPath);
      }
      // why: `coverage` rides BESIDE the engine envelope, never inside it —
      // `mstar.review/v1` is closed and the consumer keys off its shape. The
      // block is runner-owned, so a malformed one is refused here instead of
      // being published as a claim the round cannot support.
      if (coverage !== undefined && !isReviewCoverage(coverage)) {
        console.error(
          `review: coverage block failed its own shape: ${JSON.stringify(coverage).slice(0, 300)}`,
        );
        return 1;
      }
      console.log(JSON.stringify(coverage === undefined ? envelope : { ...envelope, coverage }));
      return 0;
    } catch (error) {
      if (error instanceof RunnerBudgetExhausted) {
        const signal = error.signal();
        if (!isReviewBudgetExhaustedSignal(signal)) {
          console.error(`review: budget-exhausted signal failed its own shape: ${JSON.stringify(signal)}`);
          return 1;
        }
        if (error.appliedModel !== undefined) {
          try {
            writeFileSync(appliedModelPath, JSON.stringify({ appliedModel: error.appliedModel } satisfies AppliedModelDoc));
          } catch (writeError) {
            console.error(
              JSON.stringify({
                event: "applied_model_write_failed",
                path: appliedModelPath,
                reason: (writeError as Error).message,
              }),
            );
          }
        }
        if (recheckOutPath !== undefined && error.recheck !== null) {
          try {
            writeFileSync(recheckOutPath, JSON.stringify(error.recheck));
          } catch (writeError) {
            console.error(`review: cannot write recheck output ${recheckOutPath}: ${(writeError as Error).message}`);
          }
        }
        if (recheckOutPath !== undefined && error.recheckStatus !== undefined) {
          writeRecheckStatus(error.recheckStatus, statusPath);
        }
        console.log(JSON.stringify(signal));
        return 0;
      }
      // why: A no-output failure is still a FAILURE (exit 1, worker records it),
      // but the recheck document it managed to settle is real evidence and is
      // written exactly as the budget-stop path writes it.
      if (error instanceof ReviewNoOutputFailure) {
        if (recheckOutPath !== undefined && error.recheck !== null) {
          try {
            writeFileSync(recheckOutPath, JSON.stringify(error.recheck));
          } catch (writeError) {
            console.error(`review: cannot write recheck output ${recheckOutPath}: ${(writeError as Error).message}`);
          }
        }
        if (recheckOutPath !== undefined && error.recheckStatus !== undefined) {
          writeRecheckStatus(error.recheckStatus, statusPath);
        }
      }
      const cause = (error as Error).message;
      if (agentDir !== undefined && authStorage !== undefined) {
        console.error(chainAttributionBlock(cause, chain, agentDir, authStorage));
      } else {
        console.error(formatFailureAttribution(cause, []));
      }
      return 1;
    }
  } finally {
    authStorage?.close();
    removeAgentDir();
  }
}

if (import.meta.main) {
  process.exitCode = await main(Bun.argv.slice(2));
}
