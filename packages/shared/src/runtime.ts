
import type { MstarReviewV1 } from "@mstar-harness/engine";
import type { AuthStorage } from "@oh-my-pi/pi-coding-agent";
import type { ReviewCoverage } from "./coverage-wire";
import type { RecheckDoc, RecheckInput, RecheckStatus } from "./recheck-wire";
import type { PrContext, ReportDoc } from "./report-wire";
import type { TokenUsageBucket } from "./token-usage-wire";

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
  contextWindow?: number;
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
  id: string;
  catalogProviderId: string;
  apiKeyEnv: string;
  baseUrl: string;
  api: string;
  auth: string;
  models: readonly CapabilityHostModel[];
};

export type AgentRuntimeRunInput = {
  level: ReviewLevel;
  worktreePath: string;
  reconFacts: readonly string[];
  modelSelectors: readonly string[];
  modelOverrides?: Record<string, string>;
  agentDir: string;
  authStorage: AuthStorage;
  recheck?: RecheckInput;
  outerDeadlineEpochMs?: number;
  recheckAssignmentMaxBytes?: number;
  /**
   * The fan-out the partition must produce, the worker's own choice (a small
   * diff under `review.seats.*` can ask for fewer seats than the tier). Absent
   * is `REVIEW_SEATS[level]`; a level without an entry does not use this input.
   */
  seats?: number;
  prContext?: PrContext;
  signal?: AbortSignal;
};

/** One completed review run: the validated envelope plus its optional side documents. */
export type ReviewRunResult = {
  envelope: MstarReviewV1;
  /**
   * The run's seat coverage, present on every delivered run and absent only
   * when no seat produced usable output (that round is a failure, never a
   * partial review). Transport metadata beside the closed envelope.
   */
  coverage?: ReviewCoverage;
  recheck: RecheckDoc | null;
  recheckStatus?: RecheckStatus;
  report: ReportDoc | null;
  appliedModel?: string;
  /** The run's per-(provider, model) token spend; absent/empty means nothing attributable. */
  tokenUsage?: TokenUsageBucket[];
};

/**
 * The pinned unified-diff snapshot the consumer captures into the image
 * (`src/pipeline/gitops.ts` DIFF_PATH mirrors this value — the consumer's
 * command builders keep their own interpolation constant because the workerd
 * graph may not depend on the in-image layout module). Every review seat reads
 * the change from this file: removed lines exist nowhere else in the checkout.
 */
export const PR_DIFF_PATH = "/workspace/pr.diff";

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
