---
category: Fixed
---

- **The review check run finishes when the review publishes**: the terminalize hook now owns a 10-second budget (spec §7.10) instead of sharing the 2-second begin-hook bound, and its promise is handed to the queue invocation's `ctx.waitUntil`, so a slow `checks.update` finishes out of band instead of being reclaimed with the isolate. A PR no longer sits on an `in_progress` check until the 15-minute recovery cron adopts it; an overrun logs one warn line and never blocks the review.

<!-- CN -->
- **审查发布后检查即完成**：terminalize hook 现在拥有独立的 10 秒预算（spec §7.10），不再与 begin hook 共用 2 秒上限，其 Promise 交给队列调用的 `ctx.waitUntil`，因此缓慢的 `checks.update` 会在调用返回后继续完成，而不会随 isolate 一起被回收。PR 不再需要等 15 分钟的恢复 cron 才看到检查结束；超时会记录一条 warn，且不会阻塞审查。

- **Both Check budgets are operator settings**: the terminalize wait and the bounded `checks.update` now come from `review_runtime_settings` (`review.check.terminalize_timeout_ms`, `review.check.update_timeout_ms`), read once per message and editable on the Runtime console page with one audited save. The former source constants survive only as the documented absent-row defaults (10 s for the inline wait, 5 s for the single `checks.update` send), and a save is refused unless the inline wait exceeds the configured send budget — the rule is relational, so raising the send bound raises the wait it requires. The pipeline no longer depends on a redeploy to bound a slow Check.

<!-- CN -->
- **两个检查预算改为运维配置**：terminalize 等待与受限的 `checks.update` 现在读取 `review_runtime_settings`（`review.check.terminalize_timeout_ms`、`review.check.update_timeout_ms`），每条消息读取一次，并可在 Runtime 控制台页面通过一次带审计的保存修改。原源码常量只保留为文档化的缺行默认值（内联等待 10 秒、单次 `checks.update` 发送 5 秒），且保存时内联等待必须大于所配置的发送预算——规则是关系性的，调高发送上限也会相应抬高所需的等待值。流水线不再需要重新部署才能约束缓慢的 Check。
