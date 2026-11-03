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
  intersection and the structural-change requirement still apply — and
  `removed-code`'s "old lines are gone from the new side" test is normalized the
  same way, so one trailing space on still-present code can no longer forge a
  closure that was never fixed. Normalization never rescues a BLANK quote: a
  whitespace-only `quote` normalizes to `""`, which byte-equals a blank cited
  line, so it is now rejected outright and the 1–4096 bound counts the visible
  text.
- **A lost recheck round is now attributable.** The seat writes a bounded
  `mstar.recheck-status/v1` document on every exit path — `ok` with the rejected
  row IDs and their count, `skipped` when the budget left no room, or `failed`
  with a bounded reason/error — and the worker reads it beside the document. A
  round that produced no usable document therefore records a `review_failures`
  row with `stage: recheck` and one D1 log line even when the container's stderr
  is gone. The seat writes a document it already filtered, so the status's
  `rejected_row_ids` is what keeps those rows `invalid-output` instead of
  silently `omitted`, and the status `error` is redacted before it is bounded —
  a secret straddling the cut no longer survives as a fragment.
- **The recheck seat is told how to quote and when context gaps matter.** Its
  assignment now requires copying the cited lines verbatim from the input
  document's `evidence` catalog instead of retyping them, and truncation
  downgrades only the conclusions that depend on the missing context rather
  than every row in the round.
- **A budget-skipped round no longer reads as invalid output.** The seat's own
  `skipped` status now accounts every selected row as `unverifiable/budget`
  (never sent) instead of `invalid-output` (sent and answered badly), and the
  worker bounds a status `reason`/`error` at parse time so the D1 failure text
  and the log field carry one capped value. The same honour applies to the
  worker's own §7.3 size budget: a row the budget excluded from the input was
  never sent either, so it is `budget` even when no document exists — and the
  round still emits its accounting line, naming the exclusion, instead of
  silently accounting every row as an unanswered `invalid-output`. A status from
  another HEAD — or one naming a row this round never sent — attributes nothing.
- **A recheck document-write failure is recorded, not hidden.** The runner
  writes the round status only after the document lands; a failed document
  write records `failed/write-failed` instead of the seat's `ok`, so D1 can no
  longer keep a round that published nothing as clean. The status error is
  redacted with the worker's own credential-pattern list
  (`packages/shared/src/secret-shapes.ts` — one canonical list for both halves).
- **A round that rejected every row reports `failed`, not `ok`.** When the gate
  accepts a document but not one submitted row survives it, the status is
  `failed` with reason `all-rows-rejected`, so the worker writes its
  `review_failures` row instead of keeping a round that delivered nothing as
  clean. A partial drop still reports `ok` with the rejected IDs. The status's
  `rejected` count is derived from `rejected_row_ids` on read, so the two faces
  of the count cannot disagree.
- **A finding inside an oversized hunk keeps local evidence.** A hunk larger
  than the 80-line slice bound is no longer excluded whole (which left every
  finding inside it permanently `no-evidence`): it is split into consecutive
  ≤80-line windows, nearest the concern's line first, and each window states
  its start lines from the hunk header's own arithmetic. A quote from inside
  the window validates; a quote outside it still fails.
- **`recheck` and `usage` failures stop paging ops.** The cron failure sweep
  counted every `review_failures` row in the window: its query had no stage
  predicate, and `recheck` was not even an accepted stage yet, so both
  attribution stages — a recheck round that budget-skipped, lost its seat or
  produced an invalid document, and a review that continued after its usage
  event failed to record — could page the on-call for reviews that published
  normally. Both stages are now outside the paging signal, and both are out of
  the per-PR failure count. The per-PR failure history still lists `usage`
  rows, so a lost metered-usage record keeps a surface; `recheck` rows stay out
  of it, their accounting already rides the published coverage line. The
  stage lists live once in `src/contracts/failure-stages.ts` and are
  interpolated into the sweep and dashboard queries.

<!-- CN -->
- **单行不合格不再丢弃整轮重审。** 重审文档校验现在区分两级不信任。文档级故障
  （schema 错误、HEAD 过期、`results` 非数组或超出上限、重复行 ID、行 ID 不在
  targets 内）仍然整份文档失败。行级内容故障现在只丢弃该行：它进入 `rejected`，
  worker 将其呈现为 `unverifiable/invalid-output`，其余行正常被接受并发布。
  此前一处不精确的引用会连带丢弃该轮所有其他评估。
- **引用比对宽容格式噪声。** `addressed` 引用现在按规范化后比对——CRLF/CR→LF、
  逐行去尾随空白、去掉一个尾随换行——而不再要求逐字节相等，因此不可见的尾随
  空白不会再让正确引用失效。其他资格规则不变：行号范围、slice 归属与完整性、
  原始范围相交、结构变更要求仍然生效——并且 `removed-code` 的「旧行已从新侧
  消失」判断同样规范化，因此对仍然存在的代码多加一个尾随空格，再也无法伪造
  一个从未真正修复的结案。规范化永不挽救空白引用：纯空白的 `quote` 会规范化为
  `""`，与空白的被引用行逐字节相等，因此现在直接拒绝，1–4096 的上限也只统计可见
  字符。
- **丢失的重审轮现在可归因。** 席位在每条退出路径上都会写出有界的
  `mstar.recheck-status/v1` 文档——`ok` 携带被拒行 ID 与行数、预算不足时
  `skipped`、失败时带上有界的 reason/error——worker 会在读取文档的同时读取它。
  因此即使容器 stderr 已丢失，未产出可用文档的轮次也会写入一条
  `stage: recheck` 的 `review_failures` 行和一条 D1 日志。席位写出的是已过滤
  的文档，所以正是状态里的 `rejected_row_ids` 让这些行保持
  `invalid-output`，而不是被静默算作 `omitted`；状态 `error` 先脱敏再截断，
  跨过截断点的密钥不会再以碎片形式留存。
- **重审席位现在明确了引用方式与上下文缺口的影响范围。** 其 assignment 现在要求
  从输入文档 `evidence` 目录中**逐字复制**被引用行，而不是凭记忆重打；截断
  只降级依赖缺失上下文的那部分结论，而不是整轮所有行。
- **预算跳过的轮次不再被记成无效输出。** 席位自己写的 `skipped` 状态现在把每个
  选中行记为 `unverifiable/budget`（根本没发送），而不是 `invalid-output`
  （发送后被答坏）；worker 在解析时就把状态的 `reason`/`error` 截断，因此 D1 的
  失败文本与日志字段是同一个上限值。worker 自己的 §7.3 尺寸预算同理：被预算排除在
  输入之外的行同样从未发送，因此即使没有文档也应记为 `budget`——并且该轮仍会输出
  自己的账目行，点名这次排除，而不是把每一行都静默记成无人应答的
  `invalid-output`。别的 HEAD 写下的状态、或点名了本轮从未发送的行的状态，都不产生
  任何归因。
- **重审文档写失败会被记录，而不是被掩盖。** runner 只有在文档写成功之后才写轮次
  状态；文档写失败时记录 `failed/write-failed`，而不是席位的 `ok`，因此 D1 不会
  再把「什么都没发布」的轮次留成干净记录。状态错误的脱敏使用 worker 同一份凭据
  模式表（`packages/shared/src/secret-shapes.ts`——两侧共用唯一一份列表）。
- **整轮全部行被拒时状态报 `failed` 而非 `ok`。** 当校验接受了文档、但没有任何一行
  提交行通过时，状态为 `failed`，reason 为 `all-rows-rejected`，因此 worker 会写入
  自己的 `review_failures` 行，而不会把「什么都没交付」的轮次留成干净记录。部分行
  被拒仍是 `ok` 并携带被拒行 ID。读取时 `rejected` 计数由 `rejected_row_ids` 推导，
  两个计数面不可能互相矛盾。
- **超大 hunk 内的 finding 仍保有局部证据。** 超过 80 行切片上限的 hunk 不再被整体
  排除（那会让它内部的每个 finding 永久成为 `no-evidence`）：它按连续 ≤80 行切成
  多个窗口，离原始关注行最近的优先，每个窗口的起始行号直接来自 hunk 头的行号算术。
  窗口内的引用可校验通过；窗口外的引用仍然失败。
- **`recheck` 与 `usage` 失败不再触发告警。** 定时失败扫描此前统计窗口内所有
  `review_failures` 行——查询没有任何 stage 条件，且 `recheck` 当时还不是可选
  stage——因此两类归因行都可能为正常发布的评审唤来 on-call：预算跳过 / 席位失联 /
  文档无效的重审轮，以及用量事件写入失败但评审继续的轮次。现在两个阶段都在告警
  统计之外，也都不计入单个 PR 的失败数量。单个 PR 的失败历史仍会列出 `usage` 行，
  让丢失的计量记录有可见面；`recheck` 行仍不进该列表，它的账目已经随发布覆盖行
  呈现。阶段清单只在 `src/contracts/failure-stages.ts` 写一次，并插值进扫描与
  仪表盘查询。
