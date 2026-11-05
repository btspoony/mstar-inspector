---
category: Fixed
---

- **One bot-mention comment triggers at most one review**: the `issue_comment` job now carries the comment's own id (`comment_id`, from `comment.id`), and a `comment_trigger_claims` row (migration 0048) is inserted **before** the queue send — the row's primary key, not a KV get-then-put, is what refuses a second delivery, whether it arrives concurrently or after the KV fast path's 24-hour TTL lapsed. The pipeline then consumes that row atomically before any costly step, so a queue redelivery, an outbox re-send or a duplicate delivery acknowledges without running a second review. A failed send deletes the row so GitHub's retry can claim it again, and a crash between the insert and the send is recovered by the cron sweep, which re-sends `queued` rows older than its retry window and expires a claim that reaches the attempt cap. A consumed claim is never re-executed: a failed comment-triggered review is re-run by posting a new comment. Jobs without a readable comment id enqueue exactly as before.

<!-- CN -->
- **一条机器人提及评论最多触发一次审查**：`issue_comment` 作业现在携带该评论自身的 id（`comment_id`，来自 `comment.id`），并在入队**之前**写入一行 `comment_trigger_claims`（迁移 0048）——拒绝第二次投递的是该行的主键，而不是 KV 的 get-then-put：无论是并发投递，还是在 KV 快路径 24 小时 TTL 过期之后到达。流水线会在任何昂贵步骤之前原子地消费该行，因此队列重投、outbox 重发或重复投递都只确认而不启动第二轮审查。发送失败会删除该行，让 GitHub 的重试可以重新声明；若在写入与发送之间崩溃，cron 扫描会重发超过重试窗口的 `queued` 行，并把达到尝试上限的声明置为 `expired`。已消费的声明永不再执行：失败的评论触发审查通过发布新评论（新 id）重跑，而不是重放。缺少可读评论 id 的作业行为完全不变。
