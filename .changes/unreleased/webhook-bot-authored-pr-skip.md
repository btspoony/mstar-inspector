---
category: Changed
---

- **Bot-authored PRs are never reviewed**: a `pull_request` delivery whose author login ends in `[bot]` (`dependabot[bot]`, `github-actions[bot]`, another App's own `<slug>[bot]`) is ignored instead of enqueued, independent of the App's trigger mode and action. The same check applies to `issue_comment`, so a mention on such a PR does not start a review either. The suffix match is case-insensitive and only the suffix counts — a human-accounted `renovate` login still triggers.
- **Comment-face guard order**: the PR-thread gate and the bot-author check run before the mention grammar, so neither a bot-authored PR nor a comment on a plain issue reports the mention miss. The unsynced-App `mention_unresolved` operator warn correspondingly stays limited to comments on PRs authored by a non-bot.

<!-- CN -->
- **由 bot 创建的 PR 不再审查**：`pull_request` 事件的作者登录名以 `[bot]` 结尾时（`dependabot[bot]`、`github-actions[bot]`、其他 App 自己的 `<slug>[bot]`），直接忽略、不进入队列，与 App 的触发模式和 action 无关。`issue_comment` 面同样适用，因此在这类 PR 上 @提及也不会启动审查。后缀匹配不区分大小写，且只看后缀——真人账号 `renovate` 仍会触发。
- **评论面守卫顺序**：PR 线程判定与 bot 作者判定都先于提及语法执行，因此 bot 创建的 PR 以及普通 issue 上的评论都不会报告「未匹配到提及」。未同步 App 的 `mention_unresolved` 运维告警相应只保留给非 bot 作者 PR 上的评论。
