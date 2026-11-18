---
category: Changed
---

- **The dashboard opens on the repositories page.** `/dashboard` and the retired `/dashboard/apps` spelling both redirect to `/dashboard/<workspaceRef>/repos` (the sign-in landing, the operator landing and the post-creation landing follow it), one repository lives at `/dashboard/<workspaceRef>/repos/<targetId>`, and the sidebar wordmark follows the same page. The overview now carries a page header instead of a bare title: one line saying that review settings live on each repository while insights and pull requests are shared across the workspace, plus three figures derived from the list it already loads — the repository count, how many are awaiting an installation, and how recently the workspace last reviewed.
- **A repository that lost its installation keeps its name.** A target whose `repo_id` is NULL but which still carries `repo_owner`/`repo_name` renders `owner/name` (and in the detail header) instead of an em dash; only a target naming no repository at all falls back to the dash and the 待安装 copy. The 待安装 badge still keys on `repo_id`.

<!-- CN -->
- **仪表盘默认打开仓库页。** `/dashboard` 与已退役的 `/dashboard/apps` 拼写都会重定向到 `/dashboard/<workspaceRef>/repos`（登录落地页、运营者落地页与创建后的落地页同步跟随），单个仓库位于 `/dashboard/<workspaceRef>/repos/<targetId>`，侧栏品牌链接也指向同一页。总览页不再只有标题：页头新增一行说明——评审配置在各仓库页里，洞察与拉取请求由整个工作区共享——并展示三个由现有列表直接算出的数字：仓库数、待安装数、最近一次评审时间。
- **失去安装的仓库仍显示名字。** `repo_id` 为 NULL 但仍带 `repo_owner`/`repo_name` 的目标现在渲染 `owner/name`（详情页标题同样），只有完全没有仓库标识的目标才回落到破折号与待安装文案；待安装徽章仍以 `repo_id` 判定。
