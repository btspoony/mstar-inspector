---
category: Fixed
---

- **App creation works once a deployment has several workspaces.** The creation
  right is now judged in the workspace the request addresses (`owner`/`admin`
  there), not in "the deployment's only workspace", which stopped existing the
  moment a second workspace was created. The SPA's Create action posts under the
  page's own workspace prefix and the chosen workspace's stable id rides the signed
  state and the encrypted hold, so the App lands where the operator started
  even if that workspace is renamed mid-flow.
  A request that names no workspace on a multi-workspace deployment now answers
  `409 {"code": "workspace_required", …}` (styled error page for a navigation)
  instead of a bare `403`.
- **The Create action no longer disappears.** When the caller cannot run the
  flow, the SPA renders the control disabled with the reason — the addressed
  workspace's role, or the missing workspace — in both locales.
- **`/dashboard` lands on a real route.** A login with several memberships is
  sent to its first workspace's Apps page (its membership list is ordered by
  name, then id) instead of the retired `/dashboard/apps` root, and the shell's
  nav follows that workspace.
- **The operator audit-order tests are deterministic.** `audit_events` rows
  written inside one request batch share a millisecond, so the tests now break
  the tie on `rowid` (write order) rather than the random UUID primary key.

<!-- CN -->
- **部署存在多个工作区后，App 创建仍然可用。** 创建权限现在按请求所指工作区判定
  （在该工作区为 `owner`/`admin`），而不再依赖在出现第二个工作区时就不存在的「部署唯一
  工作区」。SPA 的创建按钮提交到当前页面的工作区前缀，所选工作区随签名 state 与加密
  hold 一路传递，因此 App 落在操作者开始流程的那个工作区。多工作区部署上未指明工作区的
  请求现在返回 `409 {"code": "workspace_required", …}`（页面导航时返回同款错误页），
  而不是裸 `403`。
- **创建按钮不再静默消失。** 调用方无法执行该流程时，SPA 显示禁用的控件并给出原因——
  当前工作区的角色，或缺少工作区——两种语言均有文案。
- **`/dashboard` 落到真实路由。** 拥有多个成员关系的登录会跳转到其第一个工作区（成员
  关系按名称、再按 id 排序）的 Apps 页，而不是已退役的 `/dashboard/apps`，侧边栏导航
  也跟随该工作区。
- **运维审计顺序测试变得确定。** 同一请求批次写入的 `audit_events` 行共享毫秒级时间戳，
  因此测试改用 `rowid`（写入顺序）而不再用随机 UUID 主键打破并列。
