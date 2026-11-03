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
- **A round the runner cancels by design is no longer recorded as a failure.**
  The runner aborts an unfinished recheck seat as soon as the main review
  settles, so the round answers nothing because it was stopped, not because it
  ran and lost. That abort now reports `skipped` with reason `aborted` instead of
  `failed`/`seat-failed`: the worker writes no `review_failures` row, leaves
  every row `unverifiable/omitted` and leaves the rotation clock untouched, while
  a genuine seat error or non-`Error` rejection keeps `failed`/`seat-failed`.
- **A recheck document-write failure is recorded, not hidden.** The runner
  writes the round status only after the document lands; a failed document
  write exits 1 with no stdout (the worker's runner-failure path), so no status
  ever reports an `ok` for a document that never reached the worker, and D1
  cannot keep a round that published nothing as clean. The status error is
  redacted with the worker's own credential-pattern list
  (`packages/shared/src/secret-shapes.ts` — one canonical list for both halves).
- **A round that delivered nothing reports `failed`, not `ok`.** When the gate
  accepts a document but not one submitted row survives it, the status is
  `failed` with reason `all-rows-rejected`, so the worker writes its
  `review_failures` row instead of keeping a round that delivered nothing as
  clean. A valid document with **zero** results for a non-empty target list is
  the same failure without a gate drop and now reports `failed` with reason
  `empty-result`: the round is attributable and the rows it was sent are
  `invalid-output` (answered badly), never `omitted` (never ran). A partial
  drop still reports `ok` with the rejected IDs. The status's
  `rejected` count is derived from `rejected_row_ids` on read, so the two faces
  of the count cannot disagree.
- **`current-code` closure needs a line the change ADDED.** A verified fix used
  to be provable with an unchanged context line: the quote matched and the range
  sat inside the hunk, so citing pre-change code closed the row. The catalog
  slice now carries `addedNewLines` (the new-side line numbers its `+` lines
  occupy) and a `current-code` citation must include at least one of them; a
  presence-only citation is dropped as `invalid-output`, and a real replacement
  cites `replaced-code`, whose old-side proof already tests that the code
  changed.
- **An empty-result round no longer charges a never-sent row.** The rejection
  covered every unanswered row, so a row the trusted catalog could not prove (or
  whose slices lost the catalog byte budget) still advanced its rotation clock
  even though the seat never received it. Only rows that actually rode the wire
  are now `invalid-output` and counted as attempted; catalog-excluded rows keep
  `no-evidence`, catalog-budget rows keep `budget`, and both keep their clocks.
- **Still-present evidence is tested line by line.** The `removed-code` /
  `replaced-code` "old lines are gone" guard no longer searches the joined
  new-side block for the joined quote: an insertion inside the cited block
  split it and forged a removal. Every non-blank normalized cited line must now
  be absent from the new-side line set, so the insertion proves nothing — while
  a genuine replacement that keeps an identical context line still passes,
  because only the lines the change actually removed are gone.
- **The status `reason` is a closed vocabulary.** `budget`, `aborted`,
  `all-rows-rejected`, `empty-result`, `seat-failed` and `invalid-document` are
  the only accepted values (one shared constant both halves use). The worker's
  per-row accounting branches on those exact literals, so an off-vocabulary
  string is dropped on read instead of silently picking a branch.
- **A lost recheck document names its real cause.** A round whose seat reported
  `ok` but whose document failed the read (absent, overflow, validation) used to
  persist `error: "ok: null: null"`. The read cause now leads that text.
- **A stale drop note no longer erases a real answer.** When the seat's status
  names a row the surviving document also answered, the answer wins instead of
  being overwritten with `unverifiable/invalid-output`.
- **The published coverage line counts real seat answers.** A row the gate
  dropped was attempted and still advances its rotation clock
  (`last_assessed_ms`), but it was never assessed: the coverage line and the
  round's accounting log field now count only rows that carry a document
  result, so a round can no longer claim reassessments the seat never
  delivered. The lifecycle clock keeps the attempted rows, so fair rotation is
  unchanged. A gate drop that carried no usable row ID is attributed to the
  sent-but-unanswered row at its position instead of being reported `omitted`;
  the status now carries `rejected_unnamed` (a count, since such a drop cannot
  be named), so that attribution also works for a document the runner already
  filtered.
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
  the per-PR failure count. The per-PR failure history lists BOTH, so a lost
  metered-usage record and a recheck round that produced no usable document
  each keep a surface in the App detail page. The stage list is written once in
  `src/contracts/failure-stages.ts` and interpolated into the sweep and
  dashboard queries; the history query carries no stage predicate at all.

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
- **runner 主动取销的一轮不再被记成失败。** 主评审一结束，runner 就会中止尚未完成的
  重审席位，因此该轮之所以什么都没回答，是因为它被停止，而不是因为它运行后失败了。
  这次中止现在报 `skipped`、reason 为 `aborted`，而不再是 `failed`/`seat-failed`：
  worker 不写 `review_failures` 行，所有行保持 `unverifiable/omitted`，轮转时钟不动；
  而真正的席位错误或非 `Error` 拒绝仍然报 `failed`/`seat-failed`。
- **重审文档写失败会被记录，而不是被掩盖。** runner 只有在文档写成功之后才写轮次
  状态；文档写失败时以退出码 1 结束且不输出 stdout（走 worker 的 runner 失败路径），
  因此不会有任何状态把从未送达 worker 的文档报成 `ok`，D1 也不会再把「什么都没发布」
  的轮次留成干净记录。状态错误的脱敏使用 worker 同一份凭据模式表
  （`packages/shared/src/secret-shapes.ts`——两侧共用唯一一份列表）。
- **整轮什么都没交付时状态报 `failed` 而非 `ok`。** 当校验接受了文档、但没有任何一行
  提交行通过时，状态为 `failed`，reason 为 `all-rows-rejected`，因此 worker 会写入
  自己的 `review_failures` 行，而不会把「什么都没交付」的轮次留成干净记录。若文档
  合法、目标非空、却零结果（没有任何行被校验丢弃），那是同一种失败，现在报
  `failed`，reason 为 `empty-result`：该轮可归因，且它发送过的行记为
  `invalid-output`（答坏了），绝不算作 `omitted`（从未运行）。部分行被拒仍是 `ok`
  并携带被拒行 ID。读取时 `rejected` 计数由 `rejected_row_ids` 推导，两个计数面
  不可能互相矛盾。
- **`current-code` 结案必须引用本次变更「新增」的行。** 此前一条未改动的上下文行也能
  证明修复：引用逐字匹配、范围落在 hunk 内，于是引用变更前的代码就把该行结案了。证据
  切片现在携带 `addedNewLines`（该 hunk 中 `+` 行占用的新侧行号），`current-code`
  引用必须命中其中之一；只证明「代码还在」的引用会随行丢弃为 `invalid-output`，
  真实替换则引用 `replaced-code`——它的旧侧证明本来就要求代码确有变更。
- **empty-result 轮次不再为从未发送的行计费。** 该判定此前覆盖所有未应答行，因此被
  可信目录无法证明的行（或其切片输给了目录字节预算的行）即使席位从未收到，也会推进
  轮转时钟。现在只有真正上过线的行才是 `invalid-output` 并计入已尝试；目录排除的行
  保持 `no-evidence`，目录预算排除的行保持 `budget`，两者的时钟都不动。
- **「旧行已消失」按行判定。** `removed-code` / `replaced-code` 的守卫不再在拼接后的新侧
  块里搜索拼接后的引用：在被引用块中间插入一行会打断整块，从而伪造出一次删除。现在要求
  每一条非空白的规范化被引用行都不出现在新侧行集合中，插入因此不再能证明任何删除；而
  真实替换中仍保留的相同上下文行不会让该行失败，因为只有真正被删掉的行才会消失。
- **状态 `reason` 是封闭词表。** 只接受 `budget`、`aborted`、`all-rows-rejected`、
  `empty-result`、`seat-failed`、`invalid-document`（两侧共用一个常量）。worker 的逐行
  账目正是按这些字面值分支，因此词表外的值在读取时被丢弃，而不是静默走进某个分支。
- **丢失的重审文档会说出真实原因。** 席位报告 `ok`、但文档在读取侧失败（缺失 / 超出上限 /
  校验失败）时，此前会写入 `error: "ok: null: null"`；现在读取原因排在最前。
- **过期的丢弃记录不再抹掉真实答案。** 当状态点名了某行、而存活的文档也给出了该行的答案时，
  以答案为准，而不是覆盖成 `unverifiable/invalid-output`。
- **发布覆盖行只统计席位真正给出的回答。** 被校验丢弃的行是「已尝试」的，轮转时钟
  （`last_assessed_ms`）照常前进，但它从未被真正评估：覆盖行与该轮的账目日志字段
  现在只统计携带文档结果的行，一轮再也无法声称席位从未交付的重审数量。生命周期时钟
  仍然包含已尝试的行，因此公平轮转不变。校验丢弃且没有可用行 ID 的行，按其位置归到
  已发送但无回答的那一行，而不是报成 `omitted`；状态现在携带 `rejected_unnamed`
  （一个计数——这种丢弃无法被命名），因此即使文档已被 runner 过滤，归因依然成立。
- **超大 hunk 内的 finding 仍保有局部证据。** 超过 80 行切片上限的 hunk 不再被整体
  排除（那会让它内部的每个 finding 永久成为 `no-evidence`）：它按连续 ≤80 行切成
  多个窗口，离原始关注行最近的优先，每个窗口的起始行号直接来自 hunk 头的行号算术。
  窗口内的引用可校验通过；窗口外的引用仍然失败。
- **`recheck` 与 `usage` 失败不再触发告警。** 定时失败扫描此前统计窗口内所有
  `review_failures` 行——查询没有任何 stage 条件，且 `recheck` 当时还不是可选
  stage——因此两类归因行都可能为正常发布的评审唤来 on-call：预算跳过 / 席位失联 /
  文档无效的重审轮，以及用量事件写入失败但评审继续的轮次。现在两个阶段都在告警
  统计之外，也都不计入单个 PR 的失败数量。单个 PR 的失败历史两者都会列出，让丢失的
  计量记录和「未产出可用文档」的重审轮在 App 详情页各自保有可见面。阶段清单只在
  `src/contracts/failure-stages.ts` 写一次，并插值进扫描与仪表盘查询；失败历史
  查询完全不带 stage 条件。
