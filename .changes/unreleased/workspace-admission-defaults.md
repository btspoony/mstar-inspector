---
category: Changed
---

- **Draft review and the business pause are now workspace defaults**: the two admission switches a repository owned alone become `workspaces.default_review_drafts` and `workspaces.default_review_enabled` (migration 0108), edited on the 所有仓库 page. A target that follows the workspace defaults answers them from there; turning inheritance off snapshots the values it was running with into its row, so the toggle still changes no live behaviour. The repositories list, the application list and the application detail report the EFFECTIVE pause.

<!-- CN -->
- **草稿审查与暂停审查改为工作区默认项**：原本只属于单个仓库的两个准入开关提升为 `workspaces.default_review_drafts` 与 `workspaces.default_review_enabled`（migration 0108），在「所有仓库」页面设置。跟随工作区默认的目标由此继承；关闭继承时把它当时生效的值快照进自己那一行，因此切换本身仍不改变线上行为。仓库列表、应用列表与应用详情展示的暂停状态都是生效值。
