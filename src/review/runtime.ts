/**
 * AgentRuntime port (plan 07 Task 2) — interface signature locked verbatim to
 * `.mstar/iterations/v0.3/specs/agent-runtime.md` § TypeScript 端口.
 *
 * Pure types + constants only: zero omp SDK import, zero I/O, safe to import
 * from BOTH runtime faces (container Bun and workerd — module import matrix,
 * spec § 模块 import 矩阵).
 */

import type { MstarReviewV1 } from "@mstar-harness/engine";

/**
 * Full review-tier universe (plan 09 Task 1). `deep` is a first-class tier
 * (parent-session path lands in Task 2); unknown values are still rejected
 * at the port: throw, never a silent downgrade.
 */
export const REVIEW_LEVELS = ["quick", "default", "deep"] as const;
export type ReviewLevel = (typeof REVIEW_LEVELS)[number];

/**
 * Seats per Bun fan-out level — commands/amazing-pr-review.md 档位表.
 * `deep` deliberately has NO seats entry: it runs one parent session, not a
 * seat partition (plan 09 Task 2).
 */
export const REVIEW_SEATS: Record<Exclude<ReviewLevel, "deep">, number> = { quick: 1, default: 2 };

/**
 * One custom-provider declaration as the runner input JSON carries it (plan
 * 23 Task 3, AL-23-1): the SETTINGS declaration, keyless — the API key rides
 * ONLY the container exec env under CUSTOM_<UPPER_SNAKE(id)>_API_KEY (never
 * the input JSON, never a synthesized models.yml, never a log line). The
 * `api` vocabulary (anthropic-messages | openai-completions |
 * openai-responses) and the id/baseUrl bounds live dashboard-side
 * (assertCustomProvider); the runner guard validates shape only.
 */
export type CustomProviderDeclaration = {
  provider_id: string;
  base_url: string;
  api: string;
  model_ids: string[];
};

/**
 * AL-23-1 env-name contract fragments for custom-provider API keys. The full
 * mapping is CUSTOM_<UPPER_SNAKE(provider_id)>_API_KEY — provider ids are
 * store-enforced `[a-z0-9][a-z0-9-]{0,63}` (hyphen → underscore, uppercased).
 * Lives HERE (next to CustomProviderDeclaration) because the sandbox image
 * COPYs only src/review (sandbox-image/Dockerfile:88): the in-image runner
 * module graph must never import outside this directory. The Worker-side
 * SSOT stays single-source — src/pipeline/provider-catalog.ts re-exports
 * these (zero duplicated literals).
 */
export const CUSTOM_PROVIDER_ENV_PREFIX = "CUSTOM_";
export const CUSTOM_PROVIDER_ENV_SUFFIX = "_API_KEY";

/**
 * One capability-host model the runtime synthesizer materializes into the
 * per-review models.yml (plan 37 Task 2) — the same shape the source-controlled
 * registry (src/contracts/sandbox-images.ts `SandboxImageHostModel`) carries.
 */
export type CapabilityHostModel = {
  id: string;
  name: string;
  reasoning: boolean;
  /** Input modalities (omp: e.g. ["text"]). */
  input: readonly string[];
  contextWindow: number;
  maxTokens: number;
};

/**
 * One capability host of the App's selected sandbox image, as the runner input
 * JSON carries it (plan 37 Task 2): the runner materializes these into the
 * base of every synthesized per-review models.yml. KEYLESS static data —
 * `apiKeyEnv` is the ENV VAR NAME the host's key resolves from at request
 * time; host ids are runtime capabilities, NOT Providers catalog ids (omp's
 * `ark-plan` resolves its key through catalogProviderId `ark` / ARK_API_KEY).
 *
 * Structurally mirrors the registry's `SandboxImageHost` (src/contracts/
 * sandbox-images.ts): the consumer passes the resolved registry entry's hosts
 * verbatim into the runner input. The mirror lives HERE (not an import)
 * because the in-image runner module graph must stay inside src/review (the
 * sandbox image COPYs only this directory — tests/review/runtime-boundary
 * enforces it); the consumer-side contract import keeps the data single-sourced.
 */
export type CapabilityHost = {
  /** Host id — the selector prefix (e.g. `ark-plan/deepseek-v4-flash`). */
  id: string;
  /** Providers/BYOK catalog id whose env name carries this host's key. */
  catalogProviderId: string;
  apiKeyEnv: string;
  baseUrl: string;
  api: string;
  auth: string;
  models: readonly CapabilityHostModel[];
};

/**
 * Env var name for a custom-provider API key (plan 23 Task 3, AL-23-1): a
 * total function — any id maps to a syntactically valid env var name. The
 * queue consumer injects the decrypted key under this name and the runner's
 * synthesized per-review models.yml references the SAME name (`apiKey:
 * CUSTOM_<ID>_API_KEY` — omp resolves env first, literal fallback, so the
 * consumer-side injection closes the "declaration ⇒ key ⇒ env" loop).
 */
export function customProviderEnvName(providerId: string): string {
  return `${CUSTOM_PROVIDER_ENV_PREFIX}${providerId.toUpperCase().replace(/-/g, "_")}${CUSTOM_PROVIDER_ENV_SUFFIX}`;
}

export type AgentRuntimeRunInput = {
  level: ReviewLevel;
  /** 容器内 PR clone 的绝对路径（exec cwd；席位 worktree = 该只读 clone）。 */
  worktreePath: string;
  /** 每席可见的 recon 事实（owner/repo#pr、head sha、diff 统计、该席文件范围）。 */
  reconFacts: readonly string[];
  /** 模型选择链；SSOT = env `OMP_REVIEW_MODEL`（逗号分隔，容器注入）。 */
  modelSelectors: readonly string[];
  /**
   * Per-seat model overrides (plan 17 B6, spec Architect lock L3): agent
   * name → selector chain (B2 `parseModelChain` grammar, `:thinking` suffix
   * verbatim). OPTIONAL — absent = the legacy runner input, resolved
   * byte-identically to the pre-plan-17 behavior. Shape is validated by the
   * runner guard (`parseRunnerInput`); the role vocabulary and selector
   * grammar live dashboard-side (`MODEL_ROLE_IDS` + its parse mirror), and
   * unknown agent names pass through inertly (the SDK consumes only names it
   * actually dispatches).
   */
  modelOverrides?: Record<string, string>;
  /**
   * Directory holding the synthesized COMPLETE per-review models.yml (plan 23
   * Task 3, AL-23-1; plan 37 Task 2): the runner ALWAYS synthesizes
   * /tmp/omp-agent-<uuid>/models.yml — capability hosts of the App's selected
   * image as the base, custom-provider declarations merged in (capability ids
   * win on collision) — and rides the directory here REQUIRED for every omp
   * run; runtime-omp passes it to createAgentSession({ agentDir }). There is
   * no baked in-image models.yml to fall back to (plan 37 deleted it): a run
   * without a synthesized directory has no models.yml at all.
   */
  agentDir: string;
};

export interface AgentRuntime {
  /**
   * 跑一次审查。仅以「已通过 validateMstarReviewV1 的 mstar.review/v1」
   * resolve；session/解析/校验失败一律 throw（绝不返回 M1 形状冒充成功）。
   */
  runReview(input: AgentRuntimeRunInput): Promise<MstarReviewV1>;
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
