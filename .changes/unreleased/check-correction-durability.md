---
category: Fixed
---

- **A deferred Check correction is no longer lost.** When the request budget stopped a §7.9a correction before its `checks.update` was sent, the reopened row had already consumed its terminal mark, so the next reconcile pass had nothing to correct and refused the failure GitHub still showed — leaving it red for good. The row now records the conclusion the correction owes and the generation it targets in the same write that reopens it, a later pass delivers it, and a validated response settles the record only when it delivered that owed conclusion and the row stays retryable otherwise. An unreadable gate or review read is not a change: the pass holds the debt and retries. A debt that can no longer apply is dropped together with the intent it froze, and a target generation that moved parks the row so no later pass resurrects the stale conclusion.

<!-- CN -->
- **被预算推迟的 Check 更正不再丢失。** 当请求预算在 §7.9a 更正的 `checks.update` 发出前拦住它时，被重开的行已经消费了终态标记，于是下一轮 reconcile 没有可执行的更正，只会拒绝 GitHub 上仍存在的 failure——该 Check 永久变红。现在重开行的那次写入会同时记录该更正应交付的结论及其目标 generation，后续轮次据此补发，且只有真正交付该结论的已验证响应才结清记录、否则该行保持可重试；gate/review 读取失败不算证据变化，本轮保留欠账、下轮重试；不再适用的欠账连同它冻结的意图一并丢弃，目标 generation 已移动时把该行置为本地终态，后续轮次不会复活过期结论。
