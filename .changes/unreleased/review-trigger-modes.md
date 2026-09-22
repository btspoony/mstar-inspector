---
category: Added
---

- **Per-App review trigger modes**: each App now chooses when PR reviews run automatically — `open` (the first opening event only), `every_push` (the default; today's behavior unchanged), or `manual` (never auto-triggers) — via a segmented control in App settings backed by a new pinned settings action; existing Apps keep their current behavior.
- **@bot-mention comment trigger**: commenting the App's `@<slug>[bot]` mention on a PR now requests a review, replacing the `/review` command outright; the exact mention string renders beside the control as a single copyable snippet.
- **Webhook body cap enforced on streamed bytes**: the 413 request-size cap no longer trusts the client-supplied `content-length` header — oversized bodies are rejected mid-stream the moment the limit is exceeded, even when the header is missing or lying.
- **Deploy-time admin visibility**: the deploy pipeline warns when `ADMIN_LOGINS` is unset, so the first-login-becomes-admin bootstrap can no longer happen silently; the settings smoke check stays aligned with runtime trimming.

<!-- CN -->
- **按 App 审查触发模式**：每个 App 现在可选择 PR 审查的自动触发时机——`open`（仅首次打开事件）、`every_push`（默认，行为与现状一致）或 `manual`（从不自动触发）——通过应用设置中的分段控件与新增的固定设置操作路由配置；既有 App 行为保持不变。
- **@bot 提及评论触发**：在 PR 中评论该 App 的 `@<slug>[bot]` 提及即可发起审查，完全替代 `/review` 命令；确切的提及字符串会在设置控件旁渲染为可复制的代码片段。
- **Webhook 体积上限按流式字节生效**：413 请求体积上限不再信任客户端提供的 `content-length` 头——即使该头缺失或造假，请求体也会在流式读取超过上限的瞬间被拒绝。
- **部署时管理员可见性**：`ADMIN_LOGINS` 未设置时部署流水线会发出告警，「首次登录即成为管理员」的引导路径不再静默发生；设置冒烟检查与运行时裁剪逻辑保持一致。
