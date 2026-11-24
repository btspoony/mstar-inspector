---
category: Fixed
---

- Indexed the terminal rows of the `pull_requests` ledger by last activity, so the 15-minute retention sweep seeks the expired `closed` / `merged` rows instead of scanning the whole ledger on every run.

<!-- CN -->
- 为 `pull_requests` ledger 的终态行按最后活动时间添加部分索引，每 15 分钟的保留期清理直接定位过期的 `closed` / `merged` 行，不再每次扫描整张 ledger。
