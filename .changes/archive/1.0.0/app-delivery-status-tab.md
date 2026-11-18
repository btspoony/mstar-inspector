---
category: Changed
---

- **The App detail's credentials panel is now a 投递状态 tab**: the delivery log moved out of 应用设置 into its own tab, as a table of repository, delivery type, time, outcome and — for a refused delivery — the reason. The reason is persisted from the classifier's own sentence (new nullable `webhook_deliveries.reason` column), so a `rejected` row no longer says only "401". The tab filters by repository, time window and delivery type, and pages on the server: `GET …/api/apps/:appId/deliveries` takes `repo` / `since` / `type` / `offset` and answers the matching `total` beside the page plus the App's unnarrowed filter option sets. A malformed parameter is a 400; a well-formed value matching nothing is an honest empty page.
- **The App detail no longer links back to the repository surface**: an App with no repository, or with several, states the fact without offering a 仓库 link.

<!-- CN -->
- **应用详情的凭据面板改为「投递状态」标签页**：投递日志从应用设置移出，独立成页，以表格呈现仓库、投递类型、时间、结果，以及被拒绝时的原因。原因取自分类器自身的说明并入库（新增可空列 `webhook_deliveries.reason`），因此 `rejected` 行不再只有「401」。该标签页支持按仓库、时间范围、投递类型筛选，并在服务端分页：`GET …/api/apps/:appId/deliveries` 接收 `repo` / `since` / `type` / `offset`，返回当前页、匹配总数，以及该 App 未经收窄的筛选项集合。参数格式错误返回 400；格式正确但没有匹配则为空页。
- **应用详情不再反向链接到仓库页**：无论是没有仓库还是拥有多个仓库，页面只陈述事实，不再给出「仓库」链接。
