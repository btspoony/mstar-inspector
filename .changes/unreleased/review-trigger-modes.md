---
category: Added
---

- **Per-App review trigger modes**: each App now chooses when PR reviews run automatically — `open` (the first opening event only), `every_push` (the default; today's behavior unchanged), or `manual` (never auto-triggers) — via a segmented control in App settings backed by a new pinned settings action; existing Apps keep their current behavior.
- **@bot-mention comment trigger**: commenting the App's `@<slug>` mention on a PR now requests a review, replacing the `/review` command outright; the exact mention string renders beside the control as a single copyable snippet.

<!-- CN -->
- **按 App 审查触发模式**：每个 App 现在可选择 PR 审查的自动触发时机——`open`（仅首次打开事件）、`every_push`（默认，行为与现状一致）或 `manual`（从不自动触发）——通过应用设置中的分段控件与新增的固定设置操作路由配置；既有 App 行为保持不变。
- **@bot 提及评论触发**：在 PR 中评论该 App 的 `@<slug>` 提及即可发起审查，完全替代 `/review` 命令；确切的提及字符串会在设置控件旁渲染为可复制的代码片段。
