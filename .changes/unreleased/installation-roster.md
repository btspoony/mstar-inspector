---
category: Added
---

- **The App detail's 已安装 tab lists the App's installations again.** Every installation the settings read carries is one row — account, installation ID and last sync — in the product's own table, with the header band's installation figure counting the same array. An App with none says so instead of rendering an empty table. Restores the roster an earlier fold of the App detail dropped; the install link and the pending-binding entry stay above it.
- **The table states that it lists live installations.** The settings read filters uninstalled rows (`bot_installations.removed_at IS NULL`), so every row carries a live state badge rather than leaving the table to read as the App's full install history. An uninstalled installation still has its own face in the install block, where the bound row says reviews stopped.

<!-- CN -->
- **应用详情的「已安装」标签页重新列出该应用的安装。** 设置接口返回的每个安装都占一行——账号、安装 ID、最近同步——使用产品既有的表格，表头指标带中的安装数与表格读取同一个数组。没有任何安装时页面直接说明，而不是渲染一张空表。这恢复了此前合并应用详情时丢失的安装列表；安装链接与待绑定入口仍在其上方。
- **表格说明它只列出在线安装。** 设置接口会过滤掉已卸载的行（`bot_installations.removed_at IS NULL`），因此每行都带「在线」状态，而不是让表格看起来像是该应用的全部安装历史。已卸载的安装仍在上方的安装区块中单独呈现，其中绑定的那一行会说明审查已停止。
