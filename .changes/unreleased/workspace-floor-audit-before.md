---
category: Fixed
---

- **The workspace check-min-score audit records the floor the workspace was
  actually running.** The ledger's `before` used to name the platform default
  (60) even when the stored floor was unreadable and therefore never in effect.
  It now records the absent state (`null`) for any value the reader does not
  trust, so the ledger names only floors a workspace actually ran with.

<!-- CN -->
- **工作区 `check_min_score` 审计记录工作区实际生效的下限。** 此前即使存储值不可读、
  从未生效，账本的 `before` 也会写成平台默认值（60）。现在读取方不信任的任何值都记录为
  缺失状态（`null`），账本只记录工作区真正运行过的下限。
