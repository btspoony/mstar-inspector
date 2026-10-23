---
category: Changed
---

- **BREAKING — one deployment shape variable, one tenant read path.** The v1.2
  tenant mode is deleted end to end: no reader, no validator, no workflow
  dispatch input, no `--var`, no `env.production.vars` entry, no replay guard.
  Tenant reads are unconditional — every execution-facing App read INNER JOINs
  `app_workspaces`, and `/dashboard/<workspace-slug>/apps…` is the only App
  route family, so the pre-workspace root paths (`/dashboard/apps…`,
  `/dashboard/api/apps…`) answer 404. **Upgrade note:** delete the now-unused
  `WORKSPACE_TENANT_MODE` GitHub Actions variable and any `tenant_mode=…`
  dispatch habit; a leftover value is inert text that nothing reads.
- **New `DEPLOYMENT_MODE` Worker var (`self-hosted` | `saas`)** — the axis this
  replaces is the *product shape*, not the read path. It decides one question:
  whether an instance whose `users` table is empty tells its first signer-in
  the empty-instance story (this login is now an account on this instance; next
  step is workspace creation). `saas` never shows it. Both deploy workflows
  pass `saas` with `--var`, `env.production.vars` carries `saas`, and local dev
  declares `self-hosted`. There is **no default**: unset, empty or any other
  value fails loud at startup with
  `DEPLOYMENT_MODE must be "self-hosted" or "saas", received <value>`, and the
  SPA boot and OAuth-callback faces answer 500 with that text instead of
  serving a guessed shape. The webhook and queue faces never read it, so a bad
  value cannot 404 webhooks or stop reviews.
- **One deploy, not a two-deploy rollout.** The same build no longer needs an
  `off` deploy followed by a `strict` replay on the same SHA/tag, so the
  `tenant_mode` and `expected_deploy_sha` dispatch inputs, the replay binding
  and `scripts/resolve-tenant-mode.sh` are gone. What survives is what protects
  a normal deploy: the run's ref identity is asserted before every
  deploy-capable step (checked-out `HEAD` on staging, `refs/tags/<tag>^{commit}`
  on production, so a moved tag/branch can never deploy), migrations and the
  idempotent `0027` App-attribution repair run before the first
  version-creating step, and the zero-orphan gate aborts before every deploy
  and is re-asserted against the version serving traffic. Rollback is
  `git revert` of the merge commit — the config-level mode lever no longer
  exists.
- **New workspace ownership data plane** (migrations `0026`/`0027`/`0030`): every
  App and dashboard user belongs to a workspace. `0027` attributes existing Apps
  to the `default` workspace and is the only replayable half (both deploy
  workflows re-run it before any deploy-capable step); `0030` backfills the
  pre-open-sign-in users' memberships exactly once, cutover-scoped, because
  replaying a per-person write made every routine deploy re-add every login —
  removed members included — to `default`. Both workflows abort before any
  deploy-capable step when an App is still unmapped.

<!-- CN -->
- **破坏性变更——一个部署形态变量，一条租户读取路径。** v1.2 的租户模式已被彻底删除：
  没有读取方、没有校验器、没有 workflow dispatch 输入、没有 `--var`、没有
  `env.production.vars` 条目、没有 replay 守卫。租户读取不再有条件——所有面向执行的
  App 读取都 INNER JOIN `app_workspaces`，且 `/dashboard/<workspace-slug>/apps…`
  是唯一的 App 路由族，因此工作区之前的前缀路径（`/dashboard/apps…`、
  `/dashboard/api/apps…`）返回 404。**升级提示：** 请删除已无用的
  `WORKSPACE_TENANT_MODE` GitHub Actions 变量以及任何 `tenant_mode=…` 的 dispatch
  习惯；残留值只是无人读取的惰性文本。
- **新增 `DEPLOYMENT_MODE` Worker 变量（`self-hosted` | `saas`）**——它替代的是
  *产品形态*这条轴，而不是读取路径。它只决定一个问题：`users` 表为空的实例，是否向
  其第一个登录者讲述「空实例」故事（本次登录已成为该实例上的账号，下一步是创建工作区）。
  `saas` 永不显示该页面。两个部署 workflow 都用 `--var` 传 `saas`，
  `env.production.vars` 声明 `saas`，本地开发声明 `self-hosted`。**没有默认值**：
  未设置、空值或任何其他值都会在启动时明确失败
  （`DEPLOYMENT_MODE must be "self-hosted" or "saas", received <value>`），SPA 启动
  面与 OAuth 回调面会以该文本返回 500，而不是按猜测的形态提供服务。webhook 与队列
  消费面从不读取它，因此错误值既不会让 webhook 404，也不会中断 review。
- **一次部署，而非两阶段上线。** 同一个构建不再需要在同一 SHA/tag 上先 `off` 再
  `strict` 重放，因此 `tenant_mode` 与 `expected_deploy_sha` dispatch 输入、replay
  绑定以及 `scripts/resolve-tenant-mode.sh` 均已删除。保留下来的是保护普通部署的部分：
  在每个可部署步骤之前断言运行 ref 身份（staging 校验 checkout 的 `HEAD`，production
  校验 `refs/tags/<tag>^{commit}`，因此被移动的 tag/分支永远无法部署）、迁移与幂等的
  `0027` App 归属修复先于第一个创建版本的步骤、零孤儿门禁在任何部署之前中止并在对外服务
  版本上再次断言。回滚方式是对 merge commit 执行 `git revert`——配置层的模式开关已不存在。
- **新增工作区归属数据面**（迁移 `0026`/`0027`/`0030`）：每个 App 与 dashboard 用户
  都归属某个工作区。`0027` 把既有 App 归属到 `default` 工作区，且是唯一可重放的一半
  （两个 deploy workflow 都会在任何可部署步骤前重跑它）；`0030` 按切点范围、只执行一次地
  回填开放登录之前用户的成员关系——若把「按人写入」的那一半做成可重放，每次常规部署都会把
  所有登录（包括已被移除的成员）重新加回 `default`。两个 workflow 都会在存在未映射 App
  时于任何可部署步骤之前中止。
