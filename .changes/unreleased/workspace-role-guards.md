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
  second owner exists the same self-demotion is allowed. `users.role` is no
  longer read or written by any workspace authorization decision.

<!-- CN -->
- **工作区角色变更仅限 `owner`，所有权通过「提升」移交。** 角色变更现在也可以指向
  `owner`：现有 `owner` 把已在工作区内的 `admin` 或 `member` 提升为 `owner`，然后自行
  降级即可——没有单独的移交操作。`admin` 仍可邀请、撤销邀请、移除普通 `member`，但不能
  变更任何角色，也不能移除 `owner` 或另一名 `admin`（403——即使该 owner 是最后一名，
  也返回 403 而不是 409）。
- **最后一名 `owner` 不能被移除或降级**；唯一 `owner` 自我降级返回 409，已有第二名
  `owner` 后同样的自我降级被允许。`users.role` 不再参与任何工作区授权判定，也不会被写入。
