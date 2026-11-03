---
category: Changed
---

- **Bot-authored PRs are never reviewed**: a `pull_request` delivery whose author login ends in `[bot]` (`dependabot[bot]`, `github-actions[bot]`, another App's own `<slug>[bot]`) is ignored instead of enqueued, independent of the App's trigger mode. The same check applies to `issue_comment`, so a mention on such a PR does not start a review either. The suffix match is case-insensitive and only the suffix counts — a human-accounted `renovate` login still triggers.

<!-- CN -->
- **由 bot 创建的 PR 不再审查**：`pull_request` 事件的作者登录名以 `[bot]` 结尾时（`dependabot[bot]`、`github-actions[bot]`、其他 App 自己的 `<slug>[bot]`），直接忽略、不进入队列，与 App 的触发模式无关。`issue_comment` 面同样适用，因此在这类 PR 上 @提及也不会启动审查。后缀匹配不区分大小写，且只看后缀——真人账号 `renovate` 仍会触发。
