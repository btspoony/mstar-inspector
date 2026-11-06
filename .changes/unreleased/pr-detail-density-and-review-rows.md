---
category: Changed
---

- **Pull-request detail: the record pill row now carries the filter, and the aside starts level with it.** The findings severity filter moved out of the findings body into a toolbar slot beside the three-family pill, and the content region became a two-column shell whose right rail tops out on that same row instead of below it — a tall facts/activity rail can no longer push the record list down.
- **Review rows now read as two facts lines**: the round, the short commit (linked to its GitHub commit), the model attribution and the run clock on the first line; the verdict plus one count per finding class on the second (`must-fix 2 · should-fix 1`). Classes outside the current merge-class vocabulary — the older `critical/warning/suggestion/info` rounds — are summed into one trailing **Other** count instead of disappearing, and each row carries its reviewed-at time in a narrow right-hand column.
- **Finding cards**: the round chip moved to the card's bottom-right corner as a small inset pill, so it no longer crowds the title row and reads the same size as a review row's round chip.

<!-- CN -->
- **拉取请求详情：记录胶囊行现在承载筛选器，右侧栏与它顶端对齐。** 发现严重程度筛选从发现列表内部移到三类别胶囊旁的工具栏位；内容区改为两列外壳，右侧「拉取请求／活动」栏与同一行顶端对齐，而不是落在记录列表下方——右侧栏再高也不会把左侧列表往下推。
- **审查行改为两行事实**：第一行是轮次、短提交（链接到 GitHub commit）、模型署名与本轮耗时；第二行是结论加上按类别拆分的发现数（`必须修复 2 · 建议修复 1`）。不属于当前合并类别词表的类别——即旧记录里的 `critical/warning/suggestion/info`——不再被丢弃，而是汇总为末尾一个 **其他** 计数；每行右侧窄列居中显示审查时间。
- **发现卡片**：「第 N 轮」标签移至卡片右下角，改为小号内嵌药丸，不再挤占标题行，且与审查行的轮次标签同形同号。
