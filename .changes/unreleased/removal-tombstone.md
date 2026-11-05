---
category: Fixed
---

- **A removed login cannot be re-created**: sign-in's own row creation (`signInCreateUser`) carries `WHERE NOT EXISTS (removal record)`, so an OAuth callback cannot create a `users` row for a login recorded in `removed_logins`.
- **A tombstone on a live account stops new invites, not sign-in**: a login that still has a `users` row keeps signing in and keeps its memberships, and a pending invite minted before the tombstone can still be accepted; only minting a new invite is refused. Sign-in is refused once the row is gone.
- **Removal has no in-product surface**: no owner can undo a tombstone. The invite route answers 409 `invite.login_removed` (the dashboard surfaces only its generic invite-failure notice), and the only writer that clears a tombstone (`createUser`) has no production caller — tombstones are maintained by a deployment operator directly in D1. **Leaving a workspace is not a removal**: that deletes only the `workspace_members` row, so the account, its invites and its GitHub login are untouched.

<!-- CN -->
- **被移除的登录无法被重新创建**：登录自己的建行逻辑（`signInCreateUser`）带有 `WHERE NOT EXISTS（移除记录）`，因此 OAuth 回调无法为 `removed_logins` 中记录的登录创建 `users` 行。
- **墓碑作用于在线账号时阻止的是新建邀请，不是登录**：仍然存在 `users` 行的登录可以继续登录并保留成员关系，墓碑之前发出的待接受邀请仍可被接受；只有新建邀请会被拒绝。在该行被删除之后，登录才会被拒绝。
- **移除没有产品内入口**：任何 owner 都无法撤销墓碑。邀请接口会返回 409 `invite.login_removed`（dashboard 只显示通用的邀请失败提示），而唯一会清除墓碑的写入者（`createUser`）没有生产调用者——墓碑由部署运维者直接在 D1 中维护。**退出工作区不是移除**：那只会删除 `workspace_members` 行，账号、既有邀请与 GitHub 登录均不受影响。
