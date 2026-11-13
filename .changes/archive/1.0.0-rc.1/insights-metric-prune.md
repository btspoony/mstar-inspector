---
category: Changed
---

- Removed the **Findings by category** chart and the **Recurring findings** table from App detail → Insights. The category axis was an open set of model-authored slugs, so a bucket union was not a comparable metric.
- `/api/apps/:appId/insights/summary` no longer emits `findings_by_category`, `recurring_top`, or `by_category` inside `findings_distribution` rows; the remaining fields are unchanged. External readers of those keys break by design.

<!-- CN -->
- 从 App 详情 → 洞察移除「按类别统计的发现」图表与「重复出现的发现」表格。类别轴是模型输出的开放集 slug，其桶并集不构成可比较的指标。
- `/api/apps/:appId/insights/summary` 不再返回 `findings_by_category`、`recurring_top`，`findings_distribution` 行内也不再含 `by_category`；其余字段不变。读取这些键的外部调用方按设计失效。
