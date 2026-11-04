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
  and rendered as `none` when unavailable. Report text cannot fold or re-head the comment: headings,
  thematic breaks and raw HTML are neutralized before insertion, and the fix plan stays fenced as code.
- **The report is bound to the reviewed head**: the side document carries the reviewed `headSha`, written
  by the runner from the envelope rather than the seat, and the Worker refuses a document bound to any
  other head — a report a skipped seat left behind in the container can no longer speak for a later
  review. A missing seat definition or an unbound envelope degrades to `none`, never a failed review.
- **Prior findings render once**: the in-body `### Revalidated findings` section carries the full §7.10
  rendering (coverage line, per-row disposition, evidence, thread and the display cap), so a report body
  publishes exactly one prior-findings table instead of a second, folded copy beneath it.

<!-- CN -->
- **增量审查轮次**：当本 PR 上一个已审查的 head 是新 head 的祖先（GitHub `compare` 返回 `ahead`）时，各席位
  只审查 `since <base>` 的增量而非整个 PR，评论头部以 `· since <sha7>` 标注。既有 finding 的证据目录仍基于完整
  PR diff 构建；其它 compare 结论（或 force-push 造成的 404）继续走全量 diff 轮次。
- **完整审查报告**：发布的评论现在携带 envelope 无法承载的内容——`**What this PR does**` 概述、机器生成的
  `### Revalidated findings` 表、`### Linked-issue AC`、`### ✅ Verified`、`### 🗑️ Considered & rejected`
  与可折叠的 `## 🛠️ Plan to fix`。这些内容走独立文档（`mstar.report/v1`），由有界报告席位写出，Worker
  失败即拒绝校验，缺失时统一渲染为 `none`。报告文本无法折叠或改写评论结构：标题、分隔线与原始 HTML 在插入前
  均已中和，修复计划始终以代码块围栏呈现。
- **报告绑定到本次审查的 head**：独立文档携带被审查的 `headSha`，由 runner 从 envelope 写入（而非席位自己），
  Worker 拒绝任何绑定到其它 head 的文档——席位被跳过时遗留在容器里的报告不会再冒充后续一次审查。席位定义缺失
  或 envelope 无 head 时降级为 `none`，绝不会让审查失败。
- **既有 finding 只渲染一次**：正文 `### Revalidated findings` 段承载完整的 §7.10 呈现（覆盖行、逐行处置、
  证据、thread 与展示上限），因此带报告正文只发布一张既有 finding 表，而不再在下方折叠出第二份。
