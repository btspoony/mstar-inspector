---
category: Fixed
---

- Restore a comment trigger's claim before delayed admission retries so capacity or in-flight guards do not silently discard its review; wait until the scheduled delivery and recovery window have passed before outbox recovery or expiry.

<!-- CN -->
- 在准入延迟重试前还原评论触发的 claim，避免容量或并发门禁导致 review 被静默丢弃；outbox 重发或过期处理等待预计重投时刻及恢复窗口结束后再介入。
