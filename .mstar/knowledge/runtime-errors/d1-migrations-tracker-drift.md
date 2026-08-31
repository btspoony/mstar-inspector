---
module: ops-deploy
date: 2026-08-31
last_updated: 2026-08-31
problem_type: runtime_error
category: runtime-errors
severity: medium
applies_when:
  - "Migrations were ever applied via wrangler d1 execute / raw SQL instead of the migrations tracker"
resolution_type: workflow_improvement
root_cause: "Raw-SQL schema catch-up bypassed wrangler's d1_migrations tracker; the tracker差集 then replayed applied files"
symptoms:
  - "wrangler d1 migrations apply --remote fails with duplicate column/table [code 7500]"
  - "d1_migrations rows far fewer than local migrations/ files"
  - "schema objects verifiably exist despite tracker showing them unapplied"
plan_id: 20-multiapp-platform-golive
tags:
  - cloudflare-d1
  - wrangler
  - migrations
  - tracker-drift
  - deploy-blocked
---

# D1 migrations tracker drift: applied-but-untracked migrations replay and fail

## Problem

`wrangler d1 migrations apply <db> --remote` 在本仓现网库上报 `duplicate column name: envelope: SQLITE_ERROR [code: 7500]` 并中止。`d1_migrations` 表只记录 0001；但 0002–0010 的全部对象（列/表/索引）核实存在。

## Symptoms

- apply 从 0002 开始重放，第一个 ALTER/CREATE 即撞 duplicate 错误。
- `SELECT name FROM d1_migrations` 远短于 `migrations/` 目录文件数。
- 直接查 schema（sqlite_master / PRAGMA table_info）能看到「缺失」迁移的对象都在。

## Root Cause（本仓实例）

v0.7 plan 19 T3 的「real-D1 migrations 0002–0010 catch-up」当时用 **raw SQL（`wrangler d1 execute`）** 追平了现网 schema——wrangler 的 tracker 只在 `migrations apply` 通道内记账。此后任何 `migrations apply` 都会重放已应用文件。SQLite 没有幂等 ALTER，重放必炸。

## What Didn't Work

- 直接重跑 `migrations apply`（同样的 7500）。
- 换账户/重登（与本问题无关——先出现过一账户 mismatch 的假 blocker，由 `unset CLOUDFLARE_ACCOUNT_ID` 解决；env 里的值是外来陈旧项）。

## Solution（两步；均为显式授权的记账/标准通道）

1. **Tracker backfill**：对每个「对象已核实存在」的迁移文件名，`INSERT INTO d1_migrations (name) VALUES ('<精确文件名>')`（本例 0002–0010 共 9 条）。name 必须与本地 `migrations/` 文件名逐字一致（UNIQUE 约束兜底重复插入）。**前提：先逐对象核实确实已应用**（本例 ops 全量 probe 过列/表/索引），否则是往活库记账里写假话。
2. **标准通道落新迁移**：再跑 `migrations apply` → tracker 差集只剩真正未应用的文件（本例 0011），正常应用并记账。

## Why This Works

`migrations apply` 的语义 = 「tracker 差集按文件序重放」。把 tracker 补到与物理现实一致后，差集精确等于待应用集，重放消失。此后永远走 `migrations apply`，不再产生新漂移。

## Prevention

- **永不用 `wrangler d1 execute --file` 追 schema**——追平也必须事后 backfill tracker（本条即教训）。
- 部署前置检查：`SELECT COUNT(*) FROM d1_migrations` vs `ls migrations/ | wc -l`，不等 = 先对账。
- CI/部署脚本若做「migration 数量」断言，以 tracker 为准并允许 backfill 后的跳跃。
- 实例记录：v0.8 plan 20 T4 run-2/run-3（Worker version 91394193-7cf5-4455-8d90-0727ef2cfab3 部署前）。