---
category: Added
---

- **Per-App review trigger modes**: each App now chooses when PR reviews run automatically — `open` (the first opening event only), `every_push` (the default; today's behavior unchanged), or `manual` (never auto-triggers) — via a segmented control in App settings backed by a new pinned settings action; existing Apps keep their current behavior.
- **@bot-mention comment trigger (BREAKING — `/review` is retired)**: commenting the App's `@<slug>` mention on a PR now requests a review; the `/review` command no longer does anything, with no alias and no deprecation window. The mention fires only for the PR author or a repository owner, only on a PR thread, never from a bot account, and never on a PR opened by a `[bot]` login; everyone else's comment is answered and ignored. The exact mention string renders beside the control as a single copyable snippet.

<!-- CN -->
- **按 App 审查触发模式**：每个 App 现在可选择 PR 审查的自动触发时机——`open`（仅首次打开事件）、`every_push`（默认，行为与现状一致）或 `manual`（从不自动触发）——通过应用设置中的分段控件与新增的固定设置操作路由配置；既有 App 行为保持不变。
- **@bot 提及评论触发（破坏性变更——`/review` 已退役）**：在 PR 中评论该 App 的 `@<slug>` 提及即可发起审查；`/review` 命令不再有任何作用，不提供别名，也没有弃用期。提及只对 PR 作者或仓库所有者生效，且必须评在 PR 线程上、发送方不能是 bot 账号，由 `[bot]` 登录名创建的 PR 也永不触发；其他人的评论会被应答并忽略。确切的提及字符串会在设置控件旁渲染为可复制的代码片段。
