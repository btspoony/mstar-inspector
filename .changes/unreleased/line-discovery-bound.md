---
category: Fixed
---

- **Line-comment recovery no longer parks on a batch it can never read back.** An applied publication whose remote line batch could not be discovered stayed eligible forever, so it kept the oldest position in every pass and, once such rows filled the bounded selection, newer batches were never picked up. Each failed readback is now counted durably on the publication row (new discovery-count and unresolvable columns on `review_publications`), and at the existing five-attempt recovery cap the batch leaves the selection with the reason the last readback observed — marker missing, comment gone, readback scope, ids that could not be persisted, or a budget refusal that never dispatched — while the row, its count and its reason stay for an operator. The recovery lane reports that stop once, and the selection keeps oldest-first order among the batches that can still resolve.
- A discovery readback now names its own failure (`marker-missing` / `ambiguous` / `comment-gone` / `readback-scope` / `capture-failed`) instead of collapsing every miss into "nothing captured", so the recorded reason is the observation rather than a guess.

<!-- CN -->
- **行内评论恢复不再停在永远读不回来的批次上。** 已 apply 的发布若其远端行内评论批次始终无法发现，就会永久留在候选集里，占据每次扫描的最旧位置；一旦这类行填满有界选择，更新的批次就永远选不到。现在每次失败的回读都会持久计数在该发布行上（`review_publications` 新增发现计数与不可解析列），达到既有的五次恢复上限时该批次带着最后一次回读观察到的原因（缺少标记、评论已消失、回读范围不可用、id 无法落库，或预算拒绝导致请求未发出）离开候选集，而行、计数与原因都保留供运维查看。恢复通道只报告一次这次停止，选择顺序仍在可解析的批次内保持最旧优先。
- 发现回读现在会给出各自的失败原因（`marker-missing` / `ambiguous` / `comment-gone` / `readback-scope` / `capture-failed`），不再把所有未命中都归为“什么都没抓到”，因此记录的原因是观察结果而非猜测。
