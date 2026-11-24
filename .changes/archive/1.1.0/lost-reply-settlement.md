---
category: Fixed
---

- **A lost paid reply no longer holds capacity forever.** When the paid review step was issued and its reply never arrived, the attempt correctly stayed `launched` with no recorded outcome — a paid child may still be running — but nothing ever moved that row afterwards: its capacity slot stayed held and its Check never concluded. A bounded post-deadline grace now settles such a row as a terminal lost reply (`review.paid.reply_lost`) once it elapses, releases the capacity slot and lets the Check report the failure. The grace is the operator setting `review.lostReply.settle_ms` (absent row: 15 minutes; range 3–60 minutes), read once per scheduled pass, and it anchors on the attempt's own deadline — the instant the paid child is killed — plus the grace, so a live paid child is never declared lost. The settlement writes the failure record only when the launch row is still the `launched` shape it selected: a row that terminalized in between keeps its publishable result untouched. The pass is at-least-once and the failure row is attempt-keyed, so a second sweep writes nothing.

<!-- CN -->
- **付费回执丢失不再永久占用容量。** 付费审查步骤已发出但回执一直未到的时候，该次审查会正确地保持 `launched` 且不记录结果——付费子进程可能仍在运行——但此后没有任何机制推进该行：容量槽一直占用，Check 也始终不结束。现在由一个有界的 deadline 后宽限窗口在到期后把该行判定为终止的回执丢失（`review.paid.reply_lost`），释放容量槽并让 Check 报告失败。宽限是运维配置 `review.lostReply.settle_ms`（缺行默认 15 分钟，范围 3–60 分钟），每轮定时巡检读取一次；窗口锚定在该次审查自身的 deadline——付费子进程被终止的时刻——加上宽限，因此不会把仍在运行的付费子进程判定为丢失。只有 launch 行仍是选取时的 `launched` 形态才会写入失败记录：期间已终态化的行其可发布结果不受影响。该巡检为至少一次语义，失败行以 attempt 为键，第二次巡检不会重复写入。
