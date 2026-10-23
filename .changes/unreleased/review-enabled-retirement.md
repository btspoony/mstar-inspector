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
  enqueue. **Upgrade note:** delete the leftover `REVIEW_ENABLED` Worker
  variable (and the matching GitHub Actions variable, if one was set) — nothing
  reads it, and leaving it behind suggests a control that no longer exists.

<!-- CN -->
- **破坏性变更——部署级审查总闸已删除。** `REVIEW_ENABLED` Worker 变量不再存在：
  没有读取方、没有 env 声明、没有文档表格行、没有 `keep_vars` 说明、没有测试夹具。
  唯一的审查控制是 per-App `github_apps.review_enabled`（dashboard 的 Pause/Resume
  开关），任何部署级取值都无法冻结全部租户的审查。除此之外行为不变：
  `review_enabled = 1` 的 App 收到 webhook 会入队，`0` 的 App 返回 2xx 且零入队。
  **升级提示：** 请删除残留的 `REVIEW_ENABLED` Worker 变量（以及可能设置过的同名
  GitHub Actions 变量）——已无任何读取方，留着只会暗示一个已不存在的控制手段。
