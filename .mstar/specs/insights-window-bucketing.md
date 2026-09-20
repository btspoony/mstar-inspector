# Insights window bucketing contract（冻结）

> **Frozen spec** — promoted from iteration package (024-sweep-trend-alignment, architect Q2 ruling 2026-09-20) at iteration-close 2026-09-20; implemented and QA-verified on `daily_trend` (plans 79/80, QC tri Approve ×3 + mandatory QA PASS).
> 冻结原因：窗口→桶派生现有三个 wire 消费面（`findings_distribution` @020 AD-652、`weekly_trend` 既有、`daily_trend` @024 新增）+ SPA 镜像派生；任何新的时间桶面必须从同一套表达式/网格派生。insights-store.ts docblock 既已声明「两种周定义 = STOP face」，本 spec 把该纪律连同窗/粒度规则一并冻结。
> 变更本 spec = 架构 STOP（见文末变更协议）。

## 窗口语义（单一 clamp 点）

- `windowDays` 整数天，默认 30；>90 在 store 入口 clamp 到 90（`clampWindow`，src/dashboard/insights-store.ts）——唯一 clamp 点，下游一律绑定 clamped 值。
- 非 integer / 负值 = 路由 400；store 不复验。
- 窗口谓词（所有聚合共享 whereSql）：`reviews.reviewed_at >= datetime('now', '-' || ? || ' days')`，叠加 era gate `r.envelope IS NOT NULL`。

## 粒度派生（唯一规则）

- **granularity = clamped `windowDays > 30` → `"week"`，否则 `"day"`**（insights-store.ts:207）。UI segmented 7/30 → day、90 → week；31–89 的直连 URL 窗同样落 week。
- 日桶表达式 = UTC `date(r.reviewed_at)`（与窗口谓词同一 UTC 域）。
- 周桶表达式 = `WEEK_BUCKET_SQL`（Monday-anchored，insights-store.ts 单一定义）；JS 镜像 `mondayOf` / `weekGrid`（src/dashboard/insights-dates.ts，S-1 concrete-date pin 锁同步）。
- **禁止出现第二种周或日桶定义**（SQL 或 JS 皆然）。

## 面与填充语义

| wire 键 | 粒度 | 填充 | 计数语义 | 状态 |
|---|---|---|---|---|
| `weekly_trend` | 恒周桶（任意窗） | 原样 SQL 输出（不零填充；空周不出桶） | reviews = COUNT(DISTINCT r.id)（LEFT JOIN，零 findings 的 review 计 1）；findings = COUNT(f.id) | 冻结（既有键） |
| `findings_distribution` | 按窗派生 day\|week | JS 网格零填充（`dayGrid`/`weekGrid`，∪ 观测桶起点，首末桶 partial，网格定序） | by_severity / by_category 零填充网格 | 冻结（020 / AD-652） |
| `daily_trend` | 仅天窗（clamped ≤30）产出；周窗返回 `[]`（不运行查询） | `dayGrid` 零填充（∪ 观测 day start，网格定序） | 镜像 `weekly_trend` 计数语义，桶为日 | 024 新增（additive；本迭代裁决） |

- `daily_trend` 行形 `{ day_start: string; reviews: number; findings: number }`（形对齐 `weekly_trend` 的 `week_start`）。
- 90d 趋势卡读 `weekly_trend`（回落，不双写周数据）；SPA 以 payload 内 `findings_distribution.bucket_start` 网格做**展示层**零填充（见下），不改任何 API 键。

## SPA 镜像义务

- `parseInsights`（src/spa/pages/data.ts）：聚合面键 REQUIRED——缺失/畸形走 null fallback；唯一 tolerate-absent 例外是 opt-in `repos`（AD-652 先例，`daily_trend` 沿用）。
- 粒度判定镜像：`data.window_days > 30`（wire 回显 clamped 窗，两端同谓词；属刻意镜像，注释声明，不抽共享模块——SPA 不 import dashboard leaf）。
- 图表 x 轴：pinned `M/D` `formatDateLabel`（全 locale）+ 「>8 桶 → every-other 标签、首桶恒标」规则（TrendChart 与 StackedBarChart 各自声明的同值 `X_LABEL_MAX_VISIBLE = 8`——**改值须两图同步**）。

## 变更协议

- 新增时间桶面：复用 `WEEK_BUCKET_SQL` / `date()` 表达式与 `dayGrid`/`weekGrid`；粒度从 clamped 窗派生；additive 新键 + REQUIRED 解析 + 行级 guard。
- 改动本表中任何冻结键的形、填充或计数语义 = 架构 STOP，须重新裁决（不可作为实现细节顺带完成）。
