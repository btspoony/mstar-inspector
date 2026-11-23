---
category: Fixed
---

- **A lost paid reply no longer holds capacity forever.** When the paid review step was issued and its reply never arrived, the attempt correctly stayed `launched` with no recorded outcome — a paid child may still be running — but nothing ever moved that row afterwards: its capacity slot stayed held and its Check never concluded. A bounded observation window now settles such a row as a terminal lost reply (`review.paid.reply_lost`) once it elapses, releases the capacity slot and lets the Check report the failure. The window is the operator setting `review.lostReply.settle_ms` (absent row: 15 minutes; range 11–60 minutes), read once per scheduled pass; its floor keeps it above the longest runner budget plus the kill grace, so a live paid child is never declared lost. The pass is at-least-once and the failure row is attempt-keyed, so a second sweep writes nothing.

<!-- CN -->
- **付费回执丢失不再永久占用容量。** 付费审查步骤已发出但回执一直未到的时候，该次审查会正确地保持 `launched` 且不记录结果——付费子进程可能仍在运行——但此后没有任何机制推进该行：容量槽一直占用，Check 也始终不结束。现在由一个有界的观察窗口在到期后把该行判定为终止的回执丢失（`review.paid.reply_lost`），释放容量槽并让 Check 报告失败。窗口是运维配置 `review.lostReply.settle_ms`（缺行默认 15 分钟，范围 11–60 分钟），每轮定时巡检读取一次；其下限保证高于最长 runner 预算加 kill grace，因此不会把仍在运行的付费子进程判定为丢失。该巡检为至少一次语义，失败行以 attempt 为键，第二次巡检不会重复写入。
