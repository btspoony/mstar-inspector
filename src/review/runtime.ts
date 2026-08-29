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

export type AgentRuntimeRunInput = {
  level: ReviewLevel;
  /** 容器内 PR clone 的绝对路径（exec cwd；席位 worktree = 该只读 clone）。 */
  worktreePath: string;
  /** 每席可见的 recon 事实（owner/repo#pr、head sha、diff 统计、该席文件范围）。 */
  reconFacts: readonly string[];
  /** 模型选择链；SSOT = env `OMP_REVIEW_MODEL`（逗号分隔，容器注入）。 */
  modelSelectors: readonly string[];
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
