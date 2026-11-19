---
category: Fixed
---

- **Check recovery** no longer starves a repaired App: the suspended-Check re-enable scan resumes from a durable rotation cursor (migration `0077_check_reenable_cursor`), so pairs whose credential is unchanged or whose review is still paused cannot hold the bounded batch, and a repaired pair behind any size of backlog is reached within a full rotation.

<!-- CN -->
- **Check 恢复**不再饿死已修复的 App：挂起 Check 的重新启用扫描改为从持久化轮转游标（migration `0077_check_reenable_cursor`）续扫，凭证未变或仍暂停的 pair 不再占住有界批次，任意规模积压之后的已修复 pair 都会在一轮轮转内被扫到。
