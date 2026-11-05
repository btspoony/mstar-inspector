---
category: Fixed
---

- **A removed member stays removed (security)**: deleting a dashboard member is now authoritative — the removal is recorded (`removed_logins`, written in the SAME transaction as the membership row delete), the OAuth bootstrap consults that record **before** granting any bootstrap admin, and the bootstrap's own insert refuses at the **database write boundary** while the record exists (its `INSERT … WHERE NOT EXISTS (removal record)` cannot create a row, so a removal landing after the callback's reads still denies — an in-flight sign-in can never undo a removal). Bootstrap precedence is now: existing `users` row → recorded removal (deny) → empty-table fallback → deny. An existing row still wins, the empty-table fallback is unchanged, the last-admin protection is untouched, and only an admin's deliberate re-invite on the Members page clears the record so the login bootstraps normally again.

<!-- CN -->
- **被移除的成员不会被重新拉起（安全）**：删除 dashboard 成员现在是权威操作——移除会被记录（`removed_logins`，与成员行删除在同一事务内写入），OAuth 引导会**在**授予任何引导管理员之前检查该记录，且引导自身的插入会在**数据库写入边界**拒绝：只要该记录存在，`INSERT … WHERE NOT EXISTS（移除记录）` 就无法创建行，因此即使在回调读取之后才落地的移除也仍然会被拒绝——飞行中的登录无法撤销移除。引导优先级现为：已有 `users` 行 → 已记录移除（拒绝）→ 空表回退 → 拒绝。已有用户行仍优先，空表回退行为不变，最后一名管理员保护不变；只有管理员在 Members 页面主动重新邀请才会清除记录，该登录由此恢复正常引导。
