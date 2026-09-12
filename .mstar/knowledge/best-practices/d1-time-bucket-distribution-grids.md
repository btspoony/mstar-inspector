---
module: dashboard / D1 additive time-bucket distribution (insights analytics)
date: 2026-09-12
problem_type: best_practice
category: best-practices
severity: medium
plan_id: 65-insights-daily-stacked-charts
tags:
  - d1
  - insights
  - time-series
  - additive-api
  - zero-filled-grids
  - week-buckets
title: "D1 additive time-bucket distributions: JS zero-filled grids, single week definition, clock-drift union"
related_components:
  - src/dashboard/insights-store.ts
  - src/dashboard/insights-dates.ts
  - src/dashboard/index.ts
  - src/spa/pages/data.ts
---

# D1 additive time-bucket distribution grids（insights 按桶分布的构造纪律）

## Context

plan 65（020 迭代）给 `/api/insights/summary` 增加按天/周分桶的 findings 分布（`findings_distribution`），供 SPA 堆叠柱状时间序列消费。约束：**additive-only**（既有字段逐字节零 diff）、D1（SQLite 方言）、窗口 7/30/90 天、category 为 open-set 字符串。本文沉淀桶网格的构造纪律——这些点在 review 中被反复问询，且每一处都有明确的「错法」。

## Guidance

1. **单一周定义，构造性满足**：周桶 SQL 抽成常量（`WEEK_BUCKET_SQL`，Monday-anchored UTC `%w` 表达式）供 weekly_trend 与新分布共用——仓库里永远只有一个周定义；新桶面复用常量而非再写一遍表达式。JS 侧 mirror（`mondayOf`）保持 lockstep 并有测试互证。
2. **零填充网格在 JS 生成，不在 SQL 里造行**：以 clamped window 生成全窗桶网格（day = 以当前 UTC 日收尾；week = 与窗口相交的 Monday 桶，首尾桶可为部分周），SQL 只回真实计数行，JS 按网格补零。零计数桶诚实出现在轴上（时间连续性），不靠 GROUP BY 的稀疏输出。
3. **day 网格是 N+1 个桶（today−N .. today 双闭）**：窗口谓词 `>= datetime('now','-N days')` 能返回 today−N 当天的行——左端inclusive 是唯一同时满足「零丢数」与「网格合计 == 页级合计」的读法；周网格首尾部分桶是对称惯例。别按「恰好 N 个桶」想当然。
4. **SQL 观测桶并入网格 = 时钟漂移护栏**：`starts = grid ∪ observed`（observed 只可能来自真实行）——JS/SQLite 时钟跨零点时不会静默丢桶；Map 键控保证不重复不丢失，`get()!` 因预并集而安全。并集只加不造（fabricate 不可能，因为 observed 来自 GROUP BY 实际行）。
5. **键集逐桶稳定**：`by_severity` = 固定全集（schema enum 锁定）每桶补零；`by_category` = 窗口级 union 键集（含 `"uncategorized"` 恒在）每桶补零——SPA 拿到的是闭包词表 series，无需二次并集，堆叠色板才可能稳定。
6. **granularity 由 clamped window 派生**：`windowDays > 30 → week`，否则 `day`。UI 段集（7/30/90）精确命中；URL 直入 31–89 也归 week（防横向拥挤的初衷一致）。派生只读 clamped 值，不读原始入参。
7. **additive-only 用测试锁死**：既有字段的 zero-diff 断言（路由层 pin）与新字段形状测试同一 commit 落地——「加一个键」的 PR 才有可能被 review 看出顺手改了旧行为。

## Why This Matters

时间桶分布的每个「显而易见」写法都有一条真实踩过的错路：SQL 里造网格（时区/粒度写死）、按 N 个桶生成 day 网格（丢边界行）、两套周定义（趋势图与分布图对不上）、稀疏 GROUP BY 直接喂图（轴断裂）。这套纪律让 additive 分析字段在 D1 上便宜（与既有聚合同构同价、网格有界 ~30 桶 × 键集）且可测（跨周求和 == 既有 weekly_trend.findings 的交叉验证 pin）。

## When to Apply

任何给 insights/summary（或同构 dashboard 聚合 API）加时间维度分解的需求；任何「堆叠/分桶时间序列」消费面的后端字段设计；review 此类变更时按上面 7 条逐条对号。

## Examples

- `src/dashboard/insights-store.ts`（`findingsDistribution` + `WEEK_BUCKET_SQL` + drift-guard union）
- `src/dashboard/insights-dates.ts`（`mondayOf` mirror + day/week 网格生成）
- 测试：`tests/dashboard/insights-store.test.ts`（周求和 == weekly_trend 交叉验证、空库全零网格、repo filter 收缩 union）、`tests/worker/dashboard.test.ts`（既有字段 zero-diff pin）
