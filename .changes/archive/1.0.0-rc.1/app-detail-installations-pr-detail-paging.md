---
category: Changed
---

- **Installations get their own App detail tab**: the installations table and the recent deliveries move off the settings tab into a manager-only 已安装 / Installed tab. Deliveries now list up to 10 rows (was 5) and each names its source repository — `owner/name` from the new nullable `webhook_deliveries.repository_full_name`, with rows written before migration `0043_webhook_delivery_repository.sql` rendering the unknown-repo label.
- **PR detail links out to GitHub**: the PR number in the header and the repository in the aside are now links to `github.com`, opened in a new tab with `rel="noopener noreferrer"`.
- **PR detail records load one page at a time**: findings, reviews and failures are fetched per section on demand (default 10 rows, server-enforced max 50) instead of arriving with the header; the detail payload returns `{ pull_request, counts, latest_review }` and each section `{ items, total }`, so the family tabs count from the head counts and prev/next move the page. Findings add a severity filter whose filtered total drives the pager. The counts carry the PR's own must-fix tally, so the findings tab's danger dot and the "N must-fix" note beside the findings figure describe the PR — a severity filter or a later page can neither clear the dot nor change the note — and an empty PR opens on the reviews tab (records first, history last).

<!-- CN -->
- **安装信息独立成 Tab**：安装表与最近投递从设置 Tab 移入仅管理者可见的「已安装」Tab。投递列表改为最多 10 条（原 5 条），每条标注来源仓库——取自新增的可为空列 `webhook_deliveries.repository_full_name` 的 `owner/name`，迁移 `0043_webhook_delivery_repository.sql` 之前写入的行显示「未知仓库」。
- **PR 详情跳转 GitHub**：头部的 PR 编号与侧栏的仓库名现为 `github.com` 链接，新标签页打开并带 `rel="noopener noreferrer"`。
- **PR 详情记录分页加载**：发现、审查、失败三类记录不再随头部一次性返回，而是按分区按需加载一页（默认 10 行，服务端上限 50）；详情载荷返回 `{ pull_request, counts, latest_review }`、各分区返回 `{ items, total }`，类别 Tab 的计数取自头部计数，上一页/下一页翻页。发现新增严重程度筛选，分页按其筛选后的总数计算。计数中新增该 PR 自身的必须修复项统计：发现类别页签的危险点与发现指标旁的「N 项必须修复」备注都描述这个 PR，因此切换严重程度筛选或翻到后续页都不会让危险点消失、也不会改变备注；没有任何记录的 PR 落在审查页签（记录优先，历史最后）。
