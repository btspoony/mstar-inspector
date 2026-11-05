---
category: Fixed
---

- **One bot-mention comment triggers at most one review**: the `issue_comment` job now carries the comment's own id (`comment_id`, from `comment.id`), and a job that states no `head_sha` claims its KV idempotency key on `idemc:{installation_id}:{owner}/{repo}:{pr_number}:{comment_id}` — the same get-then-put claim with the 24-hour TTL, written only after a successful queue send. A redelivered `issue_comment.created` for the same comment is skipped instead of starting a second full review, while a different comment (or a payload without a readable id, which enqueues unclaimed) still triggers one. The commit-face `idemKey` and its non-empty-sha invariant are unchanged.

<!-- CN -->
- **一条机器人提及评论最多触发一次审查**：`issue_comment` 作业现在携带该评论自身的 id（`comment_id`，来自 `comment.id`）；没有 `head_sha` 的作业以 `idemc:{installation_id}:{owner}/{repo}:{pr_number}:{comment_id}` 作为 KV 幂等键——沿用同一套 get-then-put 声明与 24 小时 TTL，且只在队列发送成功后写入。同一条评论的重投递会被跳过，不再启动第二轮完整审查；不同评论（或缺少可读 id、按无键方式入队的作业）仍会触发审查。提交面的 `idemKey` 及其非空 sha 不变量保持不变。
