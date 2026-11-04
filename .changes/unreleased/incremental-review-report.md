---
category: Added
---

- **Incremental review rounds**: when the pull request's previous reviewed head is an ancestor of the new
  one (GitHub `compare` → `ahead`), the seats review the `since <base>` delta instead of the whole PR, and
  the comment header marks the round with `· since <sha7>`. The prior-findings evidence catalog still reads
  the full PR diff, and any other compare verdict (or a force-push 404) keeps the full-diff round.
- **Complete review reports**: the published comment now carries what the envelope cannot — a
  `**What this PR does**` overview, a mechanical `### Revalidated findings` table, `### Linked-issue AC`,
  `### ✅ Verified`, `### 🗑️ Considered & rejected`, and a collapsible `## 🛠️ Plan to fix`. These ride a
  side document (`mstar.report/v1`) written by a bounded report seat, validated fail-closed by the Worker,
  and rendered as `none` when unavailable. Report text cannot fold, fence or re-head the comment:
  headings, thematic breaks, code-fence lines and raw HTML are neutralized before insertion, and the
  fix plan stays fenced as code.
- **The report is bound to the reviewed head**: the side document carries the reviewed `headSha`, written
  by the runner from the envelope rather than the seat, and the Worker refuses a document bound to any
  other head — a report a skipped seat left behind in the container can no longer speak for a later
  review. A missing seat definition or an unbound envelope degrades to `none`, never a failed review.
- **Prior findings render once**: the in-body `### Revalidated findings` section carries the full §7.10
  rendering (coverage line, per-row disposition, evidence, thread and the display cap), so a report body
  publishes exactly one prior-findings table instead of a second, folded copy beneath it.
- **Increment bases and report context are bounded**: two Apps on one installation never share an increment
  base — only the reviewing App's own last reviewed head can bound the delta — and the best-effort PR
  context is skipped with one named log line when the round no longer has the wall clock it costs, so a slow
  sandbox cannot spend the review's window on narrative. The capture gate reserves the level's own runner
  budget as well, so a capture that fits but would starve the paid run is skipped too. An eligible increment
  base whose `base...head` is genuinely empty is nothing to review: the delivery is acked with one structured
  line, no review body and no `context_incomplete` row, and its Check inherits the reviewed head's gate result
  against the current gate (`success`/`failure`, naming that head and its verdict/score) instead of ending in a
  free-standing `neutral` — an empty commit cannot replace the reviewed head's failing required check; an
  unreadable baseline result (missing row, unparseable envelope, missing score) fails the check closed
  instead of going `neutral`. The
  report document's byte bound is derived from its per-field character budgets, so a document that honours
  every budget can never be rejected.

<!-- CN -->
- **增量审查轮次**：当本 PR 上一个已审查的 head 是新 head 的祖先（GitHub `compare` 返回 `ahead`）时，各席位
  只审查 `since <base>` 的增量而非整个 PR，评论头部以 `· since <sha7>` 标注。既有 finding 的证据目录仍基于完整
  PR diff 构建；其它 compare 结论（或 force-push 造成的 404）继续走全量 diff 轮次。
- **完整审查报告**：发布的评论现在携带 envelope 无法承载的内容——`**What this PR does**` 概述、机器生成的
  `### Revalidated findings` 表、`### Linked-issue AC`、`### ✅ Verified`、`### 🗑️ Considered & rejected`
  与可折叠的 `## 🛠️ Plan to fix`。这些内容走独立文档（`mstar.report/v1`），由有界报告席位写出，Worker
  失败即拒绝校验，缺失时统一渲染为 `none`。报告文本无法折叠、围栏或改写评论结构：标题、分隔线、代码围栏行与
  原始 HTML 在插入前均已中和，修复计划始终以代码块围栏呈现。
- **报告绑定到本次审查的 head**：独立文档携带被审查的 `headSha`，由 runner 从 envelope 写入（而非席位自己），
  Worker 拒绝任何绑定到其它 head 的文档——席位被跳过时遗留在容器里的报告不会再冒充后续一次审查。席位定义缺失
  或 envelope 无 head 时降级为 `none`，绝不会让审查失败。
- **既有 finding 只渲染一次**：正文 `### Revalidated findings` 段承载完整的 §7.10 呈现（覆盖行、逐行处置、
  证据、thread 与展示上限），因此带报告正文只发布一张既有 finding 表，而不再在下方折叠出第二份。
- **增量基线与报告上下文均有界**：同一 installation 下的两个 App 不会共用增量基线——只有本 App 自己上一个已
  审查的 head 才能界定增量；当本轮剩余的墙钟时间不足以支付 PR 上下文抓取成本时，该步骤直接跳过并打一条具名
  日志，慢沙箱因此无法把审查窗口耗在叙述上。抓取门禁同时预留本档位 runner 自己的预算，因此“装得下抓取却会
  挤掉付费运行”的情况同样跳过。若合法增量基线的 `base...head` 确实为空，则视为无可审查内容：本次投递打一条
  结构化日志后直接 ack，不发布新评论、不写 `context_incomplete` 行，其 Check 继承被审查 head 的 gate 结果
  （按当前 gate 得出 `success`/`failure`，并写明该 head 及其 verdict/score），而不是以独立的 `neutral` 结束——
  空提交无法替换被审查 head 那个失败的必需检查；基线结果不可读（行缺失、envelope 无法解析、缺少评分）时
  检查直接失败关闭，而不是保持 `neutral`。报告文档
  的字节上限由各字段的字符预算推导而来，任何满足预算的文档都不可能被字节门拒绝。
