---
category: Changed
---

- **The review comment body is now rendered by the engine**: `@mstar-harness/engine`'s `renderReviewMarkdown` owns the layout — verdict head (with score), the `cause:`/`unscanned:` pair, the tally table, `## 📋 Review`, and one block per finding in seat order — so the verdict, score, tally and finding titles no longer appear twice. This repo keeps only what the engine cannot express: the omitted-findings footer, a folded repeat callout, and the folded prior-findings recheck.
- **A seat narrative is optional**: the runner's output contract no longer requires `summary_md`, and engine 4.1.6 no longer fabricates one, so a review without a seat-written summary shows the bare Review heading instead of machine facts echoed back into the body.
- **The round header moved under the body**: `Review N · commit <sha>` is now the trailer directly above the publication marker; the hidden round marker stays the first line.
- **Review sandbox cohort moved to mstar-harness 4.1.6**: the engine manifest range, the runner's exact pin, the preinstalled CLI pin, the image tag/ref, and the regenerated lockfiles move together — the pin suite fails if any of them drifts.
- **No operational change from this entry**: pins and body assembly only — no image build, in-image replay, deployment, or smoke was run.

<!-- CN -->
- **审查评论正文改由 engine 渲染**：`@mstar-harness/engine` 的 `renderReviewMarkdown` 负责版式——结论行（含分数）、`cause:`/`unscanned:` 事实对、计数表、`## 📋 Review`，以及按席位排序的每条 finding 区块——因此结论、分数、计数与 finding 标题不再出现两次。本仓库只保留 engine 无法表达的部分：省略条目的脚注、折叠的重复项提示，以及折叠的往轮复审。
- **席位叙述改为可选**：runner 输出契约不再要求 `summary_md`，engine 4.1.6 也不再伪造它；没有席位自述摘要时，正文只渲染空的 Review 标题，而不会把机器事实回灌进摘要。
- **轮次标题移到底部**：`Review N · commit <sha>` 现在是紧贴发布标记上方的尾行；隐藏的轮次标记仍保持第一行。
- **审查沙箱版本组合升至 mstar-harness 4.1.6**：engine manifest 区间、runner 精确 pin、预装 CLI pin、镜像 tag/ref 与重新生成的 lock 一并移动——任何一处漂移都会让 pin 测试套件失败。
- **本条目不涉及运维动作**：仅 pin 与正文组装——未执行镜像构建、镜像内回放、部署或 smoke。
