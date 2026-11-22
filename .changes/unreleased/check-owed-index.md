---
category: Fixed
---

- Indexed the owed-Check marks on `review_launches`, so the per-minute Check reconcile no longer scans the whole attempt history once per waiting Check when it selects its due batch and clears concluded marks.

<!-- CN -->
- 为 `review_launches` 上的 Check 待结算标记添加部分索引，每分钟的 Check reconcile 在选择到期批次和清理已结束标记时，不再为每个等待中的 Check 扫描整张 attempt 历史表。
