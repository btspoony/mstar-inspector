---
category: Fixed
---

- **A removed member stays removed (security)**: deleting a dashboard member is now authoritative — the removal is recorded (`removed_logins`, written in the SAME transaction as the membership row delete), and the sign-in insert refuses at the **database write boundary** while that record exists: its `INSERT … WHERE NOT EXISTS (removal record)` cannot create a row, so a removal landing after the callback's reads still denies — an in-flight sign-in can never undo a removal. Sign-in precedence is now: existing `users` row → allow, zero writes; recorded removal → deny, zero writes; otherwise a `role = 'member'` row is created and the login is allowed, joined to no workspace. Only a deliberate re-admission by an owner clears the tombstone — in the same batch as its insert — which is the only thing that may undo a removal.

<!-- CN -->
- **被移除的成员不会被重新拉起（安全）**：删除 dashboard 成员现在是权威操作——移除会被记录（`removed_logins`，与成员行删除在同一事务内写入），而登录插入会在**数据库写入边界**拒绝：只要该记录存在，`INSERT … WHERE NOT EXISTS（移除记录）` 就无法创建行，因此即使在回调读取之后才落地的移除也仍然会被拒绝——飞行中的登录无法撤销移除。登录优先级现为：已有 `users` 行 → 允许，零写入；已记录移除 → 拒绝，零写入；否则创建一条 `role = 'member'` 的行并允许登录，且不加入任何工作区。只有 owner 的显式重新准入（与其插入在同一批次内清除墓碑）才能撤销移除。
