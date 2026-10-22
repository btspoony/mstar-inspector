---
category: Changed
---

- **Sign-in is open; a workspace is created, not assigned.** The deployment-level
  login allowlist is gone: any GitHub login that completes the OAuth callback gets
  a `users` row with `role = 'member'` and no workspace membership. A signed-in
  login with no workspace lands on a **Create a workspace** form
  (`POST /dashboard/api/workspaces`), which mints a lowercase `ws_…` workspace and
  makes the creator its `owner` in one transaction. There is no auto-join and no
  first-user-becomes-admin fallback; authority is workspace-scoped from then on.
- **A recorded removal is the only deny.** Deleting a member still writes the
  `removed_logins` tombstone in the same transaction, and sign-in refuses it with
  the 403 removal page (zero cookies, zero writes) until a deliberate
  re-admission clears the record — the refusal is enforced at the insert itself,
  so an in-flight sign-in cannot undo a removal.
- **Deploy wiring loses the allowlist**: the `Verify required ADMIN_LOGINS
  variable` gate, the post-deploy settings assertion and the `--var
  ADMIN_LOGINS:…` plumbing are removed from both workflows, `wrangler.jsonc`
  `env.production.vars` keeps only `WORKSPACE_TENANT_MODE`, and a bare
  `wrangler deploy` is the supported manual path. **Upgrade note:** delete the
  now-unused `ADMIN_LOGINS` GitHub Actions variable; nothing reads it.

<!-- CN -->
- **登录开放；工作区是创建出来的，不是被分配的。** 部署级的登录名名单已删除：任何完成
  OAuth 回调的 GitHub 账号都会获得一条 `role = 'member'` 的 `users` 行，且不加入任何
  工作区。已登录但没有任何工作区的用户会落在 **创建工作区** 表单
  （`POST /dashboard/api/workspaces`）：它生成小写的 `ws_…` 工作区，并在同一事务内把
  创建者设为该工作区的 `owner`。没有自动加入，也没有「首位用户成为唯一工作区管理员」的
  回退；此后权限一律按工作区判定。
- **只有「已记录移除」会拒绝登录。** 删除成员仍在同一事务内写入 `removed_logins`
  墓碑，登录会以 403 移除页面拒绝（零 cookie、零写入），直到一次显式重新准入清除该记录——
  拒绝在插入语句本身生效，因此飞行中的登录无法撤销移除。
- **部署接线去掉名单**：两个 workflow 删除 `Verify required ADMIN_LOGINS variable`
  门禁、部署后设置断言与 `--var ADMIN_LOGINS:…` 传参；`wrangler.jsonc`
  `env.production.vars` 只保留 `WORKSPACE_TENANT_MODE`，手工部署直接用
  `wrangler deploy`。**升级提示：** 请删除已无用的 GitHub Actions 变量
  `ADMIN_LOGINS`，已无任何代码读取它。
