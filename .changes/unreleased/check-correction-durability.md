---
category: Fixed
---

- **A deferred Check correction is no longer lost.** When the request budget stopped a §7.9a correction before its `checks.update` was sent, the reopened row had already consumed its terminal mark, so the next reconcile pass had nothing to correct and refused the failure GitHub still showed — leaving it red for good. The row now records the conclusion the correction owes and the generation it targets in the same write that reopens it, a later pass delivers it, and the successful send clears the record. A generation that has moved drops the obligation instead of resurrecting a stale conclusion.

<!-- CN -->
- **被预算推迟的 Check 更正不再丢失。** 当请求预算在 §7.9a 更正的 `checks.update` 发出前拦住它时，被重开的行已经消费了终态标记，于是下一轮 reconcile 没有可执行的更正，只会拒绝 GitHub 上仍存在的 failure——该 Check 永久变红。现在重开行的那次写入会同时记录该更正应交付的结论及其目标 generation，后续轮次据此补发，成功发送后清除该记录；若目标 generation 已移动，则丢弃该义务而不会复活过期结论。
