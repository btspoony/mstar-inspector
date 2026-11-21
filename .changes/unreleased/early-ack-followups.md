---
category: Fixed
---

- **A stale duplicate no longer swallows the newest commit, and a skipped delivery no longer reports `neutral` over a review that failed the gate.** The pre-claim ack now compares the head it was keyed on with the PR's live head (the App ledger watermark): a head that has since moved falls through and the round reviews the live commit — in `manual` mode a push queues no review, so that delivery is the newer commit's only chance. The read runs only on a hit; an unreadable watermark keeps today's ack with one warning, never a second paid review. A skipped delivery (idempotency hit, publication-journal hand-off, guard refusal, paused App) now settles from the head's own published review against the App's current gate — `success` when it meets the gate, `failure` when it misses — and falls back to `neutral` only when there is nothing to inherit: no published review, an unreadable gate, or a review without a readable score. A `prepared` journal row stays a hand-off to the recovery lane and is not treated as proof the review is visible.

<!-- CN -->
- **过期的重复投递不再吞掉最新提交，被跳过的投递也不再在审查未过闸时报 `neutral`。** 占用前的 ack 现在会把命中所用的 head 与 PR 的实时 head（App 账本水位）比对：head 已前进则不再 ack，本轮直接审查最新提交——`manual` 模式下 push 不会入队审查，这次投递就是该提交唯一的机会。该读取只在命中时发生；水位不可读时保持原有 ack 并记一条 warning，绝不产生第二次付费审查。被跳过的投递（幂等命中、发布日志交接、guard 拒绝、App 暂停）现在按该 head 自身已发布的审查对照 App 当前闸门收尾：过闸 `success`、未过闸 `failure`；只有无从继承时才回落 `neutral`——没有已发布审查、闸门不可读、或审查缺可读分数。`prepared` 日志行仍只是把投递交给 recovery，不代表审查已可见。
