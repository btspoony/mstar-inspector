---
category: Added
---

- **Workspace URLs can be renamed by the owner.** `PUT
  /:workspaceRef/api/settings/slug` validates the shape
  (`^[a-z0-9][a-z0-9-]{1,38}$`) and the reserved-word list, then performs ONE
  guarded UPDATE: a slug already used by another workspace (case-insensitively)
  or equal to any workspace's `id` is refused with a 409 carrying a
  machine-readable code (`slug_taken`, `slug_is_workspace_id`, `slug_reserved`).
  Nothing is auto-suffixed and nothing is retried. A rename is not a redirect —
  the old segment answers 404 from then on, while the workspace's `id` and its
  new slug both keep resolving. The settings page gains the owner-only control
  with the refusal shown inline.

<!-- CN -->
- **工作区所有者可以修改工作区 URL。** `PUT /:workspaceRef/api/settings/slug`
  先校验形状（`^[a-z0-9][a-z0-9-]{1,38}$`）与保留字，再执行一条带守卫的 UPDATE：
  若该 slug 已被其他工作区使用（大小写不敏感）或等于任何工作区的 `id`，返回带
  机器可读 code（`slug_taken`、`slug_is_workspace_id`、`slug_reserved`）的 409。
  不自动加后缀，也不重试。改 slug 不做重定向——旧路径此后返回 404，而工作区的 `id`
  与新 slug 都继续可用。设置页新增仅所有者可见的表单，冲突就地提示。
