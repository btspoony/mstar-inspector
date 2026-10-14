---
category: Added
---

- **Per-App review trigger modes**: each App now chooses when PR reviews run automatically — `open` (the first opening event only), `every_push` (the default; today's behavior unchanged), or `manual` (never auto-triggers) — via a segmented control in App settings backed by a new pinned settings action; existing Apps keep their current behavior.
- **@bot-mention comment trigger**: commenting the App's `@<slug>[bot]` mention on a PR now requests a review, replacing the `/review` command outright; the exact mention string renders beside the control as a single copyable snippet.
- **Webhook body cap enforced on streamed bytes**: the 413 request-size cap no longer trusts the client-supplied `content-length` header — oversized bodies are rejected mid-stream the moment the limit is exceeded, even when the header is missing or lying.
- **Required ADMIN_LOGINS at deploy time**: the deploy pipeline now requires the GitHub Actions variable `ADMIN_LOGINS` (comma-separated GitHub logins) and fails closed *before* its first `wrangler` invocation when it is missing or blank/comma-only, then injects it into the Worker via `wrangler deploy --var`; the post-deploy settings check is an assertion rather than a warning, so the first-login-becomes-admin bootstrap can no longer be silently armed. `ADMIN_LOGINS` stays an **"at least one" bootstrap list** — its purpose is to let the first admin reach the dashboard; it is not ongoing membership management, the dashboard's `users` table / Members page remains the membership SSOT, and listed logins with no row remain eligible for admin bootstrap, while an existing row always wins without promotion and an operator's removal is authoritative (the list never resurrects a removed login — see the admin-login revocation fix).

<!-- CN -->
- **按 App 审查触发模式**：每个 App 现在可选择 PR 审查的自动触发时机——`open`（仅首次打开事件）、`every_push`（默认，行为与现状一致）或 `manual`（从不自动触发）——通过应用设置中的分段控件与新增的固定设置操作路由配置；既有 App 行为保持不变。
- **@bot 提及评论触发**：在 PR 中评论该 App 的 `@<slug>[bot]` 提及即可发起审查，完全替代 `/review` 命令；确切的提及字符串会在设置控件旁渲染为可复制的代码片段。
- **Webhook 体积上限按流式字节生效**：413 请求体积上限不再信任客户端提供的 `content-length` 头——即使该头缺失或造假，请求体也会在流式读取超过上限的瞬间被拒绝。
- **部署时强制要求 ADMIN_LOGINS**：部署流水线现在要求 GitHub Actions 变量 `ADMIN_LOGINS`（逗号分隔的 GitHub 登录名），缺失或仅为空白/逗号时会在作业中**第一次 `wrangler` 调用之前**直接失败关闭，并通过 `wrangler deploy --var` 注入 Worker；部署后设置检查从告警改为断言，「首次登录即成为管理员」的引导路径不再可能静默启用。`ADMIN_LOGINS` 始终只是**「至少一个」的引导名单**——其目的是让首位管理员能够进入后台，而不是持续的成员管理；成员管理仍以 dashboard 的 `users` 表 / Members 页面为唯一权威；名单内但尚无用户行的登录仍可被引导为管理员，而已有用户行始终优先、不会被提权，管理员的移除同样具有权威性（名单不会把已移除的登录重新拉起——见管理员登录移除修复）。
