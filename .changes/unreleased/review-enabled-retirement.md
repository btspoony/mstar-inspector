---
category: Removed
---

- **BREAKING — the deployment-wide review brake is gone.** The `REVIEW_ENABLED`
  Worker variable no longer exists: no reader, no env declaration, no docs row,
  no `keep_vars` note, no test fixture. Per-App
  `github_apps.review_enabled` (the dashboard Pause/Resume switch) is the only
  review control, so no deployment-level value can freeze every tenant's
  reviews. Behaviour is otherwise unchanged: a webhook for an App with
  `review_enabled = 1` enqueues, and one with `0` is ignored with 2xx and zero
  enqueue.
- **A deployment still holding `REVIEW_ENABLED=false` resumes reviews for EVERY
  App the moment this Worker lands.** The value is no longer read, so it can no
  longer keep anything frozen — any App that was relying on it starts reviewing
  for real. **Before deploying**, pause each App you meant to keep frozen
  (`review_enabled = 0` on its dashboard Settings page) or suspend the App at
  GitHub. Those are the only two stop levers left: there is no deployment-wide
  brake. **Upgrade note:** delete the leftover `REVIEW_ENABLED` Worker variable
  (and the matching GitHub Actions variable, if one was set) — nothing reads it,
  and leaving it behind suggests a control that no longer exists.

<!-- CN -->
- **破坏性变更——部署级审查总闸已删除。** `REVIEW_ENABLED` Worker 变量不再存在：
  没有读取方、没有 env 声明、没有文档表格行、没有 `keep_vars` 说明、没有测试夹具。
  唯一的审查控制是 per-App `github_apps.review_enabled`（dashboard 的 Pause/Resume
  开关），任何部署级取值都无法冻结全部租户的审查。除此之外行为不变：
  `review_enabled = 1` 的 App 收到 webhook 会入队，`0` 的 App 返回 2xx 且零入队。
- **仍保留 `REVIEW_ENABLED=false` 的部署，会在本次 Worker 上线的那一刻恢复每一个
  App 的审查。** 该值已无读取方，因此再也冻结不了任何东西——原本依赖它的 App 会
  立即开始真实审查。**部署之前**，请把你要继续保持冻结的每个 App 暂停（在其 dashboard
  Settings 页把 `review_enabled` 置为 `0`），或在 GitHub 侧 suspend 该 App。此后只剩
  这两个停止手段：不存在部署级总闸。**升级提示：** 请删除残留的 `REVIEW_ENABLED`
  Worker 变量（以及可能设置过的同名 GitHub Actions 变量）——已无任何读取方，留着只会
  暗示一个已不存在的控制手段。
