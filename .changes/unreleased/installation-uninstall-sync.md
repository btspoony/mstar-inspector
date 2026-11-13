---
category: Fixed
---

- **Installations match GitHub again.** An `installation.deleted` delivery now marks that installation removed instead of being dropped, so the App settings' installed list stops showing it; a later reinstall makes it appear again. A missed delivery is repaired by the existing GitHub metadata refresh, which now also reconciles the App's installation list with GitHub.

<!-- CN -->
- **安装列表重新与 GitHub 一致。** `installation.deleted` 投递不再被丢弃，而是把该安装标记为已移除，App 设置的已安装列表随即不再展示它；之后重新安装会再次出现。投递丢失的情况由既有的 GitHub 元数据刷新修复——它现在会同时按 GitHub 的安装列表校正本地记录。
