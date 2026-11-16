---
module: d1 migrations and the test fixtures that pin their shape
date: 2026-11-16
problem_type: workflow_issue
category: workflow-patterns
severity: high
applies_when:
  - A plan adds a column or table through a numbered migration
  - A scoped test selector names a subset of suites for the implementer
  - A fixture applies a hand-written migration list over a derived tail
tags:
  - d1
  - testing
  - migrations
---

# 加列的迁移会让 selector 之外的形状测试整片变红

## 现象

一次产品迭代里，`0061` 只是 `ALTER TABLE plans ADD COLUMN shared_bot_allowed` 加一条 seed `UPDATE`。实现者的 scoped selector 是 `tests/worker tests/dashboard tests/pipeline`，全绿，push。CI 立刻红：

- `tests/store/plans-usage-migration.test.ts` 把 `plans` 的整行对象钉死，多一列就失配；
- 更贵的第二个：fixture 的 `TAIL_PREREQUISITES` 新增 `0031_plans_usage.sql` 后，另一个 hand-written 列表 `APP_CONFIG_MIGRATIONS` 仍自己列着 `0031`，spread 时被应用两次 → `SQLiteError: table plans already exists`，`tests/worker` 里 176 个用例一起挂。

两次都是"编译通过、类型正确、selector 绿"。

## 根因

迁移的契约面不在实现它的那个目录里：

| 契约 | 通常住在 | 常被 selector 漏掉 |
|---|---|---|
| 表的列集合与行形状 | `tests/store/*migration*.test.ts` | 是 |
| fixture 的迁移应用顺序 | `tests/helpers/migration-shapes.ts` | 是 |
| 迁移形状 guard 的 manifest | 同上，`TAIL_PREREQUISITES` / `*_MIGRATIONS` | 是 |
| 依赖 `SELECT *` 的读面 | 各自的 `tests/<area>` | 否 |

`SELECT *` 不会因为多一列报错，`INSERT` 也不报错——只有**钉死行对象**的断言会。这类断言散落在 `tests/store`，而迁移类 plan 的 selector 通常按功能域挑。

第二条更隐蔽：同一个迁移文件被两条路径应用（显式列表 + 前置依赖 spread），只有在某个 shape 恰好同时经过两条路径时才炸，而那个 shape 在别的套件里。

## 做法

1. 迁移类 plan 的 selector 至少包含 `tests/store` 与 `tests/helpers`，即使功能改动不在那里。加列就是改了一张表的公开形状，形状测试是它的契约测试。
2. 修 fixture 冲突时，先决定**谁拥有**该迁移文件的条目——显式列表还是前置依赖——再删另一边，不要两边都留"以防万一"。
3. 钉行形状的断言保留严格（新增列必须显式出现），不要为了过 CI 换成 `toMatchObject`；换取的是下一个加列的人还得改它，这是特性不是成本。
4. 迁移 PR 自己就跑一次 `bun test tests/store`，不要留给 CI 发现。

## 判据

问一句：这次改动的**契约消费者**里，有多少测试不在我准备跑的套件里？迁移的答案是"表形状"和"fixture 顺序"，都不在原目录。
