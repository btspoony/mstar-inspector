---
category: Changed
---

- **Sign-in is open; a workspace is created, not assigned.** The deployment-level
  login allowlist is gone: any GitHub login that completes the OAuth callback gets
  a `users` row with `role = 'member'` and no workspace membership. A signed-in
  login with no workspace lands on a **Create a workspace** form
  (`POST /dashboard/api/workspaces`), which mints a lowercase `ws_…` workspace and
  makes the creator its `owner` in one transaction. That form is always offered
  — creation is the only way into a first workspace — and a successful create
  lands directly inside the new workspace (the `201` names the target,
  `/<new ref>/apps`), so the creator never depends on sole-workspace resolution
  finding a second workspace. There is no auto-join and no
  first-user-becomes-admin fallback; authority is workspace-scoped from then on.
- **A recorded removal is the only deny.** The deployment-operator removal of a
  dashboard user still writes the `removed_logins` tombstone in the same
  transaction, and sign-in refuses it with the 403 removal page (zero cookies,
  zero writes) until a deliberate re-admission clears the record — the refusal
  is enforced at the insert itself, so an in-flight sign-in cannot undo a
  removal. **Leaving a workspace is not that**: removing someone from a
  workspace deletes only their `workspace_members` row, so their account,
  their invites and their GitHub login are untouched.
- **Deploy wiring loses the allowlist**: the `Verify required ADMIN_LOGINS
  variable` gate, the post-deploy settings assertion and the `--var
  ADMIN_LOGINS:…` plumbing are removed from both workflows, and a bare
  `wrangler deploy` is the supported manual path. **Upgrade note:** delete the
  now-unused `ADMIN_LOGINS` GitHub Actions variable; nothing reads it.

<!-- CN -->
- **登录开放；工作区是创建出来的，不是被分配的。** 部署级的登录名名单已删除：任何完成
  OAuth 回调的 GitHub 账号都会获得一条 `role = 'member'` 的 `users` 行，且不加入任何
  工作区。已登录但没有任何工作区的用户会落在 **创建工作区** 表单
  （`POST /dashboard/api/workspaces`）：它生成小写的 `ws_…` 工作区，并在同一事务内把
  创建者设为该工作区的 `owner`。该表单**始终提供**——创建工作区是进入首个工作区的唯一
  途径；创建成功后直接落在新工作区内（`201` 会给出目标 `/<新 ref>/apps`），因此不依赖
  「唯一工作区」解析能否在存在第二个工作区时命中。没有自动加入，也没有「首位用户成为唯一
  工作区管理员」的
  回退；此后权限一律按工作区判定。
- **只有「已记录移除」会拒绝登录。** 部署运维者移除某位 dashboard 用户时，仍在同一事务内
  写入 `removed_logins` 墓碑，登录会以 403 移除页面拒绝（零 cookie、零写入），直到一次显式
  重新准入清除该记录——拒绝在插入语句本身生效，因此飞行中的登录无法撤销移除。**退出工作区
  不是移除**：把某人从工作区移除只删除其 `workspace_members` 行，账号、既有邀请与 GitHub
  登录均不受影响。
- **部署接线去掉名单**：两个 workflow 删除 `Verify required ADMIN_LOGINS variable`
  门禁、部署后设置断言与 `--var ADMIN_LOGINS:…` 传参；手工部署直接用
  `wrangler deploy`。**升级提示：** 请删除已无用的 GitHub Actions 变量
  `ADMIN_LOGINS`，已无任何代码读取它。
