---
category: Changed
---

- **Workspace role changes are owner-only, and promotion is how ownership moves.**
  A role change now targets `owner` too, so an `owner` promotes an existing
  `admin` or `member` to `owner` and then steps down — there is no separate
  transfer action. An `admin` may still invite, revoke an invite and remove a
  plain `member`, but may not change any role, nor remove an `owner` or another
  `admin` (403 — including when that owner is the last one, never a 409).
- **The last owner cannot be removed or demoted**, and an `owner` demoting
  themselves while they are the only `owner` is refused with a 409; after a
  second owner exists the same self-demotion is allowed. Removing the last
  owner answers that same 409, even when the actor is that owner (it outranks
  the generic self-removal 400). `users.role` is no longer read or written by
  any workspace authorization decision.
- **Removing a member removes only the membership.** Leaving a workspace
  deletes the `workspace_members` row and nothing else: the account (`users`
  row) survives, so the person can still sign in, keeps the invites they
  created, and can be invited into another workspace or create their own. The
  deployment-level login ban (`removed_logins`) stays an operator action,
  never a side effect of a workspace membership change.

<!-- CN -->
- **工作区角色变更仅限 `owner`，所有权通过「提升」移交。** 角色变更现在也可以指向
  `owner`：现有 `owner` 把已在工作区内的 `admin` 或 `member` 提升为 `owner`，然后自行
  降级即可——没有单独的移交操作。`admin` 仍可邀请、撤销邀请、移除普通 `member`，但不能
  变更任何角色，也不能移除 `owner` 或另一名 `admin`（403——即使该 owner 是最后一名，
  也返回 403 而不是 409）。
- **最后一名 `owner` 不能被移除或降级**；唯一 `owner` 自我降级返回 409，已有第二名
  `owner` 后同样的自我降级被允许。移除最后一名 `owner` 同样返回该 409，即使操作者就是
  该 owner（它优先于通用的「不能移除自己」400）。`users.role` 不再参与任何工作区授权判定，
  也不会被写入。
- **移除成员只移除成员关系。** 退出工作区只删除对应的 `workspace_members` 行：账号
  （`users` 行）保留，因此该用户仍可登录、其创建的邀请仍在、可以被邀请进另一个工作区，
  也可以自行创建工作区。部署级的登录封禁（`removed_logins`）仍只由运维者动作写入，绝不
  作为工作区成员变更的副作用。
