---
category: Fixed
---

- **The `mstar-inspector review` Check no longer claims a review is running before it starts**: the run is created `queued` when the webhook is accepted, and the review's own begin promotes it to `in_progress` with a one-line summary naming the commit — so the PR's checks list and merge box, which read only the run's name and status, show a queued run during the wait behind the previous review instead of a green-less `in_progress` that looked stuck. The promotion is bounded by the configured check update budget, never the begin hook's 2 s, and a failed promotion is one warning: the review runs either way. The held-check relabel still only rewrites the summary, which now stays truthful because the run is already `queued`.

<!-- CN -->
- **`mstar-inspector review` 检查不再在评审真正开始前声称正在运行**：webhook 被接受时即创建 `queued` 状态的运行，评审自身开始时才将其提升为 `in_progress`，并写入一行点名该提交的摘要——因此只读取运行名称与状态的 PR 检查列表与合并框，在等待前一轮评审期间显示的是排队状态，而不是看起来卡住的 `in_progress`。提升受配置的检查更新预算约束（不是 begin 钩子的 2 秒），提升失败只记一条告警，评审照常运行。被占位拒绝时的重标注仍只改写摘要——此时运行本就已是 `queued`，因此保持真实。
