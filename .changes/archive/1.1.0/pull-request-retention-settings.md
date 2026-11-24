---
category: Changed
---

- **PR ledger retention is now an operator runtime setting.** Two new sweep settings, `platform.sweep.pull_request_retention_days` (default 90, 1–365) and `platform.sweep.pull_request_retention_cap` (default 500, 1–500), replace the hard-coded window and per-sweep cap for deleting `closed` / `merged` ledger rows; open PRs are never deleted. They are edited in admin → Runtime alongside the other sweep settings.
- **An unreadable or invalid sweep setting now also pauses PR ledger cleanup.** When the sweep settings cannot be read, or any stored sweep value is invalid, the sweep skips PR ledger deletion as well as webhook retention, and the warning names both, until the settings are fixed.

<!-- CN -->
- **PR ledger 保留期改为运维运行时设置。** 新增两项巡检设置 `platform.sweep.pull_request_retention_days`（默认 90，范围 1–365）和 `platform.sweep.pull_request_retention_cap`（默认 500，范围 1–500），取代原先写死的保留窗口和每次巡检删除上限，只清理 `closed` / `merged` 的 ledger 行，open PR 永不删除；可在 admin → Runtime 与其他巡检设置一起修改。
- **巡检设置无法读取或任一存储值无效时，PR ledger 清理也会暂停。** 此时巡检与 Webhook 保留期清理一起跳过 PR ledger 删除，警告同时列出两者，直到设置修复。
