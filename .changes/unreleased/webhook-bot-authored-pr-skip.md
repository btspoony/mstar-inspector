---
category: Changed
---

- **Bot-authored PRs are never reviewed**: a `pull_request` delivery whose author login ends in `[bot]` (`dependabot[bot]`, `github-actions[bot]`, another App's own `<slug>[bot]`) is ignored instead of enqueued, independent of the App's trigger mode and action. The same check applies to `issue_comment`, so a mention on such a PR does not start a review either. The suffix match is case-insensitive and only the suffix counts: a login without `[bot]` still triggers, whatever its account type.
- **Missing author fails closed**: a delivery without the PR author login (`pull_request.user.login` / `issue.user.login`) cannot prove a human authored the PR, so it is ignored rather than reviewed on both faces. GitHub always sends the field; this only covers a truncated payload.
- **Skip is logged**: both faces emit one info-level structured line (`reason` = `bot_author` or `missing_author`, with the author login and PR number) when a delivery is skipped for its author, so an operator can tell why a PR got no review. The HTTP response and the delivery row's `ignored` vocabulary are unchanged.
- **Comment-face guard order**: the PR-thread gate and the bot-author check run before the mention grammar, so neither a bot-authored PR nor a comment on a plain issue reports the mention miss. The unsynced-App `mention_unresolved` operator warn correspondingly stays limited to comments on PRs authored by a non-bot. Status also moves: an `issue_comment` delivery that lacks a required field (installation id, repository, issue number) now answers 400 before the policy gates, so those truncated deliveries record `rejected` instead of `ignored`.

<!-- CN -->
- **由 bot 创建的 PR 不再审查**：`pull_request` 事件的作者登录名以 `[bot]` 结尾时（`dependabot[bot]`、`github-actions[bot]`、其他 App 自己的 `<slug>[bot]`），直接忽略、不进入队列，与 App 的触发模式和 action 无关。`issue_comment` 面同样适用，因此在这类 PR 上 @提及也不会启动审查。后缀匹配不区分大小写，且只看后缀：不含 `[bot]` 的登录名仍会触发，与账号类型无关。
- **作者缺失时 fail-closed**：delivery 若缺少 PR 作者登录名（`pull_request.user.login` / `issue.user.login`），无法证明由真人创建，两个触发面都会忽略而不审查。GitHub 总是发送该字段，此项只覆盖被截断的 payload。
- **跳过会记录日志**：因作者原因跳过 delivery 时，两个触发面各输出一条 info 级结构化日志（`reason` 为 `bot_author` 或 `missing_author`，并带作者登录名与 PR 编号），运维可直接看出某个 PR 为何没有审查。HTTP 响应与 delivery 行的 `ignored` 词汇保持不变。
- **评论面守卫顺序**：PR 线程判定与 bot 作者判定都先于提及语法执行，因此 bot 创建的 PR 以及普通 issue 上的评论都不会报告「未匹配到提及」。未同步 App 的 `mention_unresolved` 运维告警相应只保留给非 bot 作者 PR 上的评论。状态码也随之变化：缺少必需字段（installation id、repository、issue number）的 `issue_comment` 现在会在策略判断之前返回 400，这类被截断的 delivery 记录为 `rejected` 而非 `ignored`。
