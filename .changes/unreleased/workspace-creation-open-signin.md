---
category: Changed
---

- **Sign-in is open; a workspace is created, not assigned.** The deployment-level
  login allowlist is gone: any GitHub login that completes the OAuth callback and
  is not recorded as removed gets a `users` row with `role = 'member'` and no
  workspace membership, unless the operator has closed `signup_open` — closed
  means no new row, while a login that already has one signs in unchanged. A
  signed-in login with no workspace lands on a **Create a workspace** form
  (`POST /dashboard/api/workspaces`), which mints a lowercase `ws_…` workspace and
  makes the creator its `owner` in one transaction. The form always renders; when
  the operator has closed workspace creation (`workspace_creation_open`) the
  submit is refused 409 `WORKSPACE_CREATION_CLOSED_REFUSAL`. Creation is the only
  way into a first workspace, and a successful create lands directly inside the
  new workspace (the `201` names `/dashboard/<ref>/apps`), so the creator never
  depends on sole-workspace resolution finding a second workspace. There is no
  auto-join and no first-user-becomes-admin fallback; authority is
  workspace-scoped from then on.
- **Deploy wiring loses the allowlist**: the allowlist's required-variable
  gate, its post-deploy settings assertion and its `--var` bind are removed
  from both workflows; the deployment shape and operator binds stay. A bare
  `wrangler deploy` is the supported manual path for a self-hosted copy.

<!-- CN -->
- **登录开放；工作区是创建出来的，不是被分配的。** 部署级的登录名名单已删除：任何完成
  OAuth 回调、且未被记录为移除的 GitHub 账号都会获得一条 `role = 'member'` 的 `users` 行，且不加入任何
  工作区——除非运维者关闭了 `signup_open`（关闭意味着不再新建行，已有行的登录照常登录）。
  已登录但没有任何工作区的用户会落在 **创建工作区** 表单
  （`POST /dashboard/api/workspaces`）：它生成小写的 `ws_…` 工作区，并在同一事务内把
  创建者设为该工作区的 `owner`。该表单始终渲染；当运维者关闭了工作区创建
  （`workspace_creation_open`）时，提交会被 409 `WORKSPACE_CREATION_CLOSED_REFUSAL` 拒绝。
  创建工作区是进入首个工作区的唯一途径；创建成功后直接落在新工作区内（`201` 会给出
  `/dashboard/<ref>/apps`），因此不依赖「唯一工作区」解析能否在存在第二个工作区时命中。
  没有自动加入，也没有「首位用户成为唯一工作区管理员」的回退；此后权限一律按工作区判定。
- **部署接线去掉名单**：两个 workflow 只删除该白名单的必填变量门禁、部署后设置断言与
  它的 `--var` 传参；部署形态与运维者传参保留。自托管副本的手工部署直接用
  `wrangler deploy`。
