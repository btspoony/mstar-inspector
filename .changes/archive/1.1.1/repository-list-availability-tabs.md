---
category: Changed
---

- **The repositories list's default face shows only installed repositories**: rows whose installation has not reported its `repo_id` no longer sit in the default list — they move behind a counted 待安装（<n>）/ Awaiting install (<n>) tab that appears only while such rows exist. The fixed 所有仓库 aggregate row and the header metric band stay workspace-wide, and when the last pending target becomes installed the selection falls back to 可用仓库 / Available.
- **The green state tag now reads 可审查 / Reviewable** instead of 审查中 / Reviewing, so it no longer suggests a review is currently running.

<!-- CN -->
- **仓库列表默认只显示已安装的仓库**：尚未上报 `repo_id` 的行不再出现在默认列表中，而是移入带计数的「待安装（<n>）」标签页——仅当存在此类行时才会出现。固定的「所有仓库」聚合行与头部指标带保持全工作区口径；当最后一个待安装目标完成安装后，选择自动回落到「可用仓库」。
- **绿色状态标签改为「可审查」（Reviewable）**：不再使用「审查中」（Reviewing），避免暗示评审正在进行。
