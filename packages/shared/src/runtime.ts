/**
 * why: AgentRuntime port — interface signature locked verbatim to the
 * agent-runtime spec § TypeScript 端口.
 *
 * Pure types + constants only: zero omp SDK RUNTIME import, zero I/O, safe to
 * import from BOTH runtime faces (container Bun and workerd — module import
 * matrix, spec § 模块 import 矩阵). The one SDK reference is the TYPE-ONLY
 * `AuthStorage` import below: `verbatimModuleSyntax` erases it, so the
 * workerd bundle keeps no dependency on the container-only package.
 */

import type { MstarReviewV1 } from "@mstar-harness/engine";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent";
import type { RecheckDoc, RecheckInput, RecheckStatus } from "./recheck-wire";
import type { PrContext, ReportDoc } from "./report-wire";

/**
 * Full review-tier universe. `deep` is a first-class tier
 * (the parent-session path); unknown values are still rejected
 * at the port: throw, never a silent downgrade.
 */
export const REVIEW_LEVELS = ["quick", "default", "deep"] as const;
export type ReviewLevel = (typeof REVIEW_LEVELS)[number];

/**
 * why: Seats per Bun fan-out level — skills/mstar-audit/references/pr-review.md
 * § Review depth (tiers). `deep` deliberately has NO seats entry: it runs one
 * parent session, not a seat partition.
 */
export const REVIEW_SEATS: Record<Exclude<ReviewLevel, "deep">, number> = { quick: 1, default: 2 };

/**
 * Runner wall-clock maximum per review level (ms) — the shipped ceiling the
 * round-budget derivation (`src/review-budget.ts`) enforces, sized inside the
 * worst-case pre-runner cutoff: quick 480s, default 600s, deep 646s.
 * `Record<ReviewLevel, …>` makes a future level widen fail at compile time,
 * never silently fall back. Lives in the shared module because the in-image
 * runner (`packages/runner/src/recheck.ts`) reads the same table for its
 * unanchored outer-guard fallback and cannot import the workerd derivation.
 */
export const RUNNER_MAX_BUDGET_MS: Record<ReviewLevel, number> = {
  quick: 480_000,
  default: 600_000,
  deep: 646_000,
};

/**
 * One custom-provider declaration as the runner input JSON carries it
 * (AL-23-1): the SETTINGS declaration, keyless — the API key rides ONLY the
 * runner's STDIN credential payload, pooled per provider under its own id,
 * and the runner writes the
 * pool into the run's credential store before the session starts (never the
 * input JSON, never a synthesized models.yml, never a log line). The `api`
 * vocabulary (anthropic-messages | openai-completions | openai-responses |
 * typesafe — forwarded verbatim into the synthesized models.yml) and
 * the id/baseUrl bounds live dashboard-side (assertCustomProvider); the runner
 * guard validates shape only.
 */
export type CustomProviderDeclaration = {
  provider_id: string;
  base_url: string;
  api: string;
  model_ids: string[];
  /**
   * note: What the App owner stated about each of `model_ids` (keyed by that id).
   * ABSENT means nothing was stated — this is NOT the same statement as `{}`,
   * and the consumer never produces the empty object. An absent fact inside an
   * entry is absent too: the runner must not read zero as "unset".
   */
  models_meta?: CustomProviderModelsMeta;
};

/**
 * One declared model's metadata as the runner input JSON carries it. Shape
 * rule and validation live dashboard-side (`src/dashboard/app-config-store.ts`
 * validates the same fields on write); the runner guard re-checks the wire
 * types only. This declaration is MIRRORED here rather than imported because
 * the in-image runner graph is exactly `packages/runner/src` +
 * `packages/shared/src` and may not reach into Worker directories.
 *
 * `contextWindow` and `maxTokens` are what make the model a usable failover
 * candidate; `name`, `reasoning` and `input` may stay unset and stay unset.
 */
export type CustomProviderModelMeta = {
  /** note: Tokens the model can hold — a positive whole count. */
  contextWindow?: number;
  /** note: Token cap one completion may spend — a positive whole count. */
  maxTokens?: number;
  name?: string;
  reasoning?: boolean;
  input?: string[];
};

/** The per-model overlay of ONE declaration, keyed by a declared model id. */
export type CustomProviderModelsMeta = Record<string, CustomProviderModelMeta>;

/**
 * One capability-host model the runtime synthesizer materializes into the
 * per-review models.yml — the same shape the source-controlled
 * registry (src/contracts/sandbox-images.ts `SandboxImageHostModel`) carries.
 */
export type CapabilityHostModel = {
  id: string;
  name: string;
  reasoning: boolean;
  /** note: Input modalities (omp: e.g. ["text"]). */
  input: readonly string[];
  contextWindow: number;
  maxTokens: number;
};

/**
 * One optional base provider in the runner input JSON: the runner
 * materializes these into the base of every synthesized per-review models.yml.
 * KEYLESS static data. Production runs send an EMPTY array — an image declares
 * no provider, and a built-in one resolves from the SDK catalog — so this
 * shape exists for a runtime that ships its own base providers.
 *
 * The type lives HERE (not imported from the dashboard contract) because the
 * in-image runner graph is only `packages/runner/src` plus this package's src
 * (the sandbox image COPYs exactly those two trees —
 * tests/review/runtime-boundary derives the admitted set from the Dockerfile).
 */
export type CapabilityHost = {
  /** note: Host id — the selector prefix (e.g. `acme/fast-model`). */
  id: string;
  /** note: Providers/BYOK catalog id whose transported pool this host resolves from. */
  catalogProviderId: string;
  /** note: Retained registry metadata — no longer an active key-resolution input. */
  apiKeyEnv: string;
  baseUrl: string;
  api: string;
  /** note: Retained registry metadata — synthesis emits `auth: oauth` for every block. */
  auth: string;
  models: readonly CapabilityHostModel[];
};

export type AgentRuntimeRunInput = {
  level: ReviewLevel;
  /** note: 容器内 PR clone 的绝对路径（exec cwd；席位 worktree = 该只读 clone）。 */
  worktreePath: string;
  /** note: 每席可见的 recon 事实（owner/repo#pr、head sha、diff 统计、该席文件范围）。 */
  reconFacts: readonly string[];
  /** note: 模型选择链；SSOT = env `OMP_REVIEW_MODEL`（逗号分隔，容器注入）。 */
  modelSelectors: readonly string[];
  /**
   * note: Per-seat model overrides (spec Architect lock L3): agent
   * name → selector chain (B2 `parseModelChain` grammar, `:thinking` suffix
   * verbatim). OPTIONAL — absent = the legacy runner input, resolved
   * byte-identically to the pre-chains behavior. Shape is validated by the
   * runner guard (`parseRunnerInput`); the role vocabulary and selector
   * grammar live dashboard-side (`MODEL_ROLE_IDS` + its parse mirror), and
   * unknown agent names pass through inertly (the SDK consumes only names it
   * actually dispatches).
   */
  modelOverrides?: Record<string, string>;
  /**
   * why: Directory holding the synthesized COMPLETE per-review models.yml
   * (AL-23-1): the runner ALWAYS synthesizes
   * /tmp/omp-agent-<uuid>/models.yml — the (empty) capability base plus the
   * custom-provider declarations (a base id wins on collision) — and rides
   * the directory here REQUIRED for every omp
   * run; runtime-omp passes it to createAgentSession({ agentDir }). There is
   * no baked in-image models.yml to fall back to (deleted): a run
   * without a synthesized directory has no models.yml at all.
   */
  agentDir: string;
  /**
   * safety: The run's credential store, handed to the session IN MEMORY (never a
   * file): the runner loads the transported pool into it and every
   * `createAgentSession` call receives this exact instance. REQUIRED, even on
   * a keyless run — omitting it makes the SDK fall back to
   * `discoverAuthStorage(agentDir)`, which recreates `<agentDir>/agent.db` on
   * disk and hands the review agent's own read/grep/glob tools the App's key
   * pool. There is no file for a tool to find only because this instance is
   * always the one passed.
   */
  authStorage: AuthStorage;
  /**
   * note: Optional typed recheck input (spec review-lifecycle
   * §7.3/§7.8): the worker-captured assessment targets, trusted evidence
   * catalog and untrusted discussion snapshot for the SAME head this run
   * reviews (headSha equality is enforced downstream by validateRecheckDoc).
   * ABSENT = the legacy runtime input — no recheck child is started and the
   * result's `recheck` is null (byte-identical legacy behavior). Never a
   * second prompt/yield stream on any existing session.
   */
  recheck?: RecheckInput;
  /**
   * why: The ABSOLUTE instant this run's exec is killed at — `Date.now()` epoch ms
   * on the WORKER's clock, the deadline the caller already derived from its
   * round budget, never a duration. The runner anchors the shared review
   * deadline AT this instant, so the runner-input write and the runner's own
   * start/parse time spend one deadline instead of each being added to it, and
   * the seats stop before the exec kills the process. Worker and container
   * both read `Date.now()` on the same NTP-synced platform; the publication
   * tail absorbs the residual skew. ABSENT = the level's tier cap
   * (`OUTER_RUNNER_CAP_MS`) counted from process start, so a legacy runner
   * input keeps its behaviour exactly.
   */
  outerDeadlineEpochMs?: number;
  /**
   * note: The seat's ask budget in UTF-8 bytes, read once from the operator's
   * `review.recheck.assignment_max_bytes` system row. ABSENT = the runner's
   * documented default (`RECHECK_ASSIGNMENT_MAX_BYTES`), so a legacy input
   * keeps its behaviour byte-identically. It rides the input, NOT the frozen
   * `mstar.recheck-input/v1` document.
   */
  recheckAssignmentMaxBytes?: number;
  /**
   * note: Optional PR context (the description plus its closing issues) for the
   * report seat. ABSENT = no report seat runs and the result's `report` is
   * null, so the legacy runner input stays byte-identical.
   */
  prContext?: PrContext;
  /**
   * why: Optional caller abort for the whole run (port-level teardown). The review
   * paths join it with their own teardown signal before handing it to the
   * report seat, so a caller that abandons a run stops a seat that is already
   * in flight. ABSENT = the legacy runtime input: the report seat keeps only
   * its own budget timer.
   */
  signal?: AbortSignal;
};

/** One completed review run: the validated envelope plus its optional side documents. */
export type ReviewRunResult = {
  envelope: MstarReviewV1;
  recheck: RecheckDoc | null;
  /**
   * note: Why the recheck round ended — present whenever the input carried a
   * recheck document, so a round with `recheck: null` is still attributable
   * (budget skip / seat failure / invalid document). Absent = no recheck
   * round was requested.
   */
  recheckStatus?: RecheckStatus;
  /**
   * note: The narrative report (mstar.report/v1), or null when the run produced
   * none (no `prContext` in the input, the seat failed, or its document did
   * not pass `validateReportDoc`). Never throws: a missing report degrades the
   * published sections to `none`.
   */
  report: ReportDoc | null;
  /**
   * why: The `provider/model` the run's session ACTUALLY served on — observed by the
   * runner, never derived from the configured chain. ABSENT means no model
   * served (a round that failed before any prompt), which is a different fact
   * from "the chain head": a consumer that fell back to the chain head would
   * report what we asked for instead of what ran.
   */
  appliedModel?: string;
};

/**
 * The applied model's side document (fixed in-image path). The published
 * envelope is the engine's schema and must not grow fields, so this crosses the
 * container boundary as its OWN document — `{"appliedModel":"provider/model"}`.
 * ABSENCE of the file means no model served.
 */
export const APPLIED_MODEL_PATH = "/workspace/review-applied-model.json";

/** The side document's shape — one optional string, nothing else. */
export type AppliedModelDoc = { appliedModel: string };

/**
 * What `reviews.provider` may hold: the selector's `provider/model` prefix —
 * one slash, no whitespace. The consumer validates the document against THIS
 * shape before persisting it, so a container-authored file cannot land an
 * arbitrary string in the column.
 */
export const APPLIED_MODEL_PATTERN = /^[^/\s]+\/[^\s]+$/;

/** Bound on that value (the column is a short provider/model pair). */
export const APPLIED_MODEL_MAX_CHARS = 256;

export interface AgentRuntime {
  /**
   * note: Runs a full review, resolving ONLY with a validated `mstar.review/v1`
   * envelope (result shape `{ envelope, recheck, report }`: each side doc is
   * either a validated document or `null` — a seat failure, timeout or empty
   * output never masquerades as success and never loses the review body);
   * session / parse / validation failures all throw. A runner-attributed
   * wall-clock stop is neither envelope nor failure: it throws
   * `RunnerBudgetExhausted` (./budget-exhausted-wire.ts) carrying the seat
   * counts the CLI publishes as the exit-0
   * `mstar.review-budget-exhausted/v1` signal.
   */
  runReview(input: AgentRuntimeRunInput): Promise<ReviewRunResult>;
}

/**
 * Type guard narrowing an arbitrary runtime value (JSON wire input) onto the
 * tier universe. Membership is checked against REVIEW_LEVELS (NOT
 * REVIEW_SEATS, which has no `deep` key); a plain-array `includes` compares
 * values only, so Object.prototype keys ("toString", "constructor", …) are
 * rejected fail-fast at the port (qc3 F-302).
 */
export function isReviewLevel(value: unknown): value is ReviewLevel {
  return typeof value === "string" && (REVIEW_LEVELS as readonly string[]).includes(value);
}
