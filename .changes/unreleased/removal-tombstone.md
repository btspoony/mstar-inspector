---
category: Fixed
---

- **A removed login stays removed (security)**: deleting a dashboard user writes the `removed_logins` tombstone in the same transaction that deletes the account row and all its workspace memberships, and sign-in refuses a tombstoned login at the insert itself — an in-flight OAuth callback cannot re-create the row.
- **A hand-written tombstone blocks invites, not a live session**: an operator can record a removal for a login that still has a row (`docs/deploy.md`); that row and its memberships keep working and the login still signs in, but it can no longer be invited into any workspace on the deployment. Sign-in is refused only once the row is gone.
- **The removal is permanent in-product**: no owner can undo it. The invite form answers 409 `invite.login_removed` and points at a deployment operator, and the only code path that clears a tombstone has no production caller — clearing one means a manual `wrangler d1 execute … DELETE FROM removed_logins …`. **Leaving a workspace is not a removal**: that deletes only the `workspace_members` row, so the account, its invites and its GitHub login are untouched.

<!-- CN -->
- **被移除的登录不会自己回来（安全）**：删除 dashboard 用户时，会在同一事务内写入 `removed_logins` 墓碑，并删除账号行与它的全部工作区成员行；登录会在插入语句本身被拒绝，飞行中的 OAuth 回调无法重建该行。
- **手工写入墓碑阻止的是邀请，不是在线会话**：运维者可以为仍然存在账号行的登录记录一次移除（见 `docs/deploy.md`）；该行与它的成员关系继续工作，登录仍然可用，但它不能再被邀请进入该部署的任何工作区。只有在该行被删除之后，登录才会被拒绝。
- **在产品内删除不可撤销**：任何 owner 都无法撤销。邀请表单会返回 409 `invite.login_removed` 并指向部署运维者，而唯一会清除墓碑的代码路径没有生产调用者——要清除只能手工执行 `wrangler d1 execute … DELETE FROM removed_logins …`。**退出工作区不是移除**：那只会删除 `workspace_members` 行，账号、既有邀请与 GitHub 登录均不受影响。
