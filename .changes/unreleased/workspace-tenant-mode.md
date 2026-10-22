---
category: Changed
---

- **BREAKING — the dashboard App routes move under a workspace slug.** With
  `WORKSPACE_TENANT_MODE=strict` (Deploy B of the tenant rollout),
  `/dashboard/apps…` and `/dashboard/api/apps…` answer 404 and the App UI lives at
  `/dashboard/<workspace-slug>/apps…`, with authorization decided by the actor's
  workspace role. Rolling back is re-deploying the same tag with `tenant_mode=off`
  (Deploy A).
- **New workspace ownership data plane** (migrations `0026`/`0027`): every App and
  dashboard user belongs to a workspace, the backfill maps existing rows to the
  `default` workspace, and `strict` App reads see only workspace-mapped rows. Both
  deploy workflows re-run the idempotent backfill and abort before `wrangler deploy`
  when any App is still unmapped.
- **`WORKSPACE_TENANT_MODE` is deploy wiring, not a rehearsal**: unset/empty means
  `off`, `off` and `strict` are the only legal values, and any other value makes the
  dashboard answer 500 and the queue consumer fail before processing a message.
- **A strict installation must set the `WORKSPACE_TENANT_MODE` repository
  variable.** Routine deploys (staging push, production release) now take the
  mode from that variable instead of resolving `off`; a routine deploy that
  still resolves to `off` warns and records `tenant_mode_change=unproven->off`
  in the run summary rather than silently demoting a strict installation. A
  routine `strict` deploy is not a replay: only a `tenant_mode=strict`
  dispatch must supply `expected_deploy_sha`.

<!-- CN -->
- **破坏性变更——dashboard 的 App 路由移到工作区 slug 之下。** 在
  `WORKSPACE_TENANT_MODE=strict`（租户上线的 Deploy B）下，`/dashboard/apps…`
  与 `/dashboard/api/apps…` 返回 404，App 界面位于
  `/dashboard/<workspace-slug>/apps…`，鉴权改用操作者在该工作区的角色。把同一个
  tag 以 `tenant_mode=off` 重新部署（Deploy A）即可退回旧路由。
- **新增工作区归属数据面**（迁移 `0026`/`0027`）：每个 App 与 dashboard 用户都
  归属某个工作区，回填把既有数据映射到 `default` 工作区，`strict` 下 App 读取
  只能看到已映射的行。两个 deploy workflow 都会重跑幂等回填，并在存在未映射 App
  时于 `wrangler deploy` 之前中止。
- **`WORKSPACE_TENANT_MODE` 属于部署接线，不是演练**：未设置/空值为 `off`，
  `off` 与 `strict` 是唯一合法值，其他值会让 dashboard 返回 500、队列消费者在处理
  任何消息前失败。
- **strict 安装必须设置 `WORKSPACE_TENANT_MODE` 仓库变量。** 常规部署（staging
  的 push、production 的 release）现在从该变量取模式，不再一律解析为 `off`；
  仍解析为 `off` 的常规部署会告警并在 run summary 记录
  `tenant_mode_change=unproven->off`，而不是静默把 strict 安装降级。常规的
  `strict` 部署不算 replay：只有 `tenant_mode=strict` 的 dispatch 必须提供
  `expected_deploy_sha`。
