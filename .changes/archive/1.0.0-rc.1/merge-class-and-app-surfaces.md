---
category: Added
---

- **`may-fix` merge class**: engine 4.2.2's finding class between `should-fix` and `nit` now reaches every layer that carries a class — the review tally and the finding cap rank it, the PR detail's findings filter offers it, the insights distribution zero-fills it, and the severity chart plots it as its own series — so a review that emits `may-fix` no longer drops the finding or misreports the distribution.
- **Pull-request ledger toolbar**: the App's Pull requests tab gains a repository filter and a refresh control. The filter runs on the server inside the ledger's bounded window, so a repository whose PRs all sit behind the newest 200 rows is still reachable once selected; the option list is the App's whole distinct repository set and never narrows with the current selection.
- **Real App avatar and availability badge**: the App install panel now shows the App's real GitHub avatar (the cached column, or the URL derived from the App id; the octocat placeholder only after a CDN miss) instead of the generic GitHub mark, and the Installed tab's table gains an availability column that grades each installation against the stored owner allowlist — valid when the allowlist is off, otherwise only for an account on it.

<!-- CN -->
- **`may-fix` 合并级别**：engine 4.2.2 在 `should-fix` 与 `nit` 之间新增的 finding 级别现在覆盖所有按级别呈现的层——审查 tally 与 finding 截断排序按它排序、PR 详情的 findings 筛选提供它、insights 分布为它补零、严重度图表把它作为独立系列绘制——因此产出 `may-fix` 的审查不再丢失 finding，也不会让分布失真。
- **Pull requests 账本工具栏**：App 的 Pull requests 标签新增仓库筛选与刷新控件。筛选在服务端于账本的有界窗口内执行，因此其 PR 全部落在最新 200 行之后的仓库在选中后依然可达；选项集合是该 App 全部去重仓库，且永不随当前选择收窄。
- **真实 App 头像与可用性徽章**：App 安装面板改为显示真实的 GitHub 头像（缓存列，或按 App id 派生的地址；仅 CDN 命中失败时才回退到 octocat 占位图），不再使用通用 GitHub 标记；Installed 标签的表格新增可用性列，按存储的 owner 允许名单判定每个安装——名单关闭时一律有效，开启时仅名单内账户有效。
