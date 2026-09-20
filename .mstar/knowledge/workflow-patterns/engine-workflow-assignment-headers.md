---
module: mstar-harness engine workflows（scoped plan coordination）
date: 2026-09-20
problem_type: workflow_issue
category: workflow-patterns
severity: medium
applies_when:
  - 使用 mstar plan bind / prepare / progress / handoff / accept 等 engine 状态动词驱动 plan 或 iteration workflow
  - 为 engine-backed workflow 编写 Assignment（prepare 登记用）
  - 处理 stuck / abandoned workflow lifecycle 的恢复
tags:
  - mstar-harness
  - engine-workflow
  - assignment-headers
  - lease
plan_id: 77-app-detail-page-feedback
---

# Engine workflow Assignment header fields must carry bare values

## Context

plan「应用详情页反馈」交付时，其 workflow Assignment 头部的 `Working branch` 字段写了带描述的值（`feat/77-... (created from main; checked out in the worktree)` 而非裸分支名）。该 prose 顺着引擎链传播：execution lease 的 `worktree_path`/`working_branch` 记成 prose 值 → handoff 的 `source_branch` 跟着错 → `complete` 在校验分支一致性时拒绝 → 整个 workflow（024）无引擎动词可挽回，只能废弃并另注册新 workflow（025）重走全部状态步。

## Guidance

1. **引擎 Assignment 头部字段一律裸值**：`Working branch: feat/<plan-id>`、`Worktree path: /abs/path`、`Plan Path: /abs/path`——括号注记、来历说明、组合句一律放正文，不进头部字段。
2. **没有 reset 动词**：prepare/bound/handed-off 状态的 row 没有任何引擎动词可以改写绑定值；写错即废弃。避免写错的唯一时机是 prepare 之前。
3. **废弃即重注册**：mid-tail 废弃的 workflow 处置 = 新 workflow id 重走（register → coordinator bind → prepare → plan-session bind → …）；旧 lifecycle 保留 active lease 会挡 `mstar worktree cleanup`（同路径 refuse.active-lease），需显式清理授权。
4. **主检出（control root）驻留分支在 plan 头部记录为 `Main worktree branch: <branch>`**；worktree check 的 L1 residency 以该记录为准（缺记录时回退 `branch.base`——iteration 场景即 `origin/main`，会误报 residency-switched，用 `--main-branch` 显式传输记录值）。

## Why This Matters

引擎状态机的每次迁移都是「byte-pinned + 守卫校验」：头部字段的值直接成为 lease / handoff / merge pin 的身份字段。自由文本让身份不可比对，守卫只能拒绝，而拒绝不可恢复（no reset verb）。一行裸值纪律换来整条链可校验、可恢复。

## When to Apply

- 每次为 engine workflow 写 prepare-Assignment（register/prepare 之前自查：字段值是否可原样作为 git ref / 文件路径使用）。
- 每次 bind 后 `mstar plan show` 核对 worktree/branch 回显值是否与预期逐字一致——prose 污染在这一步就能发现。
- 遇到 stuck lifecycle 时先查头部字段漂移，再考虑 reconcile。

## Examples

- ❌ `Working branch: feat/77-app-detail-page-feedback (created from main; checked out in the worktree)`
- ✅ `Working branch: feat/77-app-detail-page-feedback`（来历说明写正文）
- 复盘记录：plan「应用详情页反馈」Delivery tail + coordination note（2026-09-19）；教训在本迭代（2026-09-20 收口）结晶。
