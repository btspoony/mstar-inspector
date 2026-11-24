---
category: Added
---

- **Review route switch in the operator console**: `review.route.workflow` is now writable from the runtime settings page. The store accepts only the exact strings `on` and `off` (anything else is a refused write that leaves the stored row alone), audits the operator and the previous value, and answers the gate's own read-back as `effective`. The card shows the stored row beside the gate's answer, so a hand-edited value the read path refuses reads `off — untrusted` with the raw value, and a save repairs it.

<!-- CN -->
- **运维控制台可写审查路由开关**：`review.route.workflow` 现在可从运行时设置页写入。存储层只接受精确字符串 `on` 与 `off`（其他输入一律拒绝且不改动已存储行），在审计行记录操作者与先前值，并以闸门自身的回读结果作为 `effective` 返回。卡片同时展示存储行与闸门回答，因此读取路径拒绝的手工值显示为 `off — untrusted` 并附原始值，保存即可修复。
