---
category: Changed
---

- **Only the newest commit of a PR is reviewed**: a delivery whose PR head has since advanced is acknowledged as `superseded` before any sandbox is created — no container, no retry, no failure row — and the delivery carrying the current commit is the one that reviews. The skip also requires that newer commit to own a queued job (its idempotency claim, written only after a successful enqueue), so a head advance produced by a delivery that queued nothing — a `synchronize` in `open` mode, a paused App, a failed send — never drops the PR's only review. One structured info line tagged `event=review_superseded` names the newer `head_at` that overtook it, so a missing review can be explained without a second query.
- **A newer commit is no longer dropped behind the delayed-retry window**: a message held by `pr-held` now retries at `60/300/1200` seconds (quick/default) or `90/480/1200` seconds (deep). The cumulative wait outlasts the level's guard TTL, so a lock that is released or expires before the final delayed attempt admits the retry and the new commit is reviewed. A review that outlives the whole schedule still drops the message, and that drop is recorded — never silent.
- **The watermark only moves forward**: the ledger stores the `pull_request.updated_at` that last advanced `head_sha` and never rewinds on an out-of-order delivery, while a delivery at the same instant or for the newest commit is always reviewed. `issue_comment` jobs and any message without a stamp — including all traffic before this deploy — take exactly the previous path, and a ledger read failure or absent row fails open to a normal review.

<!-- CN -->
- **PR 只审查最新提交**：如果某次投递的 PR head 之后已经前进，该投递会在创建任何沙箱之前被确认为 `superseded`——不起容器、不重试、不写失败记录——由携带当前提交的那次投递来执行审查。该跳过还要求那个更新的提交确实拥有一个已入队的任务（其幂等键只在入队成功后才写入），因此由「什么都没入队」的投递（`open` 模式下的 `synchronize`、已暂停的 App、失败的入队）推进的 head 绝不会丢掉这个 PR 唯一的一次审查。一条带 `event=review_superseded` 的结构化 info 日志会写明超越它的、更新的 `head_at`，因此缺少审查时不必再查一次就能解释。
- **新提交不再被延迟重试窗口丢弃**：被 `pr-held` 挂起的消息现在按 `60/300/1200` 秒（quick/default）或 `90/480/1200` 秒（deep）重试。累计等待超过该级别的 guard TTL，因此锁在最后一次延迟尝试之前被释放或过期时，重试会被接纳，新提交也就得到审查。若审查的存活时间超过整个计划，消息仍会被丢弃，而这次丢弃会被记录下来——绝不无声。
- **水位只前进不后退**：账本记录最后一次推进 `head_sha` 的 `pull_request.updated_at`，乱序到达的投递不会让它回退；而在同一时刻到达、或属于最新提交的投递始终会被审查。`issue_comment` 任务以及任何没有该时间戳的消息——包括本次部署之前的全部流量——完全走原有路径，账本读取失败或行不存在时一律按正常审查处理，绝不跳过。
