---
category: Fixed
---

- **A queued Check says so, and a held delivery retries in minutes.** When another review is already running for the same pull request, a new commit's delivery is refused by the per-PR guard and retried; its Check was attached at webhook time, so it used to read a bare `in_progress` for the whole backoff (observed on staging: 41 of one run's 49 minutes were queue time). It now carries "Queued — the review in flight for this pull request (head <sha7>) holds the slot; this commit starts when it finishes", with the status untouched, and the retry schedule ends in short rungs — 60 s → 300 s → 300 s → 900 s → 900 s by default, 90 s → 480 s → 300 s → 900 s → 900 s for `deep` — whose cumulative sum still covers the in-flight lock. A released guard is therefore picked up within about five minutes instead of the 35-minute tail one long delay cost, and the queue's retry budget grows with the schedule so the last rung still ends in a clean ack rather than the DLQ.

<!-- CN -->
- **排队中的 Check 会说明自己在排队，被拒的投递几分钟内重试。** 同一 PR 已有 review 在跑时，新 commit 的投递会被 per-PR 闸门拒绝并重试；它的 Check 在 webhook 阶段就已 attach，此前整个退避期都只显示一个 `in_progress`（staging 实测：某次 run 的 49 分钟里有 41 分钟在排队）。现在它会写明「Queued —— 该 PR 正在执行的 review（head <sha7>）占着名额；本 commit 等它结束后开始」，status 保持不变；退避链改为以短档收尾 —— quick/default 60 s → 300 s → 300 s → 900 s → 900 s，`deep` 90 s → 480 s → 300 s → 900 s → 900 s —— 累计和仍覆盖 in-flight 锁。因此闸门释放后约五分钟内即会重试，而不是被单档长延迟拖到 35 分钟；队列重试预算随档数一起提高，最后一档仍以干净 ack 结束而非进入 DLQ。
