---
category: Changed
---

- **Only the newest commit of a PR is reviewed**: a delivery whose PR head has since advanced is acknowledged as `superseded` before any sandbox is created — no container, no retry, no failure row — and the delivery carrying the current commit is the one that reviews. One structured info line names the newer `head_at` that overtook it, so a missing review can be explained without a second query.
- **A newer commit is no longer dropped behind the delayed-retry window**: a message held by `pr-held` now retries at `60/300/1200` seconds (quick/default) or `90/480/1200` seconds (deep), so every attempt lands inside the level's guard TTL and the cumulative wait outlasts it — the terminal attempt then reviews the current head instead of the message expiring unseen.
- **The watermark only moves forward**: the ledger stores the `pull_request.updated_at` that last advanced `head_sha` and never rewinds on an out-of-order delivery, while a delivery at the same instant or for the newest commit is always reviewed. `issue_comment` jobs and any message without a stamp — including all traffic before this deploy — take exactly the previous path, and a ledger read failure or absent row fails open to a normal review.

<!-- CN -->
- **PR 只审查最新提交**：如果某次投递的 PR head 之后已经前进，该投递会在创建任何沙箱之前被确认为 `superseded`——不起容器、不重试、不写失败记录——由携带当前提交的那次投递来执行审查。一条结构化 info 日志会写明超越它的、更新的 `head_at`，因此缺少审查时不必再查一次就能解释。
- **新提交不再被延迟重试窗口丢弃**：被 `pr-held` 挂起的消息现在按 `60/300/1200` 秒（quick/default）或 `90/480/1200` 秒（deep）重试，每次尝试都落在该级别的 guard TTL 之内，而累计等待超过它——最后一次尝试因此审查的是当前 head，而不是让消息无声过期。
- **水位只前进不后退**：账本记录最后一次推进 `head_sha` 的 `pull_request.updated_at`，乱序到达的投递不会让它回退；而在同一时刻到达、或属于最新提交的投递始终会被审查。`issue_comment` 任务以及任何没有该时间戳的消息——包括本次部署之前的全部流量——完全走原有路径，账本读取失败或行不存在时一律按正常审查处理，绝不跳过。
