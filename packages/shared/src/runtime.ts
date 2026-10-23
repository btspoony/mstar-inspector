/**
 * AgentRuntime port — interface signature locked verbatim to the
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
import type { RecheckDoc, RecheckInput } from "./recheck-wire";

/**
 * Full review-tier universe. `deep` is a first-class tier
 * (the parent-session path); unknown values are still rejected
 * at the port: throw, never a silent downgrade.
 */
export const REVIEW_LEVELS = ["quick", "default", "deep"] as const;
export type ReviewLevel = (typeof REVIEW_LEVELS)[number];

/**
 * Seats per Bun fan-out level — commands/amazing-pr-review.md 档位表.
 * `deep` deliberately has NO seats entry: it runs one parent session, not a
 * seat partition.
 */
export const REVIEW_SEATS: Record<Exclude<ReviewLevel, "deep">, number> = { quick: 1, default: 2 };

/**
 * One custom-provider declaration as the runner input JSON carries it
 * (AL-23-1): the SETTINGS declaration, keyless — the API key rides ONLY the
 * runner's STDIN credential payload, pooled per provider under its own id,
 * and the runner writes the
 * pool into the run's credential store before the session starts (never the
 * input JSON, never a synthesized models.yml, never a log line). The `api`
 * vocabulary (anthropic-messages | openai-completions | openai-responses) and
 * the id/baseUrl bounds live dashboard-side (assertCustomProvider); the runner
 * guard validates shape only.
 */
export type CustomProviderDeclaration = {
  provider_id: string;
  base_url: string;
  api: string;
  model_ids: string[];
};

/**
 * One capability-host model the runtime synthesizer materializes into the
 * per-review models.yml — the same shape the source-controlled
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
 * JSON carries it: the runner materializes these into the
 * base of every synthesized per-review models.yml. KEYLESS static data; host
 * ids are runtime capabilities, NOT Providers catalog ids (omp's `ark-plan`
 * resolves its key through catalogProviderId `ark`, whose transported pool
 * arrives under that id in the credential payload). `apiKeyEnv` and `auth`
 * are RETAINED wire/registry metadata — the locked host shape carries them;
 * neither determines the payload pool key (derived from the provider id) nor
 * the active credential resolution (the stored pool does).
 *
 * Structurally mirrors the registry's `SandboxImageHost` (src/contracts/
 * sandbox-images.ts): the consumer passes the resolved registry entry's hosts
 * verbatim into the runner input. The mirror lives HERE (not an import)
 * because the in-image runner graph is only `packages/runner/src` plus this
 * package's src (the sandbox image COPYs exactly those two trees —
 * tests/review/runtime-boundary derives the admitted set from the Dockerfile);
 * the consumer-side contract import keeps the data single-sourced.
 */
export type CapabilityHost = {
  /** Host id — the selector prefix (e.g. `ark-plan/deepseek-v4-flash`). */
  id: string;
  /** Providers/BYOK catalog id whose transported pool this host resolves from. */
  catalogProviderId: string;
  /** Retained registry metadata — no longer an active key-resolution input. */
  apiKeyEnv: string;
  baseUrl: string;
  api: string;
  /** Retained registry metadata — synthesis emits `auth: oauth` for every block. */
  auth: string;
  models: readonly CapabilityHostModel[];
};

export type AgentRuntimeRunInput = {
  level: ReviewLevel;
  /** 容器内 PR clone 的绝对路径（exec cwd；席位 worktree = 该只读 clone）。 */
  worktreePath: string;
  /** 每席可见的 recon 事实（owner/repo#pr、head sha、diff 统计、该席文件范围）。 */
  reconFacts: readonly string[];
  /** 模型选择链；SSOT = env `OMP_REVIEW_MODEL`（逗号分隔，容器注入）。 */
  modelSelectors: readonly string[];
  /**
   * Per-seat model overrides (spec Architect lock L3): agent
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
   * Directory holding the synthesized COMPLETE per-review models.yml
   * (AL-23-1): the runner ALWAYS synthesizes
   * /tmp/omp-agent-<uuid>/models.yml — capability hosts of the App's selected
   * image as the base, custom-provider declarations merged in (capability ids
   * win on collision) — and rides the directory here REQUIRED for every omp
   * run; runtime-omp passes it to createAgentSession({ agentDir }). There is
   * no baked in-image models.yml to fall back to (deleted): a run
   * without a synthesized directory has no models.yml at all.
   */
  agentDir: string;
  /**
   * The run's credential store, handed to the session IN MEMORY (never a
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
   * Optional typed recheck input (spec review-lifecycle
   * §7.3/§7.8): the worker-captured assessment targets, trusted evidence
   * catalog and untrusted discussion snapshot for the SAME head this run
   * reviews (headSha equality is enforced downstream by validateRecheckDoc).
   * ABSENT = the legacy runtime input — no recheck child is started and the
   * result's `recheck` is null (byte-identical legacy behavior). Never a
   * second prompt/yield stream on any existing session.
   */
  recheck?: RecheckInput;
};

/** One completed review run: the validated envelope plus its optional recheck document (spec §7.8). */
export type ReviewRunResult = { envelope: MstarReviewV1; recheck: RecheckDoc | null };

export interface AgentRuntime {
  /**
   * 跑一次审查。仅以「已通过 validateMstarReviewV1 的 mstar.review/v1」
   * envelope resolve（result 形状为 { envelope, recheck }：recheck
   * 要么是已通过 validateRecheckDoc 的文档，要么是 null——席位失败/超时/
   * 无输出绝不冒充成功，也绝不丢失审查本体）；session/解析/校验失败一律
   * throw（绝不返回 M1 形状冒充成功）。
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
