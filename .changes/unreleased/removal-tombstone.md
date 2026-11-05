---
category: Fixed
---

- **A tombstoned login stays out (security)**: sign-in checks the `removed_logins` record at the write boundary — the bootstrap insert carries `WHERE NOT EXISTS (removal record)` — so an OAuth callback cannot create a removed account again. At this head the tombstone is written by the manual SQL documented in `docs/deploy.md`; no route calls the removal helper.
- **A tombstone blocks invites for a live account**: a login that still has a `users` row keeps signing in and keeps its memberships, but it can no longer be invited into any workspace on the deployment. Sign-in is refused only once the row is gone.
- **The removal is not reversible in-product**: no owner can undo it. The invite route answers 409 `invite.login_removed` (the dashboard surfaces only its generic invite-failure notice), and the only writer that clears a tombstone (`createUser`) has no production caller — clearing one is a manual D1 operation outside the product. **Leaving a workspace is not a removal**: that deletes only the `workspace_members` row, so the account, its invites and its GitHub login are untouched.

<!-- CN -->
- **被记录移除的登录无法自行回来（安全）**：登录会在写入边界检查 `removed_logins` 记录——引导插入带有 `WHERE NOT EXISTS（移除记录）`——因此 OAuth 回调无法重建已移除的账号。在当前版本中，墓碑由 `docs/deploy.md` 记录的手工 SQL 写入；没有任何路由调用移除辅助函数。
- **墓碑会阻止邀请，但在线账号仍可用**：仍然存在 `users` 行的登录可以继续登录并保留其成员关系，但它不能再被邀请进入该部署的任何工作区。只有在该行被删除之后，登录才会被拒绝。
- **在产品内无法撤销移除**：任何 owner 都无法撤销。邀请接口会返回 409 `invite.login_removed`（dashboard 只显示通用的邀请失败提示），而唯一会清除墓碑的写入者（`createUser`）没有生产调用者——清除墓碑是产品之外的手工 D1 操作。**退出工作区不是移除**：那只会删除 `workspace_members` 行，账号、既有邀请与 GitHub 登录均不受影响。
