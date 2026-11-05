---
category: Fixed
---

- **A removed login stays removed (security)**: deleting a dashboard user writes the `removed_logins` tombstone in the same transaction as the account and membership deletions, and sign-in refuses a tombstoned login at the insert itself — an in-flight OAuth callback cannot re-create the row. An existing `users` row and existing memberships keep working.
- **The removal is permanent in-product**: no owner can undo it. The invite form answers 409 `invite.login_removed` and points at a deployment operator, and the only code path that clears a tombstone has no production caller — clearing one means a manual `wrangler d1 execute … DELETE FROM removed_logins …` (see `docs/deploy.md`). **Leaving a workspace is not a removal**: that deletes only the `workspace_members` row, so the account, its invites and its GitHub login are untouched.

<!-- CN -->
- **被移除的登录不会自己回来（安全）**：删除 dashboard 用户时会在同一事务内写入 `removed_logins` 墓碑，并删除账号行与全部工作区成员行；登录会在插入语句本身被拒绝，飞行中的 OAuth 回调无法重建该行。已有的 `users` 行与既有成员关系不受影响。
- **在产品内删除不可撤销**：任何 owner 都无法撤销。邀请表单会返回 409 `invite.login_removed` 并指向部署运维者，而唯一会清除墓碑的代码路径没有生产调用者——要清除只能手工执行 `wrangler d1 execute … DELETE FROM removed_logins …`（见 `docs/deploy.md`）。**退出工作区不是移除**：那只会删除 `workspace_members` 行，账号、既有邀请与 GitHub 登录均不受影响。
