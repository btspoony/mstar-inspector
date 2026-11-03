---
category: Fixed
---

- **One bad recheck row no longer discards the whole round.** The recheck
  document validator now separates two distrust levels. Document-level faults
  (wrong schema, stale HEAD, non-array or oversized `results`, a duplicate row
  ID, a row ID absent from the targets) still fail the document as a whole. A
  row-level content fault now drops only that row: it lands in `rejected` and
  the worker surfaces it as `unverifiable/invalid-output`, while the surviving
  rows are accepted and published. Previously one imprecise citation threw away
  every other assessment in the round.
- **Quote matching forgives formatting noise.** An `addressed` citation is
  compared after normalization — CRLF/CR→LF, per-line trailing whitespace
  stripped, one trailing newline dropped — instead of byte equality, so
  invisible trailing blanks no longer invalidate a correct quote. Every other
  eligibility rule is unchanged: ranges, slice membership/completeness, old-range
  intersection and the structural-change requirement still apply.
- **A lost recheck round is now attributable.** The seat writes a bounded
  `mstar.recheck-status/v1` document on every exit path — `ok` with the rejected
  row count, `skipped` when the budget left no room, or `failed` with a bounded
  reason/error — and the worker reads it beside the document. A round that
  produced no usable document therefore records a `review_failures` row with
  `stage: recheck` and one D1 log line even when the container's stderr is gone.
- **The recheck seat is told how to quote and when context gaps matter.** Its
  assignment now requires copying the cited lines verbatim from the input
  document's `evidence` catalog instead of retyping them, and truncation
  downgrades only the conclusions that depend on the missing context rather
  than every row in the round.

<!-- CN -->
- **单行不合格不再丢弃整轮重审。** 重审文档校验现在区分两级不信任。文档级故障
  （schema 错误、HEAD 过期、`results` 非数组或超出上限、重复行 ID、行 ID 不在
  targets 内）仍然整份文档失败。行级内容故障现在只丢弃该行：它进入 `rejected`，
  worker 将其呈现为 `unverifiable/invalid-output`，其余行正常被接受并发布。
  此前一处不精确的引用会连带丢弃该轮所有其他评估。
- **引用比对宽容格式噪声。** `addressed` 引用现在按规范化后比对——CRLF/CR→LF、
  逐行去尾随空白、去掉一个尾随换行——而不再要求逐字节相等，因此不可见的尾随
  空白不会再让正确引用失效。其他资格规则不变：行号范围、slice 归属与完整性、
  原始范围相交、结构变更要求仍然生效。
- **丢失的重审轮现在可归因。** 席位在每条退出路径上都会写出有界的
  `mstar.recheck-status/v1` 文档——`ok` 携带被拒行数、预算不足时 `skipped`、
  失败时带上有界的 reason/error——worker 会在读取文档的同时读取它。因此即使
  容器 stderr 已丢失，未产出可用文档的轮次也会写入一条 `stage: recheck` 的
  `review_failures` 行和一条 D1 日志。
- **重审席位现在明确了引用方式与上下文缺口的影响范围。** 其 assignment 现在要求
  从输入文档 `evidence` 目录中**逐字复制**被引用行，而不是凭记忆重打；截断
  只降级依赖缺失上下文的那部分结论，而不是整轮所有行。
