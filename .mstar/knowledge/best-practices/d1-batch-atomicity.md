---
title: D1 原子写入：db.batch 是事务原语（含幂等 duplicate 分支）
category: best-practices
problem_type: best_practice
module: review-store
severity: high
date: 2026-08-26
status: active
created_at: 2026-08-26
last_updated: 2026-11-03
source: review store
iteration: v0.2
verified: true
---

# D1 原子写入：db.batch 是事务原语

## Context

Cloudflare D1 的 `D1Database` 没有 `transaction()` 方法（workers-types 5.20260825.1 只有 `prepare/batch/exec/withSession/dump`）。多语句原子写入（如 review 行 + findings 行）必须用 `db.batch([...])`。

## Guidance

- **`db.batch` 是事务**：Cloudflare 文档确认「statements executed sequentially and non-concurrently as a transaction; if any statement fails, the entire sequence is aborted/rolled back」。模块头注释写明此依据。
- **幂等 duplicate 分支**：`INSERT ... ON CONFLICT DO NOTHING` 后 `meta.changes === 0` 判 duplicate。但 findings 的 FK 引用会让「review 冲突时 findings 仍插」抛 FK 错——用 `INSERT ... SELECT ... WHERE EXISTS(review id)` 守卫：review no-op → findings 0 行 → batch 成功 → 调用方按 `changes===0` 返回 `{ outcome: "duplicate" }`。
- **非 UNIQUE 错误照抛**：batch 内任一语句失败 → 整批回滚（RAISE(ABORT) 实测回滚先前语句），调用方不得把非 UNIQUE 错误误报为 duplicate。
- **测试双**：bun:sqlite 内存库执行真实 migration SQL + 窄 D1 面（`prepare/bind/first/all/run/batch`）；`db.transaction()` 在 bun:sqlite 异步下**不**回滚（实测），测试 double 用显式 BEGIN/COMMIT/ROLLBACK。
- **真实 D1 探针**：`meta.changes===0` 与 batch 回滚语义在真实 D1 上复验（本地 + 远端各一次），不轻信本地模拟。

## Why This Matters

「先落 review 再逐条插 findings」的无事务实现会在中途失败时留下不可恢复的部分行，且 consumer 的 find-then-skip 判重会让该部分行永久残留。单 batch 原子性 + WHERE EXISTS 守卫同时保证「要么全有要么全无」与「duplicate 不误报」。

## When to Apply

- 任何 D1 多表写入（父子行、聚合 + 明细）。
- 任何「UNIQUE 冲突 = 幂等跳过」的写入路径。

## Examples

```ts
const stmts = [
  db.prepare("INSERT INTO reviews (...) VALUES (?, ...) ON CONFLICT DO NOTHING").bind(...),
  db.prepare("INSERT INTO findings (...) SELECT ?, ... WHERE EXISTS (SELECT 1 FROM reviews WHERE id = ?)").bind(...),
];
const res = await db.batch(stmts);
if (res[0].meta.changes === 0) return { outcome: "duplicate" };
```

## 单语句准入：条件 INSERT ... SELECT 作为并发配额闸门

**Context.** A runtime concurrency cap (system-wide, per-tenant) plus a per-PR mutex must be evaluated and reserved atomically. A separate `SELECT COUNT(*)` followed by `INSERT` is a check-then-act race; Cloudflare D1 serializes writes on one primary, so a single statement is the cheapest correct primitive — no batch, no transaction wrapper.

**Guidance.**

- Fold every condition into the `INSERT ... SELECT ... WHERE` predicate: per-key uniqueness comes from the primary key (`INSERT OR IGNORE`), and capacities become subquery guards (`(SELECT COUNT(*) FROM inflight WHERE expires_at > :now) < :systemCap`). One statement = atomic admission.
- A zero-row result is ambiguous (key held vs a cap hit vs unknown target). Disambiguate with one follow-up read *after* the attempt and report a typed reason; never treat zero rows as a generic failure.
- TTL the reservation row (`expires_at`) and release it scoped to the owning attempt id, so a later attempt that reclaimed an expired row cannot have its row deleted by the previous owner.
- Use the same predicate in any audit insert so a refused write appends no ledger row.
- A storage error must fail closed (treat as held/degraded), never fail open to unlimited capacity.

**Why.** This is the one D1 primitive that gives both a mutex and a capacity counter without a second lock, and its atomicity rests on the documented single-writer behaviour rather than on read-then-write luck.

**When to apply.** Any admission gate that combines uniqueness with a count/quota, especially when the limit is runtime-configurable and read on the hot path.
