---
category: Changed
---

- **A workspace's URL is its immutable id.** Every link the Worker emits —
  the shell boot ref, the operator support landing, the creation target, the
  `/dashboard` landing, the onboarding redirect, invite discovery, the sidebar
  fallback and the switcher's options — now names `ws_…` instead of the
  readable slug, so a link can never go stale because someone renamed the
  workspace. The `(slug = ? OR id = ?)` resolvers and the path-matching
  predicate are unchanged: an old `/dashboard/<slug>/…` link still serves the
  same workspace, and the browser URL is never rewritten.
- **The owner-facing slug editor is gone.** `PUT /dashboard/<ref>/api/settings/slug`
  and the Settings card that drove it are deleted, not redirected — the path
  segment is not something a tenant can change any more, and the request now
  answers the catch-all 404 for every role. Slug authoring moved to the
  platform console.
- **The owner renames the workspace label instead.** A new owner-only
  `PUT /dashboard/<ref>/api/settings/name` takes `{ name }`, trimmed and capped
  at the creation limit, and the workspace settings page renders a name card in
  place of the slug card. A save updates the top-bar switcher's label without a
  reload and without touching the path.
- **The platform console authors the slug.**
  `PATCH /_internal_admin/api/workspaces/:id/slug` lets an operator set a
  workspace's readable slug under the grammar, reserved-word and collision rules
  the owner route used to enforce (including "a slug may not equal another
  workspace's id"), and records one `workspace.slug.set` audit row in the same
  transaction. The Workspaces table shows the slug beside the name with a row
  action to edit it.

<!-- CN -->
- **工作区 URL 使用不可变的 id。** Worker 发出的每个链接——外壳 boot 的 ref、运维支持
  落地页、创建目标、`/dashboard` 落地、onboarding 重定向、邀请发现、侧边栏兜底以及
  切换器的选项——现在都使用 `ws_…` 而不是可读 slug，因此重命名工作区不会让任何链接失效。
  `(slug = ? OR id = ?)` 解析与路径匹配判定保持不变：旧的 `/dashboard/<slug>/…` 链接
  仍然指向同一工作区，浏览器 URL 也不会被改写。
- **面向所有者的 slug 编辑入口已删除。**
  `PUT /dashboard/<ref>/api/settings/slug` 及其设置页卡片被直接删除（不是重定向）——
  路径片段不再是租户可改的值，该请求对所有角色都返回兜底 404。slug 的撰写移至平台运维台。
- **所有者改为重命名工作区名称。** 新增仅所有者可用的
  `PUT /dashboard/<ref>/api/settings/name`，接收 `{ name }`，去除首尾空白并受创建时的
  长度上限约束；工作区设置页以名称卡片取代原 slug 卡片。保存后顶栏切换器的标签即时更新，
  无需重新加载，也不会改写路径。
- **平台运维台撰写 slug。** 运维者可通过
  `PATCH /_internal_admin/api/workspaces/:id/slug` 设置工作区的可读 slug，校验规则与原先
  面向所有者的路由一致（字符形状、保留字、冲突，包括「slug 不得等于其他工作区的 id」），
  并在同一事务内写入一条 `workspace.slug.set` 审计行。工作区表格在名称旁显示 slug，
  并提供行内编辑操作。
