---
category: Changed
---

- **Review concurrency limits re-scaled**: the platform cap now defaults to and accepts up to **256** concurrent reviews (the queue delivers at most 250 at once), and each workspace is bounded by its own maximum of **32**. The workspace settings card no longer displays or returns the platform cap; a value above the current limit is refused with a message that names no platform number. On upgrade, any workspace that stored a value above **32** under the previous 1..64 range is lowered to **32** by migration `0043`.

<!-- CN -->
- **审查并发上限调整**：平台上限默认值及可设置上限为 **256**（队列同时最多投递 250 个），每个工作区受自身上限 **32** 约束。工作区设置不再显示或返回平台上限；超出当前上限的值会被拒绝，且提示中不含平台数值。升级时，此前在 1..64 范围内存储了大于 **32** 的工作区会被迁移 `0043` 下调为 **32**。
