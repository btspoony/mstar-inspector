---
category: Fixed
---

- **A decided Check no longer waits out the 15-minute execution window**: after a review publishes, a Check whose conclusion is already decided is taken over by recovery once the writer that froze it has gone quiet for two minutes, instead of waiting for its 900-second claim to expire. A Check whose conclusion is not decided yet still keeps its claim until its execution deadline, so a review that is still running is never raced, and the previous writer's late writes are refused because the taker bumps the lease epoch.

<!-- CN -->
- **已决定的 Check 不再空等 15 分钟执行窗口**：审查发布后，若某个 Check 的结论已冻结，而冻结它的写入方已静默两分钟，恢复流程即可接管该行，无需等 900 秒的声明到期。结论尚未决定的 Check 仍保留其声明直到执行截止时间，因此仍在运行的审查不会被抢先接管；接管的租赁 epoch 递增，会让先前写入方的迟到写入被拒绝。
