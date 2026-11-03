---
category: Changed
---

- **The review comment body is now rendered by the engine**: `@mstar-harness/engine`'s `renderReviewMarkdown` owns the layout — verdict head (with score), the `cause:`/`unscanned:` pair, the tally table, `## 📋 Review`, and one block per finding in seat order — so the verdict, score, tally and finding titles no longer appear twice. This repo keeps only what the engine cannot express: the omitted-findings footer and the folded prior-findings recheck.
- **A seat narrative is optional**: the runner's output contract no longer requires `summary_md`, and engine 4.1.6 no longer fabricates one, so a review without a seat-written summary shows the bare Review heading instead of machine facts echoed back into the body.
- **The round header moved under the body**: `Review N · commit <sha>` is now the trailer directly above the publication marker; the hidden round marker stays the first line.
- **Review sandbox cohort moved to mstar-harness 4.1.6**: the engine manifest range, the runner's exact pin, the preinstalled CLI pin, the image tag/ref, and the regenerated lockfiles move together — the pin suite fails if any of them drifts.
- **The cross-round repeat callout is removed**: the engine's tally table is no longer ours to recompute, so a repeat can neither be annotated in the finding blocks nor excluded from the counts. It listed titles the findings section already carried, so the prior-findings recheck is what now answers what happened to earlier concerns. Its store query and its tests go with it.\n- **The review image is rebuilt**: the runner no longer requires a seat summary, and that half must ship with the engine pin above it.

<!-- CN -->
- **审查评论正文改由 engine 渲染**：`@mstar-harness/engine` 的 `renderReviewMarkdown` 负责版式——结论行（含分数）、`cause:`/`unscanned:` 事实对、计数表、`## 📋 Review`，以及按席位排序的每条 finding 区块——因此结论、分数、计数与 finding 标题不再出现两次。本仓库只保留 engine 无法表达的部分：省略条目的脚注，以及折叠的往轮复审。
- **席位叙述改为可选**：runner 输出契约不再要求 `summary_md`，engine 4.1.6 也不再伪造它；没有席位自述摘要时，正文只渲染空的 Review 标题，而不会把机器事实回灌进摘要。
- **轮次标题移到底部**：`Review N · commit <sha>` 现在是紧贴发布标记上方的尾行；隐藏的轮次标记仍保持第一行。
- **审查沙箱版本组合升至 mstar-harness 4.1.6**：engine manifest 区间、runner 精确 pin、预装 CLI pin、镜像 tag/ref 与重新生成的 lock 一并移动——任何一处漂移都会让 pin 测试套件失败。
- **跨轮重复项提示已移除**：engine 的计数表不再由本仓库重算，因此重复项既无法在原位标注，也无法从计数中排除。它列出的标题 finding 区段本来就有，往轮复审表才是回答「之前的关注点怎么样了」的地方；其存储查询与测试一并删除。\n- **审查镜像会重建**：runner 不再要求席位摘要，这半改动必须与上方的 engine pin 一同发布。
