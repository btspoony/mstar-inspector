/**
 * AgentRuntime port (plan 07 Task 2) — interface signature locked verbatim to
 * `.mstar/iterations/v0.3/specs/agent-runtime.md` § TypeScript 端口.
 *
 * Pure types + constants only: zero omp SDK import, zero I/O, safe to import
 * from BOTH runtime faces (container Bun and workerd — module import matrix,
 * spec § 模块 import 矩阵).
 */

import type { MstarReviewV1 } from "@mstar-harness/engine";

/** Review depth tiers delivered this iteration (harness tier table). */
export type ReviewLevel = "quick" | "default";
/** 其它值（含 "deep"）由端口层拒绝：throw，不静默降档。 */

/** Seats per level — commands/amazing-pr-review.md 档位表. */
export const REVIEW_SEATS: Record<ReviewLevel, number> = { quick: 1, default: 2 };

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
 * delivered tiers. Own-key check (qc3 F-302): `value in REVIEW_SEATS` also
 * matches Object.prototype keys ("toString", "constructor", …) — only
 * Object.hasOwn rejects them fail-fast at the port.
 */
export function isReviewLevel(value: unknown): value is ReviewLevel {
  return typeof value === "string" && Object.hasOwn(REVIEW_SEATS, value);
}
