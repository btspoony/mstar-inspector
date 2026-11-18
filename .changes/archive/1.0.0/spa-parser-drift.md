---
category: Fixed
---

- **The App detail and review-usage reads parse again.** Two parsers still demanded fields the worker had stopped sending — the retired owner allowlist plus its `owner_overlap` flag on the settings face, and a `quota.month` the credit block never carried — so a valid staging payload failed the parse and the page fell into its load-failed face. Both requirements and the dead park rendering they fed are gone; every other check, the blocked/reason pairing and the target-id rules included, still fails on genuine drift.

<!-- CN -->
- **App 详情与用量读取恢复正常。** 两个解析器仍在要求 Worker 已不再发送的字段——设置面上已退役的所有者白名单及其 `owner_overlap` 标记，以及额度区块从未携带的 `quota.month`——导致合法的 staging 负载解析失败，页面落入加载失败态。这两项要求及其供能的无效「停放」渲染已移除；其余校验（包括 blocked 与原因的配对、target_id 规则）在真实漂移时仍然失败。
