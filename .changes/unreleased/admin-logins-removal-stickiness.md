---
category: Fixed
---

- **A removed member stays removed (security)**: deleting a dashboard member is now authoritative — the removal is recorded (`removed_logins`, written in the SAME transaction as the membership row delete) and the OAuth bootstrap consults that record **before** the `ADMIN_LOGINS` allowlist, so a removed login can no longer be re-created as admin by its next sign-in even while the allowlist still spells it. Bootstrap precedence is now: existing `users` row → recorded removal (deny) → `ADMIN_LOGINS` → empty-table fallback → deny. An existing row still wins, the empty-table fallback is unchanged, the last-admin protection is untouched, and an admin's deliberate re-invite on the Members page clears the record so the login bootstraps normally again.
- **The required-variable gate runs before any deploy-capable step**: `Verify required ADMIN_LOGINS variable` moved ahead of the job's first `wrangler` invocation — `wrangler secret bulk` publishes a Worker version, so a gate placed after it could no longer claim to fail before a deploy. The post-deploy settings assertion is unchanged.
- **The documented manual deploys pass `ADMIN_LOGINS` explicitly**: the self-host and manual `wrangler deploy` commands in the README and deployment docs now carry `--var "ADMIN_LOGINS:…"` with the same value the Deploy workflow injects, so a fork following those steps no longer ships with the first-login-becomes-admin fallback armed.

<!-- CN -->
- **被移除的成员不会被重新拉起（安全）**：删除 dashboard 成员现在是权威操作——移除会被记录（`removed_logins`，与成员行删除在同一事务内写入），OAuth 引导会**在** `ADMIN_LOGINS` 名单之前检查该记录，因此即使名单仍包含该登录名，其下次登录也不会再被重新创建为管理员。引导优先级现为：已有 `users` 行 → 已记录移除（拒绝）→ `ADMIN_LOGINS` → 空表回退 → 拒绝。已有用户行仍优先，空表回退行为不变，最后一名管理员保护不变；管理员在 Members 页面主动重新邀请会清除记录，该登录由此恢复正常引导。
- **必需变量门禁位于任何可部署步骤之前**：`Verify required ADMIN_LOGINS variable` 已移动到作业中第一次 `wrangler` 调用之前——`wrangler secret bulk` 本身就会发布一个 Worker 版本，排在它之后的门禁无法再声称「部署前失败」。部署后的设置断言保持不变。
- **文档中的手工部署显式传入 ADMIN_LOGINS**：README 与部署文档中的自托管/手工 `wrangler deploy` 命令现在都携带 `--var "ADMIN_LOGINS:…"`（与 Deploy workflow 注入的值一致），照文档操作的分支不会再带着「首次登录即管理员」的回退路径上线。
