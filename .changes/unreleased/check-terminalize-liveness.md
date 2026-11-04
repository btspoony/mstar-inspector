---
category: Fixed
---

- **The review check run finishes when the review publishes**: the terminalize hook now owns a 10-second budget (spec §7.10) instead of sharing the 2-second begin-hook bound, and its promise is handed to the queue invocation's `ctx.waitUntil`, so a slow `checks.update` finishes out of band instead of being reclaimed with the isolate. A PR no longer sits on an `in_progress` check until the 15-minute recovery cron adopts it; an overrun logs one warn line and never blocks the review.

<!-- CN -->
- **审查发布后检查即完成**：terminalize hook 现在拥有独立的 10 秒预算（spec §7.10），不再与 begin hook 共用 2 秒上限，其 Promise 交给队列调用的 `ctx.waitUntil`，因此缓慢的 `checks.update` 会在调用返回后继续完成，而不会随 isolate 一起被回收。PR 不再需要等 15 分钟的恢复 cron 才看到检查结束；超时会记录一条 warn，且不会阻塞审查。
